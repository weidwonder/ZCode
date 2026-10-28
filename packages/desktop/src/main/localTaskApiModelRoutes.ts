/* 本机任务 API 的模型两条路由：GET /api/models（列可选模型）与
 * POST /api/tasks/:taskId/model（换模型）。从 localTaskApi.ts 拆出以守 800 行
 * lint 上限；传输、鉴权与状态依赖经参数对象注入，分支顺序与错误码同既有路由
 * （Host 头 → Bearer → 业务校验 → dispatch），行为语义与 send/create 分支一致。 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { modelSelectionSchema, type LocalTaskApiRequestOp } from "@zcode/shared";
import type { ClientRequestIdDedup } from "./localTaskApiClientRequestId.js";
import { isRecord, sendJson, validateClientRequestId } from "./localTaskApiHttpUtil.js";

/** 两条模型路由内部会触发的拒绝计数键（localTaskApi.ts 计数器的子集）。 */
type ModelRouteRejectKey = "hostForbidden" | "unauthorized" | "workspaceNotOpen" | "unavailable";

export interface LocalTaskApiModelRouteDeps {
  isAllowedHostHeader: (req: IncomingMessage) => boolean;
  isAuthorized: (req: IncomingMessage) => boolean;
  noteReject: (key: ModelRouteRejectKey) => void;
  dispatchOp: (
    res: ServerResponse,
    workspacePath: string,
    op: LocalTaskApiRequestOp,
    options?: { rememberTask?: { taskId: string; workspacePath: string } },
  ) => Promise<void>;
  dispatcher: {
    dispatch: (
      workspacePath: string,
      op: LocalTaskApiRequestOp,
    ) => Promise<{ status: number; body: unknown }>;
  };
  clientRequestIdDedup: ClientRequestIdDedup;
  resolveTaskWorkspace: (
    res: ServerResponse,
    taskId: string,
    provided?: string | null,
  ) => string | null;
  taskWorkspaceByTaskId: Map<string, string>;
}

/** GET /api/models?workspacePath=…：列某 workspace 的可选模型（只读，无幂等）。 */
export async function handleGetModelsRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: LocalTaskApiModelRouteDeps,
): Promise<void> {
  if (!deps.isAllowedHostHeader(req)) {
    deps.noteReject("hostForbidden");
    sendJson(res, 403, { error: "host_header_forbidden" });
    return;
  }
  if (!deps.isAuthorized(req)) {
    deps.noteReject("unauthorized");
    sendJson(res, 401, { error: "unauthorized" });
    return;
  }
  const workspacePath = url.searchParams.get("workspacePath");
  if (typeof workspacePath !== "string" || workspacePath.length === 0) {
    sendJson(res, 400, { error: "bad_request" });
    return;
  }
  await deps.dispatchOp(res, workspacePath, { kind: "listModels", workspacePath });
}

/** POST /api/tasks/:taskId/model：换模型。鉴权/Content-Type/body 读取由调用方统一完成后进入。 */
export async function handleSetModelRoute(
  res: ServerResponse,
  taskId: string,
  bodyText: string,
  deps: LocalTaskApiModelRouteDeps,
): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    sendJson(res, 400, { error: "bad_request" });
    return;
  }
  if (!isRecord(parsed)) {
    sendJson(res, 400, { error: "bad_request" });
    return;
  }
  // workspacePath 可选：存在时必须是 string；空串交给归属解析（与 send 分支同语义）。
  if (parsed["workspacePath"] !== undefined && typeof parsed["workspacePath"] !== "string") {
    sendJson(res, 400, { error: "bad_request" });
    return;
  }
  const providedWorkspace =
    typeof parsed["workspacePath"] === "string" ? parsed["workspacePath"] : null;
  // modelSelection 必填：strict schema 的拒绝发生在 Host 侧且不应答，请求只能等
  // 300s 兜底悬挂，所以 Main 先 400（与 create 的 mode 同理由）。
  const safeModelSelection = modelSelectionSchema.safeParse(parsed["modelSelection"]);
  if (!safeModelSelection.success) {
    sendJson(res, 400, { error: "bad_request" });
    return;
  }
  const clientRequestId = validateClientRequestId(parsed);
  if (clientRequestId === "invalid") {
    sendJson(res, 400, { error: "bad_request" });
    return;
  }
  const workspacePath = deps.resolveTaskWorkspace(res, taskId, providedWorkspace);
  if (workspacePath === null) return;
  const wasOwned = deps.taskWorkspaceByTaskId.has(taskId);
  const op: LocalTaskApiRequestOp = {
    kind: "setModel",
    workspacePath,
    taskId,
    modelSelection: safeModelSelection.data,
  };
  // clientRequestId 幂等（与 send 同语义）：归属解析之后、dispatch 之前 claim；命中由
  // respondToDuplicate 代答、不再 dispatch；settle：2xx 缓存应答、失败清除。
  if (clientRequestId !== null) {
    const modelClaim = deps.clientRequestIdDedup.model.claim(taskId, clientRequestId);
    if (modelClaim.kind !== "fresh") {
      const duplicate = await deps.clientRequestIdDedup.model.respondToDuplicate(modelClaim);
      sendJson(res, duplicate.status, duplicate.body);
      return;
    }
    try {
      const result = await deps.dispatcher.dispatch(workspacePath, op);
      if (result.status === 409) deps.noteReject("workspaceNotOpen");
      if (result.status === 503) deps.noteReject("unavailable");
      if (result.status >= 200 && result.status < 300 && !wasOwned) {
        deps.taskWorkspaceByTaskId.set(taskId, workspacePath);
      }
      modelClaim.settle(result);
      sendJson(res, result.status, result.body);
    } catch {
      modelClaim.settle({ status: 503, body: { error: "unavailable_host" } });
      deps.noteReject("unavailable");
      sendJson(res, 503, { error: "unavailable_host" });
    }
    return;
  }
  await deps.dispatchOp(
    res,
    workspacePath,
    op,
    wasOwned ? undefined : { rememberTask: { taskId, workspacePath } },
  );
}

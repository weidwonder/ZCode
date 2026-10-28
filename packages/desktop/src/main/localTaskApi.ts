/* 本机任务 API：Main 进程内全应用唯一的 loopback HTTP 监听。Main 只承载
 * 传输与鉴权（Host 头、Bearer token、Content-Type、大小上限）与 workspace→Host
 * 路由；任务业务与事件缓冲都在窗口 Host 侧。本文件不 import electron，
 * 依赖全部注入以便单测。 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { getAppConfigDir } from "@zcode/services/node";
import {
  HostMessageTypes,
  localTaskApiTaskModes,
  modelSelectionSchema,
  type LocalTaskApiRequestOp,
  type ModelSelection,
} from "@zcode/shared";
import { createClientRequestIdDedup, taskIdOf } from "./localTaskApiClientRequestId.js";
import {
  hasDeclaredBody,
  isRecord,
  parseAfter,
  parsePathSegments,
  parseWaitMs,
  readRequestBody,
  segmentAt,
  sendJson,
  validateClientRequestId,
} from "./localTaskApiHttpUtil.js";
import {
  handleGetModelsRoute,
  handleSetModelRoute,
  type LocalTaskApiModelRouteDeps,
} from "./localTaskApiModelRoutes.js";
import {
  createLocalTaskApiWorkspaceOpener,
  type EnsureWorkspaceReadyResult,
} from "./localTaskApiWorkspaceOpener.js";

export const LOCAL_TASK_API_CONFIG_FILE = "local-task-api.json";
/** 开关文件 token 最短长度。 */
const MIN_TOKEN_CHARS = 32;
/** dispatcher 兜底超时（events 的 waitMs 上限 30s 远小于此）。 */
const DISPATCH_TIMEOUT_MS = 300_000;

/** 与 ZCodeTaskMode 全集对齐（shared validation.ts 的 localTaskApiTaskModes，双向互检钉住）；未知值 create 先 400。 */
const TASK_MODES = new Set<string>(localTaskApiTaskModes);

export interface LocalTaskApiConfig {
  enabled: boolean;
  port: number;
  token: string;
}

/** 读开关文件：缺失或未启用返回 null（静默）；损坏/端口非法/token 过短返回 "invalid"（调用方 warn）。 */
export async function readLocalTaskApiConfig(
  configDir: string = getAppConfigDir(),
): Promise<LocalTaskApiConfig | null | "invalid"> {
  let raw: string;
  try {
    raw = await readFile(join(configDir, LOCAL_TASK_API_CONFIG_FILE), "utf8");
  } catch {
    return null;
  }

  let record: unknown;
  try {
    record = JSON.parse(raw);
  } catch {
    return "invalid";
  }
  if (typeof record !== "object" || record === null || Array.isArray(record)) {
    return "invalid";
  }
  const fields = record as Record<string, unknown>;

  if (fields["enabled"] !== true) {
    return null;
  }

  const port = fields["port"];
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
    return "invalid";
  }

  const token = fields["token"];
  if (typeof token !== "string" || token.length < MIN_TOKEN_CHARS) {
    return "invalid";
  }

  return { enabled: true, port, token };
}

export interface LocalTaskApiDispatcherDeps {
  /** 按本地 workspacePath 找拥有它的窗口 Host；找不到返回 null。 */
  resolveHost: (workspacePath: string) => { postMessage: (message: unknown) => void } | null;
  /** 注入后：workspace 未打开时先自动打开并有界等待 Host 注册（同 workspace 并发去重）。 */
  ensureWorkspaceReady?: (workspacePath: string) => Promise<EnsureWorkspaceReadyResult>;
  timeoutMs?: number;
  logger?: { warn: (...args: unknown[]) => void };
}

interface PendingLocalTaskApiRequest {
  resolve: (result: { status: number; body: unknown }) => void;
  timer: ReturnType<typeof setTimeout>;
  host: { postMessage: (message: unknown) => void };
}

export function createLocalTaskApiDispatcher(deps: LocalTaskApiDispatcherDeps) {
  const timeoutMs = deps.timeoutMs ?? DISPATCH_TIMEOUT_MS;
  const pending = new Map<string, PendingLocalTaskApiRequest>();

  function settle(requestId: string, result: { status: number; body: unknown }): void {
    const entry = pending.get(requestId);
    if (!entry) {
      return;
    }
    pending.delete(requestId);
    clearTimeout(entry.timer);
    entry.resolve(result);
  }

  async function dispatch(
    workspacePath: string,
    op: LocalTaskApiRequestOp,
  ): Promise<{ status: number; body: unknown }> {
    let host = deps.resolveHost(workspacePath);
    if (!host && deps.ensureWorkspaceReady) {
      // workspace 未打开：注入了自动打开时先打开并有界等待 Host 注册（同 workspace 并发去重），
      // 结果非 ready 直接以对应错误码应答（blocked/timeout → 409 族，invalid → 400）。
      const ready = await deps.ensureWorkspaceReady(workspacePath);
      if (ready.kind !== "ready") return { status: ready.status, body: ready.body };
      host = ready.host;
    }
    if (!host) {
      return { status: 409, body: { error: "workspace_not_open" } };
    }
    const requestId = randomUUID();
    return await new Promise<{ status: number; body: unknown }>((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        deps.logger?.warn(`[local-task-api] dispatch failed request=${requestId} reason=timeout`);
        resolve({ status: 503, body: { error: "unavailable_host" } });
      }, timeoutMs);
      // 不靠这条兜底定时器维持进程存活；窗口 Host 应答/断开自有其它存活来源。
      timer.unref?.();
      pending.set(requestId, { resolve, timer, host });
      try {
        host.postMessage({ type: HostMessageTypes.LocalTaskApiRequest, requestId, op });
      } catch {
        pending.delete(requestId);
        clearTimeout(timer);
        deps.logger?.warn(
          `[local-task-api] dispatch failed request=${requestId} reason=post_error`,
        );
        resolve({ status: 503, body: { error: "unavailable_host" } });
      }
    });
  }

  function resolveLocalTaskApiResponse(message: {
    requestId: string;
    ok: boolean;
    status: number;
    body: unknown;
  }): void {
    if (!pending.has(message.requestId)) {
      return;
    }
    if (message.ok) {
      settle(message.requestId, { status: message.status, body: message.body });
    } else {
      deps.logger?.warn(
        `[local-task-api] dispatch failed request=${message.requestId} reason=host_error`,
      );
      settle(message.requestId, {
        status: 503,
        body: message.body ?? { error: "unavailable_host" },
      });
    }
  }

  /** Host 退出时结清属于它的在飞请求（含 events 长轮询），返回结清条数。 */
  function settleRequestsForHost(host: unknown): number {
    const matched: string[] = [];
    for (const [requestId, entry] of pending) {
      if (entry.host === host) {
        matched.push(requestId);
      }
    }
    for (const requestId of matched) {
      settle(requestId, { status: 503, body: { error: "unavailable_host" } });
    }
    if (matched.length > 0) {
      deps.logger?.warn(
        `[local-task-api] host exited; settled ${matched.length} in-flight request(s)`,
      );
    }
    return matched.length;
  }

  return { dispatch, resolveLocalTaskApiResponse, settleRequestsForHost };
}

export interface LocalTaskApiDeps {
  readConfig?: () => Promise<LocalTaskApiConfig | null | "invalid">;
  /** 开关文件绝对路径；权限检查 stat 用。缺省为 getAppConfigDir() 下的默认文件。 */
  configPath?: string;
  resolveHost: (workspacePath: string) => { postMessage: (message: unknown) => void } | null;
  /** workspace 未打开时的自动打开（与 deep link 同链路）；缺省维持 409 workspace_not_open。 */
  openWorkspace?: (workspacePath: string) => "opened" | "invalid" | "blocked";
  /** 自动打开后等待 Host 注册的总时限，默认 30s；测试可注入小值。 */
  workspaceOpenTimeoutMs?: number;
  /** 自动打开后的轮询间隔，默认 250ms；测试可注入小值。 */
  workspaceOpenPollMs?: number;
  zcodeVersion: string;
  logger: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void };
}

/**
 * 创建本机任务 API 监听。返回 null 表示未监听（未启用/配置无效/端口被占），调用方继续正常启动。
 * 归属表 taskId→workspacePath 是本模块的进程内存状态：只有经本 API 创建的任务登记入表；
 * 重启后表为空，带 :taskId 的请求可携带可选 workspacePath（GET 用 query、POST 用 body
 * 字段）按 workspace 路由，由 Host 校验任务归属、应答 2xx 后回填本表；表未命中且未带
 * 则 404 task_not_found。events 缓冲随重启清空：重启后先查 events 返回空事件 + nextSeq
 * 是预期行为。
 */
export async function createLocalTaskApi(deps: LocalTaskApiDeps): Promise<Server | null> {
  const workspaceOpener = createLocalTaskApiWorkspaceOpener({
    resolveHost: deps.resolveHost,
    ...(deps.openWorkspace ? { openWorkspace: deps.openWorkspace } : {}),
    ...(deps.workspaceOpenTimeoutMs !== undefined
      ? { timeoutMs: deps.workspaceOpenTimeoutMs }
      : {}),
    ...(deps.workspaceOpenPollMs !== undefined ? { pollMs: deps.workspaceOpenPollMs } : {}),
    logger: deps.logger,
  });
  const dispatcher = createLocalTaskApiDispatcher({
    resolveHost: deps.resolveHost,
    ensureWorkspaceReady: workspaceOpener.ensureWorkspaceReady,
    logger: deps.logger,
  });
  setLocalTaskApiDispatcher(dispatcher);

  const taskWorkspaceByTaskId = new Map<string, string>();
  const clientRequestIdDedup = createClientRequestIdDedup({ logger: deps.logger });
  // 拒绝计数：仅内存聚合；每次自增输出一行 warn（只含键名与新值，不含路径与请求内容）。
  const rejected = {
    unauthorized: 0,
    hostForbidden: 0,
    unsupportedMedia: 0,
    tooLarge: 0,
    workspaceNotOpen: 0,
    taskNotFound: 0,
    unavailable: 0,
  };
  function noteReject(key: keyof typeof rejected): void {
    rejected[key] += 1;
    deps.logger.warn(`[local-task-api] rejected ${key} count=${rejected[key]}`);
  }

  const readConfig = deps.readConfig ?? readLocalTaskApiConfig;
  const config = await readConfig();
  if (config === "invalid") {
    deps.logger.warn(`[local-task-api] invalid ${LOCAL_TASK_API_CONFIG_FILE}; api disabled`);
    return null;
  }
  if (config === null || !config.enabled) {
    return null;
  }
  const port = config.port;
  const tokenDigest = createHash("sha256").update(config.token).digest();

  // 权限提醒：token 若对本机其他用户可读则控制权外泄；只 warn 不拒绝（拍板④）。
  try {
    const configPath = deps.configPath ?? join(getAppConfigDir(), LOCAL_TASK_API_CONFIG_FILE);
    const st = await stat(configPath);
    if (st.mode & 0o077) {
      deps.logger.warn(
        `[local-task-api] ${LOCAL_TASK_API_CONFIG_FILE} is readable by group/others; recommend chmod 600`,
      );
    }
  } catch {
    // stat 失败不阻断（readConfig 可能是注入的实现，没有真实文件）。
  }

  function isAuthorized(req: IncomingMessage): boolean {
    const header = req.headers["authorization"];
    if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
    const given = createHash("sha256").update(header.slice("Bearer ".length)).digest();
    return timingSafeEqual(tokenDigest, given); // 长度恒 32，恒时比较
  }

  function isAllowedHostHeader(req: IncomingMessage): boolean {
    const header = req.headers["host"];
    if (typeof header !== "string") return false;
    const normalized = header.trim().toLowerCase();
    return normalized === `127.0.0.1:${port}` || normalized === `localhost:${port}`;
  }

  function resolveTaskWorkspace(
    res: ServerResponse,
    taskId: string,
    provided?: string | null,
  ): string | null {
    const owned = taskWorkspaceByTaskId.get(taskId);
    if (owned) return owned;
    // 归属表未命中但请求带了 workspacePath：按它路由，由 Host 校验任务归属；
    // 应答 2xx 时回填归属表（调用方在 dispatch 后做）。
    if (typeof provided === "string" && provided.length > 0) return provided;
    noteReject("taskNotFound");
    sendJson(res, 404, { error: "task_not_found" });
    return null;
  }

  async function dispatchOp(
    res: ServerResponse,
    workspacePath: string,
    op: LocalTaskApiRequestOp,
    options?: { rememberTask?: { taskId: string; workspacePath: string } },
  ): Promise<void> {
    try {
      const result = await dispatcher.dispatch(workspacePath, op);
      if (result.status === 409) {
        noteReject("workspaceNotOpen");
      }
      if (result.status === 503) {
        noteReject("unavailable");
      }
      // Host 校验通过（2xx）才回填：外部提供的 workspacePath 从此成为权威归属。
      if (options?.rememberTask && result.status >= 200 && result.status < 300) {
        taskWorkspaceByTaskId.set(options.rememberTask.taskId, options.rememberTask.workspacePath);
      }
      sendJson(res, result.status, result.body);
    } catch {
      noteReject("unavailable");
      sendJson(res, 503, { error: "unavailable_host" });
    }
  }

  // 模型两条路由（GET /api/models、POST /api/tasks/:id/model）的依赖注入，
  // 实现在 localTaskApiModelRoutes.ts（拆出以守 800 行 lint 上限）。
  const modelRouteDeps: LocalTaskApiModelRouteDeps = {
    isAllowedHostHeader,
    isAuthorized,
    noteReject,
    dispatchOp,
    dispatcher,
    clientRequestIdDedup,
    resolveTaskWorkspace,
    taskWorkspaceByTaskId,
  };

  async function handleGet(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const pathname = url.pathname;
    if (pathname === "/health") {
      // health 不做 Host 头/鉴权——契约豁免。
      sendJson(res, 200, {
        ok: true,
        api: "zcode-local-task-api",
        version: 2,
        zcodeVersion: deps.zcodeVersion,
      });
      return;
    }

    const segments = parsePathSegments(pathname);
    if (segments === null) {
      sendJson(res, 400, { error: "bad_request" });
      return;
    }

    if (segments.length === 2 && segments[0] === "api" && segments[1] === "models") {
      await handleGetModelsRoute(req, res, url, modelRouteDeps);
      return;
    }

    if (segments.length === 2 && segments[0] === "api" && segments[1] === "tasks") {
      if (!isAllowedHostHeader(req)) {
        noteReject("hostForbidden");
        sendJson(res, 403, { error: "host_header_forbidden" });
        return;
      }
      if (!isAuthorized(req)) {
        noteReject("unauthorized");
        sendJson(res, 401, { error: "unauthorized" });
        return;
      }
      const workspacePath = url.searchParams.get("workspacePath");
      if (typeof workspacePath !== "string" || workspacePath.length === 0) {
        sendJson(res, 400, { error: "bad_request" });
        return;
      }
      await dispatchOp(res, workspacePath, { kind: "list", workspacePath });
      return;
    }

    if (
      segments.length === 4 &&
      segments[0] === "api" &&
      segments[1] === "tasks" &&
      segments[3] === "events"
    ) {
      const taskId = segmentAt(segments, 2);
      if (taskId === null) {
        sendJson(res, 404, { error: "not_found" });
        return;
      }
      if (!isAllowedHostHeader(req)) {
        noteReject("hostForbidden");
        sendJson(res, 403, { error: "host_header_forbidden" });
        return;
      }
      if (!isAuthorized(req)) {
        noteReject("unauthorized");
        sendJson(res, 401, { error: "unauthorized" });
        return;
      }
      const providedWorkspace = url.searchParams.get("workspacePath");
      const workspacePath = resolveTaskWorkspace(res, taskId, providedWorkspace);
      if (workspacePath === null) return;
      const wasOwned = taskWorkspaceByTaskId.has(taskId);
      const after = parseAfter(url.searchParams.get("after"));
      const waitMs = parseWaitMs(url.searchParams.get("waitMs"));
      await dispatchOp(
        res,
        workspacePath,
        { kind: "events", workspacePath, taskId, after, waitMs },
        wasOwned ? undefined : { rememberTask: { taskId, workspacePath } },
      );
      return;
    }

    if (segments.length === 3 && segments[0] === "api" && segments[1] === "tasks") {
      const taskId = segmentAt(segments, 2);
      if (taskId === null) {
        sendJson(res, 404, { error: "not_found" });
        return;
      }
      if (!isAllowedHostHeader(req)) {
        noteReject("hostForbidden");
        sendJson(res, 403, { error: "host_header_forbidden" });
        return;
      }
      if (!isAuthorized(req)) {
        noteReject("unauthorized");
        sendJson(res, 401, { error: "unauthorized" });
        return;
      }
      const providedWorkspace = url.searchParams.get("workspacePath");
      const workspacePath = resolveTaskWorkspace(res, taskId, providedWorkspace);
      if (workspacePath === null) return;
      const wasOwned = taskWorkspaceByTaskId.has(taskId);
      await dispatchOp(
        res,
        workspacePath,
        { kind: "get", workspacePath, taskId },
        wasOwned ? undefined : { rememberTask: { taskId, workspacePath } },
      );
      return;
    }

    sendJson(res, 404, { error: "not_found" });
  }

  async function handlePost(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const segments = parsePathSegments(url.pathname);
    if (segments === null) {
      sendJson(res, 400, { error: "bad_request" });
      return;
    }
    const isCreate = segments.length === 2 && segments[0] === "api" && segments[1] === "tasks";
    const isSend =
      segments.length === 4 &&
      segments[0] === "api" &&
      segments[1] === "tasks" &&
      segments[3] === "messages";
    const isStop =
      segments.length === 4 &&
      segments[0] === "api" &&
      segments[1] === "tasks" &&
      segments[3] === "stop";
    const isSetModel =
      segments.length === 4 &&
      segments[0] === "api" &&
      segments[1] === "tasks" &&
      segments[3] === "model";
    if (!isCreate && !isSend && !isStop && !isSetModel) {
      sendJson(res, 404, { error: "not_found" });
      return;
    }

    // 统一顺序：Host 头校验 → 鉴权 → Content-Type → body。
    if (!isAllowedHostHeader(req)) {
      noteReject("hostForbidden");
      sendJson(res, 403, { error: "host_header_forbidden" });
      return;
    }
    if (!isAuthorized(req)) {
      noteReject("unauthorized");
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }
    const contentType = req.headers["content-type"];
    if (contentType !== undefined) {
      if (!contentType.toLowerCase().includes("application/json")) {
        noteReject("unsupportedMedia");
        sendJson(res, 415, { error: "unsupported_media_type" });
        return;
      }
    } else if (hasDeclaredBody(req)) {
      noteReject("unsupportedMedia");
      sendJson(res, 415, { error: "unsupported_media_type" });
      return;
    }
    const body = await readRequestBody(req);
    if (!body.ok) {
      if (body.tooLarge) {
        noteReject("tooLarge");
        sendJson(res, 413, { error: "payload_too_large" });
        res.once("finish", () => req.destroy());
        return;
      }
      sendJson(res, 400, { error: "bad_request" });
      return;
    }

    if (isCreate) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(body.text);
      } catch {
        sendJson(res, 400, { error: "bad_request" });
        return;
      }
      if (!isRecord(parsed)) {
        sendJson(res, 400, { error: "bad_request" });
        return;
      }
      const workspacePath = parsed["workspacePath"];
      const prompt = parsed["prompt"];
      const mode = parsed["mode"];
      const title = parsed["title"];
      const modelSelection = parsed["modelSelection"];
      if (
        typeof workspacePath !== "string" ||
        workspacePath.length === 0 ||
        typeof prompt !== "string" ||
        // mode 若存在必须是 TASK_MODES 全集内的值：放行未知值会被 Host 侧 shared schema
        // 拒绝且不应答，请求只能等 300s 兜底，所以这里先 400。
        (mode !== undefined && !(typeof mode === "string" && TASK_MODES.has(mode as never))) ||
        (title !== undefined && typeof title !== "string")
      ) {
        sendJson(res, 400, { error: "bad_request" });
        return;
      }
      // modelSelection 若存在必须过 shared strict schema：strict 拒绝发生在 Host 侧且不应答，
      // 请求只能等 300s 兜底悬挂，所以 Main 先 400（与 mode 同理由）。
      let parsedModelSelection: ModelSelection | undefined;
      if (modelSelection !== undefined) {
        const safeModelSelection = modelSelectionSchema.safeParse(modelSelection);
        if (!safeModelSelection.success) {
          sendJson(res, 400, { error: "bad_request" });
          return;
        }
        parsedModelSelection = safeModelSelection.data;
      }
      const clientRequestIdState = validateClientRequestId(parsed);
      if (clientRequestIdState === "invalid") {
        sendJson(res, 400, { error: "bad_request" });
        return;
      }
      // clientRequestId 幂等：claim 同步完成惰性清理、查表与未命中登记；命中由 respondToDuplicate 代答、
      // 不再 dispatch；dispatch 结束必须 settle（createClaim.settle）：成功落缓存、失败清除（逻辑见 .ts）。
      const createClaim = clientRequestIdDedup.create.claim(clientRequestIdState);
      if (createClaim.kind !== "fresh") {
        const duplicate = await clientRequestIdDedup.create.respondToDuplicate(createClaim);
        sendJson(res, duplicate.status, duplicate.body);
        return;
      }
      const op: LocalTaskApiRequestOp = {
        kind: "create",
        workspacePath,
        prompt,
        ...(typeof mode === "string" && TASK_MODES.has(mode)
          ? { mode: mode as (typeof localTaskApiTaskModes)[number] }
          : {}),
        ...(typeof title === "string" ? { title } : {}),
        ...(parsedModelSelection !== undefined ? { modelSelection: parsedModelSelection } : {}),
      };
      try {
        const result = await dispatcher.dispatch(workspacePath, op);
        if (result.status === 409) noteReject("workspaceNotOpen");
        if (result.status === 503) noteReject("unavailable");
        // Host 侧部分失败会以 2xx + warning 应答，只要 body 形如 {taskId} 就登记。
        const createdTaskId = taskIdOf(result.body);
        if (result.status >= 200 && result.status < 300 && createdTaskId !== null) {
          taskWorkspaceByTaskId.set(createdTaskId, workspacePath);
          deps.logger.info(`[local-task-api] created task=${createdTaskId}`);
        }
        createClaim.settle(result);
        sendJson(res, result.status, result.body);
      } catch {
        createClaim.settle({ status: 503, body: { error: "unavailable_host" } });
        noteReject("unavailable");
        sendJson(res, 503, { error: "unavailable_host" });
      }
      return;
    }

    const taskId = segmentAt(segments, 2);
    if (taskId === null) {
      sendJson(res, 404, { error: "not_found" });
      return;
    }

    if (isStop) {
      // stop：空 body 放行不 parse；带 body 时取可选 workspacePath（类型错 → 400）。
      let providedWorkspace: string | null = null;
      if (body.text.length > 0) {
        let parsedStop: unknown;
        try {
          parsedStop = JSON.parse(body.text);
        } catch {
          sendJson(res, 400, { error: "bad_request" });
          return;
        }
        if (!isRecord(parsedStop)) {
          sendJson(res, 400, { error: "bad_request" });
          return;
        }
        if (
          parsedStop["workspacePath"] !== undefined &&
          typeof parsedStop["workspacePath"] !== "string"
        ) {
          sendJson(res, 400, { error: "bad_request" });
          return;
        }
        providedWorkspace =
          typeof parsedStop["workspacePath"] === "string" ? parsedStop["workspacePath"] : null;
      }
      const workspacePath = resolveTaskWorkspace(res, taskId, providedWorkspace);
      if (workspacePath === null) return;
      const wasOwned = taskWorkspaceByTaskId.has(taskId);
      await dispatchOp(
        res,
        workspacePath,
        { kind: "stop", workspacePath, taskId },
        wasOwned ? undefined : { rememberTask: { taskId, workspacePath } },
      );
      return;
    }

    if (isSetModel) {
      await handleSetModelRoute(res, taskId, body.text, modelRouteDeps);
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(body.text);
    } catch {
      sendJson(res, 400, { error: "bad_request" });
      return;
    }
    if (!isRecord(parsed)) {
      sendJson(res, 400, { error: "bad_request" });
      return;
    }
    if (parsed["workspacePath"] !== undefined && typeof parsed["workspacePath"] !== "string") {
      sendJson(res, 400, { error: "bad_request" });
      return;
    }
    const providedWorkspace =
      typeof parsed["workspacePath"] === "string" ? parsed["workspacePath"] : null;
    const text = parsed["text"];
    const delivery = parsed["delivery"];
    const clientRequestId = parsed["clientRequestId"];
    if (
      typeof text !== "string" ||
      (delivery !== undefined &&
        delivery !== "auto" &&
        delivery !== "queue" &&
        delivery !== "steer")
    ) {
      sendJson(res, 400, { error: "bad_request" });
      return;
    }
    // clientRequestId 可选：存在时须 1..200 字符，否则 400（与 create 同语义同上限）。
    let normalizedClientRequestId: string | null = null;
    if (clientRequestId !== undefined) {
      if (
        typeof clientRequestId !== "string" ||
        clientRequestId.length < 1 ||
        clientRequestId.length > 200
      ) {
        sendJson(res, 400, { error: "bad_request" });
        return;
      }
      normalizedClientRequestId = clientRequestId;
    }
    const workspacePath = resolveTaskWorkspace(res, taskId, providedWorkspace);
    if (workspacePath === null) return;
    const wasOwned = taskWorkspaceByTaskId.has(taskId);
    const op: LocalTaskApiRequestOp = {
      kind: "send",
      workspacePath,
      taskId,
      text,
      delivery: delivery ?? "auto",
    };
    // clientRequestId 幂等（与 create 同语义）：归属解析之后、dispatch 之前 claim，同步完成惰性清理、查表
    // 与未命中登记；命中由 respondToDuplicate 代答、不再 dispatch；settle：2xx 缓存应答、失败清除。
    if (normalizedClientRequestId !== null) {
      const sendClaim = clientRequestIdDedup.send.claim(taskId, normalizedClientRequestId);
      if (sendClaim.kind !== "fresh") {
        const duplicate = await clientRequestIdDedup.send.respondToDuplicate(sendClaim);
        sendJson(res, duplicate.status, duplicate.body);
        return;
      }
      try {
        const result = await dispatcher.dispatch(workspacePath, op);
        if (result.status === 409) noteReject("workspaceNotOpen");
        if (result.status === 503) noteReject("unavailable");
        if (result.status >= 200 && result.status < 300 && !wasOwned) {
          taskWorkspaceByTaskId.set(taskId, workspacePath);
        }
        sendClaim.settle(result);
        sendJson(res, result.status, result.body);
      } catch {
        sendClaim.settle({ status: 503, body: { error: "unavailable_host" } });
        noteReject("unavailable");
        sendJson(res, 503, { error: "unavailable_host" });
      }
      return;
    }
    await dispatchOp(
      res,
      workspacePath,
      op,
      wasOwned ? undefined : { rememberTask: { taskId, workspacePath } },
    );
  }

  async function handleRequest(
    req: IncomingMessage,
    res: ServerResponse,
    port_: number,
  ): Promise<void> {
    try {
      const method = req.method ?? "";
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${port_}`);
      if (method !== "GET" && method !== "POST") {
        res.writeHead(405, { "content-type": "application/json", allow: "GET, POST" });
        res.end(JSON.stringify({ error: "method_not_allowed" }));
        return;
      }
      if (method === "GET") {
        await handleGet(req, res, url);
        return;
      }
      await handlePost(req, res, url);
    } catch {
      deps.logger.warn("[local-task-api] request handler error");
      // 兜底：不给 loopback 客户端泄漏错误细节。
      if (!res.headersSent) {
        sendJson(res, 500, { error: "internal_error" });
      } else {
        res.destroy();
      }
    }
  }

  const server = createServer((req, res) => {
    void handleRequest(req, res, port);
  });

  return await new Promise<Server | null>((resolve) => {
    server.once("error", (error) => {
      deps.logger.warn(`[local-task-api] listen on 127.0.0.1:${port} failed: ${String(error)}`);
      resolve(null);
    });
    server.listen(port, "127.0.0.1", () => {
      deps.logger.info(`[local-task-api] listening on 127.0.0.1:${port}`);
      resolve(server);
    });
  });
}

let registeredDispatcher: ReturnType<typeof createLocalTaskApiDispatcher> | null = null;

export function setLocalTaskApiDispatcher(
  d: ReturnType<typeof createLocalTaskApiDispatcher> | null,
): void {
  registeredDispatcher = d;
}

export function resolveLocalTaskApiResponse(message: {
  requestId: string;
  ok: boolean;
  status: number;
  body: unknown;
}): void {
  registeredDispatcher?.resolveLocalTaskApiResponse(message);
}

/** Host 进程退出时由 desktopHostProcess 调：立即结清该 Host 的在飞请求，不等 300s 兜底。 */
export function settleLocalTaskApiRequestsForHost(host: unknown): void {
  registeredDispatcher?.settleRequestsForHost(host);
}

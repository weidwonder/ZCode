/* 本机任务 API：Main 进程内全应用唯一的 loopback HTTP 监听。Main 只承载
 * 传输与鉴权（Host 头、Bearer token、Content-Type、大小上限）与 workspace→Host
 * 路由；任务业务与事件缓冲都在窗口 Host 侧。本文件不 import electron，
 * 依赖全部注入以便单测。 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getAppConfigDir } from "@zcode/services/node";
import { HostMessageTypes, type LocalTaskApiRequestOp } from "@zcode/shared";

export const LOCAL_TASK_API_CONFIG_FILE = "local-task-api.json";
/** POST body 上限：16 MiB，超出回 413。 */
const MAX_BODY_BYTES = 16 * 1024 * 1024;
/** 开关文件 token 最短长度。 */
const MIN_TOKEN_CHARS = 32;
/** dispatcher 兜底超时（events 的 waitMs 上限 30s 远小于此）。 */
const DISPATCH_TIMEOUT_MS = 300_000;

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
  timeoutMs?: number;
}

interface PendingLocalTaskApiRequest {
  resolve: (result: { status: number; body: unknown }) => void;
  timer: ReturnType<typeof setTimeout>;
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
    const host = deps.resolveHost(workspacePath);
    if (!host) {
      return { status: 409, body: { error: "workspace_not_open" } };
    }
    const requestId = randomUUID();
    return await new Promise<{ status: number; body: unknown }>((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        resolve({ status: 503, body: { error: "unavailable_host" } });
      }, timeoutMs);
      // 不靠这条兜底定时器维持进程存活；窗口 Host 应答/断开自有其它存活来源。
      timer.unref?.();
      pending.set(requestId, { resolve, timer });
      try {
        host.postMessage({ type: HostMessageTypes.LocalTaskApiRequest, requestId, op });
      } catch {
        pending.delete(requestId);
        clearTimeout(timer);
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
      settle(message.requestId, {
        status: 503,
        body: message.body ?? { error: "unavailable_host" },
      });
    }
  }

  return { dispatch, resolveLocalTaskApiResponse };
}

export interface LocalTaskApiDeps {
  readConfig?: () => Promise<LocalTaskApiConfig | null | "invalid">;
  resolveHost: (workspacePath: string) => { postMessage: (message: unknown) => void } | null;
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
  const dispatcher = createLocalTaskApiDispatcher({ resolveHost: deps.resolveHost });
  setLocalTaskApiDispatcher(dispatcher);

  const taskWorkspaceByTaskId = new Map<string, string>();
  // 拒绝计数：仅内存聚合，供未来暴露；本版不输出，避免逐请求日志泄漏路径或内容。
  const rejected = {
    unauthorized: 0,
    hostForbidden: 0,
    unsupportedMedia: 0,
    tooLarge: 0,
    workspaceNotOpen: 0,
    taskNotFound: 0,
    unavailable: 0,
  };

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

  function sendJson(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  }

  type BodyReadResult = { ok: true; text: string } | { ok: false; tooLarge: boolean };

  function readRequestBody(req: IncomingMessage): Promise<BodyReadResult> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      let total = 0;
      let settled = false;
      const finish = (result: BodyReadResult) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      req.on("data", (chunk: Buffer) => {
        if (settled) return;
        total += chunk.length;
        if (total > MAX_BODY_BYTES) {
          finish({ ok: false, tooLarge: true });
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => finish({ ok: true, text: Buffer.concat(chunks).toString("utf8") }));
      req.on("error", () => finish({ ok: false, tooLarge: false }));
    });
  }

  function hasDeclaredBody(req: IncomingMessage): boolean {
    const contentLength = req.headers["content-length"];
    if (contentLength !== undefined && Number(contentLength) > 0) return true;
    return req.headers["transfer-encoding"] !== undefined;
  }

  function parseAfter(raw: string | null): number {
    if (raw === null || raw === "") return 0;
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < 0) return 0;
    return parsed;
  }

  function parseWaitMs(raw: string | null): number {
    const parsed = Number(raw ?? "0");
    const base = Number.isFinite(parsed) ? parsed : 0;
    return Math.min(30_000, Math.max(0, Math.trunc(base)));
  }

  function parsePathSegments(pathname: string): string[] | null {
    const segments: string[] = [];
    for (const segment of pathname.split("/")) {
      if (segment.length === 0) continue;
      try {
        segments.push(decodeURIComponent(segment));
      } catch {
        return null;
      }
    }
    return segments;
  }

  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
  }

  function segmentAt(segments: string[], index: number): string | null {
    const value = segments[index];
    return typeof value === "string" && value.length > 0 ? value : null;
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
    rejected.taskNotFound += 1;
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
        rejected.workspaceNotOpen += 1;
      }
      // Host 校验通过（2xx）才回填：外部提供的 workspacePath 从此成为权威归属。
      if (options?.rememberTask && result.status >= 200 && result.status < 300) {
        taskWorkspaceByTaskId.set(options.rememberTask.taskId, options.rememberTask.workspacePath);
      }
      sendJson(res, result.status, result.body);
    } catch {
      rejected.unavailable += 1;
      sendJson(res, 503, { error: "unavailable_host" });
    }
  }

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

    if (segments.length === 2 && segments[0] === "api" && segments[1] === "tasks") {
      if (!isAllowedHostHeader(req)) {
        rejected.hostForbidden += 1;
        sendJson(res, 403, { error: "host_header_forbidden" });
        return;
      }
      if (!isAuthorized(req)) {
        rejected.unauthorized += 1;
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
        rejected.hostForbidden += 1;
        sendJson(res, 403, { error: "host_header_forbidden" });
        return;
      }
      if (!isAuthorized(req)) {
        rejected.unauthorized += 1;
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
        rejected.hostForbidden += 1;
        sendJson(res, 403, { error: "host_header_forbidden" });
        return;
      }
      if (!isAuthorized(req)) {
        rejected.unauthorized += 1;
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
    if (!isCreate && !isSend && !isStop) {
      sendJson(res, 404, { error: "not_found" });
      return;
    }

    // 统一顺序：Host 头校验 → 鉴权 → Content-Type → body。
    if (!isAllowedHostHeader(req)) {
      rejected.hostForbidden += 1;
      sendJson(res, 403, { error: "host_header_forbidden" });
      return;
    }
    if (!isAuthorized(req)) {
      rejected.unauthorized += 1;
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }
    const contentType = req.headers["content-type"];
    if (contentType !== undefined) {
      if (!contentType.toLowerCase().includes("application/json")) {
        rejected.unsupportedMedia += 1;
        sendJson(res, 415, { error: "unsupported_media_type" });
        return;
      }
    } else if (hasDeclaredBody(req)) {
      rejected.unsupportedMedia += 1;
      sendJson(res, 415, { error: "unsupported_media_type" });
      return;
    }
    const body = await readRequestBody(req);
    if (!body.ok) {
      if (body.tooLarge) {
        rejected.tooLarge += 1;
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
      if (
        typeof workspacePath !== "string" ||
        workspacePath.length === 0 ||
        typeof prompt !== "string" ||
        (mode !== undefined && typeof mode !== "string") ||
        (title !== undefined && typeof title !== "string")
      ) {
        sendJson(res, 400, { error: "bad_request" });
        return;
      }
      const op: LocalTaskApiRequestOp = {
        kind: "create",
        workspacePath,
        prompt,
        ...(typeof mode === "string" ? { mode } : {}),
        ...(typeof title === "string" ? { title } : {}),
      };
      const result = await dispatcher.dispatch(workspacePath, op);
      if (result.status === 409) {
        rejected.workspaceNotOpen += 1;
      }
      if (
        result.status === 201 &&
        isRecord(result.body) &&
        typeof result.body["taskId"] === "string"
      ) {
        taskWorkspaceByTaskId.set(result.body["taskId"], workspacePath);
      }
      sendJson(res, result.status, result.body);
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
    const workspacePath = resolveTaskWorkspace(res, taskId, providedWorkspace);
    if (workspacePath === null) return;
    const wasOwned = taskWorkspaceByTaskId.has(taskId);
    await dispatchOp(
      res,
      workspacePath,
      {
        kind: "send",
        workspacePath,
        taskId,
        text,
        delivery: delivery ?? "auto",
      },
      wasOwned ? undefined : { rememberTask: { taskId, workspacePath } },
    );
  }

  async function handleRequest(req: IncomingMessage, res: ServerResponse, port_: number): Promise<void> {
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

/* 本机 Webhook Bot 入站端点：Main 进程内全应用唯一的 loopback HTTP 监听。
 * Main 只承载传输层关注点（Host 头校验、body 上限、路由、health），bot 业务
 * 判定经 main→host 通道转发给窗口 Host 内的 IBotsService；本文件不 import
 * electron，dispatch 与配置读取全部注入，便于单测。 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getAppConfigDir } from "@zcode/services/node";
import { HostMessageTypes } from "@zcode/shared";

export const BOT_WEBHOOK_INGRESS_CONFIG_FILE = "bot-webhook-ingress.json";
/** POST body 上限：16 MiB，超出回 413。 */
const MAX_BODY_BYTES = 16 * 1024 * 1024;
/** dispatcher 兜底超时：Host 应答永不返回时防止 Main 侧 pending 泄漏。 */
const DISPATCH_TIMEOUT_MS = 300_000;

export interface BotWebhookIngressConfig {
  enabled: boolean;
  port: number;
}

/** 读开关文件：不存在或未启用返回 null（静默）；损坏或端口非法返回 "invalid"（调用方打 warn）。 */
export async function readBotWebhookIngressConfig(
  configDir: string = getAppConfigDir(),
): Promise<BotWebhookIngressConfig | null | "invalid"> {
  let text: string;
  try {
    text = await readFile(join(configDir, BOT_WEBHOOK_INGRESS_CONFIG_FILE), "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return "invalid";
  }
  if (typeof parsed !== "object" || parsed === null) {
    return "invalid";
  }
  const record = parsed as Record<string, unknown>;
  if (record["enabled"] !== true) {
    return null;
  }
  const port = record["port"];
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
    return "invalid";
  }
  return { enabled: true, port };
}

export interface BotWebhookIngressDispatchPayload {
  botId: string | null;
  rawBody: string;
  webhookSecret: string | null;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  // 只发 content-type；本端点不发任何 CORS 头（契约：纯服务间 loopback 通道）。
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function isAllowedHostHeader(hostHeader: string | undefined, port: number): boolean {
  if (!hostHeader) {
    return false;
  }
  const normalized = hostHeader.trim().toLowerCase();
  return normalized === `127.0.0.1:${port}` || normalized === `localhost:${port}`;
}

function readBodyWithLimit(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let rejected = false;
    req.on("data", (chunk: Buffer) => {
      if (rejected) {
        return;
      }
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        rejected = true;
        // 不在这里 destroy：先把 413 发回去，再由调用方在响应结束后断开连接。
        reject(new Error("payload_too_large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!rejected) {
        resolve(Buffer.concat(chunks).toString("utf8"));
      }
    });
    req.on("error", (error) => {
      if (!rejected) {
        reject(error);
      }
    });
  });
}

export interface BotWebhookIngressDeps {
  readConfig?: () => Promise<BotWebhookIngressConfig | null | "invalid">;
  dispatch: (payload: BotWebhookIngressDispatchPayload) => Promise<{ status: number; body: unknown }>;
  zcodeVersion: string;
  logger: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void };
}

/**
 * 创建本机入站监听。返回 null 表示未监听（未启用/配置无效/端口被占），
 * 调用方继续正常启动。同一应用进程只应调用一次（server 由调用方持有并在退出前关闭）。
 */
export async function createBotWebhookIngress(
  deps: BotWebhookIngressDeps,
): Promise<Server | null> {
  const readConfig = deps.readConfig ?? (() => readBotWebhookIngressConfig());
  const config = await readConfig();
  if (config === "invalid") {
    deps.logger.warn(
      `[bot-webhook-ingress] invalid ${BOT_WEBHOOK_INGRESS_CONFIG_FILE}; ingress disabled`,
    );
    return null;
  }
  if (!config || !config.enabled) {
    return null;
  }
  const { port } = config;

  const server = createServer((req, res) => {
    void handleIngressRequest(server, req, res, {
      port,
      dispatch: deps.dispatch,
      zcodeVersion: deps.zcodeVersion,
      logger: deps.logger,
    });
  });

  return await new Promise((resolve) => {
    server.once("error", (error) => {
      deps.logger.warn(
        `[bot-webhook-ingress] listen on 127.0.0.1:${port} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      resolve(null);
    });
    // 只绑 loopback：外网接口结构性不可达（安全不变量 Invariant 1）。
    server.listen(port, "127.0.0.1", () => {
      deps.logger.info(`[bot-webhook-ingress] listening on 127.0.0.1:${port}`);
      resolve(server);
    });
  });
}

async function handleIngressRequest(
  _server: Server,
  req: IncomingMessage,
  res: ServerResponse,
  context: {
    port: number;
    dispatch: BotWebhookIngressDeps["dispatch"];
    zcodeVersion: string;
    logger: BotWebhookIngressDeps["logger"];
  },
): Promise<void> {
  const { port, dispatch, zcodeVersion, logger } = context;
  const method = req.method ?? "";
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const path = url.pathname;

  if (method !== "GET" && method !== "POST") {
    res.writeHead(405, { "content-type": "application/json", allow: "GET, POST" });
    res.end(JSON.stringify({ error: "method_not_allowed" }));
    return;
  }

  if (method === "GET") {
    if (path === "/health") {
      sendJson(res, 200, {
        ok: true,
        ingress: "zcode-bot-webhook",
        version: 1,
        zcodeVersion,
      });
      return;
    }
    sendJson(res, 404, { error: "not_found" });
    return;
  }

  // POST：只接受 /api/bots/webhook 与 /api/bots/webhook/<botId>。
  let botId: string | null = null;
  if (path === "/api/bots/webhook") {
    botId = null;
  } else if (path.startsWith("/api/bots/webhook/")) {
    const tail = path.slice("/api/bots/webhook/".length);
    if (!tail || tail.includes("/")) {
      sendJson(res, 404, { error: "not_found" });
      return;
    }
    botId = tail;
  } else {
    sendJson(res, 404, { error: "not_found" });
    return;
  }

  // Host 头白名单在读取 body 之前校验（防 DNS rebinding；Invariant 3）。
  if (!isAllowedHostHeader(req.headers["host"], port)) {
    sendJson(res, 403, { error: "host_header_forbidden" });
    return;
  }

  let rawBody: string;
  try {
    rawBody = await readBodyWithLimit(req);
  } catch (error) {
    if (error instanceof Error && error.message === "payload_too_large") {
      sendJson(res, 413, { error: "payload_too_large" });
      // 413 落盘后断开连接，不再接收残余 body。
      res.once("finish", () => req.destroy());
      return;
    }
    logger.warn(
      `[bot-webhook-ingress] read body failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    sendJson(res, 400, { error: "bad_request" });
    return;
  }

  try {
    const result = await dispatch({
      botId,
      rawBody,
      webhookSecret:
        typeof req.headers["x-zcode-bot-secret"] === "string"
          ? (req.headers["x-zcode-bot-secret"] as string)
          : null,
    });
    sendJson(res, result.status, result.body);
  } catch {
    sendJson(res, 503, { error: "unavailable_host" });
  }
}

export interface BotWebhookIngressDispatcherDeps {
  /** 取任一存活窗口 Host（与 cron 派发同策略：任一本地 Host 都能处理 webhook 回调）。 */
  getHost: () => { postMessage: (message: unknown) => void } | null;
  timeoutMs?: number;
}

interface PendingDispatch {
  resolve: (result: { status: number; body: unknown }) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Main→Host 转发器：把 dispatch payload 经 postMessage（requestId 关联）发给窗口
 * Host，等待 HostResponseTypes.BotWebhookIngressResult 应答。应答回流由
 * desktopHostProcess 的消息路由调 resolveBotWebhookIngressResult。
 */
export function createBotWebhookIngressDispatcher(deps: BotWebhookIngressDispatcherDeps) {
  const pending = new Map<string, PendingDispatch>();
  const timeoutMs = deps.timeoutMs ?? DISPATCH_TIMEOUT_MS;

  const resolveBotWebhookIngressResult = (message: {
    requestId: string;
    ok: boolean;
    status: number;
    body: unknown;
  }): void => {
    const entry = pending.get(message.requestId);
    if (!entry) {
      return;
    }
    pending.delete(message.requestId);
    clearTimeout(entry.timer);
    if (message.ok) {
      entry.resolve({ status: message.status, body: message.body });
    } else {
      entry.resolve({ status: 503, body: message.body ?? { error: "unavailable_host" } });
    }
  };

  const dispatch = (payload: BotWebhookIngressDispatchPayload) =>
    new Promise<{ status: number; body: unknown }>((resolve) => {
      const host = deps.getHost();
      if (!host) {
        resolve({ status: 503, body: { error: "unavailable_host" } });
        return;
      }
      const requestId = randomUUID();
      const timer = setTimeout(() => {
        pending.delete(requestId);
        resolve({ status: 503, body: { error: "unavailable_host" } });
      }, timeoutMs);
      pending.set(requestId, { resolve, timer });
      try {
        host.postMessage({
          type: HostMessageTypes.BotWebhookIngressDispatch,
          requestId,
          ...payload,
        });
      } catch {
        pending.delete(requestId);
        clearTimeout(timer);
        resolve({ status: 503, body: { error: "unavailable_host" } });
      }
    });

  return { dispatch, resolveBotWebhookIngressResult };
}

/* dispatcher 的模块级注册：desktopHostProcess 的消息路由按 HostResponseTypes.
 * BotWebhookIngressResult 调 resolveBotWebhookIngressResult，main 在 whenReady 内
 * 创建 dispatcher 并注册一次（与 resolveHostResourceUsageResult 的回流形态一致）。 */
let registeredDispatcher: ReturnType<typeof createBotWebhookIngressDispatcher> | null = null;

export function setBotWebhookIngressDispatcher(
  dispatcher: ReturnType<typeof createBotWebhookIngressDispatcher> | null,
): void {
  registeredDispatcher = dispatcher;
}

export function resolveBotWebhookIngressResult(message: {
  requestId: string;
  ok: boolean;
  status: number;
  body: unknown;
}): void {
  registeredDispatcher?.resolveBotWebhookIngressResult(message);
}
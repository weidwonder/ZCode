import { afterAll, describe, expect, it, vi } from "vitest";
import { request as clientRequest } from "node:http";
import {
  createServer as createHttpServer,
  type AddressInfo,
  type IncomingHttpHeaders,
  type Server,
} from "node:http";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LOCAL_TASK_API_CONFIG_FILE,
  createLocalTaskApi,
  createLocalTaskApiDispatcher,
  readLocalTaskApiConfig,
  resolveLocalTaskApiResponse,
  setLocalTaskApiDispatcher,
  type LocalTaskApiConfig,
} from "../src/main/localTaskApi.js";
import type { HostLocalTaskApiRequestMessage } from "@zcode/shared";

const TOKEN = "a".repeat(40);
const BEARER = `Bearer ${TOKEN}`;
const OPEN_WS = "/ws/open";
const ZCODE_VERSION = "9.9.9-test";

const closeLater: Array<() => Promise<void>> = [];
const tempDirs: string[] = [];

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn() };
}

async function reservePort(): Promise<number> {
  const server = createHttpServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function capturingResolveHost(captured: HostLocalTaskApiRequestMessage[]) {
  return (workspacePath: string) => {
    if (workspacePath !== OPEN_WS) return null;
    return {
      postMessage: (message: unknown) => {
        captured.push(message as HostLocalTaskApiRequestMessage);
      },
    };
  };
}

/** 同上，但放行一组 workspace（归属表未命中时按 provided workspacePath 路由的用例需要）。 */
function capturingResolveHostFor(workspaces: string[], captured: HostLocalTaskApiRequestMessage[]) {
  return (workspacePath: string) => {
    if (!workspaces.includes(workspacePath)) return null;
    return {
      postMessage: (message: unknown) => {
        captured.push(message as HostLocalTaskApiRequestMessage);
      },
    };
  };
}

async function startServer(
  overrides: {
    readConfig?: () => Promise<LocalTaskApiConfig | null | "invalid">;
    resolveHost?: (workspacePath: string) => { postMessage: (message: unknown) => void } | null;
  } = {},
): Promise<{ port: number; logger: ReturnType<typeof makeLogger>; server: Server | null }> {
  const port = await reservePort();
  const logger = makeLogger();
  const server = await createLocalTaskApi({
    readConfig: overrides.readConfig ?? (async () => ({ enabled: true, port, token: TOKEN })),
    resolveHost: overrides.resolveHost ?? (() => null),
    zcodeVersion: ZCODE_VERSION,
    logger,
  });
  if (server) {
    closeLater.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  }
  return { port, logger, server };
}

interface SendResult {
  status: number;
  headers: IncomingHttpHeaders;
  text: string;
}

/** 用 http.request 而不是 fetch：Host 头与缺省头行为必须可控。响应一旦见到就不再因
 * 连接被服务端提前销毁而失败（413 场景服务端会在 flush 后 destroy 请求流）。 */
function send(
  params: { port: number; method?: string; path: string; headers?: Record<string, string> },
  body?: string | Buffer,
): Promise<SendResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let sawResponse = false;
    let seenStatus = 0;
    const req = clientRequest(
      {
        host: "127.0.0.1",
        port: params.port,
        method: params.method ?? "GET",
        path: params.path,
        headers: params.headers,
      },
      (res) => {
        sawResponse = true;
        seenStatus = res.statusCode ?? 0;
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          settled = true;
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            text: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    req.on("error", (error) => {
      if (settled) return;
      // 响应头已到（服务端主动断连收尾）时按已收到的内容收口，不让 RST 吞掉断言。
      if (sawResponse) {
        settled = true;
        resolve({ status: seenStatus, headers: {}, text: `connection reset: ${String(error)}` });
        return;
      }
      reject(error);
    });
    if (body !== undefined) req.write(body);
    req.end();
  });
}

async function waitForCaptured(
  captured: HostLocalTaskApiRequestMessage[],
  count: number,
): Promise<void> {
  const deadline = Date.now() + 2000;
  while (captured.length < count) {
    if (Date.now() > deadline) {
      throw new Error(`timeout waiting for ${count} captured messages, got ${captured.length}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const CREATE_BODY = JSON.stringify({ workspacePath: OPEN_WS, prompt: "hello" });

afterAll(async () => {
  setLocalTaskApiDispatcher(null);
  for (const close of closeLater) {
    await close();
  }
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("localTaskApi", () => {
  it("GET /health 返回 200 与版本信息（契约豁免，不做 Host 头校验与鉴权）", async () => {
    const { port } = await startServer();
    const res = await send({ port, path: "/health" });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.text)).toEqual({
      ok: true,
      api: "zcode-local-task-api",
      version: 2,
      zcodeVersion: ZCODE_VERSION,
    });
  });

  it("Host 头非法的 POST /api/tasks → 403，且 resolveHost 未被调用", async () => {
    const resolveHost = vi.fn(() => null);
    const { port } = await startServer({ resolveHost });
    const res = await send(
      {
        port,
        method: "POST",
        path: "/api/tasks",
        headers: { host: "evil.example.com", "content-type": "application/json" },
      },
      CREATE_BODY,
    );
    expect(res.status).toBe(403);
    expect(JSON.parse(res.text)).toEqual({ error: "host_header_forbidden" });
    expect(resolveHost).not.toHaveBeenCalled();
  });

  it("鉴权：无 Authorization → 401；错误 token → 401；正确 token 放行到 dispatch", async () => {
    const captured: HostLocalTaskApiRequestMessage[] = [];
    const { port } = await startServer({ resolveHost: capturingResolveHost(captured) });

    const noAuth = await send(
      { port, method: "POST", path: "/api/tasks", headers: { "content-type": "application/json" } },
      CREATE_BODY,
    );
    expect(noAuth.status).toBe(401);
    expect(JSON.parse(noAuth.text)).toEqual({ error: "unauthorized" });

    const badAuth = await send(
      {
        port,
        method: "POST",
        path: "/api/tasks",
        headers: { authorization: "Bearer wrong", "content-type": "application/json" },
      },
      CREATE_BODY,
    );
    expect(badAuth.status).toBe(401);

    const okAuth = send(
      {
        port,
        method: "POST",
        path: "/api/tasks",
        headers: { authorization: BEARER, "content-type": "application/json" },
      },
      CREATE_BODY,
    );
    await waitForCaptured(captured, 1);
    resolveLocalTaskApiResponse({ requestId: captured[0].requestId, ok: true, status: 200, body: { ok: true } });
    expect((await okAuth).status).toBe(200);
  });

  it("开关三态：缺失/未启用静默返回 null 无 warn，invalid 返回 null 且 warn", async () => {
    const port = await reservePort();
    const loggerNull = makeLogger();
    expect(
      await createLocalTaskApi({
        readConfig: async () => null,
        resolveHost: () => null,
        zcodeVersion: ZCODE_VERSION,
        logger: loggerNull,
      }),
    ).toBeNull();
    expect(loggerNull.warn).not.toHaveBeenCalled();

    const loggerDisabled = makeLogger();
    expect(
      await createLocalTaskApi({
        readConfig: async () => ({ enabled: false, port, token: TOKEN }),
        resolveHost: () => null,
        zcodeVersion: ZCODE_VERSION,
        logger: loggerDisabled,
      }),
    ).toBeNull();
    expect(loggerDisabled.warn).not.toHaveBeenCalled();

    const loggerInvalid = makeLogger();
    expect(
      await createLocalTaskApi({
        readConfig: async () => "invalid",
        resolveHost: () => null,
        zcodeVersion: ZCODE_VERSION,
        logger: loggerInvalid,
      }),
    ).toBeNull();
    expect(loggerInvalid.warn).toHaveBeenCalledTimes(1);
    expect(loggerInvalid.warn).toHaveBeenCalledWith(
      "[local-task-api] invalid local-task-api.json; api disabled",
    );
  });

  it("readLocalTaskApiConfig 专项：缺失/损坏/未启用/端口非法/token 过短/合法 各分支", async () => {
    const root = await mkdtemp(join(tmpdir(), "local-task-api-cfg-"));
    tempDirs.push(root);
    const configPath = join(root, LOCAL_TASK_API_CONFIG_FILE);
    const writeCfg = async (content: unknown) => {
      await writeFile(configPath, JSON.stringify(content), "utf8");
    };

    expect(await readLocalTaskApiConfig(root)).toBeNull();

    await writeFile(configPath, "{not json", "utf8");
    expect(await readLocalTaskApiConfig(root)).toBe("invalid");

    await writeCfg({ enabled: false, port: 45678, token: TOKEN });
    expect(await readLocalTaskApiConfig(root)).toBeNull();

    await writeCfg({ enabled: true, port: 0, token: TOKEN });
    expect(await readLocalTaskApiConfig(root)).toBe("invalid");

    await writeCfg({ enabled: true, port: 45678, token: "a".repeat(31) });
    expect(await readLocalTaskApiConfig(root)).toBe("invalid");

    await writeCfg({ enabled: true, port: 45678, token: TOKEN });
    expect(await readLocalTaskApiConfig(root)).toEqual({
      enabled: true,
      port: 45678,
      token: TOKEN,
    });
  });

  it("Content-Type：缺头有 body → 415；text/plain → 415；application/json 放行", async () => {
    const captured: HostLocalTaskApiRequestMessage[] = [];
    const { port } = await startServer({ resolveHost: capturingResolveHost(captured) });

    const noType = await send(
      { port, method: "POST", path: "/api/tasks", headers: { authorization: BEARER } },
      CREATE_BODY,
    );
    expect(noType.status).toBe(415);
    expect(JSON.parse(noType.text)).toEqual({ error: "unsupported_media_type" });

    const textPlain = await send(
      {
        port,
        method: "POST",
        path: "/api/tasks",
        headers: { authorization: BEARER, "content-type": "text/plain" },
      },
      "hello",
    );
    expect(textPlain.status).toBe(415);

    const ok = send(
      {
        port,
        method: "POST",
        path: "/api/tasks",
        headers: { authorization: BEARER, "content-type": "application/json" },
      },
      CREATE_BODY,
    );
    await waitForCaptured(captured, 1);
    resolveLocalTaskApiResponse({ requestId: captured[0].requestId, ok: true, status: 200, body: { ok: true } });
    expect((await ok).status).toBe(200);
  });

  it("body 超过 16 MiB → 413", async () => {
    const { port } = await startServer();
    const big = Buffer.alloc(16 * 1024 * 1024 + 8, 0x61);
    const res = await send(
      {
        port,
        method: "POST",
        path: "/api/tasks",
        headers: { authorization: BEARER, "content-type": "application/json" },
      },
      big,
    );
    expect(res.status).toBe(413);
    expect(JSON.parse(res.text)).toEqual({ error: "payload_too_large" });
  });

  it("DELETE /health → 405 且带 allow: GET, POST；GET /nope → 404", async () => {
    const { port } = await startServer();
    const deleted = await send({ port, method: "DELETE", path: "/health" });
    expect(deleted.status).toBe(405);
    expect(deleted.headers["allow"]).toBe("GET, POST");
    expect(JSON.parse(deleted.text)).toEqual({ error: "method_not_allowed" });

    const notFound = await send({ port, path: "/nope" });
    expect(notFound.status).toBe(404);
    expect(JSON.parse(notFound.text)).toEqual({ error: "not_found" });
  });

  it("create 流：postMessage 捕获 op 与 requestId，回流应答后 HTTP 透传 201", async () => {
    const captured: HostLocalTaskApiRequestMessage[] = [];
    const { port } = await startServer({ resolveHost: capturingResolveHost(captured) });

    const pending = send(
      {
        port,
        method: "POST",
        path: "/api/tasks",
        headers: { authorization: BEARER, "content-type": "application/json" },
      },
      JSON.stringify({ workspacePath: OPEN_WS, prompt: "do it", mode: "plan", title: "T" }),
    );
    await waitForCaptured(captured, 1);
    expect(captured[0].type).toBe("local-task-api-request");
    expect(captured[0].requestId.length).toBeGreaterThan(0);
    expect(captured[0].op).toEqual({
      kind: "create",
      workspacePath: OPEN_WS,
      prompt: "do it",
      mode: "plan",
      title: "T",
    });

    resolveLocalTaskApiResponse({
      requestId: captured[0].requestId,
      ok: true,
      status: 201,
      body: { taskId: "t1" },
    });
    const res = await pending;
    expect(res.status).toBe(201);
    expect(JSON.parse(res.text)).toEqual({ taskId: "t1" });
  });

  it("归属表：create 后 messages 按 workspacePath 路由；未知 taskId → 404", async () => {
    const captured: HostLocalTaskApiRequestMessage[] = [];
    const { port } = await startServer({ resolveHost: capturingResolveHost(captured) });

    const createP = send(
      {
        port,
        method: "POST",
        path: "/api/tasks",
        headers: { authorization: BEARER, "content-type": "application/json" },
      },
      CREATE_BODY,
    );
    await waitForCaptured(captured, 1);
    resolveLocalTaskApiResponse({
      requestId: captured[0].requestId,
      ok: true,
      status: 201,
      body: { taskId: "t1" },
    });
    expect((await createP).status).toBe(201);

    const sendP = send(
      {
        port,
        method: "POST",
        path: "/api/tasks/t1/messages",
        headers: { authorization: BEARER, "content-type": "application/json" },
      },
      JSON.stringify({ text: "hi" }),
    );
    await waitForCaptured(captured, 2);
    expect(captured[1].op).toEqual({
      kind: "send",
      workspacePath: OPEN_WS,
      taskId: "t1",
      text: "hi",
      delivery: "auto",
    });
    resolveLocalTaskApiResponse({
      requestId: captured[1].requestId,
      ok: true,
      status: 200,
      body: { ok: true },
    });
    expect((await sendP).status).toBe(200);

    const miss = await send(
      {
        port,
        method: "POST",
        path: "/api/tasks/unknown/messages",
        headers: { authorization: BEARER, "content-type": "application/json" },
      },
      JSON.stringify({ text: "x" }),
    );
    expect(miss.status).toBe(404);
    expect(JSON.parse(miss.text)).toEqual({ error: "task_not_found" });
  });

  it("workspace 无 Host → 409 workspace_not_open", async () => {
    const { port } = await startServer();
    const res = await send(
      {
        port,
        method: "POST",
        path: "/api/tasks",
        headers: { authorization: BEARER, "content-type": "application/json" },
      },
      JSON.stringify({ workspacePath: "/ws/closed", prompt: "p" }),
    );
    expect(res.status).toBe(409);
    expect(JSON.parse(res.text)).toEqual({ error: "workspace_not_open" });
  });

  it("dispatcher：Host 应答 ok:false → 503；超时未应答 → 503", async () => {
    const captured: HostLocalTaskApiRequestMessage[] = [];
    const failing = createLocalTaskApiDispatcher({
      resolveHost: () => ({
        postMessage: (message: unknown) => {
          captured.push(message as HostLocalTaskApiRequestMessage);
        },
      }),
    });
    const pending = failing.dispatch(OPEN_WS, { kind: "list", workspacePath: OPEN_WS });
    await waitForCaptured(captured, 1);
    failing.resolveLocalTaskApiResponse({
      requestId: captured[0].requestId,
      ok: false,
      status: 500,
      body: { error: "host_boom" },
    });
    expect(await pending).toEqual({ status: 503, body: { error: "host_boom" } });

    const timingOut = createLocalTaskApiDispatcher({
      resolveHost: () => ({ postMessage: () => {} }),
      timeoutMs: 20,
    });
    const timedOut = await timingOut.dispatch(OPEN_WS, { kind: "list", workspacePath: OPEN_WS });
    expect(timedOut).toEqual({ status: 503, body: { error: "unavailable_host" } });
  });

  it("events 参数：after 非法取 0、waitMs clamp 到 30000；缺省 after=0 waitMs=0", async () => {
    const captured: HostLocalTaskApiRequestMessage[] = [];
    const { port } = await startServer({ resolveHost: capturingResolveHost(captured) });

    const createP = send(
      {
        port,
        method: "POST",
        path: "/api/tasks",
        headers: { authorization: BEARER, "content-type": "application/json" },
      },
      CREATE_BODY,
    );
    await waitForCaptured(captured, 1);
    resolveLocalTaskApiResponse({
      requestId: captured[0].requestId,
      ok: true,
      status: 201,
      body: { taskId: "t1" },
    });
    await createP;

    const weird = send({
      port,
      path: "/api/tasks/t1/events?after=abc&waitMs=99999",
      headers: { authorization: BEARER },
    });
    await waitForCaptured(captured, 2);
    expect(captured[1].op).toEqual({
      kind: "events",
      workspacePath: OPEN_WS,
      taskId: "t1",
      after: 0,
      waitMs: 30000,
    });
    resolveLocalTaskApiResponse({
      requestId: captured[1].requestId,
      ok: true,
      status: 200,
      body: { events: [] },
    });
    expect((await weird).status).toBe(200);

    const defaults = send({
      port,
      path: "/api/tasks/t1/events",
      headers: { authorization: BEARER },
    });
    await waitForCaptured(captured, 3);
    expect(captured[2].op).toEqual({
      kind: "events",
      workspacePath: OPEN_WS,
      taskId: "t1",
      after: 0,
      waitMs: 0,
    });
    resolveLocalTaskApiResponse({
      requestId: captured[2].requestId,
      ok: true,
      status: 200,
      body: { events: [] },
    });
    expect((await defaults).status).toBe(200);
  });

  it("GET /api/tasks?workspacePath=… → list op；workspacePath 缺失 → 400", async () => {
    const captured: HostLocalTaskApiRequestMessage[] = [];
    const { port } = await startServer({ resolveHost: capturingResolveHost(captured) });

    const pending = send({
      port,
      path: `/api/tasks?workspacePath=${encodeURIComponent(OPEN_WS)}`,
      headers: { authorization: BEARER },
    });
    await waitForCaptured(captured, 1);
    expect(captured[0].op).toEqual({ kind: "list", workspacePath: OPEN_WS });
    resolveLocalTaskApiResponse({
      requestId: captured[0].requestId,
      ok: true,
      status: 200,
      body: { tasks: [] },
    });
    expect((await pending).status).toBe(200);

    const missing = await send({ port, path: "/api/tasks", headers: { authorization: BEARER } });
    expect(missing.status).toBe(400);
    expect(JSON.parse(missing.text)).toEqual({ error: "bad_request" });
  });

  it("stop：无 body 无 content-type 放行，应答 202 透传", async () => {
    const captured: HostLocalTaskApiRequestMessage[] = [];
    const { port } = await startServer({ resolveHost: capturingResolveHost(captured) });

    const createP = send(
      {
        port,
        method: "POST",
        path: "/api/tasks",
        headers: { authorization: BEARER, "content-type": "application/json" },
      },
      CREATE_BODY,
    );
    await waitForCaptured(captured, 1);
    resolveLocalTaskApiResponse({
      requestId: captured[0].requestId,
      ok: true,
      status: 201,
      body: { taskId: "t1" },
    });
    await createP;

    const stopP = send({
      port,
      method: "POST",
      path: "/api/tasks/t1/stop",
      headers: { authorization: BEARER },
    });
    await waitForCaptured(captured, 2);
    expect(captured[1].op).toEqual({ kind: "stop", workspacePath: OPEN_WS, taskId: "t1" });
    resolveLocalTaskApiResponse({
      requestId: captured[1].requestId,
      ok: true,
      status: 202,
      body: { ok: true },
    });
    const res = await stopP;
    expect(res.status).toBe(202);
    expect(JSON.parse(res.text)).toEqual({ ok: true });
  });

  it("重启后归属表为空：messages 带 workspacePath 路由成功并回填，后续 stop 不带也能路由", async () => {
    const captured: HostLocalTaskApiRequestMessage[] = [];
    const { port } = await startServer({
      resolveHost: capturingResolveHostFor([OPEN_WS, "/w/old"], captured),
    });

    const sendP = send(
      {
        port,
        method: "POST",
        path: "/api/tasks/t-old/messages",
        headers: { authorization: BEARER, "content-type": "application/json" },
      },
      JSON.stringify({ text: "hi", workspacePath: "/w/old" }),
    );
    await waitForCaptured(captured, 1);
    expect(captured[0].op).toEqual({
      kind: "send",
      workspacePath: "/w/old",
      taskId: "t-old",
      text: "hi",
      delivery: "auto",
    });
    resolveLocalTaskApiResponse({
      requestId: captured[0].requestId,
      ok: true,
      status: 202,
      body: { delivery: "queued", commandId: "c1" },
    });
    const first = await sendP;
    expect(first.status).toBe(202);
    expect(JSON.parse(first.text)).toEqual({ delivery: "queued", commandId: "c1" });

    // 回填生效：同一 server 再发 stop（不带 workspacePath）仍路由到 /w/old。
    const stopP = send({
      port,
      method: "POST",
      path: "/api/tasks/t-old/stop",
      headers: { authorization: BEARER },
    });
    await waitForCaptured(captured, 2);
    expect(captured[1].op).toEqual({ kind: "stop", workspacePath: "/w/old", taskId: "t-old" });
    resolveLocalTaskApiResponse({
      requestId: captured[1].requestId,
      ok: true,
      status: 202,
      body: { ok: true },
    });
    expect((await stopP).status).toBe(202);
  });

  it("带错 workspacePath：Host 回 404 透传且不回填，后续不带 workspacePath 仍 404", async () => {
    const captured: HostLocalTaskApiRequestMessage[] = [];
    const { port } = await startServer({
      resolveHost: capturingResolveHostFor([OPEN_WS, "/w/wrong"], captured),
    });

    const sendP = send(
      {
        port,
        method: "POST",
        path: "/api/tasks/t-x/messages",
        headers: { authorization: BEARER, "content-type": "application/json" },
      },
      JSON.stringify({ text: "x", workspacePath: "/w/wrong" }),
    );
    await waitForCaptured(captured, 1);
    resolveLocalTaskApiResponse({
      requestId: captured[0].requestId,
      ok: true,
      status: 404,
      body: { error: "task_not_found" },
    });
    const first = await sendP;
    expect(first.status).toBe(404);
    expect(JSON.parse(first.text)).toEqual({ error: "task_not_found" });

    const again = await send(
      {
        port,
        method: "POST",
        path: "/api/tasks/t-x/messages",
        headers: { authorization: BEARER, "content-type": "application/json" },
      },
      JSON.stringify({ text: "x" }),
    );
    expect(again.status).toBe(404);
    expect(JSON.parse(again.text)).toEqual({ error: "task_not_found" });
    expect(captured).toHaveLength(1); // 未回填：第二次没有 dispatch
  });

  it("GET events 接受 ?workspacePath= 并回填，后续 get 不带也能路由", async () => {
    const captured: HostLocalTaskApiRequestMessage[] = [];
    const { port } = await startServer({
      resolveHost: capturingResolveHostFor([OPEN_WS, "/w/e"], captured),
    });

    const eventsP = send({
      port,
      path: `/api/tasks/t-e/events?workspacePath=${encodeURIComponent("/w/e")}&after=0&waitMs=0`,
      headers: { authorization: BEARER },
    });
    await waitForCaptured(captured, 1);
    expect(captured[0].op).toEqual({
      kind: "events",
      workspacePath: "/w/e",
      taskId: "t-e",
      after: 0,
      waitMs: 0,
    });
    resolveLocalTaskApiResponse({
      requestId: captured[0].requestId,
      ok: true,
      status: 200,
      body: { events: [], nextSeq: 0 },
    });
    expect((await eventsP).status).toBe(200);

    // 回填生效：不带 workspacePath 的 get 也按 /w/e 路由。
    const getP = send({ port, path: "/api/tasks/t-e", headers: { authorization: BEARER } });
    await waitForCaptured(captured, 2);
    expect(captured[1].op).toEqual({ kind: "get", workspacePath: "/w/e", taskId: "t-e" });
    resolveLocalTaskApiResponse({
      requestId: captured[1].requestId,
      ok: true,
      status: 200,
      body: { taskId: "t-e" },
    });
    expect((await getP).status).toBe(200);
  });

  it("stop：空 body 且表未命中 → 404；带 workspacePath body → 路由到该 workspace", async () => {
    const captured: HostLocalTaskApiRequestMessage[] = [];
    const { port } = await startServer({
      resolveHost: capturingResolveHostFor([OPEN_WS, "/w/s"], captured),
    });

    const empty = await send({
      port,
      method: "POST",
      path: "/api/tasks/t-s/stop",
      headers: { authorization: BEARER },
    });
    expect(empty.status).toBe(404);
    expect(JSON.parse(empty.text)).toEqual({ error: "task_not_found" });

    const stopP = send(
      {
        port,
        method: "POST",
        path: "/api/tasks/t-s/stop",
        headers: { authorization: BEARER, "content-type": "application/json" },
      },
      JSON.stringify({ workspacePath: "/w/s" }),
    );
    await waitForCaptured(captured, 1);
    expect(captured[0].op).toEqual({ kind: "stop", workspacePath: "/w/s", taskId: "t-s" });
    resolveLocalTaskApiResponse({
      requestId: captured[0].requestId,
      ok: true,
      status: 202,
      body: { ok: true },
    });
    expect((await stopP).status).toBe(202);
  });

  it("响应不带 CORS 头", async () => {
    const { port } = await startServer();
    const res = await send({ port, path: "/health" });
    expect(res.status).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("端口被占 → resolve null 不抛", async () => {
    const blocker = createHttpServer((_req, res) => {
      res.end("occupied");
    });
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
    const port = (blocker.address() as AddressInfo).port;
    try {
      const logger = makeLogger();
      const server = await createLocalTaskApi({
        readConfig: async () => ({ enabled: true, port, token: TOKEN }),
        resolveHost: () => null,
        zcodeVersion: ZCODE_VERSION,
        logger,
      });
      expect(server).toBeNull();
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(String(logger.warn.mock.calls[0]?.[0])).toContain("listen on 127.0.0.1");
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });

  it("create 成功打 info 日志，只含 taskId 不含 workspacePath 与 prompt", async () => {
    const captured: HostLocalTaskApiRequestMessage[] = [];
    const { port, logger } = await startServer({ resolveHost: capturingResolveHost(captured) });

    const createP = send(
      {
        port,
        method: "POST",
        path: "/api/tasks",
        headers: { authorization: BEARER, "content-type": "application/json" },
      },
      CREATE_BODY,
    );
    await waitForCaptured(captured, 1);
    resolveLocalTaskApiResponse({
      requestId: captured[0].requestId,
      ok: true,
      status: 201,
      body: { taskId: "t-log" },
    });
    expect((await createP).status).toBe(201);

    const createdCall = logger.info.mock.calls.find((call) =>
      String(call[0]).includes("created task="),
    );
    expect(createdCall).toBeDefined();
    expect(String(createdCall?.[0])).toBe("[local-task-api] created task=t-log");
  });

  it("dispatcher：Host 应答 ok:false → 503 且 logger.warn 打 dispatch failed（host_error）", async () => {
    const captured: HostLocalTaskApiRequestMessage[] = [];
    const warn = vi.fn();
    const failing = createLocalTaskApiDispatcher({
      resolveHost: () => ({
        postMessage: (message: unknown) => {
          captured.push(message as HostLocalTaskApiRequestMessage);
        },
      }),
      logger: { warn },
    });
    const pending = failing.dispatch(OPEN_WS, { kind: "list", workspacePath: OPEN_WS });
    await waitForCaptured(captured, 1);
    failing.resolveLocalTaskApiResponse({
      requestId: captured[0].requestId,
      ok: false,
      status: 500,
      body: { error: "host_boom" },
    });
    expect(await pending).toEqual({ status: 503, body: { error: "host_boom" } });
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0]?.[0]);
    expect(line).toContain("dispatch failed");
    expect(line).toContain(`request=${captured[0].requestId}`);
    expect(line).toContain("reason=host_error");
  });

  it("401 拒绝后 logger.warn 打 rejected unauthorized（键名+计数，不含路径）", async () => {
    const { port, logger } = await startServer();
    const res = await send(
      { port, method: "POST", path: "/api/tasks", headers: { "content-type": "application/json" } },
      CREATE_BODY,
    );
    expect(res.status).toBe(401);
    const rejectedCall = logger.warn.mock.calls.find((call) =>
      String(call[0]).includes("rejected unauthorized"),
    );
    expect(rejectedCall).toBeDefined();
    expect(String(rejectedCall?.[0])).toBe("[local-task-api] rejected unauthorized count=1");
    expect(String(rejectedCall?.[0])).not.toContain("/api/tasks");
  });

  it("mode 校验：非法值与空串 → 400 不 dispatch；合法 plan 放行", async () => {
    const captured: HostLocalTaskApiRequestMessage[] = [];
    const { port } = await startServer({ resolveHost: capturingResolveHost(captured) });
    const headers = { authorization: BEARER, "content-type": "application/json" };

    const bogus = await send(
      { port, method: "POST", path: "/api/tasks", headers },
      JSON.stringify({ workspacePath: OPEN_WS, prompt: "p", mode: "bogus" }),
    );
    expect(bogus.status).toBe(400);
    expect(JSON.parse(bogus.text)).toEqual({ error: "bad_request" });

    const empty = await send(
      { port, method: "POST", path: "/api/tasks", headers },
      JSON.stringify({ workspacePath: OPEN_WS, prompt: "p", mode: "" }),
    );
    expect(empty.status).toBe(400);
    expect(captured).toHaveLength(0); // 两个 400 都未触达 Host

    const ok = send(
      { port, method: "POST", path: "/api/tasks", headers },
      JSON.stringify({ workspacePath: OPEN_WS, prompt: "p", mode: "plan" }),
    );
    await waitForCaptured(captured, 1);
    expect(captured[0].op).toEqual({
      kind: "create",
      workspacePath: OPEN_WS,
      prompt: "p",
      mode: "plan",
    });
    resolveLocalTaskApiResponse({
      requestId: captured[0].requestId,
      ok: true,
      status: 201,
      body: { taskId: "t-mode" },
    });
    expect((await ok).status).toBe(201);
  });

  it("clientRequestId：同 id 二次 create 命中幂等不再 dispatch；不同 id 正常；超长 400", async () => {
    const captured: HostLocalTaskApiRequestMessage[] = [];
    const { port, logger } = await startServer({ resolveHost: capturingResolveHost(captured) });
    const headers = { authorization: BEARER, "content-type": "application/json" };

    const first = send(
      { port, method: "POST", path: "/api/tasks", headers },
      JSON.stringify({ workspacePath: OPEN_WS, prompt: "p", clientRequestId: "cid-1" }),
    );
    await waitForCaptured(captured, 1);
    resolveLocalTaskApiResponse({
      requestId: captured[0].requestId,
      ok: true,
      status: 201,
      body: { taskId: "t-cid" },
    });
    expect((await first).status).toBe(201);

    const second = await send(
      { port, method: "POST", path: "/api/tasks", headers },
      JSON.stringify({ workspacePath: OPEN_WS, prompt: "p", clientRequestId: "cid-1" }),
    );
    expect(second.status).toBe(201);
    expect(JSON.parse(second.text)).toEqual({ taskId: "t-cid" });
    expect(captured).toHaveLength(1); // 幂等命中：未再 dispatch
    expect(
      logger.info.mock.calls.some((call) =>
        String(call[0]).includes("duplicate create request=cid-1 task=t-cid"),
      ),
    ).toBe(true);

    const third = send(
      { port, method: "POST", path: "/api/tasks", headers },
      JSON.stringify({ workspacePath: OPEN_WS, prompt: "p", clientRequestId: "cid-2" }),
    );
    await waitForCaptured(captured, 2);
    resolveLocalTaskApiResponse({
      requestId: captured[1].requestId,
      ok: true,
      status: 201,
      body: { taskId: "t-cid-2" },
    });
    expect((await third).status).toBe(201);

    const tooLong = await send(
      { port, method: "POST", path: "/api/tasks", headers },
      JSON.stringify({ workspacePath: OPEN_WS, prompt: "p", clientRequestId: "x".repeat(201) }),
    );
    expect(tooLong.status).toBe(400);
    expect(JSON.parse(tooLong.text)).toEqual({ error: "bad_request" });
  });

  it("clientRequestId 并发同 id：in-flight 共享同一应答，postMessage 只收到一次 create", async () => {
    const captured: HostLocalTaskApiRequestMessage[] = [];
    const { port, logger } = await startServer({ resolveHost: capturingResolveHost(captured) });
    const headers = { authorization: BEARER, "content-type": "application/json" };
    const body = JSON.stringify({
      workspacePath: OPEN_WS,
      prompt: "p",
      clientRequestId: "cid-conc",
    });

    const first = send({ port, method: "POST", path: "/api/tasks", headers }, body);
    const second = send({ port, method: "POST", path: "/api/tasks", headers }, body);
    // 回流前两个请求都已 in-flight：首个已 dispatch、次个已挂在共享 future 上。
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(captured).toHaveLength(1); // 只 dispatch 一次
    resolveLocalTaskApiResponse({
      requestId: captured[0].requestId,
      ok: true,
      status: 201,
      body: { taskId: "t-conc" },
    });
    const [resA, resB] = await Promise.all([first, second]);
    expect(resA.status).toBe(201);
    expect(resB.status).toBe(201);
    expect(JSON.parse(resA.text)).toEqual({ taskId: "t-conc" });
    expect(JSON.parse(resB.text)).toEqual({ taskId: "t-conc" });
    // 等待方也拿到 duplicate 日志，task 取共享应答里的 taskId（首个请求打 created task=）。
    expect(
      logger.info.mock.calls.filter((call) =>
        String(call[0]).includes("duplicate create request=cid-conc task=t-conc"),
      ),
    ).toHaveLength(1);
  });

  it("clientRequestId 失败不缓存：同 id 重发重新 dispatch，二次成功", async () => {
    const captured: HostLocalTaskApiRequestMessage[] = [];
    const { port } = await startServer({ resolveHost: capturingResolveHost(captured) });
    const headers = { authorization: BEARER, "content-type": "application/json" };
    const body = JSON.stringify({
      workspacePath: OPEN_WS,
      prompt: "p",
      clientRequestId: "cid-fail",
    });

    const first = send({ port, method: "POST", path: "/api/tasks", headers }, body);
    await waitForCaptured(captured, 1);
    resolveLocalTaskApiResponse({
      requestId: captured[0].requestId,
      ok: false,
      status: 503,
      body: { error: "unavailable_host" },
    });
    expect((await first).status).toBe(503);

    // 失败未缓存：同 id 重发重新 dispatch 而不是回旧应答。
    const second = send({ port, method: "POST", path: "/api/tasks", headers }, body);
    await waitForCaptured(captured, 2);
    resolveLocalTaskApiResponse({
      requestId: captured[1].requestId,
      ok: true,
      status: 201,
      body: { taskId: "t-retry" },
    });
    const retry = await second;
    expect(retry.status).toBe(201);
    expect(JSON.parse(retry.text)).toEqual({ taskId: "t-retry" });
  });

  it("开关文件 group/others 可读（0o644）→ warn 提醒 chmod 600", async () => {
    const root = await mkdtemp(join(tmpdir(), "local-task-api-perm-"));
    tempDirs.push(root);
    const configPath = join(root, LOCAL_TASK_API_CONFIG_FILE);
    const port = await reservePort();
    await writeFile(configPath, JSON.stringify({ enabled: true, port, token: TOKEN }), "utf8");
    await chmod(configPath, 0o644);

    const logger = makeLogger();
    const server = await createLocalTaskApi({
      readConfig: () => readLocalTaskApiConfig(root),
      configPath,
      resolveHost: () => null,
      zcodeVersion: ZCODE_VERSION,
      logger,
    });
    if (server) {
      closeLater.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    }
    const permCall = logger.warn.mock.calls.find((call) =>
      String(call[0]).includes("readable by group/others"),
    );
    expect(permCall).toBeDefined();
  });

  it("settleRequestsForHost：Host 退出立即 503 结清本 Host 在飞；其他 Host 不受影响", async () => {
    const capturedA: HostLocalTaskApiRequestMessage[] = [];
    const capturedB: HostLocalTaskApiRequestMessage[] = [];
    const hostA = {
      postMessage: (message: unknown) => {
        capturedA.push(message as HostLocalTaskApiRequestMessage);
      },
    };
    const hostB = {
      postMessage: (message: unknown) => {
        capturedB.push(message as HostLocalTaskApiRequestMessage);
      },
    };
    let current: typeof hostA | typeof hostB = hostA;
    const dispatcher = createLocalTaskApiDispatcher({
      resolveHost: () => current,
      timeoutMs: 60_000,
      logger: { warn: vi.fn() },
    });

    const pendingA = dispatcher.dispatch(OPEN_WS, { kind: "list", workspacePath: OPEN_WS });
    await waitForCaptured(capturedA, 1);
    expect(dispatcher.settleRequestsForHost(hostA)).toBe(1);
    expect(await pendingA).toEqual({ status: 503, body: { error: "unavailable_host" } });

    current = hostB;
    const pendingB = dispatcher.dispatch(OPEN_WS, { kind: "list", workspacePath: OPEN_WS });
    await waitForCaptured(capturedB, 1);
    // settle 已退出的 A 不影响 B 的在飞请求：B 仍可用回流应答正常结算。
    expect(dispatcher.settleRequestsForHost(hostA)).toBe(0);
    dispatcher.resolveLocalTaskApiResponse({
      requestId: capturedB[0].requestId,
      ok: true,
      status: 200,
      body: { ok: true },
    });
    expect(await pendingB).toEqual({ status: 200, body: { ok: true } });
  });

  it("messages clientRequestId：同 key 串行重试命中幂等，回首次应答不再 dispatch", async () => {
    const captured: HostLocalTaskApiRequestMessage[] = [];
    const { port, logger } = await startServer({ resolveHost: capturingResolveHost(captured) });
    const headers = { authorization: BEARER, "content-type": "application/json" };
    const body = JSON.stringify({
      text: "hi",
      clientRequestId: "sid-1",
      workspacePath: OPEN_WS,
    });

    const first = send({ port, method: "POST", path: "/api/tasks/t-dup/messages", headers }, body);
    await waitForCaptured(captured, 1);
    // op 不带 clientRequestId，send 形态不变；首个请求 2xx 后回填归属表。
    expect(captured[0].op).toEqual({
      kind: "send",
      workspacePath: OPEN_WS,
      taskId: "t-dup",
      text: "hi",
      delivery: "auto",
    });
    resolveLocalTaskApiResponse({
      requestId: captured[0].requestId,
      ok: true,
      status: 202,
      body: { delivery: "queued", commandId: "c1" },
    });
    const firstRes = await first;
    expect(firstRes.status).toBe(202);
    expect(JSON.parse(firstRes.text)).toEqual({ delivery: "queued", commandId: "c1" });

    // 同 key 重试：直接回首次应答（commandId 仍是 c1），不再 dispatch，打一行 duplicate 日志。
    const retry = await send(
      { port, method: "POST", path: "/api/tasks/t-dup/messages", headers },
      body,
    );
    expect(retry.status).toBe(202);
    expect(JSON.parse(retry.text)).toEqual({ delivery: "queued", commandId: "c1" });
    expect(captured).toHaveLength(1);
    expect(
      logger.info.mock.calls.filter((call) =>
        String(call[0]).includes("duplicate send request=sid-1 task=t-dup"),
      ),
    ).toHaveLength(1);
  });

  it("messages clientRequestId 并发同 key：in-flight 共享同一应答，postMessage 只收到一次 send", async () => {
    const captured: HostLocalTaskApiRequestMessage[] = [];
    const { port, logger } = await startServer({ resolveHost: capturingResolveHost(captured) });
    const headers = { authorization: BEARER, "content-type": "application/json" };
    const body = JSON.stringify({
      text: "hi",
      clientRequestId: "sid-conc",
      workspacePath: OPEN_WS,
    });

    const first = send(
      { port, method: "POST", path: "/api/tasks/t-conc/messages", headers },
      body,
    );
    const second = send(
      { port, method: "POST", path: "/api/tasks/t-conc/messages", headers },
      body,
    );
    // 回流前两个请求都已 in-flight：首个已 dispatch、次个已挂在共享 future 上。
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(captured).toHaveLength(1); // 只 dispatch 一次
    resolveLocalTaskApiResponse({
      requestId: captured[0].requestId,
      ok: true,
      status: 202,
      body: { delivery: "queued", commandId: "c-conc" },
    });
    const [resA, resB] = await Promise.all([first, second]);
    expect(resA.status).toBe(202);
    expect(resB.status).toBe(202);
    expect(JSON.parse(resA.text)).toEqual({ delivery: "queued", commandId: "c-conc" });
    expect(JSON.parse(resB.text)).toEqual({ delivery: "queued", commandId: "c-conc" });
    // 只有等待方打 duplicate 日志（首个请求不打）。
    expect(
      logger.info.mock.calls.filter((call) =>
        String(call[0]).includes("duplicate send request=sid-conc task=t-conc"),
      ),
    ).toHaveLength(1);
  });

  it("messages clientRequestId 失败不缓存：同 key 重发重新 dispatch", async () => {
    const captured: HostLocalTaskApiRequestMessage[] = [];
    const { port } = await startServer({ resolveHost: capturingResolveHost(captured) });
    const headers = { authorization: BEARER, "content-type": "application/json" };
    const body = JSON.stringify({
      text: "hi",
      clientRequestId: "sid-fail",
      workspacePath: OPEN_WS,
    });

    const first = send({ port, method: "POST", path: "/api/tasks/t-fail/messages", headers }, body);
    await waitForCaptured(captured, 1);
    resolveLocalTaskApiResponse({
      requestId: captured[0].requestId,
      ok: false,
      status: 503,
      body: { error: "unavailable_host" },
    });
    expect((await first).status).toBe(503);

    // 失败未缓存：同 key 重发重新 dispatch（captured 增为 2）而不是回旧应答。
    const second = send({ port, method: "POST", path: "/api/tasks/t-fail/messages", headers }, body);
    await waitForCaptured(captured, 2);
    resolveLocalTaskApiResponse({
      requestId: captured[1].requestId,
      ok: true,
      status: 202,
      body: { delivery: "queued", commandId: "c-retry" },
    });
    const retry = await second;
    expect(retry.status).toBe(202);
    expect(JSON.parse(retry.text)).toEqual({ delivery: "queued", commandId: "c-retry" });
  });

  it("messages clientRequestId：不同任务同 key 互不影响，各自 dispatch", async () => {
    const captured: HostLocalTaskApiRequestMessage[] = [];
    const { port } = await startServer({ resolveHost: capturingResolveHost(captured) });
    const headers = { authorization: BEARER, "content-type": "application/json" };

    // 先 create 两个任务登记归属（同一 workspace，归属表各自登记）。
    const createA = send({ port, method: "POST", path: "/api/tasks", headers }, CREATE_BODY);
    await waitForCaptured(captured, 1);
    resolveLocalTaskApiResponse({
      requestId: captured[0].requestId,
      ok: true,
      status: 201,
      body: { taskId: "t-a" },
    });
    expect((await createA).status).toBe(201);

    const createB = send({ port, method: "POST", path: "/api/tasks", headers }, CREATE_BODY);
    await waitForCaptured(captured, 2);
    resolveLocalTaskApiResponse({
      requestId: captured[1].requestId,
      ok: true,
      status: 201,
      body: { taskId: "t-b" },
    });
    expect((await createB).status).toBe(201);

    const sendA = send(
      { port, method: "POST", path: "/api/tasks/t-a/messages", headers },
      JSON.stringify({ text: "x", clientRequestId: "sid-shared" }),
    );
    await waitForCaptured(captured, 3);
    resolveLocalTaskApiResponse({
      requestId: captured[2].requestId,
      ok: true,
      status: 202,
      body: { delivery: "queued", commandId: "c-a" },
    });
    expect((await sendA).status).toBe(202);

    // 同一 clientRequestId 打到任务 B：命名空间按任务分隔，必须重新 dispatch。
    const sendB = send(
      { port, method: "POST", path: "/api/tasks/t-b/messages", headers },
      JSON.stringify({ text: "x", clientRequestId: "sid-shared" }),
    );
    await waitForCaptured(captured, 4);
    expect(captured[3].op).toEqual({
      kind: "send",
      workspacePath: OPEN_WS,
      taskId: "t-b",
      text: "x",
      delivery: "auto",
    });
    resolveLocalTaskApiResponse({
      requestId: captured[3].requestId,
      ok: true,
      status: 202,
      body: { delivery: "queued", commandId: "c-b" },
    });
    const resB = await sendB;
    expect(resB.status).toBe(202);
    expect(JSON.parse(resB.text)).toEqual({ delivery: "queued", commandId: "c-b" });
  });

  it("messages clientRequestId 非法：空串与 201 字符 → 400 不 dispatch", async () => {
    const captured: HostLocalTaskApiRequestMessage[] = [];
    const { port } = await startServer({ resolveHost: capturingResolveHost(captured) });
    const headers = { authorization: BEARER, "content-type": "application/json" };

    const empty = await send(
      { port, method: "POST", path: "/api/tasks/t-bad/messages", headers },
      JSON.stringify({ text: "x", clientRequestId: "", workspacePath: OPEN_WS }),
    );
    expect(empty.status).toBe(400);
    expect(JSON.parse(empty.text)).toEqual({ error: "bad_request" });

    const tooLong = await send(
      { port, method: "POST", path: "/api/tasks/t-bad/messages", headers },
      JSON.stringify({ text: "x", clientRequestId: "x".repeat(201), workspacePath: OPEN_WS }),
    );
    expect(tooLong.status).toBe(400);
    expect(JSON.parse(tooLong.text)).toEqual({ error: "bad_request" });
    expect(captured).toHaveLength(0); // 两个 400 都未触达 Host
  });
});

import { afterAll, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import { createServer, request, type Server } from "node:http";
import {
  createBotWebhookIngress,
  createBotWebhookIngressDispatcher,
  readBotWebhookIngressConfig,
  type BotWebhookIngressConfig,
  type BotWebhookIngressDispatchPayload,
} from "../src/main/botWebhookIngress.js";

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
};

async function reservePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", () => resolve()));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

interface IngressHarness {
  server: Server;
  port: number;
  dispatch: ReturnType<
    typeof vi.fn<
      (
        payload: BotWebhookIngressDispatchPayload,
      ) => Promise<{ status: number; body: unknown }>
    >
  >;
  close(): Promise<void>;
}

async function startIngress(options?: {
  config?: Partial<BotWebhookIngressConfig>;
  dispatch?: (
    payload: BotWebhookIngressDispatchPayload,
  ) => Promise<{ status: number; body: unknown }>;
}): Promise<IngressHarness> {
  const port = await reservePort();
  const dispatch = vi.fn(
    options?.dispatch ?? (async () => ({ status: 200, body: { ok: true, replies: [] } })),
  );
  const server = await createBotWebhookIngress({
    readConfig: async () => ({
      enabled: true,
      port,
      ...options?.config,
    }),
    dispatch,
    zcodeVersion: "9.9.9-test",
    logger,
  });
  if (!server) {
    throw new Error("ingress server was not created");
  }
  const close = () =>
    new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  return { server, port, dispatch, close };
}

function rawRequest(
  port: number,
  options: { method?: string; path?: string; headers?: Record<string, string>; body?: string },
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, ...options, headers: options.headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

const servers: Array<() => Promise<void>> = [];
afterAll(async () => {
  await Promise.all(servers.map((close) => close().catch(() => undefined)));
});

describe("bot webhook ingress server", () => {
  it("serves /health without auth", async () => {
    const harness = await startIngress();
    servers.push(harness.close);
    const response = await rawRequest(harness.port, {
      method: "GET",
      path: "/health",
      headers: { host: `127.0.0.1:${harness.port}` },
    });
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      ok: true,
      ingress: "zcode-bot-webhook",
      version: 1,
      zcodeVersion: "9.9.9-test",
    });
  });

  it("rejects a foreign Host header with 403 before reading the body", async () => {
    const harness = await startIngress();
    servers.push(harness.close);
    const response = await rawRequest(harness.port, {
      method: "POST",
      path: "/api/bots/webhook/bot-1",
      headers: { host: "evil.example.com" },
      body: "{}",
    });
    expect(response.status).toBe(403);
    expect(JSON.parse(response.body)).toEqual({ error: "host_header_forbidden" });
    expect(harness.dispatch).not.toHaveBeenCalled();
  });

  it("accepts both 127.0.0.1 and localhost Host headers", async () => {
    const harness = await startIngress();
    servers.push(harness.close);
    for (const host of [`127.0.0.1:${harness.port}`, `localhost:${harness.port}`]) {
      const response = await rawRequest(harness.port, {
        method: "POST",
        path: "/api/bots/webhook/bot-1",
        headers: { host },
        body: JSON.stringify({ botId: "bot-1", userId: "u1", text: "hi" }),
      });
      expect(response.status).toBe(200);
    }
  });

  it("forwards path botId, raw body and secret header, and echoes them back", async () => {
    const dispatch = vi.fn(
      async (payload: BotWebhookIngressDispatchPayload) => ({
        status: 200,
        body: { echoed: payload },
      }),
    );
    const harness = await startIngress({ dispatch });
    servers.push(harness.close);

    const body = JSON.stringify({ botId: "body-bot", userId: "u1", text: "/status" });
    const response = await rawRequest(harness.port, {
      method: "POST",
      path: "/api/bots/webhook/path-bot",
      headers: {
        host: `127.0.0.1:${harness.port}`,
        "content-type": "application/json",
        "x-zcode-bot-secret": "s3cret",
      },
      body,
    });
    expect(response.status).toBe(200);
    expect(dispatch).toHaveBeenCalledWith({
      botId: "path-bot",
      rawBody: body,
      webhookSecret: "s3cret",
    });
    expect(JSON.parse(response.body)).toEqual({
      echoed: { botId: "path-bot", rawBody: body, webhookSecret: "s3cret" },
    });
  });

  it("passes service error statuses through unchanged", async () => {
    for (const status of [400, 401, 503]) {
      const harness = await startIngress({
        dispatch: async () => ({ status, body: { error: `svc-${status}` } }),
      });
      servers.push(harness.close);
      const response = await rawRequest(harness.port, {
        method: "POST",
        path: "/api/bots/webhook",
        headers: { host: `localhost:${harness.port}` },
        body: "{}",
      });
      expect(response.status).toBe(status);
      expect(JSON.parse(response.body)).toEqual({ error: `svc-${status}` });
    }
  });

  it("sends a null botId when the callback path has no botId segment", async () => {
    const dispatch = vi.fn(async () => ({ status: 200, body: { ok: true, replies: [] } }));
    const harness = await startIngress({ dispatch });
    servers.push(harness.close);
    await rawRequest(harness.port, {
      method: "POST",
      path: "/api/bots/webhook",
      headers: { host: `127.0.0.1:${harness.port}` },
      body: JSON.stringify({ botId: "body-bot", userId: "u1" }),
    });
    expect(dispatch).toHaveBeenCalledWith({
      botId: null,
      rawBody: JSON.stringify({ botId: "body-bot", userId: "u1" }),
      webhookSecret: null,
    });
  });

  it("rejects bodies over 16 MiB with 413", async () => {
    const harness = await startIngress();
    servers.push(harness.close);
    const response = await rawRequest(harness.port, {
      method: "POST",
      path: "/api/bots/webhook/bot-1",
      headers: { host: `127.0.0.1:${harness.port}`, "content-length": String(16 * 1024 * 1024 + 8) },
      body: "x".repeat(16 * 1024 * 1024 + 8),
    });
    // 超限时连接可能被 destroy（413 已发出但客户端侧读端可能看到 ECONNRESET）。
    expect([413, 0]).toContain(response.status);
  }, 30_000);

  it("returns 404 for unknown GET paths and 405 for other methods", async () => {
    const harness = await startIngress();
    servers.push(harness.close);
    const notFound = await rawRequest(harness.port, {
      method: "GET",
      path: "/api/bots/webhook",
      headers: { host: `127.0.0.1:${harness.port}` },
    });
    expect(notFound.status).toBe(404);
    const methodNotAllowed = await rawRequest(harness.port, {
      method: "DELETE",
      path: "/health",
      headers: { host: `127.0.0.1:${harness.port}` },
    });
    expect(methodNotAllowed.status).toBe(405);
    expect(methodNotAllowed.headers["allow"]).toBe("GET, POST");
  });

  it("does not send CORS headers", async () => {
    const harness = await startIngress();
    servers.push(harness.close);
    const response = await rawRequest(harness.port, {
      method: "GET",
      path: "/health",
      headers: { host: `127.0.0.1:${harness.port}`, origin: "http://evil.example.com" },
    });
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("stays silent when the config is missing or disabled", async () => {
    for (const readConfig of [
      async () => null,
      async () => ({ enabled: false, port: 47821 }) as BotWebhookIngressConfig,
    ]) {
      const server = await createBotWebhookIngress({
        readConfig,
        dispatch: async () => ({ status: 200, body: {} }),
        zcodeVersion: "v",
        logger,
      });
      expect(server).toBeNull();
    }
  });

  it("warns and stays dark for an invalid config", async () => {
    const server = await createBotWebhookIngress({
      readConfig: async () => "invalid",
      dispatch: async () => ({ status: 200, body: {} }),
      zcodeVersion: "v",
      logger,
    });
    expect(server).toBeNull();
    expect(logger.warn).toHaveBeenCalled();
  });

  it("does not throw when the port is already in use", async () => {
    const port = await reservePort();
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(port, "127.0.0.1", () => resolve()));
    servers.push(
      () => new Promise<void>((resolve) => blocker.close(() => resolve())),
    );
    const server = await createBotWebhookIngress({
      readConfig: async () => ({ enabled: true, port }),
      dispatch: async () => ({ status: 200, body: {} }),
      zcodeVersion: "v",
      logger,
    });
    expect(server).toBeNull();
    expect(logger.warn).toHaveBeenCalled();
  });

  it("returns 503 when dispatch fails", async () => {
    const harness = await startIngress({
      dispatch: async () => {
        throw new Error("no host");
      },
    });
    servers.push(harness.close);
    const response = await rawRequest(harness.port, {
      method: "POST",
      path: "/api/bots/webhook/bot-1",
      headers: { host: `127.0.0.1:${harness.port}` },
      body: "{}",
    });
    expect(response.status).toBe(503);
    expect(JSON.parse(response.body)).toEqual({ error: "unavailable_host" });
  });
});

describe("readBotWebhookIngressConfig", () => {
  it("returns null when the file is missing", async () => {
    expect(await readBotWebhookIngressConfig("/nonexistent-dir-for-zcode-test")).toBeNull();
  });
});

describe("bot webhook ingress dispatcher", () => {
  it("rejects with 503 when no host is alive", async () => {
    const dispatcher = createBotWebhookIngressDispatcher({ getHost: () => null });
    await expect(dispatcher.dispatch({ botId: "b", rawBody: "{}", webhookSecret: null })).resolves.toEqual(
      { status: 503, body: { error: "unavailable_host" } },
    );
  });

  it("posts a dispatch message and resolves on the matching result", async () => {
    const posted: Array<Record<string, unknown>> = [];
    const dispatcher = createBotWebhookIngressDispatcher({
      getHost: () => ({ postMessage: (message) => posted.push(message as never) }),
    });
    const pending = dispatcher.dispatch({ botId: "b1", rawBody: "{}", webhookSecret: "s" });
    await new Promise((resolve) => setImmediate(resolve));
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({
      type: "bot-webhook-ingress-dispatch",
      botId: "b1",
      rawBody: "{}",
      webhookSecret: "s",
    });
    dispatcher.resolveBotWebhookIngressResult({
      requestId: posted[0]!["requestId"] as string,
      ok: true,
      status: 200,
      body: { ok: true, replies: [] },
    });
    await expect(pending).resolves.toEqual({ status: 200, body: { ok: true, replies: [] } });
  });

  it("resolves 503 when the host reports failure", async () => {
    const posted: Array<Record<string, unknown>> = [];
    const dispatcher = createBotWebhookIngressDispatcher({
      getHost: () => ({ postMessage: (message) => posted.push(message as never) }),
    });
    const pending = dispatcher.dispatch({ botId: "b1", rawBody: "{}", webhookSecret: null });
    await new Promise((resolve) => setImmediate(resolve));
    dispatcher.resolveBotWebhookIngressResult({
      requestId: posted[0]!["requestId"] as string,
      ok: false,
      status: 503,
      body: { error: "dispatch failed" },
    });
    await expect(pending).resolves.toEqual({ status: 503, body: { error: "dispatch failed" } });
  });

  it("times out to 503 when the host never answers", async () => {
    const dispatcher = createBotWebhookIngressDispatcher({
      getHost: () => ({ postMessage: () => undefined }),
      timeoutMs: 20,
    });
    await expect(
      dispatcher.dispatch({ botId: "b1", rawBody: "{}", webhookSecret: null }),
    ).resolves.toEqual({ status: 503, body: { error: "unavailable_host" } });
  });
});

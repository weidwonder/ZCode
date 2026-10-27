import { describe, expect, it, vi } from "vitest";
import { ServiceCollection, IBotsService, type IBotsService as BotsService } from "@zcode/services";
import { createBotWebhookIngressResponder } from "../src/host/botWebhookIngressResponder.js";
import type { HostBotWebhookIngressResultResponse } from "@zcode/shared";

function dispatchMessage(overrides?: Record<string, unknown>) {
  return {
    type: "bot-webhook-ingress-dispatch",
    requestId: "req-1",
    botId: "webhook-1",
    rawBody: JSON.stringify({ botId: "webhook-1", userId: "user-1", text: "/status" }),
    webhookSecret: "s3cret",
    ...overrides,
  } as Parameters<ReturnType<typeof createBotWebhookIngressResponder>["handleDispatch"]>[0];
}

function createHarness(options?: {
  botsService?: BotsService | null;
}) {
  const posted: HostBotWebhookIngressResultResponse[] = [];
  const services =
    options?.botsService === undefined
      ? null
      : options.botsService === null
        ? new ServiceCollection()
        : new ServiceCollection().register(IBotsService, options.botsService);
  const responder = createBotWebhookIngressResponder({
    getServices: () => services,
    post: (message) => posted.push(message),
  });
  return { responder, posted };
}

describe("bot webhook ingress host responder", () => {
  it("forwards the dispatch to the bots service and posts the result", async () => {
    // 契约锚点：mock 类型绑定 IBotsService.handleProviderCallbackResponse，
    // 上游签名变化时本文件编译失败（任务书：契约测试要在上游接口变化时失败）。
    const handleProviderCallbackResponse = vi.fn(
      async (_provider: unknown, payload: unknown) => {
        expect(payload).toMatchObject({ botId: "webhook-1", webhookSecret: "s3cret" });
        return { ok: true, replies: [], responseBody: { ok: true, replies: [] } };
      },
    );
    const botsService = { handleProviderCallbackResponse } as unknown as BotsService;
    const { responder, posted } = createHarness({ botsService });

    await responder.handleDispatch(dispatchMessage());

    expect(handleProviderCallbackResponse).toHaveBeenCalledWith("webhook", expect.anything());
    expect(posted).toEqual([
      {
        type: "bot-webhook-ingress-result",
        requestId: "req-1",
        ok: true,
        status: 200,
        body: { ok: true, replies: [] },
      },
    ]);
  });

  it("passes through retryable statuses from the bots service", async () => {
    const botsService = {
      handleProviderCallbackResponse: vi.fn(async () => ({
        ok: false,
        replies: [],
        status: 503,
      })),
    } as unknown as BotsService;
    const { responder, posted } = createHarness({ botsService });

    await responder.handleDispatch(dispatchMessage());

    expect(posted[0]).toMatchObject({ ok: true, status: 503, body: { ok: false, replies: [] } });
  });

  it("replies 503 when the bots service is not registered", async () => {
    const { responder, posted } = createHarness({ botsService: null });

    await responder.handleDispatch(dispatchMessage());

    expect(posted[0]).toMatchObject({
      requestId: "req-1",
      ok: true,
      status: 503,
      body: { error: "Bots service is not available." },
    });
  });

  it("replies 503 when no services container exists", async () => {
    const { responder, posted } = createHarness();

    await responder.handleDispatch(dispatchMessage());

    expect(posted[0]).toMatchObject({ ok: true, status: 503 });
  });

  it("always replies when the bots service throws", async () => {
    const botsService = {
      handleProviderCallbackResponse: vi.fn(async () => {
        throw new Error("boom");
      }),
    } as unknown as BotsService;
    const { responder, posted } = createHarness({ botsService });

    await responder.handleDispatch(dispatchMessage());

    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ requestId: "req-1", ok: false, status: 503 });
  });

  it("keeps the body botId when no path botId is given", async () => {
    const handleProviderCallbackResponse = vi.fn(async () => ({ ok: true, replies: [] }));
    const botsService = { handleProviderCallbackResponse } as unknown as BotsService;
    const { responder } = createHarness({ botsService });

    await responder.handleDispatch(dispatchMessage({ botId: null }));

    // 路径 botId 为 null 时不覆盖 body 里的 botId（parseCallback 靠它路由）。
    const payload = handleProviderCallbackResponse.mock.calls[0]![1] as Record<string, unknown>;
    expect(payload["botId"]).toBe("webhook-1");
  });
});

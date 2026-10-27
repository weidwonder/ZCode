import { describe, expect, it, vi } from "vitest";
import type { BotProviderCallbackResult } from "@zcode/shared";
import {
  handleWebhookBotCallback,
  parseWebhookCallbackBody,
  type WebhookBotCallbackBotsService,
} from "../src/bots/webhookCallbackHttp.js";

function createBotsService(
  result: BotProviderCallbackResult,
): WebhookBotCallbackBotsService & { handleProviderCallbackResponse: ReturnType<typeof vi.fn> } {
  return {
    // 契约锚点：mock 显式实现 Pick<IBotsService, "handleProviderCallbackResponse">，
    // 上游签名（provider/payload 参数或返回 BotProviderCallbackResult）变化时本文件编译失败。
    handleProviderCallbackResponse: vi.fn(async () => result),
  };
}

describe("parseWebhookCallbackBody", () => {
  it("treats an empty body as an empty object", () => {
    expect(parseWebhookCallbackBody("")).toEqual({});
  });

  it("returns parsed JSON objects as-is", () => {
    expect(parseWebhookCallbackBody('{"botId":"b1"}')).toEqual({ botId: "b1" });
  });

  it("wraps JSON scalars as payload with the parsed value", () => {
    expect(parseWebhookCallbackBody("123")).toEqual({ payload: 123 });
    expect(parseWebhookCallbackBody("null")).toEqual({ payload: null });
  });

  it("falls back to the raw text for invalid JSON", () => {
    expect(parseWebhookCallbackBody("not json")).toEqual({ payload: "not json" });
  });
});

describe("handleWebhookBotCallback", () => {
  it("rejects providers outside the bot provider list", async () => {
    const result = await handleWebhookBotCallback({
      provider: "unknown" as never,
      rawBodyText: "{}",
      botsService: null,
    });
    expect(result).toEqual({
      status: 400,
      body: { error: "Unsupported provider: unknown" },
    });
  });

  it("rejects non-webhook providers on the HTTP callback path", async () => {
    const result = await handleWebhookBotCallback({
      provider: "feishu",
      rawBodyText: "{}",
      botsService: null,
    });
    expect(result).toEqual({
      status: 400,
      body: { error: "Provider feishu does not support HTTP callbacks." },
    });
  });

  it("returns 503 when the bots service is unavailable", async () => {
    const result = await handleWebhookBotCallback({
      provider: "webhook",
      rawBodyText: "{}",
      botsService: null,
    });
    expect(result).toEqual({
      status: 503,
      body: { error: "Bots service is not available." },
    });
  });

  it("forwards provider, parsed body, rawBody, botId and webhook secret", async () => {
    const botsService = createBotsService({ ok: true, replies: [] });
    const rawBodyText = JSON.stringify({ botId: "body-bot", userId: "u1", text: "hi" });
    const result = await handleWebhookBotCallback({
      provider: "webhook",
      botId: "path-bot",
      rawBodyText,
      webhookSecret: "s3cret",
      botsService,
    });
    expect(result).toEqual({ status: 200, body: { ok: true, replies: [] } });
    expect(botsService.handleProviderCallbackResponse).toHaveBeenCalledWith("webhook", {
      botId: "path-bot",
      userId: "u1",
      text: "hi",
      rawBody: rawBodyText,
      webhookSecret: "s3cret",
    });
  });

  it("keeps body botId when no path botId is given", async () => {
    const botsService = createBotsService({ ok: true, replies: [] });
    await handleWebhookBotCallback({
      provider: "webhook",
      rawBodyText: JSON.stringify({ botId: "body-bot", userId: "u1" }),
      botsService,
    });
    const payload = botsService.handleProviderCallbackResponse.mock.calls[0]![1] as Record<
      string,
      unknown
    >;
    expect(payload["botId"]).toBe("body-bot");
  });

  it("passes through retryable and error statuses with the response body", async () => {
    for (const status of [400, 401, 503] as const) {
      const botsService = createBotsService({
        ok: false,
        replies: [],
        status,
        responseBody: { error: `svc-${status}` },
      });
      const result = await handleWebhookBotCallback({
        provider: "webhook",
        rawBodyText: "{}",
        botsService,
      });
      expect(result).toEqual({ status, body: { error: `svc-${status}` } });
    }
  });

  it("defaults to 200 with {ok, replies} when no response body is set", async () => {
    const replies = [{ botId: "b1", provider: "webhook", providerUserId: "u1", text: "ok" }];
    const botsService = createBotsService({ ok: true, replies });
    const result = await handleWebhookBotCallback({
      provider: "webhook",
      rawBodyText: "{}",
      botsService,
    });
    expect(result).toEqual({ status: 200, body: { ok: true, replies } });
  });

  it("treats a missing service status as 200", async () => {
    const botsService = createBotsService({ ok: true, replies: [] });
    const result = await handleWebhookBotCallback({
      provider: "webhook",
      rawBodyText: "{}",
      botsService,
    });
    expect(result.status).toBe(200);
  });
});

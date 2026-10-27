/* Web 与桌面共用的 Webhook Bot 入站回调处理：provider 校验、body 解析、
 * 调用 handleProviderCallbackResponse 与状态码映射收口在此，两个 HTTP 入口不得各自复制。 */
import { botProviders, type BotProvider } from "@zcode/shared";
import type { IBotsService } from "./bots.js";

/** 只依赖 IBotsService 的回调处理面；签名随 IBotsService.handleProviderCallbackResponse 演进。 */
export type WebhookBotCallbackBotsService = Pick<
  IBotsService,
  "handleProviderCallbackResponse"
>;

export interface WebhookBotCallbackResult {
  status: 200 | 400 | 401 | 503;
  body: unknown;
}

/** 解析回调 body 原文：空文本得空对象；JSON 非对象或解析失败按 {payload: <解析值或原文>} 处理。 */
export function parseWebhookCallbackBody(rawBodyText: string): Record<string, unknown> {
  if (!rawBodyText) {
    return {};
  }
  try {
    const parsed = JSON.parse(rawBodyText) as unknown;
    // 与 Web 服务原实现一致：JSON 标量/null 包成 {payload: 解析值}，不回退到原文。
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : { payload: parsed };
  } catch {
    return { payload: rawBodyText };
  }
}

export async function handleWebhookBotCallback(params: {
  provider: BotProvider;
  botId?: string;
  rawBodyText: string;
  webhookSecret?: string;
  botsService: WebhookBotCallbackBotsService | null | undefined;
}): Promise<WebhookBotCallbackResult> {
  const { provider, botId, rawBodyText, webhookSecret, botsService } = params;
  if (!botProviders.includes(provider)) {
    return { status: 400, body: { error: `Unsupported provider: ${provider}` } };
  }
  if (provider !== "webhook") {
    return {
      status: 400,
      body: { error: `Provider ${provider} does not support HTTP callbacks.` },
    };
  }
  if (!botsService) {
    return { status: 503, body: { error: "Bots service is not available." } };
  }
  const rawBody = parseWebhookCallbackBody(rawBodyText);
  const result = await botsService.handleProviderCallbackResponse(provider, {
    ...rawBody,
    rawBody: rawBodyText,
    ...(botId ? { botId } : {}),
    ...(webhookSecret ? { webhookSecret } : {}),
  });
  const responseBody = result.responseBody ?? { ok: result.ok, replies: result.replies };
  if (result.status === 400) {
    return { status: 400, body: responseBody };
  }
  if (result.status === 401) {
    return { status: 401, body: responseBody };
  }
  if (result.status === 503) {
    // Bugfix：Bot 业务失败必须把可重试状态透传给 HTTP provider；返回 200 会让
    // webhook/网关误以为消息已消费，效果与提前提交 Telegram offset 相同。
    return { status: 503, body: responseBody };
  }
  return { status: 200, body: responseBody };
}

/* 本机 Webhook Bot 入站回调的 Host 侧应答器：Main 经 postMessage 转发的回调在此
 * 交给窗口 Host 内的 bots 服务处理，结果按 requestId 回传。解析与状态映射收口在
 * services 的共享实现（webhookCallbackHttp.ts），本模块只做服务定位与应答回流。 */
import { IBotsService, handleWebhookBotCallback } from "@zcode/services";
import type { ServiceCollection } from "@zcode/services";
import type { HostBotWebhookIngressDispatchMessage, HostBotWebhookIngressResultResponse } from "@zcode/shared";

export function createBotWebhookIngressResponder(deps: {
  getServices: () => ServiceCollection | null;
  post: (message: HostBotWebhookIngressResultResponse) => void;
}) {
  const reply = (requestId: string, ok: boolean, status: number, body: unknown) => {
    deps.post({ type: "bot-webhook-ingress-result", requestId, ok, status, body });
  };
  return {
    async handleDispatch(msg: HostBotWebhookIngressDispatchMessage): Promise<void> {
      const botsService = deps.getServices()?.getOptional(IBotsService) ?? null;
      try {
        const result = await handleWebhookBotCallback({
          provider: "webhook",
          botId: msg.botId ?? undefined,
          rawBodyText: msg.rawBody,
          webhookSecret: msg.webhookSecret ?? undefined,
          botsService,
        });
        reply(msg.requestId, true, result.status, result.body);
      } catch (error) {
        // bots 服务抛错时也必须应答：Main 侧的 pending 请求靠这条消息解除等待，
        // 静默丢弃会让入站请求悬挂到超时。
        reply(msg.requestId, false, 503, {
          error: `bot webhook ingress dispatch failed: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    },
  };
}

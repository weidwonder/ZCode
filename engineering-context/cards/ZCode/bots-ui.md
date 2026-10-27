# 业务域卡 — ZCode › bots-ui

## 职责
Bots 设置对话框（共享 UI 包）的 provider 列表、provider 设置卡与凭据保存路径。

## 权威实现与对外接口

| 能力 / 入口 | 权威实现（cite） | 类型 | 版本 / 状态 | 调用方 / 触发源 | 约束 |
|---|---|---|---|---|---|
| provider 清单与 implemented 标记 | `packages/ui/src/botsUi.ts#BOT_PROVIDERS` | 内部 | canonical | BotsDialog | webhook 已 implemented:true |
| 新建 bot 列表渲染 | `packages/ui/src/BotsDialog.tsx`（creatingBot 分支） | 内部 | canonical | 用户 | 桌面曾把 webhook 过滤（本分支放开，与 docs/bots.md「Webhook setup is available from the new bot provider list」声明对齐） |
| provider 凭据设置卡 | `packages/ui/src/BotsDialog/ProviderSettingsCard.tsx#ProviderSettingsCard` | 内部 | canonical | BotsDialog | webhook 分支曾 return null（本分支改为 webhook 设置卡）；secret 保存走 saveBot 的 webhookSecretValue |
| UI 保存路径 | `packages/ui/src/BotsDialog.tsx#saveBot`（→ botsService.saveBot） | RPC | canonical | BotsDialog | 服务端 BotSaveBotParams 含 credentialValue 与 webhookSecretValue 两个独立参数 |
| UI 服务获取 | `packages/ui/src/hooks/useServices.tsx#useServices` | 内部 | canonical | UI 组件 | React Context 注入 IServiceAccessor |

## 陷阱项

- `bots.botTokenDescription.webhook` 这类 per-provider 文案 key — 渲染按 provider id 拼 key，新增 provider 分支时 zh-CN 与 en-US 必须成对补

## 测试入口

- 无独立组件测试；行为由 `packages/desktop/test/` e2e 与类型检查兜底（本分支 webhook 卡为最小实现）

## 确认
2026-10-27｜来源：packages/ui/src/{botsUi.ts,BotsDialog.tsx,BotsDialog/ProviderSettingsCard.tsx,hooks/useServices.tsx}

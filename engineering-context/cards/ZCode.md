# 仓库地图卡 — ZCode

## 职责
ZCode 桌面版（Electron）+ Web 服务 + 共享 services/UI 的 monorepo：Agent 任务运行时、Bots 第三方聊天驱动、多窗口 window-scoped Local Host 架构。

> 根目录：packages（本卡与域卡路径均相对仓库根）

## 业务域地图

> **划分方式只写在这里**：按 packages 的业务能力切（bots 服务端 / desktop 进程架构 / bots UI），与 docs/ 现行文档的bots 域切法一致。

| 业务域 | 一句话 | 域卡 |
|---|---|---|
| bots-webhook-callback | Webhook Bot 入站回调的解析、鉴权与状态码语义 | `cards/ZCode/bots-webhook-callback.md` |
| desktop-host-ipc | Main ↔ window Local Host 进程间消息协议与请求转发 | `cards/ZCode/desktop-host-ipc.md` |
| local-task-api | 桌面版本机任务 API（loopback HTTP → 窗口 Host 的任务服务） | `cards/ZCode/local-task-api.md` |
| bots-ui | Bots 设置对话框的 provider 列表与凭据保存路径 | `cards/ZCode/bots-ui.md` |

## 对外入口总览

| 入口 | 类型 | 归属域 |
|---|---|---|
| POST /api/bots/:provider(/:botId)（Web 服务） | HTTP | bots-webhook-callback |
| GET /health 与 /api/tasks*（桌面版本机任务 API，opt-in） | HTTP（loopback） | local-task-api |

## 确认
2026-10-27｜来源：packages/services/src/bots/、packages/desktop/src/main/index.ts、packages/desktop/src/host/index.ts、packages/server/src/http.ts、packages/ui/src/BotsDialog*.tsx

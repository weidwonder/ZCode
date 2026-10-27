---
lifecycle: active
superseded_by: ''
archived: ''
last_confirmed: '2026-10-28'
authority_refs:
  - '本机入站通道的形态选择（webhook bot 入站 vs 本机任务 API）'
---

# 决策：本机入站通道从 webhook bot 改为本机任务 API

- 日期：2026-10-28
- 状态：已定（上级任务书拍板）

## 背景

用户要让外部桥接程序驱动 ZCode 桌面版执行任务。第一版（2026-10-27，已实现并回退）走「Webhook Bot 入站」：桥接把任务以 webhook bot 消息投给桌面版，复用 bots 链路。

## 为什么换

用户硬性要求（上级任务书转述）：

1. 必须像桌面端原生那样**多对话并行**；
2. 任务**运行中能补充消息**（排队/引导）。

桥接侧查实 webhook bot 做不到：单 bot 绑定单用户单会话（`/bind` 语义），私聊无 steer/queue 通道——一条消息一个任务流，运行中的补充输入没有 GUI 那样的排队语义。

## 现在的方案

本机任务 API（契约 v2）：Main 进程起 loopback HTTP，按 workspace 路由到拥有它的窗口 Host，Host 直接调 `IZCodeTaskService`（createTask / sendPrompt / enqueueTaskCommand / promoteTaskCommand / stopGeneration / getTaskSnapshot / 事件订阅）。经它建的任务就是普通桌面对话——GUI 可见、可并行、可在 GUI 接管。

## 处置

- v1 全部功能改动随 75f60bd3 回退到 origin/main 原样（services 抽取、server 路由、UI、消息对、应答器、文档）。
- v1 调查结论中仍有效的架构事实（bots 服务在每窗口 Host、Main 无实例、requestId postMessage 模式、taskRealtimeBus 路由）保留在 engineering-context 卡片。
- v1 eng-spec 与配套 coding plan 均转 superseded（后者 superseded_by 指向 2026-10-28 的 plan）；实现与验证按 `docs/spec/2026-10-28-zcode-local-task-api-eng-spec.md`。

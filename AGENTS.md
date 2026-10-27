<!-- dw-workflow:hint:start -->
> **本项目采用 dw-workflow 开发流程**：接到开发、改代码或写文档的任务，动手前 MUST 先加载 `dw-workflow` skill 并按它的路由走，MUST NOT 凭印象直接开干。本项目的流程字段与常驻规则在本文的 `dw-workflow` 标记块里。
<!-- dw-workflow:hint:end -->

## 核心原则

- 新增或修改行为前，先更新对应 spec；目录不存在时按需创建。先明确产品规则、状态所有者、接口和验收场景，再实现代码。
- 以当前检出的源码、`package.json` 和架构策略为准。说明中只保留当前仓库提供的功能、命令和文件；删除功能时同步清理指令和技能中的引用。
- 定位问题时，未明确要求修改代码就先调查原因。结合源码、日志和运行时证据，区分已确认原因与待验证假设。
- 保留与任务无关的本地改动，不自行恢复已移除的模块或内部依赖。

## 命令与仓库结构

开工前运行 `node scripts/check-workspace-freshness.mjs` 检查基线。Node 版本以 `mise.toml` 为准。

以下命令从仓库根目录执行：

| 用途             | 命令                                                 |
| ---------------- | ---------------------------------------------------- |
| 类型检查         | `pnpm typecheck`                                     |
| Lint             | `pnpm lint` / `pnpm lint:fix`                        |
| 格式检查         | `pnpm fmt:check`                                     |
| 桌面开发         | `pnpm dev:desktop`                                   |
| Web 开发         | `pnpm dev:web`                                       |
| 提交前检查       | `pnpm verify:pre-push`（Lint、架构检查与受影响单测） |
| 架构检查         | `pnpm architecture:check --changed`                  |
| 模块阅读包       | `pnpm architecture:context <module-id>`              |
| 未使用依赖与导出 | `pnpm knip`                                          |
| 导出引用查询     | `pnpm dep:refs --list-exports <file>`                |

affected 使用 Vitest 官方选择，只运行选中的根 UT；选中整个套件时说明并跳过 UT，成功退出，不因此阻止 Push；不替代 CLI 测试或桌面 E2E。全量使用 `pnpm test` / `pnpm test:unit`，仅在用户明确要求时调用。范围与输出合同见 [pre-push 说明](docs/testing/pre-push-hook.md)。

测试入口以目标包当前的 `package.json` 和实际测试文件为准，不假定存在统一的单测或 E2E 命令。

- `packages/desktop`：Electron main、host、renderer。
- `packages/web`、`packages/server`：Web 客户端与服务端。
- `packages/ui`：共享 React 组件、hooks 与 Zustand store。
- `packages/services`：业务服务；`packages/rpc`：RPC 框架。
- `packages/shared`：共享协议与类型；`packages/client`：Agent 客户端 SDK。
- `apps/zcode-cli`：Agent CLI 与运行时。
- `CONTEXT.md`：插件商店领域词汇；修改相关 UI 前阅读。
- `DESIGN.md`：UI 设计规范；修改 UI 前阅读。

## 实现与验证

- 代码改动使用 `.agents/skills/architecture-governance/SKILL.md`，先运行架构检查，再读取目标模块的受控上下文。
- 避免重复状态和多条写入路径。明确唯一所有者、接口、依赖方向、事件顺序与幂等边界，不能用超时掩盖同步问题。
- 有行为改动时先补充对应测试；交互改动需要 E2E 场景。检查测试与实现是否一致，并实际执行可用的验证。未执行或环境受限时如实说明。
- 修复 bug 时用中文注释说明原因和修复依据。发现设计缺陷时先与用户对齐，不不断增加兜底分支。
- PR 描述须说明背景、设计意图与修改前后行为；包含 bugfix 时逐项说明触发场景、根因证据、修复机制及回归验证，并尽量关联已有工单链接。未确认的根因或引入提交如实标注，不根据模块或时间接近推断归因。
- 涉及状态、时序、远端或异步同步的方案，用图展示所有者及事件顺序。
- 必须执行 `pnpm typecheck` 和 `pnpm lint`，报告真实结果，不将已有失败写成通过。
- 使用异步文件和网络 IO；跨包导入使用公开入口，遵守现有路径别名。
- 禁止 UI 直接调用 Repo、Service 引用 Runtime 具体实现、跨域导入实现细节及循环依赖。

## UI 与平台边界

- 遵守 `DESIGN.md`，复用已有组件，兼顾桌面与手机 Web 的布局、交互、主题和国际化。
- 组件通过 `packages/ui/src/hooks/` 访问服务；平台操作通过 `IPlatformService`（`packages/shared/src/platform.ts`），不直接调用 `window.zcode`。
- 通过依赖注入处理 Desktop、Web、本地和远程环境的差异，并兼顾 Windows、macOS 和 Linux。
- Zustand 状态位于 `packages/ui/src/store/`。广播同步的主题、语言等字段需要防止回环；UI 局部状态不应被误当作服务端事实。
- hooks 中含 JSX 的文件使用 `.tsx`。

## 进程、协议与远程控制

- Desktop app 通过 stdio 与 Agent 通信。协议改动同步更新 `packages/shared/src/zcode-protocol/index.ts`，提供严格类型与运行时校验。
- Main 负责窗口、原生操作、进程调度和消息转发，不承载 task/session 业务状态。
- 每个窗口使用一个 window-scoped Local Host；本地 workspace 共享该 Host。远程 workspace 由窗口内的连接注册表管理，不另建 Desktop Remote Host。
- 手机远控连接桌面已有 Host attachment，复用会话运行时；不为手机另起 Agent、Local Host 或远程会话。
- Desktop 的 `desktop-continuous` 实时链路与手机的 `web-remote-replayable` 恢复链路必须明确区分。修改 stream、snapshot、queue 或重连时，同时验证两种语义。
- 外部 relay 与 Main 只做鉴权、配对、心跳、转发及 attachment 调度，不保存任务队列、快照等业务状态。
- 已接受的 busy/running 输入由 CLI/runtime `CommandInbox` 串行 admission；Renderer 只保留未提交草稿与 pending optimistic overlay，Host owner/lease 负责路由。
- 保留 owner/lease、跨 Host 路由和 stale run 防护，不能仅根据单一路径删除边界判断。

## Workspace Identity

- `workspaceIdentity` 用于身份隔离，`workspacePath` 用于文件操作、命令 cwd、Git 和路径展示。
- 身份 key 统一为 `workspaceIdentity?.trim() || workspacePath`，适用于去重、绑定、缓存、队列、持久化和请求关联。
- 远程链路贯穿传递 `workspaceIdentity` 与 `remoteSessionId`，不得仅按路径匹配。
- 新接口保留本地路径 fallback；远程 identity 复用现有构造和解析工具，不在业务代码中手写格式。

## 日志

- UI 使用 `packages/ui/src/logger.ts`，不直接使用 `console.log` 或 `window.zcode?.log`。
- Agent/session/runtime 相关服务日志使用 `createServiceLogger(scope)`（`packages/services/src/logger/serviceLogger.ts`）。
- `debug` 用于协议原始数据、流式 chunk 和逐条工具更新等高频诊断，生产环境不落盘。
- `info` 用于进程和会话生命周期、权限结果、一次性初始化等生产可用事件。
- `warn` 用于可恢复异常；`error` 用于崩溃、握手失败、鉴权丢失等不可恢复错误。
- 不在日志、示例或提交中写入凭据、真实用户数据和内部服务地址。

<!-- dw-workflow:start -->
> **本项目采用 dw-workflow**
> (collaboration="solo" merge-gate="direct" worktree-dir="./.worktrees/")
>
> 本块只放每个会话都要知道的规则与指针；每条规则的判据在它后面点名的 skill 里，到那一步 MUST 加载该 skill，MUST NOT 凭本块一句话推断判据。skill 在项目级或全局的 `<skills 根>/<名>/`（路径见 `dw-code-facts`）。按 RFC 2119 解释规范词。
>
> - **路由**：唤起 `dw-workflow` / `dw-prd` 时按本块字段路由，MUST NOT 再问一次。有没有代码图谱索引由 skill 每次运行探测，MUST NOT 写死在本块。
> - **两条总纲**（展开在 `dw-workflow` 入口）：一个事实只有一个家，别处只放链接；规范文本有体积上限，超限先搬走、再压缩、最后才抬上限。
> - **落盘前 MUST 先建独立 worktree**（`dw-worktree`）：任何文档或代码落盘前，Lean 也不例外；多仓每仓一个。目录取本块 `worktree-dir`，每次从这里读；换位置 MUST 改本字段，MUST NOT 临时另建目录。MUST NOT 在主工作树直接改，MUST NOT stash / reset 用户既有改动。
> - **查代码事实 MUST 先用 `ctx`**（`dw-code-facts`）：`ctx find-scenes <关键词>` → `ctx discover "<意图>"` → `ctx get-card <repo> [域]`，每条事实 MUST 附 cite（`路径#符号` + 确认时间），无 cite 视为幻觉。查不到卡片 → 读源码核实并当场补卡（最小四节：职责 / 权威实现与对外接口 / 陷阱项 / 确认）、随本次分支提交，MUST NOT 顺延。`ctx` 命令找不到时用 `node <skills 根>/dw-code-facts/scripts/ctx/src/cli.js <命令>`。两种情况都 MUST NOT 退回 grep 找权威实现。`engineering-context/` 没有开关，起步只有模板占位是正常状态。
> - **bug、回归、异常行为**：改代码前 MUST 先造出能变红的复现回路（`dw-bug-diagnosis`）。
> - **AI MUST NOT 默认向后兼容**：spec 定稿前把被改变的既有行为逐条列出送拍板；被取代的旧函数 / 文件 / 配置 / 开关当场删除，保留项 MUST 带理由与到期日并登记进替换清单（`dw-workflow` 的 `确认门.md`、`dw-review-gate` 的 `替换清单.md`）。
> - **spec 定稿后、动手实现前 MUST 过 spec 过稿门**（`dw-workflow` 的 `确认门.md`）：只请拍板人看业务可判定的部分；他没回复 MUST NOT 推进；跳过只认他自己说"这次不用看"，且只对本次有效。
> - **改动落盘后（含只改 `docs/`）MUST 过代码评审门**（`dw-review-gate`）：判对象面 → 推评审轴 → 派子代理 → P0 / P1 修完；三个对象面都不命中时轴集合只有文档轴，MUST NOT 跳过本门。够小的改动 MAY 按该 skill 的规则登记积压；未过门也未登记积压时 MUST NOT 合并。
> - **写方案与写代码 MUST 守 YAGNI / KISS / DRY / LoD**（`dw-workflow` 的 `实现纪律.md` §设计原则）：没有需求对应的抽象、开关、配置项不写。
> - **纯 skill 改动**（范围不含可执行代码文件）：PRD 即 spec，动手前 MUST 加载 `skill-principle`；跳过的是产物，不是门（`dw-workflow` 的 `纯skill改动.md`）。
> - **文档**（`dw-doc-governance`）：spec → `docs/spec/`，plan → `docs/plan/`，report → `docs/report/`，决策记录 → `docs/decisions/`；新建文档 frontmatter MUST 带 `lifecycle: active` 与 `authority_refs`；`docs/index.md` 只放现行口径。需求真相源只写已实现的现状，还没做的去 `docs/TODO.md`。
> - **写或精简规范文本、注释、卡片、提示词**：按 `dw-prose`——删改前保住每条命题，只写现状，来历进决策记录。
> - **每次合并 MUST 在仓库根 `CHANGELOG.md` 的 `## 未发布` 下至少写一条**，在评审门之前写好；分类是闭集 `不兼容` / `新增` / `变更` / `修复` / `内部`，MUST NOT 自造，对外不可见的写 `内部`，MUST NOT 以"本次无对外变化"为由不写；升级上游前 MUST 先读 `engineering-context/dependencies/` 下它的依赖声明（`dw-code-facts`）。`direct` 下 AI MUST NOT 替拍板人定版本号或打 tag；`pr` 下合并即发。
> - **合并方式只读本块 `merge-gate`，与协作面无关**（`dw-worktree`）：`direct` 为全部门禁通过后本地非快进合并并清理 worktree；`pr` 为过评审门后开 PR，平台放行后才合并——本门是 PR 前的地板，MUST NOT 替代人审，平台未放行 MUST NOT 改用本地直合。合并失败 MUST 保留 worktree，MUST NOT 强推，MUST NOT 绕过保护分支。
> - **真实数据**固化进项目既有测试目录，没有则 `tests/fixtures/<场景名>/`，凭证进同级 `secrets/` 并 gitignore、脱敏副本入库；未覆盖的重要场景挂账到 `docs/report/测试场景覆盖度.md`；长链路 MUST 有断言中间结果的端到端用例（`dw-workflow` 的 `测试资产纪律.md`）。
> - **Agentic 应用**（命中任一即是：模型自主规划、直接调工具、未过确定性闸门就改状态、记忆跨会话影响决策）MUST 加载 `agentic-principle`；**新建或改动 skill** MUST 加载 `skill-principle`。两者是伴生 skill，判据以它们当前版本为准。
> - **与用户只用业务语言**：大架构 MUST 交用户确认，模块内设计只问业务问题，详细程序设计不要求用户确认（`dw-workflow` 的 `用户沟通纪律.md`）。
> - 本项目没有其他人类协作方：MUST NOT 向不存在的 owner 求证，MUST NOT 开评审会，MUST NOT 因等**第三方**（owner / 业务方 / 评审人）确认而挂起任务；**用户本人的兼容取舍拍板、用户本人在 spec 过稿门的表态、以及合并方式为 `pr` 时的平台审批与 CI 除外**（这些例外是门，不是对齐开销；前两者是仅有的两个允许因等用户而挂起的流程内点，MUST NOT 因为"只有我一个人用"就跳过）。需要第二意见时派子代理，不等人。
> - **兼容取舍每次由你（开发者本人）拍板**，AI MUST NOT 代拍，也 MUST NOT 因为"只有我一个人用"就跳过这次拍板。
> - 合并方式为 `pr` 时，PR 的审批人就是你本人：MUST 把 PR 链接与各轴报告结论交给你过目并请你放行，MUST NOT 静默等待外部审批；CI 失败按常规修复后重推，MUST NOT 改用本地直合。
<!-- dw-workflow:end -->

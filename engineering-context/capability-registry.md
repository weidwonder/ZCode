# Capability Registry — 产品能力到权威代码实体的映射

> 精简骨架；完整字段说明与填写指南见 dw-code-facts skill 的 assets/context-layer/capability-registry.md。
> 代码事实层（"信哪个"）的核心资产，**每个装了本体系的项目都维护它**。人工确认。
> 事实以源码为准，PRD 仅作 scope + 业务语境。每条带 freshness 与理由链。
> 只剩【】占位行是**正常起步态**：内容按任务渐进补齐（见 references/代码事实纪律.md §4），
> MUST NOT 因为表是空的就告警、或退回裸 grep 找权威实现。
> 下面两张表**填哪张都算，解析器会合并**（表头首列命中 Capability/能力的表全部解析）：
> 三列是 MUST，十列表里的其余列是 MAY——缺列跳过不报错，没有 freshness 列的条目输出标注「未声明新鲜度」。
> **第三列 MUST NOT 省**——它是最小 schema 里唯一的防误用装置，省掉就挡不住"改错了那个"。

## 最小合法 schema（起步用这个）

| Capability | 权威实现 | 陷阱项（废弃或中间产物） |
|---|---|---|
| 【能力，如 背单词记录】 | 【现在该改/该调的那一个，如 POST /v2/word/record 或 src/word/record.ts】 | 【相似但不该用的旧实现，如 POST /v1/word/record；确实没有就写 无】 |

## 能力表（完整形态）

| Capability | 业务含义 | 权威仓库 | 权威接口(含版本) | 废弃/中间产物替代 | 兼容窗口 | owner | 测试入口 | freshness(最近确认) | 理由链 |
|---|---|---|---|---|---|---|---|---|---|
| 【能力】 | 【含义】 | 【repo】 | 【POST /v2/xxx】 | 【旧接口不可用】 | 【切点】 | 【owner】 | 【测试入口】 | 【YYYY-MM-DD / PR】 | 【诞生压力】 |

/* 本机任务 API 的 Host 侧应答器：Main 按 workspace 路由转发过来的请求在这里
 * 调用本 Host 的 IZCodeTaskService。九个 op 的业务语义、事件 ring buffer 与
 * 长轮询都收敛在本文件；Main 只做传输与鉴权，不承载任务业务状态。 */
import { randomUUID } from "node:crypto";
import { IModelSelectionService, IZCodeTaskService, type ServiceCollection } from "@zcode/services";
import type {
  HostLocalTaskApiRequestMessage,
  HostLocalTaskApiResponseMessage,
  ModelSelection,
} from "@zcode/shared";

/** 只依赖本 API 用到的任务服务面；签名随 IZCodeTaskService 演进。 */
export type LocalTaskApiTaskService = Pick<
  IZCodeTaskService,
  | "createTask"
  | "sendPrompt"
  | "stopGeneration"
  | "getTaskSnapshot"
  | "getTaskMeta"
  | "listTasks"
  | "listActiveTaskIds"
  | "renameTask"
  | "setModel"
  | "onDynamicTaskEvent"
  | "onDynamicTaskTerminalOutcome"
>;

export type LocalTaskApiEvent =
  | { seq: number; type: "turn.started"; at: number; turnId: string }
  | { seq: number; type: "assistant.message"; at: number; text: string }
  | { seq: number; type: "turn.completed"; at: number; text: string }
  | { seq: number; type: "turn.failed"; at: number; error: string }
  | { seq: number; type: "permission.requested"; at: number; summary: string }
  | { seq: number; type: "input.queued"; at: number; commandId: string }
  | { seq: number; type: "input.steered"; at: number; commandId: string }
  | { seq: number; type: "steer.injected"; at: number }
  | { seq: number; type: "steer.fellBack"; at: number; error: string };

export interface LocalTaskApiEventsResult {
  events: LocalTaskApiEvent[];
  nextSeq: number;
  resync?: true;
}

/** appendEvent 入参：分配式去掉各成员的 seq、at（at 可选注入）。 */
type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never;
type LocalTaskApiEventInput = DistributiveOmit<LocalTaskApiEvent, "seq" | "at"> & { at?: number };

const MAX_EVENTS_PER_TASK = 500;

interface TaskEventBuffer {
  seq: number;
  events: LocalTaskApiEvent[]; // 已按 seq 升序，超上限丢最老
  /** 挂起中的长轮询：各记自己的 after 水位，唤醒时只投递它没读过的事件。 */
  waiters: Array<{ resolve: (result: LocalTaskApiEventsResult) => void; after: number }>;
  subscriptions: Array<{ dispose(): void }>; // onDynamicTaskEvent + onDynamicTaskTerminalOutcome 的退订句柄
  /** 上一次 turn.failed 的投递时刻；1 秒内的重复 failed（流事件 + 终态）只发一次。 */
  lastFailedAt?: number;
}

export interface LocalTaskApiResponder {
  handleRequest(msg: HostLocalTaskApiRequestMessage): Promise<void>;
}

type ModelSelectionResolution =
  | { ok: true; selection: ModelSelection }
  | { ok: false; status: 400; body: { error: "invalid_model_selection"; message: string } };

/** create/setModel 的模型选择预检与补齐（GUI 同源）：
 * 1) getView({selection}) 让服务端解析——provider/model 不存在、账号态不可用、给了不支持的档位
 *    → 400 invalid_model_selection（可判定的请求参数错误，不再落到 503）；
 * 2) reasoning-level-missing → 按 GUI 新建对话同一默认补最高档（completeNewModelSelection 的
 *    values.at(-1)，provider/src/model-selection-config.ts:58-73；GUI 调用先例
 *    useDraftConfigControl.ts:545-557）；模型无档位可补时透传原样（CLI 对无档位模型不要求）；
 * 3) 无 issue → 透传 effectiveSelection（服务端规范化，account-plan providerId 归一）。
 * 模型服务缺失时不阻断：透传原样交由既有路径（CLI 侧报错按 503 表现）。 */
async function resolveModelSelectionForOp(
  modelSelectionService: Pick<IModelSelectionService, "getView"> | null,
  selection: ModelSelection,
): Promise<ModelSelectionResolution> {
  if (!modelSelectionService) return { ok: true, selection };
  const view = await modelSelectionService.getView({ selection });
  const issue = view.selectionIssue;
  if (
    issue === "provider-not-found" ||
    issue === "model-not-found" ||
    issue === "account-connection-unavailable" ||
    issue === "reasoning-level-not-supported"
  ) {
    return { ok: false, status: 400, body: { error: "invalid_model_selection", message: issue } };
  }
  if (issue === "reasoning-level-missing") {
    // 账号档 providerId 已在服务端归一：按归一后的身份找候选；找不到回落请求原值。
    const providerId = view.effectiveSelection?.providerId ?? selection.providerId;
    const spec = view.providers
      .find((p) => p.providerId === providerId)
      ?.models.find((m) => m.modelId === selection.modelId)
      ?.config.optionSpecs?.reasoningLevel; // 类型上必有、运行时可能缺：可选链是防御
    const defaultLevel = spec?.values?.at(-1);
    if (defaultLevel === undefined) return { ok: true, selection };
    return {
      ok: true,
      selection: { ...selection, options: { ...selection.options, reasoningLevel: defaultLevel } },
    };
  }
  // 无 issue 或 "selection-missing"（防御，op 侧必有选择）：透传服务端规范化结果。
  return { ok: true, selection: view.effectiveSelection ?? selection };
}

export function createLocalTaskApiResponder(deps: {
  getServices: () => ServiceCollection | null;
  post: (message: HostLocalTaskApiResponseMessage) => void;
  /** 诊断日志出口（Host 侧 logger）；出站 body 只带固定文案，原始错误只进这里。 */
  log?: (message: string) => void;
  /** 终态后延迟修剪的等待时长；默认 10 分钟。测试注入小值即可验证。 */
  terminalPruneDelayMs?: number;
  now?: () => number; // 测试注入，默认 Date.now
  randomUUID?: () => string; // 测试注入，默认 node:crypto 的 randomUUID
}): LocalTaskApiResponder {
  const now = deps.now ?? Date.now;
  const newUUID = deps.randomUUID ?? randomUUID;
  /** taskId → 事件缓冲；只对本 API 创建/查询过的任务缓冲事件。 */
  const buffers = new Map<string, TaskEventBuffer>();

  function reply(requestId: string, ok: boolean, status: number, body: unknown): void {
    deps.post({ type: "local-task-api-response", requestId, ok, status, body });
  }

  function notifyWaiters(buffer: TaskEventBuffer): void {
    const waiters = buffer.waiters.splice(0, buffer.waiters.length);
    if (waiters.length === 0) return;
    // 每个 waiter 按它自己的 after 过滤：只投递它没读过的事件（buffer 满重发整段时不再带上已读重复）。
    for (const waiter of waiters) {
      waiter.resolve({
        events: buffer.events.filter((event) => event.seq > waiter.after),
        nextSeq: buffer.seq,
      });
    }
  }

  /** buffer 不存在则忽略（未订阅的任务不缓冲）。 */
  function appendEvent(taskId: string, event: LocalTaskApiEventInput): void {
    const buffer = buffers.get(taskId);
    if (!buffer) return;
    buffer.seq += 1;
    buffer.events.push({ ...event, seq: buffer.seq, at: event.at ?? now() });
    if (buffer.events.length > MAX_EVENTS_PER_TASK) {
      buffer.events.splice(0, buffer.events.length - MAX_EVENTS_PER_TASK);
    }
    notifyWaiters(buffer);
  }

  /** task_error 流事件与 failed 终态可能都到：同 task 两次 failed 间隔 <1s 只发一次。 */
  function appendTurnFailed(taskId: string, error: string): void {
    const buffer = buffers.get(taskId);
    if (!buffer) return;
    const at = now();
    if (buffer.lastFailedAt !== undefined && at - buffer.lastFailedAt < 1000) return;
    buffer.lastFailedAt = at;
    appendEvent(taskId, { type: "turn.failed", error });
  }

  /** 纯函数：快照里反向找最后一条 assistant 文本；null 快照或无 assistant 消息返回 ""。 */
  function lastAssistantTextFromSnapshot(
    snapshot: Awaited<ReturnType<LocalTaskApiTaskService["getTaskSnapshot"]>>,
  ): string {
    if (!snapshot) return "";
    for (let i = snapshot.messages.length - 1; i >= 0; i -= 1) {
      const message = snapshot.messages[i]!;
      if (message.role === "assistant") return message.content;
    }
    return "";
  }

  /** 已存在直接返回；否则建 buffer 并挂两个订阅。失败向上抛：create 只记 log 不回滚，events/懒订阅路径交给外层 503。 */
  function ensureSubscriptions(
    taskService: LocalTaskApiTaskService,
    workspacePath: string,
    taskId: string,
  ): TaskEventBuffer {
    const existing = buffers.get(taskId);
    if (existing) return existing;
    const buffer: TaskEventBuffer = { seq: 0, events: [], waiters: [], subscriptions: [] };
    buffers.set(taskId, buffer);
    try {
      buffer.subscriptions.push(
        taskService.onDynamicTaskEvent({ workspacePath, taskId })((event) => {
          if (event.type === "task_run_started") {
            appendEvent(taskId, {
              type: "turn.started",
              turnId: event.turnId ?? "",
            });
          } else if (event.type === "permission_request") {
            // summary 用事件真实字段：kind + title（缺省回落 description）；恒 undefined 的 toolName 已删。
            appendEvent(taskId, {
              type: "permission.requested",
              summary: `${event.kind} ${event.title ?? event.description}`.trim(),
            });
          } else if (event.type === "task_complete") {
            // 快照读失败（异常/null）时 text 用 ""，仍发两条；事件路径单次读快照。
            void taskService
              .getTaskSnapshot({ taskId, workspacePath })
              .catch(() => null)
              .then((snapshot) => {
                const text = lastAssistantTextFromSnapshot(snapshot);
                appendEvent(taskId, { type: "assistant.message", text });
                appendEvent(taskId, { type: "turn.completed", text });
              });
          } else if (event.type === "task_error") {
            appendTurnFailed(taskId, String((event as { error?: unknown }).error ?? "task failed"));
          } else if (event.type === "turn_steer_queued") {
            // CLI 已把 guide 请求排入引导：事件 inputId=envelope.commandId=202 应答的 commandId，
            // 与应答可对账；pendingInputId 是 "queue_<commandId>"（admission 加前缀），不相等。
            // 旧 CLI 形状无 inputId 时回落 pendingInputId 兜底。
            appendEvent(taskId, { type: "input.steered", commandId: event.inputId ?? event.pendingInputId });
          } else if (event.type === "turn_steer_status") {
            if (event.status === "drained") {
              appendEvent(taskId, { type: "steer.injected" });
            } else if (event.status === "discarded" || event.status === "rejected") {
              appendEvent(taskId, { type: "steer.fellBack", error: event.reason ?? event.status });
            }
          }
          // 其它流事件类型全部忽略
        }),
        taskService.onDynamicTaskTerminalOutcome(taskId)((outcome) => {
          if (outcome.outcome === "failed") {
            appendTurnFailed(taskId, outcome.error ?? "task failed");
          } else if (outcome.outcome === "stopped") {
            appendEvent(taskId, { type: "turn.completed", text: "" });
          }
          // succeeded：task_complete 流事件已覆盖，不重复发
          // 终态后延迟修剪：释放流订阅并整体移除 buffer，避免长驻进程累积每任务缓冲。
          // 修剪后再到的流事件按"无 buffer"忽略；客户端再查 events 会懒建新 buffer。
          // 同一 buffer 多次终态会排多个 timer——幂等，无害。
          setTimeout(() => {
            for (const subscription of buffer.subscriptions) {
              try {
                subscription.dispose();
              } catch {
                // 已释放
              }
            }
            buffer.subscriptions.length = 0;
            buffer.events.length = 0;
            buffers.delete(taskId);
          }, deps.terminalPruneDelayMs ?? 600_000).unref?.();
        }),
      );
    } catch (error) {
      for (const subscription of buffer.subscriptions) {
        try {
          subscription.dispose();
        } catch {
          // 退订失败不影响向上抛原始错误
        }
      }
      buffers.delete(taskId);
      throw error;
    }
    return buffer;
  }

  async function readSnapshotStatus(
    taskService: LocalTaskApiTaskService,
    op: Extract<HostLocalTaskApiRequestMessage["op"], { kind: "get" }>,
    snapshot: Awaited<ReturnType<LocalTaskApiTaskService["getTaskSnapshot"]>>,
  ): Promise<string> {
    if (!snapshot) return "idle";
    // ZCodeTaskSnapshot["runtime"] 类型自带 pendingPermissions / pendingElicitations，直接访问。
    if (snapshot.runtime?.pendingPermissions?.length) return "waiting_permission";
    if (snapshot.runtime?.pendingElicitations?.length) return "waiting_input";
    if ((await taskService.listActiveTaskIds({ workspacePath: op.workspacePath })).includes(op.taskId)) {
      return "running";
    }
    if (snapshot.meta.status === "error") return "error";
    return "idle";
  }

  async function dispatch(
    taskService: LocalTaskApiTaskService,
    modelSelectionService: Pick<IModelSelectionService, "getView"> | null,
    op: HostLocalTaskApiRequestMessage["op"],
  ): Promise<{ status: number; body: unknown }> {
    if (op.kind === "create") {
      // 模型选择预检与补齐（GUI 同源默认档位）：可判定的参数错误按 400 拒绝，不落 503。
      let modelSelection = op.modelSelection;
      if (op.modelSelection) {
        const resolved = await resolveModelSelectionForOp(modelSelectionService, op.modelSelection);
        if (!resolved.ok) return { status: resolved.status, body: resolved.body };
        modelSelection = resolved.selection;
      }
      const created = await taskService.createTask({
        workspacePath: op.workspacePath,
        deferPersistenceUntilFirstPrompt: true,
        ...(op.mode ? { mode: op.mode } : {}),
        // modelSelection 透传预检/补齐后的选择（IZCodeTaskService.createTask 正式字段；deprecated 的 model/thoughtLevel 不用）。
        ...(modelSelection ? { modelSelection } : {}),
      });
      // 订阅先行：首条 prompt 与 rename 的结果事件都要能进 buffer；失败不回滚 create，
      // 后续首次 events 调用会懒订阅兜底。
      try {
        ensureSubscriptions(taskService, op.workspacePath, created.taskId);
      } catch (error) {
        deps.log?.(
          `local task api: subscription setup failed after create (taskId=${created.taskId}): ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      // 首条 prompt 失败也不吞 taskId：任务已建（副作用可见、可接续），warning 告知调用方。
      let firstPromptFailed = false;
      try {
        await taskService.sendPrompt({
          taskId: created.taskId,
          traceId: created.traceId,
          content: op.prompt,
          clientMode: "desktop-continuous",
        });
      } catch (error) {
        firstPromptFailed = true;
        deps.log?.(
          `local task api: first prompt failed (taskId=${created.taskId}): ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      // rename 放在首条 prompt 之后：deferPersistenceUntilFirstPrompt 下 session 随首条
      // prompt 才落盘，此前 renameTask（底层 v4 renameSession）会报
      // "Session not found after write"（真机日志实锤）。首条 prompt 已失败时 session
      // 仍可能未落盘，跳过 rename，避免再一次必然失败。
      let renameFailed = false;
      if (op.title && !firstPromptFailed) {
        try {
          await taskService.renameTask({
            taskId: created.taskId,
            workspacePath: op.workspacePath,
            title: op.title,
          });
        } catch (error) {
          // 改名失败不致命：继续，warning 告知调用方。
          renameFailed = true;
          deps.log?.(
            `local task api: rename failed after create (taskId=${created.taskId}): ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
      // warning 按严重度只取一：首条 prompt 失败重于改名失败。
      const warning = firstPromptFailed ? "first_prompt_failed" : renameFailed ? "rename_failed" : undefined;
      return { status: 201, body: { taskId: created.taskId, ...(warning ? { warning } : {}) } };
    }

    if (op.kind === "send") {
      // 归属校验：Main 侧外部提供的 workspacePath 在这里核实（getTaskMeta 按
      // workspace 查不到该任务即 404）；归属表命中的请求也会再走一次，成本是一次轻量 meta 读。
      const meta = await taskService.getTaskMeta({ taskId: op.taskId, workspacePath: op.workspacePath });
      if (!meta) return { status: 404, body: { error: "task_not_found" } };
      // 空闲任务收到 steer：CLI 空闲分支不看 delivery、直接普通起轮且不发 steer 事件——按
      // 实际去向应答 sent（拍板 r6-52 #2②），普通发送不发 guide；运行中才交 CLI guide 裁决。
      let effectiveDelivery = op.delivery;
      if (op.delivery === "steer") {
        const active = await taskService.listActiveTaskIds({ workspacePath: op.workspacePath });
        if (!active.includes(op.taskId)) {
          effectiveDelivery = "auto";
        }
      }
      // 与 GUI 运行中发送同一条链路：v4 sendText 的 requestedDelivery 交给 CLI inputRouting
      // 裁决（guide→steering 裁决 steered/fellBack，queue→入队，缺省→按会话 followupMode）。
      // auto 不带参数=跟随会话 followupMode（GUI 运行中默认发送行为）；
      // queue=入队；steer=guide（运行中即时引导注入，CLI 权威裁决，结果经流事件回报）。
      const commandId = newUUID();
      await taskService.sendPrompt({
        taskId: op.taskId,
        traceId: commandId,
        content: op.text,
        clientMode: "desktop-continuous",
        ...(effectiveDelivery === "queue" ? { requestedDelivery: "queue" as const } : {}),
        ...(effectiveDelivery === "steer" ? { requestedDelivery: "guide" as const } : {}),
      });
      // 受理即补订阅：保证 steer 的权威流事件（input.steered / steer.*）能进 buffer；
      // 失败不致命（首次 events 调用懒订阅兜底），只是这批事件可能不被记录。
      try {
        ensureSubscriptions(taskService, op.workspacePath, op.taskId);
      } catch {
        // 懒订阅兜底由首次 events 调用承担
      }
      // auto/queue 的受理事件自产（CLI 无对应专属流事件）；steer 的 input.steered 统一由
      // turn_steer_queued 流事件投影发出（CLI 事件的 inputId=envelope.commandId 即我们的
      // commandId，可与 202 应答对账；旧 CLI 无 inputId 时回落 pendingInputId）。
      if (effectiveDelivery !== "steer") {
        appendEvent(op.taskId, { type: "input.queued", commandId });
      }
      return {
        status: 202,
        body: {
          delivery:
            effectiveDelivery === "auto"
              ? "sent"
              : effectiveDelivery === "queue"
                ? "queued"
                : "steered",
          commandId,
        },
      };
    }

    if (op.kind === "stop") {
      // 归属校验：Main 侧外部提供的 workspacePath 在这里核实（getTaskMeta 按
      // workspace 查不到该任务即 404）；归属表命中的请求也会再走一次，成本是一次轻量 meta 读。
      const meta = await taskService.getTaskMeta({ taskId: op.taskId, workspacePath: op.workspacePath });
      if (!meta) return { status: 404, body: { error: "task_not_found" } };
      await taskService.stopGeneration({ taskId: op.taskId, workspacePath: op.workspacePath });
      return { status: 202, body: { ok: true } };
    }

    if (op.kind === "get") {
      const snapshot = await taskService.getTaskSnapshot({
        taskId: op.taskId,
        workspacePath: op.workspacePath,
      });
      if (!snapshot) return { status: 404, body: { error: "task_not_found" } };
      const status = await readSnapshotStatus(taskService, op, snapshot);
      const lastAssistantText = lastAssistantTextFromSnapshot(snapshot);
      const turnCount = snapshot.messages.filter((message) => message.role === "assistant").length;
      return {
        status: 200,
        body: {
          taskId: op.taskId,
          workspacePath: op.workspacePath,
          title: snapshot.meta.title ?? "",
          status,
          turnCount,
          lastAssistantText,
          updatedAt: snapshot.meta.updatedAt,
        },
      };
    }

    if (op.kind === "events") {
      // 归属校验：Main 侧外部提供的 workspacePath 在这里核实（getTaskMeta 按
      // workspace 查不到该任务即 404）；归属表命中的请求也会再走一次，成本是一次轻量 meta 读。
      const meta = await taskService.getTaskMeta({ taskId: op.taskId, workspacePath: op.workspacePath });
      if (!meta) return { status: 404, body: { error: "task_not_found" } };
      // buffer 已存在走原逻辑（filter / resync 判定 / 长轮询）；不存在（含终态释放后的
      // 懒重建）先 ensure，保证后续事件开始被收集，再按水位分流：
      // 终态释放后 seq 从 1 重新计，after>0 的旧水位只能让客户端 resync（先 GET 对账，
      // 再从当前 nextSeq 重新跟）；after=0 即从头开始跟，无历史承诺。
      const existingBuffer = buffers.get(op.taskId);
      if (!existingBuffer) {
        ensureSubscriptions(taskService, op.workspacePath, op.taskId);
        if (op.after > 0) return { status: 200, body: { resync: true } };
        return { status: 200, body: { events: [], nextSeq: 0 } };
      }
      const buffer = existingBuffer;
      const events = buffer.events.filter((event) => event.seq > op.after);
      const nextSeq = buffer.seq;
      // 客户端落后太多（最老事件已丢弃）→ 只能整体重同步。
      if (op.after > 0 && buffer.events.length > 0 && op.after < buffer.events[0]!.seq - 1) {
        return { status: 200, body: { resync: true } };
      }
      if (events.length > 0) return { status: 200, body: { events, nextSeq } };
      if (op.waitMs === 0) return { status: 200, body: { events: [], nextSeq } };
      const result = await new Promise<LocalTaskApiEventsResult>((resolve) => {
        const waiter = { resolve, after: op.after };
        buffer.waiters.push(waiter);
        // 超时路径 resolve 空事件：仍挂起=没有新于 after 的事件到达（老事件请求发出时已读过）。
        setTimeout(() => {
          const index = buffer.waiters.indexOf(waiter);
          if (index >= 0) buffer.waiters.splice(index, 1);
          resolve({ events: [], nextSeq: buffer.seq });
        }, op.waitMs);
      });
      return { status: 200, body: result };
    }

    if (op.kind === "listModels") {
      // 模型候选与 GUI 新建对话同源：IModelSelectionService.getView() 的 providers[].models[]
      // （GUI 分组展示见 ui/src/lib/modelSelectionGroups.ts#buildRegistryModelSelectGroups，模型
      // 显示名即 modelId）；思考档位读模型 config.optionSpecs.reasoningLevel.values（GUI 投影
      // 先例 ui/src/lib/modelThoughtOption.ts#resolveModelThoughtOption，缺失/空 → 该模型无
      // 档位）；默认选择透传 view.preferredSelection（automation 先例
      // host/automationModelSelection.ts）。不做 GUI 的 selectedProvider 菜单过滤——
      // view.providers 本身就是 Environment Registry 的执行目录。
      if (!modelSelectionService) return { status: 503, body: { error: "unavailable_host" } };
      const view = await modelSelectionService.getView();
      const preferred = view.preferredSelection;
      return {
        status: 200,
        body: {
          providers: view.providers.map((provider) => ({
            providerId: provider.providerId,
            displayName: provider.providerName?.trim() || provider.providerId,
            models: provider.models.map((model) => {
              // optionSpecs 类型上必有（completeModelConfigDataSchema），可选链是配置解析缺口的防御。
              const thoughtLevels = model.config.optionSpecs?.reasoningLevel?.values ?? [];
              const defaultThoughtLevel = thoughtLevels.at(-1);
              return {
                modelId: model.modelId,
                displayName: model.modelId,
                thoughtLevels,
                // GUI 新建对话的默认档位同源：completeNewModelSelection 取 values.at(-1)（最高档）；
                // 无档位模型（thoughtLevels 为空）不给该字段。
                ...(defaultThoughtLevel !== undefined ? { defaultThoughtLevel } : {}),
                isDefault:
                  preferred?.providerId === provider.providerId &&
                  preferred?.modelId === model.modelId,
              };
            }),
          })),
          ...(preferred ? { preferred } : {}),
        },
      };
    }

    if (op.kind === "setModel") {
      // 归属校验：与 send/stop/events 同一模式（重锚定语义）。
      const meta = await taskService.getTaskMeta({ taskId: op.taskId, workspacePath: op.workspacePath });
      if (!meta) return { status: 404, body: { error: "task_not_found" } };
      // 模型选择预检与补齐（GUI 同源默认档位）：归属校验在前，可判定的参数错误按 400 拒绝。
      const resolved = await resolveModelSelectionForOp(modelSelectionService, op.modelSelection);
      if (!resolved.ok) return { status: resolved.status, body: resolved.body };
      // 运行中允许换模型——与 GUI 一致（GUI 仅 Highspeed 卡激活时锁定，SessionPane.tsx 的
      // handleSelectModel；Highspeed 是 UI 运行态，Host 侧不可见，agent 侧拒绝时经外层 503 表现）。
      await taskService.setModel({ taskId: op.taskId, traceId: newUUID(), modelSelection: resolved.selection });
      return { status: 200, body: { ok: true } };
    }

    // op.kind === "list"
    const tasks = await taskService.listTasks({ workspacePath: op.workspacePath });
    const activeIds = new Set(await taskService.listActiveTaskIds({ workspacePath: op.workspacePath }));
    return {
      status: 200,
      body: {
        tasks: tasks.map((task) => ({
          taskId: task.taskId,
          title: task.title ?? "",
          status: activeIds.has(task.taskId) ? ("running" as const) : ("idle" as const),
          updatedAt: task.updatedAt,
        })),
      },
    };
  }

  return {
    async handleRequest(msg) {
      const services = deps.getServices();
      const taskService = services?.getOptional(IZCodeTaskService) ?? null;
      if (!taskService) {
        reply(msg.requestId, true, 503, { error: "unavailable_host" });
        return;
      }
      const modelSelectionService = services?.getOptional(IModelSelectionService) ?? null;
      try {
        const { status, body } = await dispatch(taskService, modelSelectionService, msg.op);
        reply(msg.requestId, true, status, body);
      } catch (error) {
        // 出站只带固定文案，不外泄内部错误文本；原始错误经 log 输出一行。
        deps.log?.(
          `local task api op failed (${msg.op.kind} ${msg.requestId}): ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        reply(msg.requestId, false, 503, { error: "unavailable_host" });
      }
    },
  };
}

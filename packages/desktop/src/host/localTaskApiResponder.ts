/* 本机任务 API 的 Host 侧应答器：Main 按 workspace 路由转发过来的请求在这里
 * 调用本 Host 的 IZCodeTaskService。六个 op 的业务语义、事件 ring buffer 与
 * 长轮询都收敛在本文件；Main 只做传输与鉴权，不承载任务业务状态。 */
import { randomUUID } from "node:crypto";
import { IZCodeTaskService, type ServiceCollection } from "@zcode/services";
import type {
  HostLocalTaskApiRequestMessage,
  HostLocalTaskApiResponseMessage,
} from "@zcode/shared";

/** 只依赖本 API 用到的任务服务面；签名随 IZCodeTaskService 演进。 */
export type LocalTaskApiTaskService = Pick<
  IZCodeTaskService,
  | "createTask"
  | "sendPrompt"
  | "enqueueTaskCommand"
  | "promoteTaskCommand"
  | "stopGeneration"
  | "getTaskSnapshot"
  | "getTaskMeta"
  | "listTasks"
  | "listActiveTaskIds"
  | "renameTask"
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
  | { seq: number; type: "input.steered"; at: number; commandId: string };

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
  waiters: Array<(result: LocalTaskApiEventsResult) => void>;
  subscriptions: Array<{ dispose(): void }>; // onDynamicTaskEvent + onDynamicTaskTerminalOutcome 的退订句柄
  /** 上一次 turn.failed 的投递时刻；1 秒内的重复 failed（流事件 + 终态）只发一次。 */
  lastFailedAt?: number;
}

export interface LocalTaskApiResponder {
  handleRequest(msg: HostLocalTaskApiRequestMessage): Promise<void>;
}

export function createLocalTaskApiResponder(deps: {
  getServices: () => ServiceCollection | null;
  post: (message: HostLocalTaskApiResponseMessage) => void;
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
    const result: LocalTaskApiEventsResult = { events: [...buffer.events], nextSeq: buffer.seq };
    for (const waiter of waiters) waiter(result);
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

  async function readLastAssistantText(
    taskService: LocalTaskApiTaskService,
    workspacePath: string,
    taskId: string,
  ): Promise<string> {
    const snapshot = await taskService.getTaskSnapshot({ taskId, workspacePath });
    if (!snapshot) return "";
    for (let i = snapshot.messages.length - 1; i >= 0; i -= 1) {
      const message = snapshot.messages[i]!;
      if (message.role === "assistant") return message.content;
    }
    return "";
  }

  /** 已存在直接返回；否则建 buffer 并挂两个订阅。订阅建立失败向上抛（create op 会 catch 清理）。 */
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
              turnId: (event as { turnId?: string }).turnId ?? "",
            });
          } else if (event.type === "permission_request") {
            const kind = (event as { kind?: string }).kind ?? "permission";
            const toolName = (event as { toolName?: string }).toolName;
            appendEvent(taskId, {
              type: "permission.requested",
              summary: `${kind}${toolName ? " " + toolName : ""}`,
            });
          } else if (event.type === "task_complete") {
            // 快照读失败（异常/null）时 text 用 ""，仍发两条。
            void readLastAssistantText(taskService, workspacePath, taskId)
              .catch(() => "")
              .then((text) => {
                appendEvent(taskId, { type: "assistant.message", text });
                appendEvent(taskId, { type: "turn.completed", text });
              });
          } else if (event.type === "task_error") {
            appendTurnFailed(taskId, String((event as { error?: unknown }).error ?? "task failed"));
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
    // runtime 字段类型上可能没有 pendingPermissions / pendingElicitations，按形状读取。
    const runtime = snapshot.runtime as
      | { pendingPermissions?: unknown[]; pendingElicitations?: unknown[] }
      | undefined;
    if (runtime?.pendingPermissions?.length) return "waiting_permission";
    if (runtime?.pendingElicitations?.length) return "waiting_input";
    if ((await taskService.listActiveTaskIds({ workspacePath: op.workspacePath })).includes(op.taskId)) {
      return "running";
    }
    if (snapshot.meta.status === "error") return "error";
    return "idle";
  }

  async function dispatch(
    taskService: LocalTaskApiTaskService,
    op: HostLocalTaskApiRequestMessage["op"],
  ): Promise<{ status: number; body: unknown }> {
    if (op.kind === "create") {
      const created = await taskService.createTask({
        workspacePath: op.workspacePath,
        deferPersistenceUntilFirstPrompt: true,
        ...(op.mode ? { mode: op.mode as never } : {}),
      });
      if (op.title) {
        try {
          await taskService.renameTask({
            taskId: created.taskId,
            workspacePath: op.workspacePath,
            title: op.title,
          });
        } catch {
          // 改名失败不致命：继续发送首条 prompt
        }
      }
      try {
        ensureSubscriptions(taskService, op.workspacePath, created.taskId);
      } catch (error) {
        buffers.delete(created.taskId);
        throw error;
      }
      await taskService.sendPrompt({
        taskId: created.taskId,
        traceId: created.traceId,
        content: op.prompt,
        clientMode: "desktop-continuous",
      });
      return { status: 201, body: { taskId: created.taskId } };
    }

    if (op.kind === "send") {
      const active = await taskService.listActiveTaskIds({ workspacePath: op.workspacePath });
      if (!active.includes(op.taskId)) {
        await taskService.sendPrompt({
          taskId: op.taskId,
          traceId: newUUID(),
          content: op.text,
          clientMode: "desktop-continuous",
        });
        return { status: 202, body: { delivery: "sent" } };
      }
      const commandId = newUUID();
      const traceId = newUUID();
      await taskService.enqueueTaskCommand({
        workspacePath: op.workspacePath,
        taskId: op.taskId,
        commandId,
        traceId,
        type: "send_prompt",
        content: op.text,
      });
      if (op.delivery === "steer") {
        await taskService.promoteTaskCommand({
          workspacePath: op.workspacePath,
          taskId: op.taskId,
          commandId,
          ownerRunId: traceId,
          clientMode: "desktop-continuous",
        });
        // appendEvent 前不需要 ensureSubscriptions——任务没 buffer 就忽略，正常。
        appendEvent(op.taskId, { type: "input.steered", commandId });
        return { status: 202, body: { delivery: "steered", commandId } };
      }
      appendEvent(op.taskId, { type: "input.queued", commandId });
      return { status: 202, body: { delivery: "queued", commandId } };
    }

    if (op.kind === "stop") {
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
      const lastAssistantText = await readLastAssistantText(taskService, op.workspacePath, op.taskId);
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
      // buffer 不存在时直接 ensure（新建空 buffer + 订阅），行为=从现在开始记事件。
      const buffer = ensureSubscriptions(taskService, op.workspacePath, op.taskId);
      const events = buffer.events.filter((event) => event.seq > op.after);
      const nextSeq = buffer.seq;
      // 客户端落后太多（最老事件已丢弃）→ 只能整体重同步。
      if (op.after > 0 && buffer.events.length > 0 && op.after < buffer.events[0]!.seq - 1) {
        return { status: 200, body: { resync: true } };
      }
      if (events.length > 0) return { status: 200, body: { events, nextSeq } };
      if (op.waitMs === 0) return { status: 200, body: { events: [], nextSeq } };
      const result = await new Promise<LocalTaskApiEventsResult>((resolve) => {
        buffer.waiters.push(resolve);
        setTimeout(() => {
          const index = buffer.waiters.indexOf(resolve);
          if (index >= 0) buffer.waiters.splice(index, 1);
          resolve({ events: [], nextSeq: buffer.seq });
        }, op.waitMs);
      });
      return { status: 200, body: result };
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
      try {
        const { status, body } = await dispatch(taskService, msg.op);
        reply(msg.requestId, true, status, body);
      } catch (error) {
        reply(msg.requestId, false, 503, {
          error: `local task api op failed: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    },
  };
}

import { describe, expect, it, vi } from "vitest";
import { IZCodeTaskService, ServiceCollection } from "@zcode/services";
import type { HostLocalTaskApiRequestMessage, HostLocalTaskApiResponseMessage } from "@zcode/shared";
import { createLocalTaskApiResponder } from "../src/host/localTaskApiResponder.js";

const WORKSPACE = "/ws";
const TASK_ID = "task-1";

interface Harness {
  responder: ReturnType<typeof createLocalTaskApiResponder>;
  posted: HostLocalTaskApiResponseMessage[];
  eventListeners: Array<(event: unknown) => void>;
  terminalListeners: Array<(outcome: unknown) => void>;
  mock: Record<string, ReturnType<typeof vi.fn>>;
  log: ReturnType<typeof vi.fn>;
}

/** ServiceCollection + 12 个 Pick 面方法全量 mock；post 收集到数组。 */
function createHarness(overrides: Record<string, unknown> = {}): Harness {
  const eventListeners: Array<(event: unknown) => void> = [];
  const terminalListeners: Array<(outcome: unknown) => void> = [];
  const mock: Record<string, ReturnType<typeof vi.fn>> = {
    createTask: vi.fn(async () => ({
      taskId: TASK_ID,
      traceId: "trace-1",
      title: "",
      workspacePath: WORKSPACE,
      createdAt: 1,
      updatedAt: 1,
      mode: "code",
    })),
    sendPrompt: vi.fn(async () => undefined),
    enqueueTaskCommand: vi.fn(async () => ({ commandId: "cmd-1" })),
    promoteTaskCommand: vi.fn(async () => ({ commandId: "cmd-1" })),
    stopGeneration: vi.fn(async () => undefined),
    getTaskSnapshot: vi.fn(async () => null),
    // send/stop/events op 现在先过归属校验：默认放行（meta 存在），否则三个 op 全 404。
    getTaskMeta: vi.fn(async () => ({ taskId: TASK_ID, workspacePath: WORKSPACE }) as never),
    listTasks: vi.fn(async () => []),
    listActiveTaskIds: vi.fn(async () => [] as string[]),
    renameTask: vi.fn(async () => null),
    // 真实签名：onDynamicTaskEvent(params) → Event<T>，再以 listener 调用才得到 IDisposable。
    onDynamicTaskEvent: vi.fn((_params: unknown) => {
      return (listener: (event: unknown) => void) => {
        eventListeners.push(listener);
        return { dispose: vi.fn() };
      };
    }),
    onDynamicTaskTerminalOutcome: vi.fn((_taskId: string) => {
      return (listener: (outcome: unknown) => void) => {
        terminalListeners.push(listener);
        return { dispose: vi.fn() };
      };
    }),
    ...overrides,
  };
  const services = new ServiceCollection();
  services.register(IZCodeTaskService, mock as unknown as IZCodeTaskService);
  const posted: HostLocalTaskApiResponseMessage[] = [];
  const log = vi.fn();
  const responder = createLocalTaskApiResponder({
    getServices: () => services,
    post: (message) => posted.push(message),
    log,
    // 终态修剪走真实 timer；小值让修剪用例 20ms 内完成。
    terminalPruneDelayMs: 10,
  });
  return { responder, posted, eventListeners, terminalListeners, mock, log };
}

function request(requestId: string, op: HostLocalTaskApiRequestMessage["op"]): HostLocalTaskApiRequestMessage {
  return { type: "local-task-api-request", requestId, op };
}

function snapshotMock(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    meta: { taskId: TASK_ID, title: "T", status: "idle", updatedAt: 123 },
    messages: [
      { role: "user", content: "q" },
      { role: "assistant", content: "hello" },
    ],
    runtime: {},
    ...overrides,
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("localTaskApiResponder", () => {
  it("create：建任务（deferPersistence）+ 直接 sendPrompt 首条输入，按 201 应答", async () => {
    const { responder, posted, mock } = createHarness();

    await responder.handleRequest(
      request("r1", { kind: "create", workspacePath: WORKSPACE, prompt: "hi" }),
    );

    expect(mock.createTask).toHaveBeenCalledWith(
      expect.objectContaining({ workspacePath: WORKSPACE, deferPersistenceUntilFirstPrompt: true }),
    );
    expect(mock.sendPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: TASK_ID,
        traceId: "trace-1",
        content: "hi",
        clientMode: "desktop-continuous",
      }),
    );
    expect(posted.at(-1)).toMatchObject({ ok: true, status: 201, body: { taskId: TASK_ID } });
  });

  it("create：带 title 走 renameTask，带 mode 透传给 createTask", async () => {
    const { responder, mock } = createHarness();

    await responder.handleRequest(
      request("r1", { kind: "create", workspacePath: WORKSPACE, prompt: "hi", title: "T", mode: "plan" }),
    );

    expect(mock.renameTask).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: TASK_ID, workspacePath: WORKSPACE, title: "T" }),
    );
    expect(mock.createTask).toHaveBeenCalledWith(
      expect.objectContaining({ workspacePath: WORKSPACE, mode: "plan" }),
    );
  });

  it("create：订阅两个动态事件，投影 task_run_started 后 events op 能读到 turn.started", async () => {
    const { responder, posted, eventListeners, mock } = createHarness();

    await responder.handleRequest(
      request("r1", { kind: "create", workspacePath: WORKSPACE, prompt: "hi" }),
    );
    expect(mock.onDynamicTaskEvent).toHaveBeenCalledTimes(1);
    expect(mock.onDynamicTaskEvent).toHaveBeenCalledWith({ workspacePath: WORKSPACE, taskId: TASK_ID });
    expect(mock.onDynamicTaskTerminalOutcome).toHaveBeenCalledTimes(1);
    expect(mock.onDynamicTaskTerminalOutcome).toHaveBeenCalledWith(TASK_ID);

    eventListeners[0]!({ type: "task_run_started", turnId: "t1" });
    await responder.handleRequest(
      request("r2", { kind: "events", workspacePath: WORKSPACE, taskId: TASK_ID, after: 0, waitMs: 0 }),
    );

    expect(posted.at(-1)).toMatchObject({
      ok: true,
      status: 200,
      body: {
        nextSeq: 1,
        events: [expect.objectContaining({ seq: 1, type: "turn.started", turnId: "t1" })],
      },
    });
  });

  it("send 空闲：直接 sendPrompt（traceId 为 uuid），应答 delivery=sent", async () => {
    const { responder, posted, mock } = createHarness();

    await responder.handleRequest(
      request("r1", {
        kind: "send",
        workspacePath: WORKSPACE,
        taskId: TASK_ID,
        text: "hello",
        delivery: "auto",
      }),
    );

    expect(mock.sendPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: TASK_ID, content: "hello", clientMode: "desktop-continuous" }),
    );
    const traceId = (mock.sendPrompt.mock.calls[0]![0] as { traceId: string }).traceId;
    expect(traceId).toMatch(UUID_RE);
    expect(posted.at(-1)).toMatchObject({ ok: true, status: 202, body: { delivery: "sent" } });
  });

  it("send 运行中 auto：入队 command，应答 delivery=queued + commandId", async () => {
    const { responder, posted, mock } = createHarness();
    mock.listActiveTaskIds.mockImplementation(async () => [TASK_ID]);

    await responder.handleRequest(
      request("r1", {
        kind: "send",
        workspacePath: WORKSPACE,
        taskId: TASK_ID,
        text: "hello",
        delivery: "auto",
      }),
    );

    expect(mock.enqueueTaskCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        workspacePath: WORKSPACE,
        taskId: TASK_ID,
        type: "send_prompt",
        content: "hello",
      }),
    );
    expect(mock.promoteTaskCommand).not.toHaveBeenCalled();
    const body = posted.at(-1)!.body as { delivery: string; commandId: string };
    expect(body.delivery).toBe("queued");
    expect(body.commandId).toBeTruthy();
  });

  it("send 运行中 steer：入队 + promote，应答 delivery=steered，events 里能查到 input.steered", async () => {
    const { responder, posted, mock } = createHarness();
    mock.listActiveTaskIds.mockImplementation(async () => [TASK_ID]);
    // 先经 events op 懒订阅建 buffer；无 buffer 时 input.steered 按设计被忽略。
    await responder.handleRequest(
      request("r0", { kind: "events", workspacePath: WORKSPACE, taskId: TASK_ID, after: 0, waitMs: 0 }),
    );

    await responder.handleRequest(
      request("r1", {
        kind: "send",
        workspacePath: WORKSPACE,
        taskId: TASK_ID,
        text: "hello",
        delivery: "steer",
      }),
    );

    expect(mock.enqueueTaskCommand).toHaveBeenCalledTimes(1);
    expect(mock.promoteTaskCommand).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: TASK_ID, clientMode: "desktop-continuous" }),
    );
    const commandId = (posted.at(-1)!.body as { delivery: string; commandId: string }).commandId;
    expect(commandId).toBeTruthy();

    await responder.handleRequest(
      request("r2", { kind: "events", workspacePath: WORKSPACE, taskId: TASK_ID, after: 0, waitMs: 0 }),
    );
    const events = (posted.at(-1)!.body as { events: Array<{ type: string; commandId: string }> }).events;
    expect(events.at(-1)).toMatchObject({ type: "input.steered", commandId });
  });

  it("stop：stopGeneration 以 {taskId, workspacePath} 调用，应答 202", async () => {
    const { responder, posted, mock } = createHarness();

    await responder.handleRequest(
      request("r1", { kind: "stop", workspacePath: WORKSPACE, taskId: TASK_ID }),
    );

    expect(mock.stopGeneration).toHaveBeenCalledWith({ taskId: TASK_ID, workspacePath: WORKSPACE });
    expect(posted.at(-1)).toMatchObject({ ok: true, status: 202, body: { ok: true } });
  });

  it("get：空闲快照投影 status/turnCount/lastAssistantText/title/updatedAt", async () => {
    const { responder, posted, mock } = createHarness();
    mock.getTaskSnapshot.mockImplementation(async () => snapshotMock());

    await responder.handleRequest(
      request("r1", { kind: "get", workspacePath: WORKSPACE, taskId: TASK_ID }),
    );

    expect(posted.at(-1)).toMatchObject({
      ok: true,
      status: 200,
      body: {
        taskId: TASK_ID,
        workspacePath: WORKSPACE,
        title: "T",
        status: "idle",
        turnCount: 1,
        lastAssistantText: "hello",
        updatedAt: 123,
      },
    });
  });

  it("get：pendingPermissions 判定在前（不查 listActive）", async () => {
    const { responder, posted, mock } = createHarness();
    mock.getTaskSnapshot.mockImplementation(async () =>
      snapshotMock({ runtime: { pendingPermissions: [{}] }, meta: { status: "error" } }),
    );

    await responder.handleRequest(
      request("r1", { kind: "get", workspacePath: WORKSPACE, taskId: TASK_ID }),
    );

    expect(mock.listActiveTaskIds).not.toHaveBeenCalled();
    expect(posted.at(-1)).toMatchObject({ status: 200, body: { status: "waiting_permission" } });
  });

  it("get：active 集合命中 → running；meta.status=error → error", async () => {
    const running = createHarness();
    running.mock.listActiveTaskIds.mockImplementation(async () => [TASK_ID]);
    running.mock.getTaskSnapshot.mockImplementation(async () => snapshotMock());
    await running.responder.handleRequest(
      request("r1", { kind: "get", workspacePath: WORKSPACE, taskId: TASK_ID }),
    );
    expect((running.posted.at(-1)!.body as { status: string }).status).toBe("running");

    const errored = createHarness();
    errored.mock.getTaskSnapshot.mockImplementation(async () =>
      snapshotMock({ meta: { taskId: TASK_ID, title: "T", status: "error", updatedAt: 123 } }),
    );
    await errored.responder.handleRequest(
      request("r2", { kind: "get", workspacePath: WORKSPACE, taskId: TASK_ID }),
    );
    expect((errored.posted.at(-1)!.body as { status: string }).status).toBe("error");
  });

  it("get：快照 null → 404 task_not_found", async () => {
    const { responder, posted } = createHarness();

    await responder.handleRequest(
      request("r1", { kind: "get", workspacePath: WORKSPACE, taskId: TASK_ID }),
    );

    expect(posted.at(-1)).toMatchObject({ status: 404, body: { error: "task_not_found" } });
  });

  it("events：长轮询在事件到达后立刻 resolve 且带新事件", async () => {
    const { responder, posted, eventListeners } = createHarness();
    await responder.handleRequest(
      request("r1", { kind: "events", workspacePath: WORKSPACE, taskId: TASK_ID, after: 0, waitMs: 0 }),
    );
    expect(posted.at(-1)).toMatchObject({ status: 200, body: { events: [], nextSeq: 0 } });

    const pending = responder.handleRequest(
      request("r2", { kind: "events", workspacePath: WORKSPACE, taskId: TASK_ID, after: 0, waitMs: 5000 }),
    );
    eventListeners[0]!({ type: "task_run_started", turnId: "t1" });
    await pending;

    expect(posted.at(-1)).toMatchObject({
      status: 200,
      body: {
        nextSeq: 1,
        events: [expect.objectContaining({ seq: 1, type: "turn.started", turnId: "t1" })],
      },
    });
  }, 8000);

  it("events：after=0 不 resync 返回全部；client 落后出缺口 → {resync:true}", async () => {
    const { responder, posted, eventListeners } = createHarness();
    await responder.handleRequest(
      request("r0", { kind: "events", workspacePath: WORKSPACE, taskId: TASK_ID, after: 0, waitMs: 0 }),
    );

    for (let i = 0; i < 3; i += 1) {
      eventListeners[0]!({ type: "task_run_started", turnId: `t${i}` });
    }
    await responder.handleRequest(
      request("r1", { kind: "events", workspacePath: WORKSPACE, taskId: TASK_ID, after: 0, waitMs: 0 }),
    );
    const all = posted.at(-1)!.body as {
      events: unknown[];
      nextSeq: number;
      resync?: true;
    };
    expect(all.events).toHaveLength(3);
    expect(all.nextSeq).toBe(3);
    expect(all.resync).toBeUndefined();

    // 再投 499 条触发 500 上限裁剪：buffer 只留 seq 3..502，after=1 与最老 seq 之间缺 seq 2。
    for (let i = 0; i < 499; i += 1) {
      eventListeners[0]!({ type: "task_run_started", turnId: `bulk-${i}` });
    }
    await responder.handleRequest(
      request("r2", { kind: "events", workspacePath: WORKSPACE, taskId: TASK_ID, after: 1, waitMs: 0 }),
    );
    expect(posted.at(-1)).toEqual({
      type: "local-task-api-response",
      requestId: "r2",
      ok: true,
      status: 200,
      body: { resync: true },
    });
  });

  it("send：getTaskMeta 查不到任务 → 404 前置，不触达 sendPrompt/enqueue/listActive", async () => {
    const { responder, posted, mock } = createHarness({
      getTaskMeta: vi.fn(async () => null),
    });

    await responder.handleRequest(
      request("r1", {
        kind: "send",
        workspacePath: WORKSPACE,
        taskId: "task-other",
        text: "hello",
        delivery: "auto",
      }),
    );

    expect(mock.getTaskMeta).toHaveBeenCalledWith({ taskId: "task-other", workspacePath: WORKSPACE });
    expect(mock.sendPrompt).not.toHaveBeenCalled();
    expect(mock.enqueueTaskCommand).not.toHaveBeenCalled();
    expect(mock.listActiveTaskIds).not.toHaveBeenCalled();
    expect(posted.at(-1)).toMatchObject({ ok: true, status: 404, body: { error: "task_not_found" } });
  });

  it("stop/events：getTaskMeta null → 404 前置；meta 命中 → 正常走 stopGeneration 与 buffer", async () => {
    const denied = createHarness({ getTaskMeta: vi.fn(async () => null) });
    await denied.responder.handleRequest(
      request("r1", { kind: "stop", workspacePath: WORKSPACE, taskId: TASK_ID }),
    );
    await denied.responder.handleRequest(
      request("r2", { kind: "events", workspacePath: WORKSPACE, taskId: TASK_ID, after: 0, waitMs: 0 }),
    );
    expect(denied.mock.stopGeneration).not.toHaveBeenCalled();
    expect(denied.mock.onDynamicTaskEvent).not.toHaveBeenCalled();
    expect(denied.posted.at(-2)).toMatchObject({ status: 404, body: { error: "task_not_found" } });
    expect(denied.posted.at(-1)).toMatchObject({ status: 404, body: { error: "task_not_found" } });

    const allowed = createHarness();
    await allowed.responder.handleRequest(
      request("r1", { kind: "stop", workspacePath: WORKSPACE, taskId: TASK_ID }),
    );
    expect(allowed.mock.stopGeneration).toHaveBeenCalledWith({
      taskId: TASK_ID,
      workspacePath: WORKSPACE,
    });
    expect(allowed.posted.at(-1)).toMatchObject({ ok: true, status: 202, body: { ok: true } });

    await allowed.responder.handleRequest(
      request("r2", { kind: "events", workspacePath: WORKSPACE, taskId: TASK_ID, after: 0, waitMs: 0 }),
    );
    expect(allowed.mock.onDynamicTaskEvent).toHaveBeenCalledTimes(1);
    expect(allowed.posted.at(-1)).toMatchObject({ status: 200, body: { events: [], nextSeq: 0 } });
  });

  it("服务缺失（getServices 返回 null）→ 503 unavailable_host", async () => {
    const posted: HostLocalTaskApiResponseMessage[] = [];
    const responder = createLocalTaskApiResponder({
      getServices: () => null,
      post: (message) => posted.push(message),
    });

    await responder.handleRequest(
      request("r1", { kind: "list", workspacePath: WORKSPACE }),
    );

    expect(posted.at(-1)).toMatchObject({ status: 503, body: { error: "unavailable_host" } });
  });

  it("op 抛错（createTask reject）→ ok=false + 503 固定文案，原始错误只进 log", async () => {
    const { responder, posted, mock, log } = createHarness();
    mock.createTask.mockImplementation(async () => {
      throw new Error("boom");
    });

    await responder.handleRequest(
      request("r1", { kind: "create", workspacePath: WORKSPACE, prompt: "hi" }),
    );

    expect(posted.at(-1)).toMatchObject({
      ok: false,
      status: 503,
      body: { error: "unavailable_host" },
    });
    expect(JSON.stringify(posted.at(-1)!.body)).not.toContain("boom");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("boom"));
  });

  it("list：tasks 投影按 active 集合标 running/idle", async () => {
    const { responder, posted, mock } = createHarness();
    mock.listTasks.mockImplementation(async () => [
      { taskId: "a", title: "A", updatedAt: 1 },
      { taskId: "b", title: "B", updatedAt: 2 },
    ] as never);
    mock.listActiveTaskIds.mockImplementation(async () => ["a"]);

    await responder.handleRequest(
      request("r1", { kind: "list", workspacePath: WORKSPACE }),
    );

    const tasks = (posted.at(-1)!.body as { tasks: Array<Record<string, unknown>> }).tasks;
    expect(tasks[0]).toMatchObject({ taskId: "a", title: "A", status: "running", updatedAt: 1 });
    expect(tasks[1]).toMatchObject({ taskId: "b", title: "B", status: "idle", updatedAt: 2 });
  });

  it("get：pendingElicitations → waiting_input", async () => {
    const { responder, posted, mock } = createHarness();
    mock.getTaskSnapshot.mockImplementation(async () =>
      snapshotMock({ runtime: { pendingElicitations: [{}] } }),
    );

    await responder.handleRequest(
      request("r1", { kind: "get", workspacePath: WORKSPACE, taskId: TASK_ID }),
    );

    expect(posted.at(-1)).toMatchObject({ status: 200, body: { status: "waiting_input" } });
  });

  it("send 运行中 auto：受理即补订阅，随后 events 立即可查 input.queued", async () => {
    const { responder, posted, mock } = createHarness();
    mock.listActiveTaskIds.mockImplementation(async () => [TASK_ID]);

    await responder.handleRequest(
      request("r1", {
        kind: "send",
        workspacePath: WORKSPACE,
        taskId: TASK_ID,
        text: "hello",
        delivery: "auto",
      }),
    );
    expect(posted.at(-1)).toMatchObject({ ok: true, status: 202, body: { delivery: "queued" } });

    await responder.handleRequest(
      request("r2", { kind: "events", workspacePath: WORKSPACE, taskId: TASK_ID, after: 0, waitMs: 0 }),
    );
    const events = (posted.at(-1)!.body as { events: Array<{ type: string }> }).events;
    expect(events.some((event) => event.type === "input.queued")).toBe(true);
  });

  it("create：首条 prompt 失败 → 仍 201 + warning=first_prompt_failed，taskId 与 createTask 返回一致", async () => {
    const { responder, posted, mock, log } = createHarness();
    mock.sendPrompt.mockImplementation(async () => {
      throw new Error("prompt rejected");
    });

    await responder.handleRequest(
      request("r1", { kind: "create", workspacePath: WORKSPACE, prompt: "hi" }),
    );

    expect(posted.at(-1)).toMatchObject({
      ok: true,
      status: 201,
      body: { taskId: TASK_ID, warning: "first_prompt_failed" },
    });
    expect((posted.at(-1)!.body as { taskId: string }).taskId).toBe(TASK_ID);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("prompt rejected"));
  });

  it("create：订阅建立失败不回滚 → 仍 201 且 taskId 在、sendPrompt 照发", async () => {
    const { responder, posted, mock } = createHarness({
      onDynamicTaskEvent: vi.fn(() => {
        throw new Error("subscription failed");
      }),
    });

    await responder.handleRequest(
      request("r1", { kind: "create", workspacePath: WORKSPACE, prompt: "hi" }),
    );

    expect(posted.at(-1)).toMatchObject({ ok: true, status: 201 });
    expect((posted.at(-1)!.body as { taskId?: string }).taskId).toBe(TASK_ID);
    expect(mock.sendPrompt).toHaveBeenCalledTimes(1);
  });

  it("op 抛错（stopGeneration reject）→ 出站固定文案 unavailable_host，不含原始错误文本", async () => {
    const { responder, posted, mock, log } = createHarness();
    mock.stopGeneration.mockImplementation(async () => {
      throw new Error("stop exploded");
    });

    await responder.handleRequest(
      request("r1", { kind: "stop", workspacePath: WORKSPACE, taskId: TASK_ID }),
    );

    expect(posted.at(-1)).toMatchObject({
      ok: false,
      status: 503,
      body: { error: "unavailable_host" },
    });
    expect(JSON.stringify(posted.at(-1)!.body)).not.toContain("stop exploded");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("stop exploded"));
  });

  it("终态修剪：succeeded 终态后延迟释放 buffer，流事件不再入 buffer、events 查询懒建新 buffer", async () => {
    const { responder, posted, eventListeners, terminalListeners, mock } = createHarness();

    await responder.handleRequest(
      request("r1", { kind: "create", workspacePath: WORKSPACE, prompt: "hi" }),
    );
    expect(mock.onDynamicTaskEvent).toHaveBeenCalledTimes(1);
    const streamListener = eventListeners[0]!;
    const terminalListener = terminalListeners[0]!;

    // 三种 outcome 都算终态：succeeded 也会排修剪 timer（terminalPruneDelayMs=10）。
    terminalListener({ outcome: "succeeded" });
    await new Promise((resolve) => setTimeout(resolve, 30));

    // 修剪后 buffer 已移除：流事件（含 disposed 订阅迟到的投递）不再累积。
    streamListener({ type: "task_run_started", turnId: "after-prune" });
    await responder.handleRequest(
      request("r2", { kind: "events", workspacePath: WORKSPACE, taskId: TASK_ID, after: 0, waitMs: 0 }),
    );

    expect(posted.at(-1)).toMatchObject({
      ok: true,
      status: 200,
      body: { events: [], nextSeq: 0 },
    });
    // events 查询懒建了新 buffer（第 2 次订阅），证明旧 buffer 已被修剪释放。
    expect(mock.onDynamicTaskEvent).toHaveBeenCalledTimes(2);
  });
});

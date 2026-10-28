import { describe, expect, it, vi } from "vitest";
import { IModelSelectionService, IZCodeTaskService, ServiceCollection } from "@zcode/services";
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

/** ServiceCollection + 11 个 Pick 面方法全量 mock；post 收集到数组。
 * modelSelectionService 非 undefined 时按原样注册 IModelSelectionService（listModels 与
 * create/setModel 的模型选择预检都用；缺省不注册 → listModels 走 503 分支、create/setModel
 * 的预检透传原样，其余 op 不受影响）。 */
function createHarness(
  overrides: Record<string, unknown> = {},
  modelSelectionService?: { getView: (input?: { selection: unknown }) => Promise<unknown> },
): Harness {
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
    stopGeneration: vi.fn(async () => undefined),
    getTaskSnapshot: vi.fn(async () => null),
    // send/stop/events op 现在先过归属校验：默认放行（meta 存在），否则三个 op 全 404。
    getTaskMeta: vi.fn(async () => ({ taskId: TASK_ID, workspacePath: WORKSPACE }) as never),
    listTasks: vi.fn(async () => []),
    listActiveTaskIds: vi.fn(async () => [] as string[]),
    renameTask: vi.fn(async () => null),
    // setModel op（POST /:id/model 落到 Host 的换模型）：应答不消费其返回值。
    setModel: vi.fn(async () => []),
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
  if (modelSelectionService) {
    services.register(IModelSelectionService, modelSelectionService as never);
  }
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

  it("create：带 title 走 renameTask，且 rename 在首条 sendPrompt 成功之后（defer 落盘依赖）", async () => {
    const { responder, posted, mock } = createHarness();

    await responder.handleRequest(
      request("r1", { kind: "create", workspacePath: WORKSPACE, prompt: "hi", title: "T", mode: "plan" }),
    );

    expect(mock.renameTask).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: TASK_ID, workspacePath: WORKSPACE, title: "T" }),
    );
    expect(mock.createTask).toHaveBeenCalledWith(
      expect.objectContaining({ workspacePath: WORKSPACE, mode: "plan" }),
    );
    // 顺序钉死：首条 sendPrompt（defer 模式下 session 随它落盘）必须先于 renameTask，
    // 否则底层 renameSession 报 Session not found after write（真机日志）。
    expect(mock.sendPrompt.mock.invocationCallOrder[0]!).toBeLessThan(
      mock.renameTask.mock.invocationCallOrder[0]!,
    );
    // 两者都成功：无 warning。
    expect(posted.at(-1)).toMatchObject({ ok: true, status: 201, body: { taskId: TASK_ID } });
    expect((posted.at(-1)!.body as { warning?: string }).warning).toBeUndefined();
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

  it("send auto：sendPrompt 不带 requestedDelivery（跟随会话 followupMode），应答 delivery=sent + commandId", async () => {
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

    expect(mock.sendPrompt).toHaveBeenCalledTimes(1);
    expect(mock.sendPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: TASK_ID, content: "hello", clientMode: "desktop-continuous" }),
    );
    const params = mock.sendPrompt.mock.calls[0]![0] as {
      traceId: string;
      requestedDelivery?: string;
    };
    expect(params.traceId).toMatch(UUID_RE);
    expect(params.requestedDelivery).toBeUndefined();
    const body = posted.at(-1)!.body as { delivery: string; commandId: string };
    expect(body.delivery).toBe("sent");
    expect(body.commandId).toMatch(UUID_RE);
    // 受理也发 input.queued：GUI 运行中默认提交会被 CLI 排队或引导，对账方需要知道有输入进入。
    await responder.handleRequest(
      request("r2", { kind: "events", workspacePath: WORKSPACE, taskId: TASK_ID, after: 0, waitMs: 0 }),
    );
    const events = (posted.at(-1)!.body as { events: Array<{ type: string; commandId: string }> }).events;
    expect(events.at(-1)).toMatchObject({ type: "input.queued", commandId: body.commandId });
  });

  it("send queue：sendPrompt 带 requestedDelivery=queue，应答 delivery=queued + commandId", async () => {
    const { responder, posted, mock } = createHarness();

    await responder.handleRequest(
      request("r1", {
        kind: "send",
        workspacePath: WORKSPACE,
        taskId: TASK_ID,
        text: "hello",
        delivery: "queue",
      }),
    );

    expect(mock.sendPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: TASK_ID,
        content: "hello",
        clientMode: "desktop-continuous",
        requestedDelivery: "queue",
      }),
    );
    const body = posted.at(-1)!.body as { delivery: string; commandId: string };
    expect(body.delivery).toBe("queued");
    expect(body.commandId).toMatch(UUID_RE);
  });

  it("send steer（运行中）：sendPrompt 带 requestedDelivery=guide，应答 delivery=steered，受理时无自产事件", async () => {
    const { responder, posted, mock } = createHarness();
    mock.listActiveTaskIds.mockImplementation(async () => [TASK_ID]); // 运行中：steer 语义保留

    await responder.handleRequest(
      request("r1", {
        kind: "send",
        workspacePath: WORKSPACE,
        taskId: TASK_ID,
        text: "hello",
        delivery: "steer",
      }),
    );

    expect(mock.sendPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: TASK_ID,
        content: "hello",
        clientMode: "desktop-continuous",
        requestedDelivery: "guide",
      }),
    );
    const body = posted.at(-1)!.body as { delivery: string; commandId: string };
    expect(body.delivery).toBe("steered");
    expect(body.commandId).toMatch(UUID_RE);

    await responder.handleRequest(
      request("r2", { kind: "events", workspacePath: WORKSPACE, taskId: TASK_ID, after: 0, waitMs: 0 }),
    );
    const events = (posted.at(-1)!.body as { events: Array<{ type: string }> }).events;
    // 受理不自产 input.steered：由 turn_steer_queued 流事件投影统一发出。
    expect(events.some((event) => event.type === "input.steered")).toBe(false);
    // 运行态判定确实做了：steer 应答前查过 active 集合（空闲时会降级为 sent，另有用例）。
    expect(mock.listActiveTaskIds).toHaveBeenCalledWith({ workspacePath: WORKSPACE });
  });

  it("steer 权威投影：turn_steer_queued 的 inputId → input.steered(commandId)；status drained/discarded → injected/fellBack", async () => {
    const { responder, posted, eventListeners, mock } = createHarness();
    mock.listActiveTaskIds.mockImplementation(async () => [TASK_ID]); // 运行中：steer 语义保留
    // send 受理即补订阅：listener 已就位，直接投递 CLI 流事件。
    await responder.handleRequest(
      request("r1", {
        kind: "send",
        workspacePath: WORKSPACE,
        taskId: TASK_ID,
        text: "hello",
        delivery: "steer",
      }),
    );

    // CLI 真实形状：pendingInputId 带 "queue_" 前缀，inputId=envelope.commandId 才与应答可对账。
    eventListeners[0]!({ type: "turn_steer_queued", pendingInputId: "queue_pi-1", inputId: "pi-1" });
    eventListeners[0]!({ type: "turn_steer_status", status: "drained" });
    eventListeners[0]!({ type: "turn_steer_status", status: "discarded", reason: "turn ended" });

    await responder.handleRequest(
      request("r2", { kind: "events", workspacePath: WORKSPACE, taskId: TASK_ID, after: 0, waitMs: 0 }),
    );
    const events = (
      posted.at(-1)!.body as { events: Array<{ type: string; commandId?: string; error?: string }> }
    ).events;
    expect(events.some((event) => event.type === "input.steered" && event.commandId === "pi-1")).toBe(
      true,
    );
    expect(events.some((event) => event.type === "steer.injected")).toBe(true);
    const fellBack = events.find((event) => event.type === "steer.fellBack");
    expect(fellBack).toMatchObject({ type: "steer.fellBack", error: "turn ended" });
  });

  it("send steer（运行中）CLI 真实形状：input.steered.commandId 与 202 应答 commandId 对账（不被 queue_ 前缀污染）", async () => {
    const { responder, posted, mock, eventListeners } = createHarness();
    mock.listActiveTaskIds.mockImplementation(async () => [TASK_ID]); // 运行中：steer 语义保留

    await responder.handleRequest(
      request("r1", {
        kind: "send",
        workspacePath: WORKSPACE,
        taskId: TASK_ID,
        text: "hello",
        delivery: "steer",
      }),
    );
    const accepted = posted.at(-1)!.body as { delivery: string; commandId: string };
    expect(accepted.delivery).toBe("steered");

    // P1 核心：CLI admission 给 pendingInputId 加 "queue_" 前缀（command-inbox），
    // inputId=envelope.commandId 才与 202 应答相等；修复前会投影成 "queue_<commandId>"。
    eventListeners[0]!({
      type: "turn_steer_queued",
      pendingInputId: `queue_${accepted.commandId}`,
      inputId: accepted.commandId,
    });

    await responder.handleRequest(
      request("r2", { kind: "events", workspacePath: WORKSPACE, taskId: TASK_ID, after: 0, waitMs: 0 }),
    );
    const events = (posted.at(-1)!.body as { events: Array<{ type: string; commandId?: string }> })
      .events;
    const steered = events.find((event) => event.type === "input.steered");
    expect(steered).toMatchObject({ type: "input.steered", commandId: accepted.commandId });
    expect(steered!.commandId).not.toBe(`queue_${accepted.commandId}`);
  });

  it("send steer（空闲）：CLI 空闲分支不看 delivery 直接普通起轮且不发 steer 事件 → 按实际去向应答 sent（拍板 r6-52 #2②）", async () => {
    const { responder, posted, mock } = createHarness(); // listActiveTaskIds 默认 []：任务空闲

    await responder.handleRequest(
      request("r1", {
        kind: "send",
        workspacePath: WORKSPACE,
        taskId: TASK_ID,
        text: "hello",
        delivery: "steer",
      }),
    );

    expect(mock.listActiveTaskIds).toHaveBeenCalledWith({ workspacePath: WORKSPACE });
    // 降级为普通发送：不带 requestedDelivery（跟随会话 followupMode）。
    const params = mock.sendPrompt.mock.calls[0]![0] as { requestedDelivery?: string };
    expect(params.requestedDelivery).toBeUndefined();
    const body = posted.at(-1)!.body as { delivery: string; commandId: string };
    expect(body.delivery).toBe("sent");
    expect(body.commandId).toMatch(UUID_RE);
    // 普通发送受理自产 input.queued（运行中 steer 才不自产）。
    await responder.handleRequest(
      request("r3", { kind: "events", workspacePath: WORKSPACE, taskId: TASK_ID, after: 0, waitMs: 0 }),
    );
    const events = (posted.at(-1)!.body as { events: Array<{ type: string; commandId: string }> })
      .events;
    expect(events.at(-1)).toMatchObject({ type: "input.queued", commandId: body.commandId });
  });

  it("steer 投影回落：旧 CLI 事件无 inputId → 兜底投影 pendingInputId", async () => {
    const { responder, posted, mock, eventListeners } = createHarness();
    mock.listActiveTaskIds.mockImplementation(async () => [TASK_ID]);
    await responder.handleRequest(
      request("r1", {
        kind: "send",
        workspacePath: WORKSPACE,
        taskId: TASK_ID,
        text: "hello",
        delivery: "steer",
      }),
    );

    eventListeners[0]!({ type: "turn_steer_queued", pendingInputId: "pi-legacy" });

    await responder.handleRequest(
      request("r4", { kind: "events", workspacePath: WORKSPACE, taskId: TASK_ID, after: 0, waitMs: 0 }),
    );
    const events = (posted.at(-1)!.body as { events: Array<{ type: string; commandId?: string }> })
      .events;
    expect(
      events.some((event) => event.type === "input.steered" && event.commandId === "pi-legacy"),
    ).toBe(true);
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

  it("send：getTaskMeta 查不到任务 → 404 前置，不触达 sendPrompt/listActive", async () => {
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
    expect(mock.listActiveTaskIds).not.toHaveBeenCalled();
    expect(posted.at(-1)).toMatchObject({ status: 404, body: { error: "task_not_found" } });
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

  it("send auto：受理即补订阅（onDynamicTaskEvent 挂上），随后 events 立即可查 input.queued", async () => {
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
    expect(mock.onDynamicTaskEvent).toHaveBeenCalledTimes(1);
    expect(posted.at(-1)).toMatchObject({ status: 202, body: { delivery: "sent" } });

    await responder.handleRequest(
      request("r2", { kind: "events", workspacePath: WORKSPACE, taskId: TASK_ID, after: 0, waitMs: 0 }),
    );
    const events = (posted.at(-1)!.body as { events: Array<{ type: string }> }).events;
    expect(events.some((event) => event.type === "input.queued")).toBe(true);
  });

  it("create：首条 prompt 失败 → 仍 201 + warning=first_prompt_failed，且不再尝试 renameTask", async () => {
    const { responder, posted, mock, log } = createHarness();
    mock.sendPrompt.mockImplementation(async () => {
      throw new Error("prompt rejected");
    });

    await responder.handleRequest(
      request("r1", { kind: "create", workspacePath: WORKSPACE, prompt: "hi", title: "T" }),
    );

    expect(posted.at(-1)).toMatchObject({
      status: 201,
      body: { taskId: TASK_ID, warning: "first_prompt_failed" },
    });
    expect((posted.at(-1)!.body as { taskId: string }).taskId).toBe(TASK_ID);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("prompt rejected"));
    // 首 prompt 已失败时 defer 模式的 session 仍可能未落盘：跳过 rename，避免再一次必然失败。
    expect(mock.renameTask).not.toHaveBeenCalled();
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

  it("events：挂起唤醒按该请求的 after 过滤——只投新事件，不重发已读旧事件", async () => {
    const { responder, posted, eventListeners } = createHarness();
    await responder.handleRequest(
      request("r0", { kind: "events", workspacePath: WORKSPACE, taskId: TASK_ID, after: 0, waitMs: 0 }),
    );
    eventListeners[0]!({ type: "task_run_started", turnId: "t1" });
    eventListeners[0]!({ type: "task_run_started", turnId: "t2" });

    // after=2（两条旧事件都已读过）：请求时无积压 → 真挂起；唤醒只应投第 3 条。
    // （若 after=1 且 seq2 已在 buffer，seq2 已满足 seq>after，会在注册 waiter 前走积压即返，测不到唤醒过滤。）
    const pending = responder.handleRequest(
      request("r1", { kind: "events", workspacePath: WORKSPACE, taskId: TASK_ID, after: 2, waitMs: 5000 }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0)); // 等挂起注册落地
    eventListeners[0]!({ type: "task_run_started", turnId: "t3" });
    await pending;

    const body = posted.at(-1)!.body as { events: Array<{ seq: number; turnId: string }>; nextSeq: number };
    expect(body.nextSeq).toBe(3);
    expect(body.events).toHaveLength(1);
    expect(body.events[0]).toMatchObject({ seq: 3, type: "turn.started", turnId: "t3" });
    expect(body.events.some((event) => event.seq <= 2)).toBe(false);
  }, 8000);

  it("events：终态修剪懒重建后 after>0 → resync；after=0 → 从 0 开始跟", async () => {
    const { responder, posted, eventListeners, terminalListeners } = createHarness();

    await responder.handleRequest(
      request("r1", { kind: "create", workspacePath: WORKSPACE, prompt: "hi" }),
    );
    eventListeners[0]!({ type: "task_run_started", turnId: "t1" });
    terminalListeners[0]!({ outcome: "succeeded" });
    await new Promise((resolve) => setTimeout(resolve, 30)); // terminalPruneDelayMs=10，确保修剪已落地

    // 旧 buffer 已整体释放、seq 历史作废：旧水位 after=1 只能 resync（先 ensure 新 buffer 收集后续事件）。
    await responder.handleRequest(
      request("r2", { kind: "events", workspacePath: WORKSPACE, taskId: TASK_ID, after: 1, waitMs: 0 }),
    );
    expect(posted.at(-1)).toMatchObject({ ok: true, status: 200, body: { resync: true } });

    // after=0：新 buffer 已存在（上一次调用懒建），从 0 开始跟。
    await responder.handleRequest(
      request("r3", { kind: "events", workspacePath: WORKSPACE, taskId: TASK_ID, after: 0, waitMs: 0 }),
    );
    expect(posted.at(-1)).toMatchObject({ ok: true, status: 200, body: { events: [], nextSeq: 0 } });
  });

  it("create：renameTask 失败（发生在 sendPrompt 成功后）→ 201 + warning=rename_failed", async () => {
    const renamed = createHarness({
      renameTask: vi.fn(async () => {
        throw new Error("rename rejected");
      }),
    });
    await renamed.responder.handleRequest(
      request("r1", { kind: "create", workspacePath: WORKSPACE, prompt: "hi", title: "T" }),
    );
    expect(renamed.posted.at(-1)).toMatchObject({
      status: 201,
      body: { taskId: TASK_ID, warning: "rename_failed" },
    });
    expect(renamed.log).toHaveBeenCalledWith(expect.stringContaining("rename rejected"));
    // rename 在首条 prompt 成功之后才被尝试。
    expect(renamed.mock.sendPrompt).toHaveBeenCalledTimes(1);
    expect(renamed.mock.renameTask.mock.invocationCallOrder[0]!).toBeGreaterThan(
      renamed.mock.sendPrompt.mock.invocationCallOrder[0]!,
    );

    // rename 与首条 prompt 同败时：rename 被跳过，warning 取 first_prompt_failed。
    const both = createHarness({
      sendPrompt: vi.fn(async () => {
        throw new Error("prompt rejected");
      }),
      renameTask: vi.fn(async () => null),
    });
    await both.responder.handleRequest(
      request("r2", { kind: "create", workspacePath: WORKSPACE, prompt: "hi", title: "T" }),
    );
    expect(both.mock.renameTask).not.toHaveBeenCalled();
    expect(both.posted.at(-1)).toMatchObject({
      status: 201,
      body: { taskId: TASK_ID, warning: "first_prompt_failed" },
    });
  });

  it("create：modelSelection 透传进 createTask（与 deferPersistence 并存）", async () => {
    const { responder, posted, mock } = createHarness();

    await responder.handleRequest(
      request("r1", {
        kind: "create",
        workspacePath: WORKSPACE,
        prompt: "hi",
        modelSelection: { providerId: "glm", modelId: "glm-4.7" },
      }),
    );

    expect(mock.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        workspacePath: WORKSPACE,
        deferPersistenceUntilFirstPrompt: true,
        modelSelection: { providerId: "glm", modelId: "glm-4.7" },
      }),
    );
    expect(posted.at(-1)).toMatchObject({ ok: true, status: 201, body: { taskId: TASK_ID } });
  });

  it("listModels：getView() 投影 providers/models（displayName 回落、thoughtLevels 缺省空、defaultThoughtLevel 同源 values.at(-1)、isDefault 按 preferred）", async () => {
    // 形状对齐 ModelSelectionView：providerName 可缺省；config.optionSpecs 按
    // RegistryModelConfigObject 恒存在（reasoningLevel 才可缺省）。
    const view = {
      revision: 1,
      providers: [
        {
          providerId: "glm",
          providerName: "智谱 GLM",
          config: {},
          models: [
            {
              modelId: "glm-4.7",
              config: { optionSpecs: { reasoningLevel: { values: ["low", "high"] } } },
            },
            { modelId: "glm-4.7-air", config: { optionSpecs: {} } },
          ],
        },
        {
          providerId: "bare",
          config: {},
          models: [{ modelId: "m1", config: { optionSpecs: {} } }],
        },
      ],
      preferredSelection: { providerId: "glm", modelId: "glm-4.7", options: { reasoningLevel: "high" } },
    };
    const { responder, posted } = createHarness({}, { getView: async () => view });

    await responder.handleRequest(request("r2", { kind: "listModels", workspacePath: WORKSPACE }));

    expect(posted.at(-1)).toEqual({
      type: "local-task-api-response",
      requestId: "r2",
      ok: true,
      status: 200,
      body: {
        providers: [
          {
            providerId: "glm",
            displayName: "智谱 GLM",
            models: [
              {
                modelId: "glm-4.7",
                displayName: "glm-4.7",
                thoughtLevels: ["low", "high"],
                // 与 GUI 新建对话补档位同源：values.at(-1)。
                defaultThoughtLevel: "high",
                isDefault: true,
              },
              {
                modelId: "glm-4.7-air",
                displayName: "glm-4.7-air",
                thoughtLevels: [],
                isDefault: false,
              },
            ],
          },
          {
            providerId: "bare",
            displayName: "bare", // providerName 缺省回落 providerId
            models: [{ modelId: "m1", displayName: "m1", thoughtLevels: [], isDefault: false }],
          },
        ],
        preferred: { providerId: "glm", modelId: "glm-4.7", options: { reasoningLevel: "high" } },
      },
    });
  });

  it("listModels：IModelSelectionService 未注册 → 503 unavailable_host", async () => {
    const { responder, posted } = createHarness(); // 缺省不注册模型服务

    await responder.handleRequest(request("r1", { kind: "listModels", workspacePath: WORKSPACE }));

    expect(posted.at(-1)).toMatchObject({
      ok: true,
      status: 503,
      body: { error: "unavailable_host" },
    });
  });

  it("setModel：getTaskMeta 查不到 → 404 前置，不触达 setModel", async () => {
    const { responder, posted, mock } = createHarness({
      getTaskMeta: vi.fn(async () => null),
    });

    await responder.handleRequest(
      request("r1", {
        kind: "setModel",
        workspacePath: WORKSPACE,
        taskId: TASK_ID,
        modelSelection: { providerId: "p", modelId: "m" },
      }),
    );

    expect(mock.getTaskMeta).toHaveBeenCalledWith({ taskId: TASK_ID, workspacePath: WORKSPACE });
    expect(mock.setModel).not.toHaveBeenCalled();
    expect(posted.at(-1)).toMatchObject({ status: 404, body: { error: "task_not_found" } });
  });

  it("setModel：meta 命中 → setModel 以 uuid traceId 调用，应答 200 {ok:true}", async () => {
    const { responder, posted, mock } = createHarness();

    await responder.handleRequest(
      request("r1", {
        kind: "setModel",
        workspacePath: WORKSPACE,
        taskId: TASK_ID,
        modelSelection: { providerId: "p", modelId: "m" },
      }),
    );

    expect(mock.setModel).toHaveBeenCalledWith({
      taskId: TASK_ID,
      traceId: expect.stringMatching(UUID_RE),
      modelSelection: { providerId: "p", modelId: "m" },
    });
    expect(posted.at(-1)).toMatchObject({ ok: true, status: 200, body: { ok: true } });
  });

  it("setModel：setModel 抛错 → 503 固定文案，原始错误只进 log 一行", async () => {
    const { responder, posted, log } = createHarness({
      setModel: vi.fn(async () => {
        throw new Error("boom");
      }),
    });

    await responder.handleRequest(
      request("r1", {
        kind: "setModel",
        workspacePath: WORKSPACE,
        taskId: TASK_ID,
        modelSelection: { providerId: "p", modelId: "m" },
      }),
    );

    expect(posted.at(-1)).toMatchObject({
      ok: false,
      status: 503,
      body: { error: "unavailable_host" },
    });
    expect(JSON.stringify(posted.at(-1)!.body)).not.toContain("boom");
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("boom"));
  });

  it("create：reasoning-level-missing 按 GUI 同源补最高档（values.at(-1)），posted 201", async () => {
    const getView = vi.fn(async () => ({
      providers: [
        {
          providerId: "p",
          config: {},
          models: [
            { modelId: "m", config: { optionSpecs: { reasoningLevel: { values: ["low", "high"] } } } },
          ],
        },
      ],
      selectionIssue: "reasoning-level-missing",
    }));
    const { responder, posted, mock } = createHarness({}, { getView });

    await responder.handleRequest(
      request("r1", {
        kind: "create",
        workspacePath: WORKSPACE,
        prompt: "hi",
        modelSelection: { providerId: "p", modelId: "m" },
      }),
    );

    expect(getView).toHaveBeenCalledWith({ selection: { providerId: "p", modelId: "m" } });
    expect(mock.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        modelSelection: { providerId: "p", modelId: "m", options: { reasoningLevel: "high" } },
      }),
    );
    expect(posted.at(-1)).toMatchObject({ ok: true, status: 201, body: { taskId: TASK_ID } });
  });

  it("create：reasoning-level-missing 但模型无档位 → 原样透传（CLI 对无档位模型不要求）", async () => {
    const { responder, posted, mock } = createHarness({}, {
      getView: async () => ({
        providers: [
          { providerId: "p", config: {}, models: [{ modelId: "m", config: { optionSpecs: {} } }] },
        ],
        selectionIssue: "reasoning-level-missing",
      }),
    });

    await responder.handleRequest(
      request("r1", {
        kind: "create",
        workspacePath: WORKSPACE,
        prompt: "hi",
        modelSelection: { providerId: "p", modelId: "m" },
      }),
    );

    expect(mock.createTask).toHaveBeenCalledWith(
      expect.objectContaining({ modelSelection: { providerId: "p", modelId: "m" } }),
    );
    expect(posted.at(-1)).toMatchObject({ ok: true, status: 201 });
  });

  it("create：provider-not-found → 400 invalid_model_selection，不触达 createTask", async () => {
    const { responder, posted, mock } = createHarness({}, {
      getView: async () => ({ selectionIssue: "provider-not-found" }),
    });

    await responder.handleRequest(
      request("r1", {
        kind: "create",
        workspacePath: WORKSPACE,
        prompt: "hi",
        modelSelection: { providerId: "nope", modelId: "m" },
      }),
    );

    expect(posted.at(-1)).toMatchObject({
      ok: true,
      status: 400,
      body: { error: "invalid_model_selection", message: "provider-not-found" },
    });
    expect(mock.createTask).not.toHaveBeenCalled();
  });

  it("create：model-not-found → 400 invalid_model_selection，不触达 createTask", async () => {
    const { responder, posted, mock } = createHarness({}, {
      getView: async () => ({ selectionIssue: "model-not-found" }),
    });

    await responder.handleRequest(
      request("r1", {
        kind: "create",
        workspacePath: WORKSPACE,
        prompt: "hi",
        modelSelection: { providerId: "p", modelId: "nope" },
      }),
    );

    expect(posted.at(-1)).toMatchObject({
      ok: true,
      status: 400,
      body: { error: "invalid_model_selection", message: "model-not-found" },
    });
    expect(mock.createTask).not.toHaveBeenCalled();
  });

  it("create：reasoning-level-not-supported → 400 invalid_model_selection，不触达 createTask", async () => {
    const { responder, posted, mock } = createHarness({}, {
      getView: async () => ({ selectionIssue: "reasoning-level-not-supported" }),
    });

    await responder.handleRequest(
      request("r1", {
        kind: "create",
        workspacePath: WORKSPACE,
        prompt: "hi",
        modelSelection: { providerId: "p", modelId: "m", options: { reasoningLevel: "turbo" } },
      }),
    );

    expect(posted.at(-1)).toMatchObject({
      ok: true,
      status: 400,
      body: { error: "invalid_model_selection", message: "reasoning-level-not-supported" },
    });
    expect(mock.createTask).not.toHaveBeenCalled();
  });

  it("create：account-connection-unavailable → 400 invalid_model_selection 且不建任务", async () => {
    const { responder, posted, mock } = createHarness({}, {
      getView: async () => ({ selectionIssue: "account-connection-unavailable" }),
    });

    await responder.handleRequest(
      request("r1", {
        kind: "create",
        workspacePath: WORKSPACE,
        prompt: "hi",
        modelSelection: {
          providerId: "account:bigmodel-individual-coding-plan",
          modelId: "GLM-5.3-Flash",
        },
      }),
    );

    expect(mock.createTask).not.toHaveBeenCalled();
    expect(posted.at(-1)).toMatchObject({
      ok: true,
      status: 400,
      body: { error: "invalid_model_selection", message: "account-connection-unavailable" },
    });
  });

  it("create：无 issue → 透传 effectiveSelection（服务端归一后的选择，不用请求原值）", async () => {
    const { responder, posted, mock } = createHarness({}, {
      getView: async () => ({
        effectiveSelection: {
          providerId: "real-provider",
          modelId: "m",
          options: { reasoningLevel: "high" },
        },
      }),
    });

    await responder.handleRequest(
      request("r1", {
        kind: "create",
        workspacePath: WORKSPACE,
        prompt: "hi",
        modelSelection: { providerId: "account:plan-x", modelId: "m" },
      }),
    );

    expect(mock.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        modelSelection: {
          providerId: "real-provider",
          modelId: "m",
          options: { reasoningLevel: "high" },
        },
      }),
    );
    expect(posted.at(-1)).toMatchObject({ ok: true, status: 201 });
  });

  it("create：模型服务缺失 → 原样透传（旧行为，不阻断建会话）", async () => {
    const { responder, posted, mock } = createHarness(); // 缺省不注册 IModelSelectionService

    await responder.handleRequest(
      request("r1", {
        kind: "create",
        workspacePath: WORKSPACE,
        prompt: "hi",
        modelSelection: { providerId: "p", modelId: "m" },
      }),
    );

    expect(mock.createTask).toHaveBeenCalledWith(
      expect.objectContaining({ modelSelection: { providerId: "p", modelId: "m" } }),
    );
    expect(posted.at(-1)).toMatchObject({ ok: true, status: 201, body: { taskId: TASK_ID } });
  });

  it("setModel：reasoning-level-missing 补最高档后调 setModel，应答 200 {ok:true}", async () => {
    const { responder, posted, mock } = createHarness({}, {
      getView: async () => ({
        providers: [
          {
            providerId: "p",
            config: {},
            models: [
              { modelId: "m", config: { optionSpecs: { reasoningLevel: { values: ["low", "high"] } } } },
            ],
          },
        ],
        selectionIssue: "reasoning-level-missing",
      }),
    });

    await responder.handleRequest(
      request("r1", {
        kind: "setModel",
        workspacePath: WORKSPACE,
        taskId: TASK_ID,
        modelSelection: { providerId: "p", modelId: "m" },
      }),
    );

    expect(mock.setModel).toHaveBeenCalledWith({
      taskId: TASK_ID,
      traceId: expect.stringMatching(UUID_RE),
      modelSelection: { providerId: "p", modelId: "m", options: { reasoningLevel: "high" } },
    });
    expect(posted.at(-1)).toMatchObject({ ok: true, status: 200, body: { ok: true } });
  });

  it("setModel：provider-not-found → 归属校验在前（getTaskMeta 已调）、400 且不调 setModel", async () => {
    const { responder, posted, mock } = createHarness({}, {
      getView: async () => ({ selectionIssue: "provider-not-found" }),
    });

    await responder.handleRequest(
      request("r1", {
        kind: "setModel",
        workspacePath: WORKSPACE,
        taskId: TASK_ID,
        modelSelection: { providerId: "nope", modelId: "m" },
      }),
    );

    expect(mock.getTaskMeta).toHaveBeenCalledWith({ taskId: TASK_ID, workspacePath: WORKSPACE });
    expect(mock.setModel).not.toHaveBeenCalled();
    expect(posted.at(-1)).toMatchObject({
      ok: true,
      status: 400,
      body: { error: "invalid_model_selection", message: "provider-not-found" },
    });
  });
});

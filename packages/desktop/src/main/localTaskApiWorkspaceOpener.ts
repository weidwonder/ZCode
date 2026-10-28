/* 本机任务 API 的 workspace 自动打开协调器：dispatcher 解析不到 Host 时，经注入的
 * openWorkspace 触发 ZCode 主进程打开工作区（与 deep link / --open-workspace /
 * Finder 同一条 handleOpenWorkspacePath 链路，不自定义窗口策略），再有界轮询等待
 * 窗口 Host 在 taskRealtimeBus 注册；同 workspace 的并发请求共享同一次打开+等待。
 * 本文件不 import electron，依赖全部注入以便单测。 */

export type LocalTaskApiOpenWorkspaceResult = "opened" | "invalid" | "blocked";

export interface LocalTaskApiWorkspaceOpenerDeps {
  /** 与 dispatcher 同源的 Host 解析；命中即视为已注册。 */
  resolveHost: (workspacePath: string) => { postMessage: (message: unknown) => void } | null;
  /** 缺省（undefined）表示不自动打开，维持 409 workspace_not_open。 */
  openWorkspace?: (workspacePath: string) => LocalTaskApiOpenWorkspaceResult;
  /** 打开→Host 注册的总时限，默认 30_000；测试可注入小值。 */
  timeoutMs?: number;
  /** 轮询间隔，默认 250；测试可注入小值。 */
  pollMs?: number;
  /** 等待期间重发 openWorkspace 的间隔，默认 2000，测试可注入小值。 */
  reopenEveryMs?: number;
  logger: { warn: (...args: unknown[]) => void };
  /** 测试注入时钟；缺省 Date.now。 */
  now?: () => number;
}

export type EnsureWorkspaceReadyResult =
  | { kind: "ready"; host: { postMessage: (message: unknown) => void } }
  | { kind: "reject"; status: number; body: unknown };

/** 打开→Host 注册的默认总时限。 */
const DEFAULT_TIMEOUT_MS = 30_000;
/** 打开后的默认轮询间隔。 */
const DEFAULT_POLL_MS = 250;
/** 等待期间重发 openWorkspace 的间隔。上游 pendingOpenWorkspaceRequest 是单槽
 * （desktopOAuthDeepLink.ts），无窗口/renderer 未 ready 时跨 workspace 并发打开后到覆盖先到；
 * 重发幂等：renderer 侧 handleSelectProject 对已开目录只激活 tab 跳过重复打开
 * （useRootWorkspaceActions.ts:540-547），不会加重复标签。 */
const DEFAULT_REOPEN_EVERY_MS = 2_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    // 与 dispatcher 兜底定时器同理：不靠轮询维持进程存活。
    timer.unref?.();
  });
}

export function createLocalTaskApiWorkspaceOpener(deps: LocalTaskApiWorkspaceOpenerDeps) {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollMs = deps.pollMs ?? DEFAULT_POLL_MS;
  const reopenEveryMs = deps.reopenEveryMs ?? DEFAULT_REOPEN_EVERY_MS;
  const now = deps.now ?? Date.now;
  // in-flight 去重：同 workspace 并发请求共享同一次 openWorkspace + 一轮等待。
  const inFlight = new Map<string, Promise<EnsureWorkspaceReadyResult>>();

  async function openAndWait(
    workspacePath: string,
    requestId?: string,
  ): Promise<EnsureWorkspaceReadyResult> {
    let opened: LocalTaskApiOpenWorkspaceResult;
    try {
      opened = deps.openWorkspace!(workspacePath);
    } catch {
      // openWorkspace 抛错不按 "blocked" 处理：blocked 语义是强制升级等进程级拦截
      // （有专属错误码），抛错属于注入实现的未预期异常，按 503 unavailable_host 应答。
      deps.logger.warn(
        `[local-task-api] workspace open unexpected error request=${requestId ?? "unknown"}`,
      );
      return { kind: "reject", status: 503, body: { error: "unavailable_host" } };
    }
    if (opened === "blocked") {
      deps.logger.warn(`[local-task-api] workspace open blocked request=${requestId ?? "unknown"}`);
      return { kind: "reject", status: 409, body: { error: "workspace_open_blocked" } };
    }
    if (opened === "invalid") {
      deps.logger.warn(`[local-task-api] workspace open invalid request=${requestId ?? "unknown"}`);
      return { kind: "reject", status: 400, body: { error: "workspace_path_invalid" } };
    }
    // "opened"：renderer 侧把 workspace 标签挂上、Host 进程注册到 bus 都需要时间，
    // 首查前先等一个 pollMs，再有界轮询直到 Host 注册或超时。
    const startedAt = now();
    // 首次 openWorkspace 的时刻：重发间隔从它起算。
    let lastOpenAt = startedAt;
    for (;;) {
      await sleep(pollMs);
      const host = deps.resolveHost(workspacePath);
      if (host) {
        return { kind: "ready", host };
      }
      if (now() - lastOpenAt >= reopenEveryMs) {
        lastOpenAt = now();
        // 重发只为治愈单槽覆盖；首次判定（blocked/invalid）不变，重发结果与异常都忽略。
        try {
          deps.openWorkspace!(workspacePath);
        } catch {
          // 重发失败不改变首次判定，继续等待
        }
      }
      const waitedMs = now() - startedAt;
      if (waitedMs >= timeoutMs) {
        deps.logger.warn(
          `[local-task-api] workspace open timeout request=${requestId ?? "unknown"} waited=${waitedMs}`,
        );
        return { kind: "reject", status: 409, body: { error: "workspace_open_timeout" } };
      }
    }
  }

  async function ensureWorkspaceReady(
    workspacePath: string,
    requestId?: string,
  ): Promise<EnsureWorkspaceReadyResult> {
    // 已注册：直接命中，不进去重表（也不触发 openWorkspace）。
    const host = deps.resolveHost(workspacePath);
    if (host) {
      return { kind: "ready", host };
    }
    if (!deps.openWorkspace) {
      return { kind: "reject", status: 409, body: { error: "workspace_not_open" } };
    }
    const existing = inFlight.get(workspacePath);
    if (existing) {
      return existing;
    }
    const promise = openAndWait(workspacePath, requestId).finally(() => {
      // settle 后必清：防泄漏；失败也允许下一次请求立即重试。
      inFlight.delete(workspacePath);
    });
    inFlight.set(workspacePath, promise);
    return promise;
  }

  return { ensureWorkspaceReady };
}

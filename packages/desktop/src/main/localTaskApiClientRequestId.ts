/* 本机任务 API 的 clientRequestId 幂等：create 与 messages 共用同一套
 * 10 分钟去重 / in-flight future 共享 / 失败不缓存语义；两张表按各自
 * 命名空间独立（create 全局键、messages 以 taskId 隔离）。duplicate 应答与
 * 日志文案由本模块逐字保持；HTTP 写回经调用方注入的 respond 回调完成，本模块
 * 不接触传输。时序约定：claim 同步完成惰性清理 + 查表 + 未命中登记（miss 与
 * 登记之间无 await，并发同 id 不可能双双 dispatch），命中方经 respondToDuplicate
 * 异步等待共享应答。model 命名空间供 POST /api/tasks/:id/model 换模型幂等使用，
 * key 加 `model\0` 前缀与 send 隔离（同一 clientRequestId 先后用于两个端点不会误判）。 */

/** 与 dispatcher 应答同形的最小结构：幂等表缓存与共享 future 都用它。 */
export type LocalTaskApiResponseLike = { status: number; body: unknown };

/** 从应答 body 提取 taskId：仅形如 { taskId: string } 才算，否则 null。 */
export function taskIdOf(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const taskId = (body as { taskId?: unknown })["taskId"];
  return typeof taskId === "string" ? taskId : null;
}

/** 幂等窗口内的表项：进行中带共享 future，settle 时覆写为缓存值或清除。 */
interface DedupEntry<TDone> {
  expiresAt: number;
  /** in-flight 期共享的完整应答 future；settle 先落缓存/清除，再 resolve。 */
  future?: Promise<LocalTaskApiResponseLike>;
  /** 成功后的缓存值：create 存 taskId（代答回 201 {taskId}），send 存完整应答。 */
  done?: TDone;
}

/** create 命中形态：done 回缓存 taskId、inflight 等共享 future、fresh 表示已登记新条目。 */
export type CreateDedupClaim =
  | { kind: "done"; clientRequestId: string; taskId: string }
  | { kind: "inflight"; clientRequestId: string; future: Promise<LocalTaskApiResponseLike> }
  | { kind: "fresh"; settle: (result: LocalTaskApiResponseLike) => void };

/** send 命中形态：done 回缓存完整应答、inflight 等共享 future、fresh 表示已登记新条目。 */
export type SendDedupClaim =
  | {
      kind: "done";
      clientRequestId: string;
      taskId: string;
      response: LocalTaskApiResponseLike;
    }
  | {
      kind: "inflight";
      clientRequestId: string;
      taskId: string;
      future: Promise<LocalTaskApiResponseLike>;
    }
  | { kind: "fresh"; settle: (result: LocalTaskApiResponseLike) => void };

export interface ClientRequestIdDedupOptions {
  /** duplicate 日志的输出端，与拆分前同一 logger（info 级）。 */
  logger: { info: (...args: unknown[]) => void };
  /** 幂等窗口，默认 10 分钟。 */
  ttlMs?: number;
  /** 时钟注入点（测试用），默认 Date.now。 */
  now?: () => number;
}

export interface ClientRequestIdDedup {
  create: {
    /** 同步清理过期项并查表；未命中登记 in-flight future。无 id（null）返回空转 fresh。 */
    claim(clientRequestId: string | null): CreateDedupClaim;
    /** 命中代答：in-flight 等共享应答、done 回缓存，先输出 duplicate create 日志再返回应答。 */
    respondToDuplicate(
      claim: Exclude<CreateDedupClaim, { kind: "fresh" }>,
    ): Promise<LocalTaskApiResponseLike>;
  };
  send: {
    /** 同 create：键为 `${taskId}\0${clientRequestId}`，按任务隔离。 */
    claim(taskId: string, clientRequestId: string): SendDedupClaim;
    /** 命中代答：in-flight 等共享应答、done 回缓存，先输出 duplicate send 日志再返回应答。 */
    respondToDuplicate(
      claim: Exclude<SendDedupClaim, { kind: "fresh" }>,
    ): Promise<LocalTaskApiResponseLike>;
  };
  model: {
    /** 同 send：键加 `model\0` 前缀与 send 隔离，按任务隔离。 */
    claim(taskId: string, clientRequestId: string): SendDedupClaim;
    /** 命中代答：in-flight 等共享应答、done 回缓存，先输出 duplicate model 日志再返回应答。 */
    respondToDuplicate(
      claim: Exclude<SendDedupClaim, { kind: "fresh" }>,
    ): Promise<LocalTaskApiResponseLike>;
  };
}

/** 创建 clientRequestId 幂等：create / send / model 三个命名空间各自独立。 */
export function createClientRequestIdDedup(
  options: ClientRequestIdDedupOptions,
): ClientRequestIdDedup {
  const ttlMs = options.ttlMs ?? 10 * 60 * 1000;
  const now = options.now ?? Date.now;
  return {
    create: createCreateNamespace(options.logger, ttlMs, now),
    send: createSendNamespace(options.logger, ttlMs, now, "", "send"),
    model: createSendNamespace(options.logger, ttlMs, now, "model\0", "model"),
  };
}

function createCreateNamespace(
  logger: ClientRequestIdDedupOptions["logger"],
  ttlMs: number,
  now: () => number,
) {
  const entries = new Map<string, DedupEntry<string>>();

  function claim(clientRequestId: string | null): CreateDedupClaim {
    // 无 id 不查表也不清理：与拆分前一致（清理只发生在带 id 的请求上）。
    if (clientRequestId === null) {
      return { kind: "fresh", settle: () => {} };
    }
    const nowMs = now();
    // 惰性清理：整表扫一遍删过期项，再查本次的 id。
    for (const [key, entry] of entries) {
      if (entry.expiresAt < nowMs) entries.delete(key);
    }
    const hit = entries.get(clientRequestId);
    if (hit !== undefined) {
      if (hit.future !== undefined) {
        return { kind: "inflight", clientRequestId, future: hit.future };
      }
      if (hit.done !== undefined) {
        return { kind: "done", clientRequestId, taskId: hit.done };
      }
    }
    let resolveFuture!: (result: LocalTaskApiResponseLike) => void;
    const future = new Promise<LocalTaskApiResponseLike>((resolve) => {
      resolveFuture = resolve;
    });
    entries.set(clientRequestId, { expiresAt: now() + ttlMs, future });
    return {
      kind: "fresh",
      settle: (result) => {
        // 成功（2xx 且 body 形如 {taskId}）落 taskId 缓存并刷新 TTL；失败/异常清除
        // （可重试）；future 恒结清，in-flight 等待方不悬死。
        const taskId = result.status >= 200 && result.status < 300 ? taskIdOf(result.body) : null;
        if (taskId !== null) {
          entries.set(clientRequestId, { expiresAt: now() + ttlMs, done: taskId });
        } else {
          entries.delete(clientRequestId);
        }
        resolveFuture(result);
      },
    };
  }

  async function respondToDuplicate(
    claim: Exclude<CreateDedupClaim, { kind: "fresh" }>,
  ): Promise<LocalTaskApiResponseLike> {
    if (claim.kind === "inflight") {
      const shared = await claim.future;
      const sharedTaskId = taskIdOf(shared.body) ?? "unknown";
      // 等待方直接透传首个请求的应答：归属表由首个请求登记，这里不重复登记。
      logger.info(
        `[local-task-api] duplicate create request=${claim.clientRequestId} task=${sharedTaskId}`,
      );
      return shared;
    }
    logger.info(
      `[local-task-api] duplicate create request=${claim.clientRequestId} task=${claim.taskId}`,
    );
    return { status: 201, body: { taskId: claim.taskId } };
  }

  return { claim, respondToDuplicate };
}

function createSendNamespace(
  logger: ClientRequestIdDedupOptions["logger"],
  ttlMs: number,
  now: () => number,
  keyPrefix: string,
  logLabel: string,
) {
  const entries = new Map<string, DedupEntry<LocalTaskApiResponseLike>>();

  function claim(taskId: string, clientRequestId: string): SendDedupClaim {
    const dedupeKey = `${keyPrefix}${taskId}\0${clientRequestId}`;
    const nowMs = now();
    // 惰性清理：与 create 同语义，dispatch 之前先删过期项。
    for (const [key, entry] of entries) {
      if (entry.expiresAt < nowMs) entries.delete(key);
    }
    const hit = entries.get(dedupeKey);
    if (hit !== undefined) {
      if (hit.future !== undefined) {
        return { kind: "inflight", clientRequestId, taskId, future: hit.future };
      }
      if (hit.done !== undefined) {
        return { kind: "done", clientRequestId, taskId, response: hit.done };
      }
    }
    let resolveFuture!: (result: LocalTaskApiResponseLike) => void;
    const future = new Promise<LocalTaskApiResponseLike>((resolve) => {
      resolveFuture = resolve;
    });
    entries.set(dedupeKey, { expiresAt: now() + ttlMs, future });
    return {
      kind: "fresh",
      settle: (result) => {
        // 成功（2xx）缓存完整应答并刷新 TTL；失败清除（可重试）；future 恒结清。
        if (result.status >= 200 && result.status < 300) {
          entries.set(dedupeKey, {
            expiresAt: now() + ttlMs,
            done: { status: result.status, body: result.body },
          });
        } else {
          entries.delete(dedupeKey);
        }
        resolveFuture(result);
      },
    };
  }

  async function respondToDuplicate(
    claim: Exclude<SendDedupClaim, { kind: "fresh" }>,
  ): Promise<LocalTaskApiResponseLike> {
    const shared = claim.kind === "inflight" ? await claim.future : claim.response;
    // 等待方直接透传首个请求的应答：归属表由首个请求回填，这里不重复回填。
    logger.info(
      `[local-task-api] duplicate ${logLabel} request=${claim.clientRequestId} task=${claim.taskId}`,
    );
    return shared;
  }

  return { claim, respondToDuplicate };
}

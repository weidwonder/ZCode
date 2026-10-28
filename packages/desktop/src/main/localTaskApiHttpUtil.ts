/* 本机任务 API 的 HTTP 传输层纯工具，从 localTaskApi.ts 拆出以守 800 行 lint 上限。
 * 只含无状态函数与常量：JSON 应答写回、body 读取与大小上限、路径段解析等。
 * 行为零变化；localTaskApi.ts 经 import 使用。 */
import type { IncomingMessage, ServerResponse } from "node:http";

/** POST body 上限：16 MiB，超出回 413。 */
export const MAX_BODY_BYTES = 16 * 1024 * 1024;

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

export type BodyReadResult = { ok: true; text: string } | { ok: false; tooLarge: boolean };

export function readRequestBody(req: IncomingMessage): Promise<BodyReadResult> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const finish = (result: BodyReadResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    req.on("data", (chunk: Buffer) => {
      if (settled) return;
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        finish({ ok: false, tooLarge: true });
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => finish({ ok: true, text: Buffer.concat(chunks).toString("utf8") }));
    req.on("error", () => finish({ ok: false, tooLarge: false }));
  });
}

export function hasDeclaredBody(req: IncomingMessage): boolean {
  const contentLength = req.headers["content-length"];
  if (contentLength !== undefined && Number(contentLength) > 0) return true;
  return req.headers["transfer-encoding"] !== undefined;
}

export function parseAfter(raw: string | null): number {
  if (raw === null || raw === "") return 0;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) return 0;
  return parsed;
}

export function parseWaitMs(raw: string | null): number {
  const parsed = Number(raw ?? "0");
  const base = Number.isFinite(parsed) ? parsed : 0;
  return Math.min(30_000, Math.max(0, Math.trunc(base)));
}

export function parsePathSegments(pathname: string): string[] | null {
  const segments: string[] = [];
  for (const segment of pathname.split("/")) {
    if (segment.length === 0) continue;
    try {
      segments.push(decodeURIComponent(segment));
    } catch {
      return null;
    }
  }
  return segments;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** clientRequestId 可选：存在时须 1..200 字符；未提供回 null、非法回 "invalid"（create 与 setModel 共用）。 */
export function validateClientRequestId(parsed: Record<string, unknown>): string | null | "invalid" {
  const clientRequestId = parsed["clientRequestId"];
  if (clientRequestId === undefined) return null;
  if (
    typeof clientRequestId !== "string" ||
    clientRequestId.length < 1 ||
    clientRequestId.length > 200
  ) {
    return "invalid";
  }
  return clientRequestId;
}

export function segmentAt(segments: string[], index: number): string | null {
  const value = segments[index];
  return typeof value === "string" && value.length > 0 ? value : null;
}

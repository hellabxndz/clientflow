import { sysQuery } from "./db";

export interface RateLimitResult {
  ok: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

/**
 * Fixed-window rate limiter shared by every app instance, backed by the `rate_limits` table.
 * One atomic upsert per call: a new key or an expired window starts at 1, otherwise the count increments.
 */
export async function rateLimit(key: string, limit: number, windowMs: number): Promise<RateLimitResult> {
  const [row] = await sysQuery<{ count: number; window_start: Date }>(
    `insert into rate_limits (key, window_start, count) values ($1, now(), 1)
     on conflict (key) do update set
       count = case when rate_limits.window_start <= now() - ($2 || ' milliseconds')::interval then 1 else rate_limits.count + 1 end,
       window_start = case when rate_limits.window_start <= now() - ($2 || ' milliseconds')::interval then now() else rate_limits.window_start end
     returning count, window_start`,
    [key.slice(0, 300), String(Math.max(1, Math.trunc(windowMs)))],
  );
  const count = row?.count ?? 1;
  const resetAt = (row ? new Date(row.window_start).getTime() : Date.now()) + windowMs;
  const ok = count <= limit;
  return { ok, remaining: Math.max(0, limit - count), retryAfterSeconds: ok ? 0 : Math.max(1, Math.ceil((resetAt - Date.now()) / 1000)) };
}

/** Removes windows that ended long ago. Safe to call from the scheduled tick. */
export async function pruneRateLimits(olderThanMs = 24 * 60 * 60 * 1000) {
  await sysQuery("delete from rate_limits where window_start < now() - ($1 || ' milliseconds')::interval", [String(olderThanMs)]);
}

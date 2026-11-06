import type { RpcClient } from "../db/rpc.ts";
import { hmacSha256Hex } from "../lib/hash.ts";

/**
 * Abuse and cost control for an anonymous endpoint that spends money on every message.
 *
 * - Per-client fixed windows (per minute and per day) keyed by an HMAC of the IP: the database
 *   never holds an IP, and without the salt the hashes cannot be reversed.
 * - A global daily budget: once the day's estimated spend reaches DAILY_BUDGET_USD, the API stops
 *   calling the model and answers with the contact channels only.
 */
export interface RateLimitDecision {
  allowed: boolean;
  /** Seconds until the window that blocked the request resets. */
  retryAfterSeconds: number;
}

export class RateLimiter {
  constructor(
    private readonly rpc: RpcClient,
    private readonly settings: { salt: string; perMinute: number; perDay: number },
    private readonly now: () => Date = () => new Date(),
  ) {}

  async check(clientKey: string): Promise<RateLimitDecision> {
    const hashed = (await hmacSha256Hex(this.settings.salt, clientKey)).slice(0, 32);
    for (const [label, seconds, limit] of [
      ["minute", 60, this.settings.perMinute],
      ["day", 86_400, this.settings.perDay],
    ] as const) {
      const result = await this.rpc.value<{ allowed: boolean; reset_at: string }>("rl_hit", {
        p_key: `ip:${hashed}:${label}`,
        p_window_seconds: seconds,
        p_limit: limit,
      });
      if (!result.allowed) {
        const wait = Math.ceil((new Date(result.reset_at).getTime() - this.now().getTime()) / 1000);
        return { allowed: false, retryAfterSeconds: Math.max(1, wait) };
      }
    }
    return { allowed: true, retryAfterSeconds: 0 };
  }
}

export class DailyBudget {
  private cached: { spent: number; at: number } | null = null;

  constructor(
    private readonly rpc: RpcClient,
    private readonly limitUsd: number,
    /** The sum is re-read at most this often; a burst can overshoot by a few requests. */
    private readonly cacheMs = 30_000,
    private readonly now: () => number = Date.now,
  ) {}

  async exceeded(): Promise<boolean> {
    if (!this.cached || this.now() - this.cached.at > this.cacheMs) {
      const spent = Number(await this.rpc.value<number | string>("budget_spent_today"));
      this.cached = { spent: Number.isFinite(spent) ? spent : 0, at: this.now() };
    }
    return this.cached.spent >= this.limitUsd;
  }

  /** Count a request's cost locally until the next read. */
  add(costUsd: number): void {
    if (this.cached) this.cached.spent += costUsd;
  }
}

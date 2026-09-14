import type { RetryPolicy } from "@/lib/http";

/**
 * Cron 1回あたりの処理時間の予算。最悪ケースは
 *   データ取得 35s(+保険の猶予 0.25s)+ LINE 15s = 50.25s
 * で、route.ts の maxDuration(60s)に対して約10秒の余裕を残す。
 * 数値を変えたら tests/timing.test.ts と tests/route.test.ts の時間予算テストで検証される。
 */
export const MAX_DURATION_MS = 60_000;
export const DATA_PHASE_BUDGET_MS = 35_000;
export const LINE_PHASE_BUDGET_MS = 15_000;
/** Deadline.race の保険用の猶予。通常は各リクエストが残り時間に合わせた自分のタイムアウトで先に終わる */
export const DEADLINE_GRACE_MS = 250;

/** 失敗した指標を取り直す前の待ち時間と、取り直しに最低限必要な残り時間 */
export const REFETCH_DELAY_MS = 3_000;
export const MIN_REFETCH_WINDOW_MS = 2_000;

/** 残り時間がこれ未満なら、新しい試行を始めない */
export const MIN_ATTEMPT_MS = 500;

/** 再試行前の待ち時間にかけるジッター係数の範囲 */
export const JITTER_MIN = 0.5;
export const JITTER_MAX = 1.5;

export const RETRY_POLICY = {
  fred: { timeoutMs: 8_000, retries: 2, backoffMs: 1_000 },
  ecb: { timeoutMs: 8_000, retries: 2, backoffMs: 1_000 },
  // 月初に読む全期間 CSV は約1.1MB あるため長め
  mof: { timeoutMs: 10_000, retries: 1, backoffMs: 1_000 },
  line: { timeoutMs: 5_000, retries: 2, backoffMs: 500 },
} satisfies Record<string, RetryPolicy>;

/** 再試行前の待ち時間の基準(ジッター前)。試行ごとに2倍になる */
export function backoffBaseMs(policy: RetryPolicy, attempt: number): number {
  return policy.backoffMs * 2 ** (attempt - 1);
}

/** 制限時間がない場合に、1つのリクエストが再試行を含めてかかりうる最長時間 */
export function worstCaseRequestMs(policy: RetryPolicy): number {
  let total = policy.timeoutMs * (policy.retries + 1);
  for (let attempt = 1; attempt <= policy.retries; attempt++) total += backoffBaseMs(policy, attempt) * JITTER_MAX;
  return total;
}

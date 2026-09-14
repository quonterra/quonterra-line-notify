import { describe, expect, it } from "vitest";
import { maxDuration } from "@/app/api/cron/line-market-summary/route";
import {
  DATA_PHASE_BUDGET_MS,
  DEADLINE_GRACE_MS,
  LINE_PHASE_BUDGET_MS,
  MAX_DURATION_MS,
  MIN_REFETCH_WINDOW_MS,
  REFETCH_DELAY_MS,
  RETRY_POLICY,
  worstCaseRequestMs,
} from "@/lib/timing";

describe("time budget", () => {
  it("matches the route's maxDuration", () => {
    expect(maxDuration * 1000).toBe(MAX_DURATION_MS);
  });

  it("keeps the worst case (data phase + grace + LINE phase) at least 9 seconds under maxDuration", () => {
    const worstCase = DATA_PHASE_BUDGET_MS + DEADLINE_GRACE_MS + LINE_PHASE_BUDGET_MS;
    expect(worstCase).toBe(50_250);
    expect(MAX_DURATION_MS - worstCase).toBeGreaterThanOrEqual(9_000);
  });

  it("lets a FRED request use all its retries inside the data phase and still leaves room to refetch", () => {
    const fred = worstCaseRequestMs(RETRY_POLICY.fred);
    // 8s × 3回 + 待ち 1s×1.5 + 2s×1.5(ジッター最大)
    expect(fred).toBe(28_500);
    expect(DATA_PHASE_BUDGET_MS - fred - REFETCH_DELAY_MS).toBeGreaterThanOrEqual(MIN_REFETCH_WINDOW_MS);
  });

  it("allows at least two full LINE attempts inside the LINE phase", () => {
    const { timeoutMs, backoffMs } = RETRY_POLICY.line;
    expect(timeoutMs * 2 + backoffMs * 1.5).toBeLessThanOrEqual(LINE_PHASE_BUDGET_MS);
  });
});

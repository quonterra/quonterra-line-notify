import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Deadline } from "@/lib/deadline";
import { errorMessage, FetchError } from "@/lib/errors";
import { request, type RetryPolicy } from "@/lib/http";
import { hang, settle, useFakeClock } from "./helpers";

const policy: RetryPolicy = { timeoutMs: 8_000, retries: 2, backoffMs: 1_000 };
const url = "https://api.stlouisfed.org/fred/series/observations?series_id=DGS2&api_key=secret-key";
const readText = (res: Response) => res.text();

beforeEach(() => {
  useFakeClock();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function failureOf(promise: Promise<unknown>): Promise<FetchError> {
  const error = await settle(promise).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(FetchError);
  return error as FetchError;
}

describe("errorMessage", () => {
  it("masks API keys and bearer tokens", () => {
    const message = errorMessage(new Error(`GET ${url} failed; Authorization: Bearer tok-xyz`));
    expect(message).not.toMatch(/secret-key|tok-xyz/);
    expect(message).toContain("api_key=***");
  });
});

describe("request", () => {
  it("returns what read() produces on success", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("ok")));
    await expect(settle(request({ label: "t", url, policy, read: readText }))).resolves.toBe("ok");
  });

  it("retries a 5xx after a backoff and returns the recovered response", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("", { status: 503 }))
      .mockResolvedValueOnce(new Response("ok"));
    vi.stubGlobal("fetch", fetchMock);
    const startedAt = Date.now();

    await expect(settle(request({ label: "t", url, policy, read: readText }))).resolves.toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(1_000);
  });

  it("does not retry a 4xx and reports it as an HTTP failure", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("Bad Request", { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);

    const error = await failureOf(request({ label: "FRED DGS2", url, policy, read: readText }));
    expect(error.failure).toEqual({ kind: "http", status: 400, detail: "Bad Request", attempts: 1, elapsedMs: 0, stoppedByDeadline: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reports a server that never answers as a timeout, with attempts and elapsed time", async () => {
    const fetchMock = vi.fn(hang);
    vi.stubGlobal("fetch", fetchMock);

    const error = await failureOf(request({ label: "FRED DGS2", url, policy, read: readText }));
    // 8s × 3回 + 再試行前の待ち 1s + 2s
    expect(error.failure).toEqual({ kind: "timeout", timeoutMs: 8_000, attempts: 3, elapsedMs: 27_000, stoppedByDeadline: false });
    expect(error.message).toBe("FRED DGS2: timeout (no response within 8000ms); 3 attempts in 27000ms");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("also times out when the headers arrive but the body never finishes", async () => {
    const slowBody = vi.fn(async (_input: string, init?: RequestInit) => {
      const body = hang(new URL("https://example.com"), init);
      return { ok: true, status: 200, headers: new Headers(), text: () => body } as unknown as Response;
    });
    vi.stubGlobal("fetch", slowBody);

    const error = await failureOf(request({ label: "MOF JGB", url, policy, read: readText }));
    expect(error.failure).toMatchObject({ kind: "timeout", attempts: 3 });
  });

  it("reports a refused connection as a network error with its code, without the URL", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(Object.assign(new TypeError(`fetch failed: ${url}`), { cause: { code: "ECONNREFUSED" } })),
    );

    const error = await failureOf(request({ label: "FRED DGS2", url, policy, read: readText }));
    // タイムアウトまで待たず、再試行前の待ち(1s + 2s)だけで終わる
    expect(error.failure).toEqual({
      kind: "network",
      errorName: "TypeError",
      code: "ECONNREFUSED",
      attempts: 3,
      elapsedMs: 3_000,
      stoppedByDeadline: false,
    });
    expect(error.message).toBe("FRED DGS2: network error (TypeError ECONNREFUSED); 3 attempts in 3000ms");
  });

  it.each([
    [0, 1_500], // 係数 0.5: 0.5s + 1s
    [0.999, 4_497], // 係数 1.499: 1.499s + 2.998s
  ])("applies jitter to the backoff (Math.random = %s → %sms)", async (random, expectedMs) => {
    vi.mocked(Math.random).mockReturnValue(random);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));

    const error = await failureOf(request({ label: "t", url, policy, read: readText }));
    expect(error.failure.elapsedMs).toBe(expectedMs);
  });

  it("shrinks the last timeout and stops at the deadline", async () => {
    vi.stubGlobal("fetch", vi.fn(hang));

    const error = await failureOf(request({ label: "t", url, policy, read: readText, deadline: new Deadline(20_000) }));
    // 8s → 待ち1s → 8s(17s)→ 待ち2s(19s)→ 残り1sなのでタイムアウトを1sに縮める
    expect(error.failure).toEqual({ kind: "timeout", timeoutMs: 1_000, attempts: 3, elapsedMs: 20_000, stoppedByDeadline: true });
  });

  it("does not start a request when the deadline has already passed", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const error = await failureOf(request({ label: "t", url, policy, read: readText, deadline: new Deadline(0) }));
    expect(error.failure).toEqual({ kind: "deadline", attempts: 0, elapsedMs: 0, stoppedByDeadline: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

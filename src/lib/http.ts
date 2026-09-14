import { sleep, type Deadline } from "@/lib/deadline";
import { FetchError, redactSecrets, type FetchFailure } from "@/lib/errors";
import { backoffBaseMs, JITTER_MAX, JITTER_MIN, MIN_ATTEMPT_MS } from "@/lib/timing";

export type RetryPolicy = {
  /** 1回あたりのタイムアウト(本文の読み取りまで含む) */
  timeoutMs: number;
  /** 再試行回数(初回を含まない) */
  retries: number;
  /** 再試行前の待ち時間の基準。試行ごとに2倍にし、ジッターをかける */
  backoffMs: number;
};

export type RequestOptions<T> = {
  /** ログ・エラーに出す名前。URL は API キーを含み得るので使わない */
  label: string;
  url: string;
  init?: RequestInit;
  policy: RetryPolicy;
  deadline?: Deadline;
  /** read に渡して成功扱いにするレスポンス(既定: 2xx) */
  accept?: (res: Response) => boolean;
  /** レスポンスの読み取り。タイムアウトの対象に含まれる */
  read: (res: Response) => Promise<T>;
};

const isRetryableStatus = (status: number) => status === 429 || status >= 500;

type AttemptFailure = Omit<FetchFailure, "attempts" | "elapsedMs" | "stoppedByDeadline">;

/**
 * タイムアウト・再試行(ジッター付き指数バックオフ)・制限時間つきの fetch。
 * - タイムアウト / ネットワークエラー / 429 / 5xx は再試行し、それ以外の HTTP エラーはすぐに失敗にする
 * - deadline があれば、残り時間を超えて待ったりリクエストしたりしない
 * - 失敗時は、試行回数・経過時間・最後のエラーを持つ FetchError を投げる
 */
export async function request<T>({
  label,
  url,
  init = {},
  policy,
  deadline,
  accept = (res) => res.ok,
  read,
}: RequestOptions<T>): Promise<T> {
  const startedAt = Date.now();
  let attempts = 0;
  let stoppedByDeadline = false;
  let last: AttemptFailure = { kind: "deadline" };

  for (let attempt = 0; attempt <= policy.retries; attempt++) {
    if (attempt > 0) {
      const wait = backoffBaseMs(policy, attempt) * (JITTER_MIN + Math.random() * (JITTER_MAX - JITTER_MIN));
      if (deadline && deadline.remaining() < wait + MIN_ATTEMPT_MS) {
        stoppedByDeadline = true;
        break;
      }
      await sleep(wait);
    }

    const timeoutMs = Math.min(policy.timeoutMs, deadline ? deadline.remaining() : Infinity);
    if (timeoutMs < MIN_ATTEMPT_MS) {
      stoppedByDeadline = true;
      break;
    }

    attempts++;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...init, cache: "no-store", signal: controller.signal });
      if (accept(res)) return await read(res);
      const detail = redactSecrets((await res.text()).replace(/\s+/g, " ").trim().slice(0, 300));
      last = { kind: "http", status: res.status, ...(detail ? { detail } : {}) };
      if (!isRetryableStatus(res.status)) break;
    } catch (e) {
      if (controller.signal.aborted) {
        last = { kind: "timeout", timeoutMs };
        if (timeoutMs < policy.timeoutMs) stoppedByDeadline = true;
      } else {
        last = { kind: "network", ...describeNetworkError(e) };
      }
    } finally {
      clearTimeout(timer);
    }
  }

  throw new FetchError(label, { ...last, attempts, elapsedMs: Date.now() - startedAt, stoppedByDeadline });
}

// 元のエラーメッセージは URL を含む可能性があるので、エラー名と原因のコードだけ残す
function describeNetworkError(e: unknown): { errorName: string; code?: string } {
  const errorName = e instanceof Error ? e.name : "unknown";
  const code = (e as { cause?: { code?: unknown } } | undefined)?.cause?.code;
  return typeof code === "string" ? { errorName, code } : { errorName };
}

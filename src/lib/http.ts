export class HttpError extends Error {
  constructor(
    readonly label: string,
    readonly status: number,
    detail?: string,
  ) {
    super(`${label}: HTTP ${status}${detail ? ` ${detail}` : ""}`);
    this.name = "HttpError";
  }
}

type RetryOptions = { timeoutMs?: number; retries?: number };

const isRetryable = (status: number) => status === 429 || status >= 500;

/**
 * タイムアウト + 一時的な失敗(ネットワークエラー / 429 / 5xx)のリトライ付き fetch。
 * URL には API キーが含まれ得るため、エラーメッセージには label だけを載せる。
 * 最終試行のレスポンスは ok でなくてもそのまま返すので、呼び出し側で res.ok を確認すること。
 */
export async function fetchWithRetry(
  label: string,
  url: string,
  init: RequestInit = {},
  { timeoutMs = 10_000, retries = 1 }: RetryOptions = {},
): Promise<Response> {
  let lastError: Error = new Error(`${label}: request failed`);
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 1000 * attempt));
    try {
      const res = await fetch(url, {
        ...init,
        cache: "no-store",
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.ok || !isRetryable(res.status) || attempt === retries) return res;
      lastError = new HttpError(label, res.status);
    } catch (e) {
      // 元のエラーメッセージは URL を含む可能性があるので、エラー名だけ残す
      const reason = e instanceof Error ? e.name : "unknown";
      lastError = new Error(`${label}: network error (${reason})`);
    }
  }
  throw lastError;
}

/** ログ・レスポンスに載せる用のエラーメッセージ。万一に備えて API キーらしき値を伏せる。 */
export function errorMessage(e: unknown): string {
  const message = e instanceof Error ? e.message : String(e);
  return message.replace(/(api_key=)[^&\s"]+/gi, "$1***").replace(/(Bearer\s+)\S+/gi, "$1***");
}

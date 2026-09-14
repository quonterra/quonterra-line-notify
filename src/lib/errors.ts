/**
 * timeout:  timeoutMs 以内に応答(本文を含む)が返らなかった = 相手が遅い
 * network:  接続できなかった(code に ECONNREFUSED / ENOTFOUND など)
 * http:     エラーステータスが返った
 * deadline: フェーズの制限時間に達して、試行を始められなかった
 */
export type FailureKind = "timeout" | "network" | "http" | "deadline";

export type FetchFailure = {
  kind: FailureKind;
  attempts: number;
  elapsedMs: number;
  /** フェーズの制限時間のために、試行を打ち切った・タイムアウトを縮めた */
  stoppedByDeadline: boolean;
  timeoutMs?: number;
  status?: number;
  errorName?: string;
  code?: string;
  /** HTTP エラー時のレスポンス本文(先頭のみ) */
  detail?: string;
};

export class FetchError extends Error {
  constructor(
    readonly label: string,
    readonly failure: FetchFailure,
  ) {
    super(describeFailure(label, failure));
    this.name = "FetchError";
  }
}

function describeFailure(label: string, f: FetchFailure): string {
  let what: string;
  switch (f.kind) {
    case "timeout":
      what = `timeout (no response within ${f.timeoutMs}ms)`;
      break;
    case "network":
      what = `network error (${[f.errorName, f.code].filter(Boolean).join(" ") || "unknown"})`;
      break;
    case "http":
      what = `HTTP ${f.status}${f.detail ? ` ${f.detail}` : ""}`;
      break;
    case "deadline":
      what = "phase deadline reached";
      break;
  }
  const attempts = `${f.attempts} attempt${f.attempts === 1 ? "" : "s"}`;
  return `${label}: ${what}; ${attempts} in ${f.elapsedMs}ms${f.stoppedByDeadline ? ", stopped by deadline" : ""}`;
}

/** 万一に備えて、API キーやトークンらしき値を伏せる */
export function redactSecrets(text: string): string {
  return text.replace(/(api_key=)[^&\s"]+/gi, "$1***").replace(/(Bearer\s+)\S+/gi, "$1***");
}

/** ログ・レスポンスに載せる用のエラーメッセージ */
export function errorMessage(e: unknown): string {
  return redactSecrets(e instanceof Error ? e.message : String(e));
}

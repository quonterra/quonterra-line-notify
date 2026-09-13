import { createHash } from "node:crypto";
import type { LineMessage } from "@/lib/flex";
import { fetchWithRetry, HttpError } from "@/lib/http";

const MESSAGE_API = "https://api.line.me/v2/bot/message";

export type BroadcastResult = {
  status: "sent" | "already_sent";
  requestId: string | null;
};

export type ValidationResult = { valid: true } | { valid: false; detail: string };

/**
 * 友だち全員へのブロードキャスト配信。
 * X-Line-Retry-Key が同じリクエストは LINE 側で一度しか受け付けられない(24時間有効)ので、
 * リトライや Cron の再実行で二重に配信されることはない。
 */
export async function broadcast(messages: LineMessage[], token: string, retryKey: string): Promise<BroadcastResult> {
  const label = "LINE broadcast";
  const res = await postMessages(label, `${MESSAGE_API}/broadcast`, messages, token, { "X-Line-Retry-Key": retryKey }, 2);

  if (res.ok) return { status: "sent", requestId: res.headers.get("x-line-request-id") };
  // 同じリトライキーのリクエストがすでに受け付け済み
  if (res.status === 409 && res.headers.has("x-line-accepted-request-id")) {
    return { status: "already_sent", requestId: res.headers.get("x-line-accepted-request-id") };
  }
  throw new HttpError(label, res.status, (await res.text()).slice(0, 500));
}

/** 配信はせず、メッセージが LINE の仕様に合っているかだけを検証する(通数も消費しない)。 */
export async function validateBroadcast(messages: LineMessage[], token: string): Promise<ValidationResult> {
  const label = "LINE validate";
  const res = await postMessages(label, `${MESSAGE_API}/validate/broadcast`, messages, token, {}, 1);

  if (res.ok) return { valid: true };
  const detail = (await res.text()).slice(0, 1000);
  if (res.status === 400) return { valid: false, detail };
  throw new HttpError(label, res.status, detail.slice(0, 500));
}

function postMessages(
  label: string,
  url: string,
  messages: LineMessage[],
  token: string,
  headers: Record<string, string>,
  retries: number,
): Promise<Response> {
  return fetchWithRetry(
    label,
    url,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ messages }),
    },
    { timeoutMs: 15_000, retries },
  );
}

/** JST の日付から決まる UUID 形式のリトライキー。同じ日の配信は1回だけになる。 */
export function dailyRetryKey(jstIsoDate: string): string {
  const h = createHash("sha256").update(`quonterra-academy:line-market-summary:${jstIsoDate}`).digest("hex");
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

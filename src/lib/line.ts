import { createHash } from "node:crypto";
import type { LineMessage } from "@/lib/flex";
import { fetchWithRetry, HttpError } from "@/lib/http";

const BROADCAST_ENDPOINT = "https://api.line.me/v2/bot/message/broadcast";

export type BroadcastResult = {
  status: "sent" | "already_sent";
  requestId: string | null;
};

/**
 * 友だち全員へのブロードキャスト配信。
 * X-Line-Retry-Key が同じリクエストは LINE 側で一度しか受け付けられない(24時間有効)ので、
 * リトライや Cron の再実行で二重に配信されることはない。
 */
export async function broadcast(messages: LineMessage[], token: string, retryKey: string): Promise<BroadcastResult> {
  const label = "LINE broadcast";
  const res = await fetchWithRetry(
    label,
    BROADCAST_ENDPOINT,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-Line-Retry-Key": retryKey,
      },
      body: JSON.stringify({ messages }),
    },
    { timeoutMs: 15_000, retries: 2 },
  );

  if (res.ok) return { status: "sent", requestId: res.headers.get("x-line-request-id") };
  // 同じリトライキーのリクエストがすでに受け付け済み
  if (res.status === 409 && res.headers.has("x-line-accepted-request-id")) {
    return { status: "already_sent", requestId: res.headers.get("x-line-accepted-request-id") };
  }
  throw new HttpError(label, res.status, (await res.text()).slice(0, 500));
}

/** JST の日付から決まる UUID 形式のリトライキー。同じ日の配信は1回だけになる。 */
export function dailyRetryKey(jstIsoDate: string): string {
  const h = createHash("sha256").update(`quonterra-academy:line-market-summary:${jstIsoDate}`).digest("hex");
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

import { createHash } from "node:crypto";
import type { Deadline } from "@/lib/deadline";
import type { LineMessage } from "@/lib/flex";
import { request } from "@/lib/http";
import { RETRY_POLICY } from "@/lib/timing";

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
export function broadcast(
  messages: LineMessage[],
  token: string,
  retryKey: string,
  deadline?: Deadline,
): Promise<BroadcastResult> {
  return request<BroadcastResult>({
    label: "LINE broadcast",
    url: `${MESSAGE_API}/broadcast`,
    init: postInit(messages, token, { "X-Line-Retry-Key": retryKey }),
    policy: RETRY_POLICY.line,
    deadline,
    // 409 + x-line-accepted-request-id は、同じリトライキーのリクエストがすでに受け付け済みという意味
    accept: (res) => res.ok || (res.status === 409 && res.headers.has("x-line-accepted-request-id")),
    read: async (res) =>
      res.ok
        ? { status: "sent", requestId: res.headers.get("x-line-request-id") }
        : { status: "already_sent", requestId: res.headers.get("x-line-accepted-request-id") },
  });
}

/** 配信はせず、メッセージが LINE の仕様に合っているかだけを検証する(通数も消費しない)。 */
export function validateBroadcast(messages: LineMessage[], token: string, deadline?: Deadline): Promise<ValidationResult> {
  return request<ValidationResult>({
    label: "LINE validate",
    url: `${MESSAGE_API}/validate/broadcast`,
    init: postInit(messages, token),
    policy: RETRY_POLICY.line,
    deadline,
    accept: (res) => res.ok || res.status === 400,
    read: async (res) => (res.ok ? { valid: true } : { valid: false, detail: (await res.text()).slice(0, 1000) }),
  });
}

function postInit(messages: LineMessage[], token: string, headers: Record<string, string> = {}): RequestInit {
  return {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ messages }),
  };
}

/** JST の日付から決まる UUID 形式のリトライキー。同じ日の配信は1回だけになる。 */
export function dailyRetryKey(jstIsoDate: string): string {
  const h = createHash("sha256").update(`quonterra-academy:line-market-summary:${jstIsoDate}`).digest("hex");
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

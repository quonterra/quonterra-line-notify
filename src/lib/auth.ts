import { createHash, timingSafeEqual } from "node:crypto";

const MIN_SECRET_LENGTH = 16;

/**
 * Vercel Cron から送られる `Authorization: Bearer <CRON_SECRET>` を検証する。
 * CRON_SECRET が未設定・短すぎる場合は常に拒否する
 * (未設定のまま `Bearer undefined` と比較して一致してしまうのを防ぐ)。
 */
export function isAuthorizedCron(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.trim().length < MIN_SECRET_LENGTH) {
    console.error(`[auth] CRON_SECRET is not configured (must be at least ${MIN_SECRET_LENGTH} characters)`);
    return false;
  }

  const header = request.headers.get("authorization");
  if (!header) return false;

  // 長さの違いで早期に抜けないよう、両方をハッシュして固定長にしてから比較する
  const digest = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(digest(header), digest(`Bearer ${secret}`));
}

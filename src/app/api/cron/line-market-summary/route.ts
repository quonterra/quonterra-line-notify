import { isAuthorizedCron } from "@/lib/auth";
import { readConfig } from "@/lib/config";
import { buildFallbackMessage, buildSummaryMessage } from "@/lib/flex";
import { jstDay } from "@/lib/format";
import { errorMessage } from "@/lib/http";
import { enabledIndicators, loadIndicators } from "@/lib/indicators";
import { broadcast, dailyRetryKey, validateBroadcast } from "@/lib/line";

export const maxDuration = 60;

const LOG = "[line-market-summary]";

type Mode = "broadcast" | "dryRun" | "validate";

/**
 * Vercel Cron(平日 07:00 JST)から呼ばれ、マーケットサマリーを LINE の友だち全員に配信する。
 * テスト用のモード(どちらも認証は必要):
 * - `?dryRun=1`   LINE を呼ばず、組み立てたメッセージを JSON で返す
 * - `?validate=1` LINE の検証 API でメッセージを検証する(配信しない)
 */
export async function GET(request: Request) {
  if (!isAuthorizedCron(request)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const config = readConfig();
  const params = new URL(request.url).searchParams;
  const mode: Mode = params.get("dryRun") === "1" ? "dryRun" : params.get("validate") === "1" ? "validate" : "broadcast";
  const now = new Date();

  const results = await loadIndicators(enabledIndicators(config.includeLicensed), config.fredApiKey);
  const indicators = results.map((r) =>
    r.ok ? { id: r.def.id, ok: true, date: r.latest.date } : { id: r.def.id, ok: false, error: r.error },
  );
  const failed = indicators.filter((i) => !i.ok);
  if (failed.length > 0) console.error(LOG, "indicator fetch failed", JSON.stringify(failed));

  const fallback = failed.length === results.length;
  const message = fallback
    ? buildFallbackMessage(now, config.detailUrl)
    : buildSummaryMessage(results, now, config.detailUrl);

  if (mode === "dryRun") {
    return Response.json({ mode, fallback, indicators, messages: [message] });
  }

  if (!config.lineToken) {
    console.error(LOG, "LINE_CHANNEL_ACCESS_TOKEN_ACADEMY is not set");
    return Response.json({ error: "LINE token is not configured", fallback, indicators }, { status: 500 });
  }

  try {
    if (mode === "validate") {
      const validation = await validateBroadcast([message], config.lineToken);
      return Response.json(
        { mode, ...validation, fallback, indicators, messages: [message] },
        { status: validation.valid ? 200 : 422 },
      );
    }

    const result = await broadcast([message], config.lineToken, dailyRetryKey(jstDay(now).isoDate));
    console.info(LOG, "broadcast", JSON.stringify({ ...result, fallback, failed: failed.length }));
    return Response.json({ mode, ...result, fallback, indicators });
  } catch (e) {
    console.error(LOG, `${mode} failed`, errorMessage(e));
    return Response.json({ error: `LINE ${mode} failed`, fallback, indicators }, { status: 502 });
  }
}

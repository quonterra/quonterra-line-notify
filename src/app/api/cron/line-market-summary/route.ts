import { isAuthorizedCron } from "@/lib/auth";
import { readConfig } from "@/lib/config";
import { buildFallbackMessage, buildSummaryMessage } from "@/lib/flex";
import { jstDay } from "@/lib/format";
import { errorMessage } from "@/lib/http";
import { enabledIndicators, loadIndicators } from "@/lib/indicators";
import { broadcast, dailyRetryKey } from "@/lib/line";

export const maxDuration = 60;

const LOG = "[line-market-summary]";

/**
 * Vercel Cron(平日 07:00 JST)から呼ばれ、マーケットサマリーを LINE の友だち全員に配信する。
 * `?dryRun=1` を付けると配信せず、組み立てたメッセージを JSON で返す(この場合も認証は必要)。
 */
export async function GET(request: Request) {
  if (!isAuthorizedCron(request)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const config = readConfig();
  const dryRun = new URL(request.url).searchParams.get("dryRun") === "1";
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

  if (dryRun) {
    return Response.json({ dryRun: true, fallback, indicators, messages: [message] });
  }

  if (!config.lineToken) {
    console.error(LOG, "LINE_CHANNEL_ACCESS_TOKEN_ACADEMY is not set");
    return Response.json({ error: "LINE token is not configured", fallback, indicators }, { status: 500 });
  }

  try {
    const result = await broadcast([message], config.lineToken, dailyRetryKey(jstDay(now).isoDate));
    console.info(LOG, "broadcast", JSON.stringify({ ...result, fallback, failed: failed.length }));
    return Response.json({ ...result, fallback, indicators });
  } catch (e) {
    console.error(LOG, "broadcast failed", errorMessage(e));
    return Response.json({ error: "LINE broadcast failed", fallback, indicators }, { status: 502 });
  }
}

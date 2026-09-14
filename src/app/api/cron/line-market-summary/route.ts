import { isAuthorizedCron } from "@/lib/auth";
import { readConfig } from "@/lib/config";
import { Deadline } from "@/lib/deadline";
import { errorMessage, FetchError } from "@/lib/errors";
import { buildFallbackMessage, buildSummaryMessage } from "@/lib/flex";
import { jstDay } from "@/lib/format";
import { enabledIndicators, loadIndicators, type IndicatorResult } from "@/lib/indicators";
import { broadcast, dailyRetryKey, validateBroadcast } from "@/lib/line";
import { DATA_PHASE_BUDGET_MS, LINE_PHASE_BUDGET_MS } from "@/lib/timing";

// = MAX_DURATION_MS / 1000。最悪ケースの内訳は src/lib/timing.ts(tests/timing.test.ts で検証)
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

  const startedAt = Date.now();
  const config = readConfig();
  const params = new URL(request.url).searchParams;
  const mode: Mode = params.get("dryRun") === "1" ? "dryRun" : params.get("validate") === "1" ? "validate" : "broadcast";
  const now = new Date();

  const results = await loadIndicators(
    enabledIndicators(config.includeLicensed),
    config.fredApiKey,
    new Deadline(DATA_PHASE_BUDGET_MS),
  );
  logIndicatorOutcome(results, Date.now() - startedAt);
  const indicators = results.map(summarize);

  const failedCount = results.filter((r) => !r.ok).length;
  const fallback = failedCount === results.length;
  const message = fallback
    ? buildFallbackMessage(now, config.detailUrl)
    : buildSummaryMessage(results, now, config.detailUrl);

  if (mode === "dryRun") {
    return Response.json({ mode, fallback, indicators, elapsedMs: Date.now() - startedAt, messages: [message] });
  }

  if (!config.lineToken) {
    console.error(LOG, "LINE_CHANNEL_ACCESS_TOKEN_ACADEMY is not set");
    return Response.json({ error: "LINE token is not configured", fallback, indicators }, { status: 500 });
  }

  const lineDeadline = new Deadline(LINE_PHASE_BUDGET_MS);
  try {
    if (mode === "validate") {
      const validation = await validateBroadcast([message], config.lineToken, lineDeadline);
      return Response.json(
        { mode, ...validation, fallback, indicators, elapsedMs: Date.now() - startedAt, messages: [message] },
        { status: validation.valid ? 200 : 422 },
      );
    }

    const result = await broadcast([message], config.lineToken, dailyRetryKey(jstDay(now).isoDate), lineDeadline);
    const elapsedMs = Date.now() - startedAt;
    console.info(LOG, "broadcast", JSON.stringify({ ...result, fallback, failed: failedCount, elapsedMs }));
    return Response.json({ mode, ...result, fallback, indicators, elapsedMs });
  } catch (e) {
    const elapsedMs = Date.now() - startedAt;
    const failure = e instanceof FetchError ? e.failure : {};
    console.error(LOG, `${mode} failed`, JSON.stringify({ error: errorMessage(e), ...failure, elapsedMs }));
    return Response.json({ error: `LINE ${mode} failed`, fallback, indicators, elapsedMs }, { status: 502 });
  }
}

function summarize(r: IndicatorResult) {
  return r.ok
    ? { id: r.def.id, ok: true, date: r.latest.date, refetched: r.refetched }
    : { id: r.def.id, ok: false, refetched: r.refetched, ...r.failure };
}

/**
 * 取り直しと失敗の内訳をログに残す。
 * kind(timeout / network / http / deadline)・試行回数・経過時間から、
 * 「応答が遅かった」のか「接続できなかった」のかをログだけで判別できるようにする。
 */
function logIndicatorOutcome(results: IndicatorResult[], dataPhaseMs: number) {
  const refetched = results.filter((r) => r.refetched);
  if (refetched.length > 0) {
    console.info(
      LOG,
      "indicator refetch",
      JSON.stringify({
        recovered: refetched.filter((r) => r.ok).map((r) => r.def.id),
        stillFailed: refetched.filter((r) => !r.ok).map((r) => r.def.id),
      }),
    );
  }

  const failures = results.flatMap((r) => (r.ok ? [] : [{ id: r.def.id, refetched: r.refetched, ...r.failure }]));
  if (failures.length > 0) {
    console.error(LOG, "indicator fetch failed", JSON.stringify({ dataPhaseMs, failures }));
  }
}

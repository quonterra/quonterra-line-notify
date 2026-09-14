import { Deadline, sleep } from "@/lib/deadline";
import { errorMessage, FetchError, type FetchFailure } from "@/lib/errors";
import { fetchEcbRate } from "@/lib/sources/ecb";
import { fetchFredObservations } from "@/lib/sources/fred";
import { fetchJgbYield } from "@/lib/sources/mof";
import { DATA_PHASE_BUDGET_MS, MIN_REFETCH_WINDOW_MS, REFETCH_DELAY_MS } from "@/lib/timing";
import type { Observation } from "@/lib/types";

/** 前日比の表示形式。bp: 利回りの差(ベーシスポイント)、abs: 値の差、pct: 変化率 */
export type ChangeFormat = "bp" | "abs" | "pct";

export type LoadContext = {
  /** FRED の系列ごとに、成功した取得は使い回す(失敗したものは取り直しのときに再リクエストする) */
  fred: (seriesId: string) => Promise<Observation[]>;
  /** データ取得フェーズ全体の制限時間 */
  deadline: Deadline;
};

export type IndicatorDef = {
  id: string;
  label: string;
  unit: "%" | "";
  decimals: number;
  change: ChangeFormat;
  /** カード下部に出す出典表記 */
  source: string;
  /** 新しい順の観測値を返す */
  load: (ctx: LoadContext) => Promise<Observation[]>;
};

export type IndicatorFailure = Omit<Partial<FetchFailure>, "kind"> & {
  error: string;
  /** config: 設定不備(FRED_API_KEY 未設定など)、invalid: データが足りない・形式が違う */
  kind: FetchFailure["kind"] | "config" | "invalid";
  /** 取り直した場合の、1回目の取得での失敗 */
  firstRound?: Omit<IndicatorFailure, "firstRound">;
};

export type IndicatorResult =
  | { def: IndicatorDef; ok: true; latest: Observation; previous: Observation; refetched: boolean }
  | { def: IndicatorDef; ok: false; failure: IndicatorFailure; refetched: boolean };

class ConfigError extends Error {}

/**
 * 配信に第三者の許諾が必要な株価指数(FRED 上の区分: S&P DJI / Nasdaq は "pre-approval required"、
 * 日経は再配布に許諾が必要)。ENABLE_LICENSED_INDICES=true のときだけ配信する。
 */
const LICENSED_INDICATORS: IndicatorDef[] = [
  { id: "nikkei225", label: "日経平均", unit: "", decimals: 2, change: "pct", source: "日本経済新聞社", load: (c) => c.fred("NIKKEI225") },
  { id: "djia", label: "NYダウ", unit: "", decimals: 2, change: "pct", source: "S&P Dow Jones Indices", load: (c) => c.fred("DJIA") },
  { id: "sp500", label: "S&P500", unit: "", decimals: 2, change: "pct", source: "S&P Dow Jones Indices", load: (c) => c.fred("SP500") },
  { id: "nasdaq", label: "NASDAQ総合", unit: "", decimals: 2, change: "pct", source: "Nasdaq", load: (c) => c.fred("NASDAQCOM") },
];

/** 許諾なしで配信できる指標(パブリックドメイン、または出典表記で利用可) */
const OPEN_INDICATORS: IndicatorDef[] = [
  { id: "us10y", label: "米10年債利回り", unit: "%", decimals: 2, change: "bp", source: "FRED", load: (c) => c.fred("DGS10") },
  { id: "us2y", label: "米2年債利回り", unit: "%", decimals: 2, change: "bp", source: "FRED", load: (c) => c.fred("DGS2") },
  { id: "us10y2y", label: "米10年-2年スプレッド", unit: "%", decimals: 2, change: "bp", source: "FRED", load: loadUsSpread },
  { id: "vix", label: "VIX(恐怖指数)", unit: "", decimals: 2, change: "abs", source: "Cboe via FRED", load: (c) => c.fred("VIXCLS") },
  { id: "usdjpy", label: "ドル円", unit: "", decimals: 2, change: "abs", source: "ECB", load: (c) => fetchEcbRate("USD", "JPY", c.deadline) },
  { id: "jgb10y", label: "日本10年国債利回り", unit: "%", decimals: 3, change: "bp", source: "財務省", load: (c) => fetchJgbYield("10年", c.deadline) },
];

export function enabledIndicators(includeLicensed: boolean): IndicatorDef[] {
  return includeLicensed ? [...LICENSED_INDICATORS, ...OPEN_INDICATORS] : OPEN_INDICATORS;
}

/** 10年債 − 2年債。両方の値が揃っている日だけを使う。 */
async function loadUsSpread(ctx: LoadContext): Promise<Observation[]> {
  const [long, short] = await Promise.all([ctx.fred("DGS10"), ctx.fred("DGS2")]);
  const shortByDate = new Map(short.map((o) => [o.date, o.value]));
  return long.flatMap((o) => {
    const s = shortByDate.get(o.date);
    return s === undefined ? [] : [{ date: o.date, value: o.value - s }];
  });
}

/**
 * 全指標を並列で取得する。失敗した指標は ok: false として返し、例外は投げない。
 * 1回目に一時的な理由(タイムアウト・接続エラー・429/5xx)で失敗した指標だけを、
 * REFETCH_DELAY_MS 待ってからまとめて取り直す。すべて deadline の範囲内で行う。
 */
export async function loadIndicators(
  defs: IndicatorDef[],
  fredApiKey: string | undefined,
  deadline: Deadline = new Deadline(DATA_PHASE_BUDGET_MS),
): Promise<IndicatorResult[]> {
  const fredCache = new Map<string, Promise<Observation[]>>();
  const ctx: LoadContext = {
    deadline,
    fred: (seriesId) => {
      if (!fredApiKey) return Promise.reject(new ConfigError("FRED_API_KEY is not set"));
      const cached = fredCache.get(seriesId);
      if (cached) return cached;
      const pending = fetchFredObservations(seriesId, fredApiKey, deadline);
      fredCache.set(seriesId, pending);
      pending.catch(() => {
        if (fredCache.get(seriesId) === pending) fredCache.delete(seriesId);
      });
      return pending;
    },
  };

  const results = await loadRound(defs, ctx, false);
  const retryIndexes = results.flatMap((r, i) => (!r.ok && isTransient(r.failure) ? [i] : []));
  if (retryIndexes.length === 0 || deadline.remaining() < REFETCH_DELAY_MS + MIN_REFETCH_WINDOW_MS) return results;

  await sleep(REFETCH_DELAY_MS);
  const retried = await loadRound(
    retryIndexes.map((i) => defs[i]),
    ctx,
    true,
  );
  retryIndexes.forEach((index, j) => {
    const first = results[index];
    const second = retried[j];
    results[index] =
      !second.ok && !first.ok ? { ...second, failure: { ...second.failure, firstRound: first.failure } } : second;
  });
  return results;
}

async function loadRound(defs: IndicatorDef[], ctx: LoadContext, refetched: boolean): Promise<IndicatorResult[]> {
  const settled = await Promise.allSettled(defs.map((def) => ctx.deadline.race(def.load(ctx), `indicator ${def.id}`)));
  return settled.map((s, i): IndicatorResult => {
    const def = defs[i];
    if (s.status === "rejected") return { def, ok: false, refetched, failure: toFailure(s.reason) };
    const [latest, previous] = s.value;
    if (!latest || !previous) {
      return { def, ok: false, refetched, failure: { kind: "invalid", error: `${def.id}: not enough observations` } };
    }
    return { def, ok: true, latest, previous, refetched };
  });
}

function toFailure(e: unknown): IndicatorFailure {
  if (e instanceof FetchError) return { error: errorMessage(e), ...e.failure };
  return { error: errorMessage(e), kind: e instanceof ConfigError ? "config" : "invalid" };
}

/** 時間をおけば成功する可能性がある失敗か */
function isTransient(failure: IndicatorFailure): boolean {
  if (failure.kind === "http") return failure.status === 429 || (failure.status ?? 0) >= 500;
  return failure.kind === "timeout" || failure.kind === "network" || failure.kind === "deadline";
}

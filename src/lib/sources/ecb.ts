import { fetchWithRetry, HttpError } from "@/lib/http";
import type { Observation } from "@/lib/types";

// ECB 参照レートを配信する Frankfurter API(APIキー不要)
const FRANKFURTER_ENDPOINT = "https://api.frankfurter.dev/v1";
const LOOKBACK_DAYS = 14;

type FrankfurterResponse = { rates?: Record<string, Record<string, number>> };

/** ECB 参照レートによる為替(新しい順)。FRED の DEXJPUS は週次更新で鮮度が足りないため、こちらを使う。 */
export async function fetchEcbRate(base: string, quote: string): Promise<Observation[]> {
  const start = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000).toISOString().slice(0, 10);
  const label = `ECB ${base}/${quote}`;
  const res = await fetchWithRetry(label, `${FRANKFURTER_ENDPOINT}/${start}..?base=${base}&symbols=${quote}`);
  if (!res.ok) throw new HttpError(label, res.status);

  const json = (await res.json()) as FrankfurterResponse;
  return Object.entries(json.rates ?? {})
    .map(([date, rates]) => ({ date, value: rates[quote] }))
    .filter((o) => Number.isFinite(o.value))
    .sort((a, b) => b.date.localeCompare(a.date));
}

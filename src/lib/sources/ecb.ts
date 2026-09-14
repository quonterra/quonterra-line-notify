import type { Deadline } from "@/lib/deadline";
import { request } from "@/lib/http";
import { RETRY_POLICY } from "@/lib/timing";
import type { Observation } from "@/lib/types";

// ECB 参照レートを配信する Frankfurter API(APIキー不要)
const FRANKFURTER_ENDPOINT = "https://api.frankfurter.dev/v1";
const LOOKBACK_DAYS = 14;

type FrankfurterResponse = { rates?: Record<string, Record<string, number>> };

/** ECB 参照レートによる為替(新しい順)。FRED の DEXJPUS は週次更新で鮮度が足りないため、こちらを使う。 */
export async function fetchEcbRate(base: string, quote: string, deadline?: Deadline): Promise<Observation[]> {
  const start = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000).toISOString().slice(0, 10);
  const json = await request({
    label: `ECB ${base}/${quote}`,
    url: `${FRANKFURTER_ENDPOINT}/${start}..?base=${base}&symbols=${quote}`,
    policy: RETRY_POLICY.ecb,
    deadline,
    read: (res) => res.json() as Promise<FrankfurterResponse>,
  });

  return Object.entries(json.rates ?? {})
    .map(([date, rates]) => ({ date, value: rates[quote] }))
    .filter((o) => Number.isFinite(o.value))
    .sort((a, b) => b.date.localeCompare(a.date));
}

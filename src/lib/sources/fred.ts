import type { Deadline } from "@/lib/deadline";
import { request } from "@/lib/http";
import { RETRY_POLICY } from "@/lib/timing";
import type { Observation } from "@/lib/types";

const FRED_ENDPOINT = "https://api.stlouisfed.org/fred/series/observations";
const LOOKBACK_DAYS = 30;

type FredResponse = { observations?: { date: string; value: string }[] };

/** FRED 系列の直近の有効な観測値(新しい順)。休場日は値が "." になるので除外する。 */
export async function fetchFredObservations(seriesId: string, apiKey: string, deadline?: Deadline): Promise<Observation[]> {
  const start = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000).toISOString().slice(0, 10);
  const params = new URLSearchParams({
    series_id: seriesId,
    api_key: apiKey,
    file_type: "json",
    sort_order: "desc",
    observation_start: start,
  });
  const json = await request({
    label: `FRED ${seriesId}`,
    url: `${FRED_ENDPOINT}?${params}`,
    policy: RETRY_POLICY.fred,
    deadline,
    read: (res) => res.json() as Promise<FredResponse>,
  });

  return (json.observations ?? [])
    .filter((o) => o.value.trim() !== "" && o.value !== ".")
    .map((o) => ({ date: o.date, value: Number(o.value) }))
    .filter((o) => Number.isFinite(o.value));
}

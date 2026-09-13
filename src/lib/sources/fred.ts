import { fetchWithRetry, HttpError } from "@/lib/http";
import type { Observation } from "@/lib/types";

const FRED_ENDPOINT = "https://api.stlouisfed.org/fred/series/observations";
const LOOKBACK_DAYS = 30;

type FredResponse = { observations?: { date: string; value: string }[] };

/** FRED 系列の直近の有効な観測値(新しい順)。休場日は値が "." になるので除外する。 */
export async function fetchFredObservations(seriesId: string, apiKey: string): Promise<Observation[]> {
  const start = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000).toISOString().slice(0, 10);
  const params = new URLSearchParams({
    series_id: seriesId,
    api_key: apiKey,
    file_type: "json",
    sort_order: "desc",
    observation_start: start,
  });
  const label = `FRED ${seriesId}`;
  const res = await fetchWithRetry(label, `${FRED_ENDPOINT}?${params}`);
  if (!res.ok) throw new HttpError(label, res.status);

  const json = (await res.json()) as FredResponse;
  return (json.observations ?? [])
    .filter((o) => o.value.trim() !== "" && o.value !== ".")
    .map((o) => ({ date: o.date, value: Number(o.value) }))
    .filter((o) => Number.isFinite(o.value));
}

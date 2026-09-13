import { fetchWithRetry, HttpError } from "@/lib/http";
import type { Observation } from "@/lib/types";

// 財務省「国債金利情報」(Shift_JIS の CSV)。当月分と、前月末までの全期間分に分かれている。
const MOF_CURRENT_MONTH = "https://www.mof.go.jp/jgbs/reference/interest_rate/jgbcm.csv";
const MOF_ALL = "https://www.mof.go.jp/jgbs/reference/interest_rate/data/jgbcm_all.csv";

/** 日本国債の指定年限(例: "10年")の利回り(新しい順)。月初で当月分が2件未満なら全期間 CSV で補う。 */
export async function fetchJgbYield(tenor: string): Promise<Observation[]> {
  const current = await fetchJgbCsv(MOF_CURRENT_MONTH, tenor);
  if (current.length >= 2) return current;

  const all = await fetchJgbCsv(MOF_ALL, tenor);
  const byDate = new Map([...all, ...current].map((o) => [o.date, o]));
  return [...byDate.values()].sort((a, b) => b.date.localeCompare(a.date));
}

async function fetchJgbCsv(url: string, tenor: string): Promise<Observation[]> {
  const label = "MOF JGB";
  const res = await fetchWithRetry(label, url, {}, { timeoutMs: 20_000 });
  if (!res.ok) throw new HttpError(label, res.status);
  const text = new TextDecoder("shift_jis").decode(await res.arrayBuffer());
  return parseJgbCsv(text, tenor);
}

export function parseJgbCsv(text: string, tenor: string): Observation[] {
  const lines = text.split(/\r?\n/);
  const header = lines.find((line) => line.startsWith("基準日"));
  const col = header ? header.split(",").indexOf(tenor) : -1;
  if (col < 1) throw new Error(`MOF JGB: column "${tenor}" not found`);

  const observations: Observation[] = [];
  for (const line of lines) {
    const cells = line.split(",");
    // 基準日は和暦(令和)表記: R8.9.10
    const m = /^R(\d+)\.(\d+)\.(\d+)$/.exec(cells[0] ?? "");
    const raw = cells[col]?.trim();
    if (!m || !raw) continue;
    const value = Number(raw);
    if (!Number.isFinite(value)) continue;
    const year = 2018 + Number(m[1]);
    observations.push({ date: `${year}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`, value });
  }
  return observations.sort((a, b) => b.date.localeCompare(a.date));
}

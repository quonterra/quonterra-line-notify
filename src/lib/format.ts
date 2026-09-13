import type { ChangeFormat } from "@/lib/indicators";

export type JstDay = {
  /** 2026-09-14 */
  isoDate: string;
  /** 9月14日(月) */
  label: string;
  /** 9/14(月) */
  short: string;
};

export function jstDay(now: Date): JstDay {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("ja-JP", {
      timeZone: "Asia/Tokyo",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      weekday: "short",
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  return {
    isoDate: `${parts.year}-${parts.month.padStart(2, "0")}-${parts.day.padStart(2, "0")}`,
    label: `${parts.month}月${parts.day}日(${parts.weekday})`,
    short: `${parts.month}/${parts.day}(${parts.weekday})`,
  };
}

/** "2026-09-10" → "9/10時点" */
export function asOfLabel(isoDate: string): string {
  const [, month, day] = isoDate.split("-").map(Number);
  return `${month}/${day}時点`;
}

function formatNumber(value: number, digits: number): string {
  return value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function formatValue(value: number, decimals: number, unit: string): string {
  return `${formatNumber(value, decimals)}${unit}`;
}

export type Change = { text: string; direction: "up" | "down" | "flat" };

export function formatChange(latest: number, previous: number, format: ChangeFormat, decimals: number): Change {
  let amount: number;
  let digits: number;
  let suffix: string;
  switch (format) {
    case "bp":
      amount = (latest - previous) * 100;
      digits = Math.max(0, decimals - 2);
      suffix = "bp";
      break;
    case "pct":
      amount = previous === 0 ? 0 : (latest / previous - 1) * 100;
      digits = 2;
      suffix = "%";
      break;
    case "abs":
      amount = latest - previous;
      digits = decimals;
      suffix = "";
      break;
  }

  // 表示桁で丸めた結果で符号を判定する(浮動小数の誤差で「▲+0bp」にならないように)
  const rounded = Number(amount.toFixed(digits));
  if (rounded === 0) return { text: `±0${suffix}`, direction: "flat" };
  return rounded > 0
    ? { text: `▲+${formatNumber(rounded, digits)}${suffix}`, direction: "up" }
    : { text: `▼−${formatNumber(-rounded, digits)}${suffix}`, direction: "down" };
}

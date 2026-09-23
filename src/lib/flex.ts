import { asOfLabel, formatChange, formatValue, jstDay } from "@/lib/format";
import type { IndicatorResult } from "@/lib/indicators";

export type LineMessage = Record<string, unknown>;
type FlexComponent = Record<string, unknown>;

const COLOR = {
  navy: "#0B1F3A",
  headerSub: "#D6E0EE",
  headerMuted: "#9FB3D1",
  text: "#111827",
  muted: "#6B7280",
  separator: "#E5E7EB",
  up: "#16A34A",
  down: "#DC2626",
  flat: "#6B7280",
} as const;

const TITLE = "本日のマーケットルーティン";

export function buildSummaryMessage(results: IndicatorResult[], now: Date, detailUrl: string): LineMessage {
  const day = jstDay(now);
  const available = results.filter((r) => r.ok);
  const missing = results.filter((r) => !r.ok);
  if (available.length === 0) return buildFallbackMessage(now, detailUrl);
  const rows = available.flatMap((r, i): FlexComponent[] =>
    i === 0 ? [indicatorRow(r)] : [{ type: "separator", margin: "md", color: COLOR.separator }, indicatorRow(r)],
  );
  const sources = [...new Set(available.map((r) => r.def.source))].join(", ");
  if (missing.length) rows.unshift({
    type: "text", text: `一部データを取得できませんでした：${missing.map((r) => r.def.label).join("、")}。確認できた値を表示しています。`,
    size: "xs", color: COLOR.muted, wrap: true, margin: "md",
  });

  return {
    type: "flex",
    altText: summaryAltText(day.short, results),
    contents: {
      type: "bubble",
      size: "mega",
      header: {
        type: "box",
        layout: "vertical",
        backgroundColor: COLOR.navy,
        paddingAll: "lg",
        contents: [
          { type: "text", text: "QUONTERRA ACADEMY", size: "xxs", color: COLOR.headerMuted },
          { type: "text", text: day.label, size: "sm", color: COLOR.headerSub, margin: "sm" },
          { type: "text", text: TITLE, size: "lg", weight: "bold", color: "#FFFFFF" },
          { type: "text", text: "取得できた公表値・観測日は項目ごとに異なります", size: "xxs", color: COLOR.headerSub, wrap: true, margin: "sm" },
        ],
      },
      body: { type: "box", layout: "vertical", contents: rows },
      footer: {
        type: "box",
        layout: "vertical",
        spacing: "sm",
        contents: [
          {
            type: "button",
            style: "primary",
            color: COLOR.navy,
            height: "sm",
            action: { type: "uri", label: "詳しく見る", uri: detailUrl },
          },
          { type: "text", text: `出典: ${sources}`, size: "xxs", color: COLOR.muted, align: "center", wrap: true },
          { type: "text", text: "※投資助言ではありません", size: "xxs", color: COLOR.muted, align: "center" },
        ],
      },
    },
  };
}

function indicatorRow(r: IndicatorResult): FlexComponent {
  if (!r.ok) {
    return {
      type: "box",
      layout: "horizontal",
      margin: "md",
      alignItems: "center",
      contents: [
        { type: "text", text: r.def.label, size: "sm", color: COLOR.text, wrap: true, flex: 5 },
        { type: "text", text: "取得できませんでした", size: "xs", color: COLOR.muted, align: "end", flex: 7 },
      ],
    };
  }

  const change = formatChange(r.latest.value, r.previous.value, r.def.change, r.def.decimals);
  return {
    type: "box",
    layout: "horizontal",
    margin: "md",
    alignItems: "center",
    contents: [
      {
        type: "box",
        layout: "vertical",
        flex: 5,
        contents: [
          { type: "text", text: r.def.label, size: "sm", color: COLOR.text, wrap: true },
          { type: "text", text: asOfLabel(r.latest.date), size: "xxs", color: COLOR.muted },
          { type: "text", text: `${asOfLabel(r.previous.date)}との比較`, size: "xxs", color: COLOR.muted, wrap: true },
        ],
      },
      {
        type: "text",
        text: formatValue(r.latest.value, r.def.decimals, r.def.unit),
        size: "md",
        weight: "bold",
        color: COLOR.text,
        align: "end",
        flex: 4,
      },
      { type: "text", text: change.text, size: "xs", color: COLOR[change.direction], align: "end", flex: 3 },
    ],
  };
}

/** 通知やトーク一覧に表示されるテキスト */
function summaryAltText(dayShort: string, results: IndicatorResult[]): string {
  const highlights = results
    .filter((r) => r.ok)
    .slice(0, 3)
    .map((r) => `${r.def.label} ${formatValue(r.latest.value, r.def.decimals, r.def.unit)}`)
    .join(" / ");
  return `${dayShort} ${TITLE}|${results.some((r) => !r.ok) ? "一部データ未取得 / " : ""}${highlights}`.slice(0, 400);
}

/** すべての指標の取得に失敗したときに送るテキスト */
export function buildFallbackMessage(now: Date, detailUrl: string): LineMessage {
  const day = jstDay(now);
  return {
    type: "text",
    text: [
      `【${day.label} ${TITLE}】`,
      "本日は指標データの取得に失敗したため、サマリーをお届けできませんでした。",
      "詳細ページでも各指標の日付をご確認ください。古い値が表示されている場合があります。",
      detailUrl,
    ].join("\n"),
  };
}

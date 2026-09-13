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
  const rows = results.flatMap((r, i): FlexComponent[] =>
    i === 0 ? [indicatorRow(r)] : [{ type: "separator", margin: "md", color: COLOR.separator }, indicatorRow(r)],
  );
  const sources = [...new Set(results.map((r) => r.def.source))].join(", ");

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
  return `${dayShort} ${TITLE}|${highlights}`.slice(0, 400);
}

/** すべての指標の取得に失敗したときに送るテキスト */
export function buildFallbackMessage(now: Date, detailUrl: string): LineMessage {
  const day = jstDay(now);
  return {
    type: "text",
    text: [
      `【${day.label} ${TITLE}】`,
      "本日は指標データの取得に失敗したため、サマリーをお届けできませんでした。",
      "最新の相場状況はこちらからご確認ください。",
      detailUrl,
    ].join("\n"),
  };
}

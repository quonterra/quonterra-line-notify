const DEFAULT_MARKET_ROUTINE_URL = "https://market-routine.vercel.app/";

export type Config = {
  fredApiKey: string | undefined;
  lineToken: string | undefined;
  detailUrl: string;
  includeLicensed: boolean;
};

/** 機密情報は環境変数からだけ読み込む。値そのものはログに出さないこと。 */
export function readConfig(): Config {
  return {
    fredApiKey: process.env.FRED_API_KEY || undefined,
    lineToken: process.env.LINE_CHANNEL_ACCESS_TOKEN_ACADEMY || undefined,
    detailUrl: resolveDetailUrl(process.env.MARKET_ROUTINE_URL),
    includeLicensed: process.env.ENABLE_LICENSED_INDICES === "true",
  };
}

// LINE の URI アクションは https が必須
function resolveDetailUrl(value: string | undefined): string {
  if (!value) return DEFAULT_MARKET_ROUTINE_URL;
  try {
    if (new URL(value).protocol === "https:") return value;
  } catch {}
  console.error("[config] MARKET_ROUTINE_URL is not a valid https URL; using default");
  return DEFAULT_MARKET_ROUTINE_URL;
}

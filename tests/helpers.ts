import { readFileSync } from "node:fs";
import { vi } from "vitest";

// テスト用のダミー値。レスポンスやログに出ていないことの検証にも使う。
export const CRON_SECRET = "test-cron-secret-0123456789abcdef";
export const FRED_API_KEY = "fred-key-SHOULD-NOT-LEAK";
export const LINE_TOKEN = "line-token-SHOULD-NOT-LEAK";

export function fixture(name: string): ArrayBuffer {
  return Uint8Array.from(readFileSync(new URL(`./fixtures/${name}`, import.meta.url))).buffer;
}

type Handler = (url: URL, init?: RequestInit) => Response | Promise<Response>;
type Upstream = "fred" | "ecb" | "mof" | "line";

const FRED_SERIES: Record<string, [date: string, value: string][]> = {
  DGS10: [["2026-09-10", "4.95"], ["2026-09-09", "4.83"], ["2026-09-07", "."]],
  DGS2: [["2026-09-10", "4.56"], ["2026-09-09", "4.43"]],
  VIXCLS: [["2026-09-10", "17.84"], ["2026-09-09", "16.46"]],
  NIKKEI225: [["2026-09-11", "64011.34"], ["2026-09-10", "65270.95"]],
  DJIA: [["2026-09-11", "52573.29"], ["2026-09-10", "52064.10"]],
  SP500: [["2026-09-11", "7656.98"], ["2026-09-10", "7591.70"]],
  NASDAQCOM: [["2026-09-11", "26333.04"], ["2026-09-10", "26081.72"]],
};

const defaultHandlers: Record<Upstream, Handler> = {
  fred: (url) => {
    const observations = FRED_SERIES[url.searchParams.get("series_id") ?? ""];
    return observations
      ? Response.json({ observations: observations.map(([date, value]) => ({ date, value })) })
      : new Response("Bad Request", { status: 400 });
  },
  ecb: () => Response.json({ rates: { "2026-09-10": { JPY: 154.18 }, "2026-09-11": { JPY: 154.04 } } }),
  mof: () => new Response(fixture("jgbcm-current.csv")),
  line: () => new Response("{}", { status: 200, headers: { "x-line-request-id": "req-sent" } }),
};

const HOSTS: Record<string, Upstream> = {
  "api.stlouisfed.org": "fred",
  "api.frankfurter.dev": "ecb",
  "www.mof.go.jp": "mof",
  "api.line.me": "line",
};

/** 外部 API をホスト名ごとにモックする。指定しなかったものは正常なレスポンスを返す。 */
export function mockUpstreams(overrides: Partial<Record<Upstream, Handler>> = {}) {
  const handlers = { ...defaultHandlers, ...overrides };
  const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = new URL(input);
    const upstream = HOSTS[url.hostname];
    if (!upstream) throw new Error(`unexpected fetch to ${url.hostname}`);
    return handlers[upstream](url, init);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

export function callsTo(fetchMock: ReturnType<typeof mockUpstreams>, pathPart: string) {
  return fetchMock.mock.calls.filter(([input]) => String(input).includes(pathPart));
}

export const networkError: Handler = () => {
  throw new TypeError("fetch failed");
};

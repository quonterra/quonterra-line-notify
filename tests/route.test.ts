import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { GET, maxDuration } from "@/app/api/cron/line-market-summary/route";
import { dailyRetryKey } from "@/lib/line";
import { DATA_PHASE_BUDGET_MS, LINE_PHASE_BUDGET_MS, RETRY_POLICY } from "@/lib/timing";
import {
  CRON_SECRET,
  FRED_API_KEY,
  LINE_TOKEN,
  callsTo,
  hang,
  mockUpstreams,
  networkError,
  refused,
  settle,
  upstreamHandlers,
  useFakeClock,
} from "./helpers";

type IndicatorSummary = { id: string; ok: boolean; refetched: boolean; [key: string]: unknown };

const cronRequest = (query = "", authorization: string | null = `Bearer ${CRON_SECRET}`) =>
  new Request(`http://localhost/api/cron/line-market-summary${query}`, {
    headers: authorization ? { authorization } : {},
  });

/** フェイクタイマーを進めながら GET を最後まで実行する */
const run = (query?: string, authorization?: string | null) => settle(GET(cronRequest(query, authorization)));

let errorLog: MockInstance;
let infoLog: MockInstance;

beforeEach(() => {
  // cron の実行時刻 = 2026-09-14(月) 07:00 JST。再試行などの待ち時間はフェイクタイマーで進める
  useFakeClock("2026-09-13T22:00:00Z");
  vi.stubEnv("CRON_SECRET", CRON_SECRET);
  vi.stubEnv("FRED_API_KEY", FRED_API_KEY);
  vi.stubEnv("LINE_CHANNEL_ACCESS_TOKEN_ACADEMY", LINE_TOKEN);
  vi.stubEnv("MARKET_ROUTINE_URL", undefined);
  vi.stubEnv("ENABLE_LICENSED_INDICES", undefined);
  errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
  infoLog = vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** console.error / console.info に JSON で出したログを取り出す */
function logged(spy: MockInstance, message: string) {
  return spy.mock.calls.filter((args) => args[1] === message).map((args) => JSON.parse(args[2] as string));
}

/** レスポンスとログのどこにも機密情報が出ていないこと */
async function expectNoSecrets(res: Response) {
  const output = (await res.clone().text()) + JSON.stringify([...errorLog.mock.calls, ...infoLog.mock.calls]);
  for (const secret of [CRON_SECRET, FRED_API_KEY, LINE_TOKEN]) expect(output).not.toContain(secret);
}

function sentMessages(fetchMock: ReturnType<typeof mockUpstreams>) {
  return callsTo(fetchMock, "/message/broadcast").map(([, init]) => JSON.parse(init?.body as string).messages[0]);
}

describe("authentication", () => {
  it.each([null, "Bearer undefined", "Bearer wrong"])("returns 401 for %s before fetching anything", async (auth) => {
    const fetchMock = mockUpstreams();
    expect((await run("", auth)).status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns 401 for Bearer undefined when CRON_SECRET is not configured", async () => {
    vi.stubEnv("CRON_SECRET", undefined);
    const fetchMock = mockUpstreams();
    expect((await run("", "Bearer undefined")).status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("dry run", () => {
  it("builds the summary card without calling LINE", async () => {
    const fetchMock = mockUpstreams();
    const res = await run("?dryRun=1");
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ mode: "dryRun", fallback: false });
    expect(body.indicators.map((i: IndicatorSummary) => [i.id, i.ok, i.refetched])).toEqual([
      ["us10y", true, false],
      ["us2y", true, false],
      ["us10y2y", true, false],
      ["vix", true, false],
      ["usdjpy", true, false],
      ["jgb10y", true, false],
    ]);

    const [message] = body.messages;
    expect(message.type).toBe("flex");
    expect(message.altText).toMatch(/^9\/14\(月\) 本日のマーケットルーティン\|米10年債利回り 4.95%/);
    const json = JSON.stringify(message);
    for (const text of ["9月14日(月)", "▲+12bp", "0.39%", "▼−1bp", "154.04", "▼−0.14", "2.920%", "9/10時点"]) {
      expect(json).toContain(text);
    }
    expect(json).toContain('"uri":"https://market-routine.vercel.app/"');
    expect(callsTo(fetchMock, "api.line.me")).toHaveLength(0);
  });

  it("includes the licensed stock indices only when ENABLE_LICENSED_INDICES=true", async () => {
    vi.stubEnv("ENABLE_LICENSED_INDICES", "true");
    mockUpstreams();
    const body = await (await run("?dryRun=1")).json();
    expect(body.indicators.map((i: IndicatorSummary) => i.id).slice(0, 4)).toEqual(["nikkei225", "djia", "sp500", "nasdaq"]);
    expect(body.indicators).toHaveLength(10);
    expect(JSON.stringify(body.messages[0])).toContain("S&P Dow Jones Indices");
  });

  it("falls back to the default link when MARKET_ROUTINE_URL is not https", async () => {
    vi.stubEnv("MARKET_ROUTINE_URL", "http://example.com/");
    mockUpstreams();
    const body = await (await run("?dryRun=1")).json();
    expect(JSON.stringify(body.messages[0])).toContain('"uri":"https://market-routine.vercel.app/"');
  });
});

describe("broadcast", () => {
  it("sends the card once with a retry key for the JST day", async () => {
    const fetchMock = mockUpstreams();
    const res = await run();

    expect(res.status).toBe(200);
    expect(await res.clone().json()).toMatchObject({ mode: "broadcast", status: "sent", requestId: "req-sent", fallback: false });
    expect(sentMessages(fetchMock)).toHaveLength(1);
    expect(sentMessages(fetchMock)[0].type).toBe("flex");
    const [[, init]] = callsTo(fetchMock, "/message/broadcast");
    expect((init?.headers as Record<string, string>)["X-Line-Retry-Key"]).toBe(dailyRetryKey("2026-09-14"));
    await expectNoSecrets(res);
  });

  it("returns already_sent when the same day was already broadcast", async () => {
    mockUpstreams({
      line: () => new Response("{}", { status: 409, headers: { "x-line-accepted-request-id": "req-first" } }),
    });
    const res = await run();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "already_sent", requestId: "req-first" });
  });
});

describe("refetching failed series (B)", () => {
  it("refetches only the series that failed and recovers them before sending", async () => {
    const calls: Record<string, number> = {};
    const fetchMock = mockUpstreams({
      fred: (url, init) => {
        const id = url.searchParams.get("series_id") ?? "";
        calls[id] = (calls[id] ?? 0) + 1;
        // 1回目の並行取得(3回の試行)の間だけ、DGS2 と VIXCLS が応答しない(今朝の障害の再現)
        return (id === "DGS2" || id === "VIXCLS") && calls[id] <= 3 ? hang(url, init) : upstreamHandlers.fred(url, init);
      },
    });

    const res = await run();
    const body = await res.clone().json();

    expect(res.status).toBe(200);
    expect(body.fallback).toBe(false);
    expect(body.indicators.map((i: IndicatorSummary) => [i.id, i.ok, i.refetched])).toEqual([
      ["us10y", true, false],
      ["us2y", true, true],
      ["us10y2y", true, true],
      ["vix", true, true],
      ["usdjpy", true, false],
      ["jgb10y", true, false],
    ]);
    // 成功した DGS10 は取り直さない。DGS2 と VIXCLS は 1回目の3回 + 取り直しの1回
    expect(calls).toEqual({ DGS10: 1, DGS2: 4, VIXCLS: 4 });
    expect(JSON.stringify(sentMessages(fetchMock)[0])).not.toContain("取得できませんでした");
    expect(logged(infoLog, "indicator refetch")).toEqual([{ recovered: ["us2y", "us10y2y", "vix"], stillFailed: [] }]);
    expect(logged(errorLog, "indicator fetch failed")).toEqual([]);
    expect(body.elapsedMs).toBeLessThanOrEqual(DATA_PHASE_BUDGET_MS);
  });

  it("confirms a row as failed only after the refetch also fails", async () => {
    const fetchMock = mockUpstreams({
      fred: (url, init) => (url.searchParams.get("series_id") === "DGS2" ? hang(url, init) : upstreamHandlers.fred(url, init)),
    });

    const res = await run();
    const body = await res.clone().json();

    expect(body.indicators.filter((i: IndicatorSummary) => !i.ok).map((i: IndicatorSummary) => i.id)).toEqual(["us2y", "us10y2y"]);
    expect(JSON.stringify(sentMessages(fetchMock)[0]).match(/取得できませんでした/g)).toHaveLength(1);
    expect(logged(infoLog, "indicator refetch")).toEqual([{ recovered: [], stillFailed: ["us2y", "us10y2y"] }]);

    const [entry] = logged(errorLog, "indicator fetch failed");
    expect(entry.dataPhaseMs).toBeLessThanOrEqual(DATA_PHASE_BUDGET_MS);
    expect(entry.failures[0]).toMatchObject({
      id: "us2y",
      refetched: true,
      kind: "timeout",
      attempts: 1,
      stoppedByDeadline: true,
      firstRound: { kind: "timeout", timeoutMs: 8_000, attempts: 3, elapsedMs: 27_000, stoppedByDeadline: false },
    });
    await expectNoSecrets(res);
  });

  it("does not refetch failures that waiting cannot fix", async () => {
    vi.stubEnv("FRED_API_KEY", undefined);
    const fetchMock = mockUpstreams();
    const body = await (await run("?dryRun=1")).json();

    expect(callsTo(fetchMock, "api.stlouisfed.org")).toHaveLength(0);
    expect(body.indicators.filter((i: IndicatorSummary) => !i.ok)).toHaveLength(4);
    expect(body.indicators[0]).toMatchObject({ error: "FRED_API_KEY is not set", kind: "config", refetched: false });
    expect(logged(infoLog, "indicator refetch")).toEqual([]);
    expect(body.fallback).toBe(false);
    const message = JSON.stringify(body.messages[0]);
    expect(message).toContain("一部データを取得できませんでした");
    expect(message).toContain("ドル円");
    expect(message).toContain("との比較");
    expect(message).not.toContain('出典: FRED');
  });
});

describe("failure logs (C)", () => {
  it("records attempts, elapsed time, and the last HTTP error for each round", async () => {
    const fetchMock = mockUpstreams({ fred: () => new Response("Internal Server Error", { status: 500 }) });
    const res = await run();
    const body = await res.clone().json();

    expect(res.status).toBe(200);
    expect(body.fallback).toBe(false);
    expect(JSON.stringify(sentMessages(fetchMock)[0]).match(/取得できませんでした/g)).toHaveLength(1);

    const [entry] = logged(errorLog, "indicator fetch failed");
    expect(entry.failures.map((f: IndicatorSummary) => f.id)).toEqual(["us10y", "us2y", "us10y2y", "vix"]);
    expect(entry.failures[0]).toMatchObject({
      kind: "http",
      status: 500,
      detail: "Internal Server Error",
      attempts: 3,
      elapsedMs: 3_000,
      firstRound: { kind: "http", status: 500, attempts: 3, elapsedMs: 3_000 },
    });
    await expectNoSecrets(res);
  });

  it("tells a refused connection apart from a slow server", async () => {
    mockUpstreams({ fred: refused });
    await run();

    const [entry] = logged(errorLog, "indicator fetch failed");
    const us10y = entry.failures.find((f: IndicatorSummary) => f.id === "us10y");
    expect(us10y).toMatchObject({ kind: "network", errorName: "TypeError", code: "ECONNREFUSED", attempts: 3, refetched: true });
    expect(us10y.firstRound).toMatchObject({ kind: "network", code: "ECONNREFUSED", attempts: 3 });
    // 接続エラーはタイムアウトまで待たないので、1回分のタイムアウトより短い
    expect(us10y.elapsedMs).toBeLessThan(RETRY_POLICY.fred.timeoutMs);
  });

  it("sends the text fallback when every source fails", async () => {
    const fetchMock = mockUpstreams({ fred: networkError, ecb: networkError, mof: networkError });
    const res = await run();

    expect(res.status).toBe(200);
    expect(await res.clone().json()).toMatchObject({ status: "sent", fallback: true });
    const [message] = sentMessages(fetchMock);
    expect(message.type).toBe("text");
    expect(message.text).toContain("【9月14日(月) 本日のマーケットルーティン】");
    expect(message.text).toContain("取得に失敗");
    expect(message.text).toContain("https://market-routine.vercel.app/");
    await expectNoSecrets(res);
  });
});

describe("time budget", () => {
  it("finishes within the phase budgets, well under maxDuration, even when every upstream and LINE hang", async () => {
    const fetchMock = mockUpstreams({ fred: hang, ecb: hang, mof: hang, line: hang });
    const res = await run();
    const body = await res.json();

    expect(res.status).toBe(502);
    expect(body.fallback).toBe(true);
    expect(callsTo(fetchMock, "/message/broadcast").length).toBeGreaterThan(0);
    // データ取得 35s + LINE 15s = 50s(maxDuration 60s)
    expect(body.elapsedMs).toBeLessThanOrEqual(DATA_PHASE_BUDGET_MS + LINE_PHASE_BUDGET_MS);
    expect(maxDuration * 1000 - body.elapsedMs).toBeGreaterThanOrEqual(9_000);

    const [dataLog] = logged(errorLog, "indicator fetch failed");
    expect(dataLog.dataPhaseMs).toBeLessThanOrEqual(DATA_PHASE_BUDGET_MS);
    expect(logged(errorLog, "broadcast failed")[0]).toMatchObject({ kind: "timeout", stoppedByDeadline: true });
  });

  it("returns 500 without calling LINE when the token is missing", async () => {
    vi.stubEnv("LINE_CHANNEL_ACCESS_TOKEN_ACADEMY", undefined);
    const fetchMock = mockUpstreams();
    const res = await run();
    expect(res.status).toBe(500);
    expect(callsTo(fetchMock, "api.line.me")).toHaveLength(0);
  });

  it("returns 502 when LINE rejects the broadcast, without leaking secrets", async () => {
    mockUpstreams({ line: () => new Response('{"message":"Authentication failed"}', { status: 401 }) });
    const res = await run();
    expect(res.status).toBe(502);
    expect(await res.clone().json()).toMatchObject({ error: "LINE broadcast failed" });
    expect(logged(errorLog, "broadcast failed")[0]).toMatchObject({ kind: "http", status: 401, attempts: 1 });
    await expectNoSecrets(res);
  });
});

describe("validate mode", () => {
  it("checks the message with LINE without broadcasting", async () => {
    const fetchMock = mockUpstreams();
    const res = await run("?validate=1");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ mode: "validate", valid: true });
    expect(callsTo(fetchMock, "/message/validate/broadcast")).toHaveLength(1);
    expect(callsTo(fetchMock, "/message/broadcast")).toHaveLength(0);
  });

  it("returns 422 with LINE's detail when the message is invalid", async () => {
    mockUpstreams({ line: () => new Response('{"message":"invalid flex"}', { status: 400 }) });
    const res = await run("?validate=1");
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ valid: false, detail: '{"message":"invalid flex"}' });
  });
});

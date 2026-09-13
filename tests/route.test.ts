import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { GET } from "@/app/api/cron/line-market-summary/route";
import { dailyRetryKey } from "@/lib/line";
import { CRON_SECRET, FRED_API_KEY, LINE_TOKEN, callsTo, mockUpstreams, networkError } from "./helpers";

const request = (query = "", authorization: string | null = `Bearer ${CRON_SECRET}`) =>
  new Request(`http://localhost/api/cron/line-market-summary${query}`, {
    headers: authorization ? { authorization } : {},
  });

let logs: MockInstance[] = [];

beforeEach(() => {
  // cron の実行時刻 = 2026-09-14(月) 07:00 JST。fetch のリトライ待ちは実時間のまま
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-13T22:00:00Z"));
  vi.stubEnv("CRON_SECRET", CRON_SECRET);
  vi.stubEnv("FRED_API_KEY", FRED_API_KEY);
  vi.stubEnv("LINE_CHANNEL_ACCESS_TOKEN_ACADEMY", LINE_TOKEN);
  vi.stubEnv("MARKET_ROUTINE_URL", undefined);
  vi.stubEnv("ENABLE_LICENSED_INDICES", undefined);
  logs = [vi.spyOn(console, "error").mockImplementation(() => {}), vi.spyOn(console, "info").mockImplementation(() => {})];
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** レスポンスとログのどこにも機密情報が出ていないこと */
async function expectNoSecrets(res: Response) {
  const output = (await res.clone().text()) + JSON.stringify(logs.flatMap((l) => l.mock.calls));
  for (const secret of [CRON_SECRET, FRED_API_KEY, LINE_TOKEN]) expect(output).not.toContain(secret);
}

function sentMessage(fetchMock: ReturnType<typeof mockUpstreams>) {
  const calls = callsTo(fetchMock, "/message/broadcast");
  expect(calls).toHaveLength(1);
  return JSON.parse(calls[0][1]?.body as string).messages[0];
}

describe("authentication", () => {
  it.each([null, "Bearer undefined", "Bearer wrong"])("returns 401 for %s before fetching anything", async (auth) => {
    const fetchMock = mockUpstreams();
    const res = await GET(request("", auth));
    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns 401 for Bearer undefined when CRON_SECRET is not configured", async () => {
    vi.stubEnv("CRON_SECRET", undefined);
    const fetchMock = mockUpstreams();
    expect((await GET(request("", "Bearer undefined"))).status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("dry run", () => {
  it("builds the summary card without calling LINE", async () => {
    const fetchMock = mockUpstreams();
    const res = await GET(request("?dryRun=1"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ mode: "dryRun", fallback: false });
    expect(body.indicators.map((i: { id: string; ok: boolean }) => [i.id, i.ok])).toEqual([
      ["us10y", true],
      ["us2y", true],
      ["us10y2y", true],
      ["vix", true],
      ["usdjpy", true],
      ["jgb10y", true],
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
    const body = await (await GET(request("?dryRun=1"))).json();
    expect(body.indicators.map((i: { id: string }) => i.id).slice(0, 4)).toEqual(["nikkei225", "djia", "sp500", "nasdaq"]);
    expect(body.indicators).toHaveLength(10);
    expect(JSON.stringify(body.messages[0])).toContain("S&P Dow Jones Indices");
  });

  it("falls back to the default link when MARKET_ROUTINE_URL is not https", async () => {
    vi.stubEnv("MARKET_ROUTINE_URL", "http://example.com/");
    mockUpstreams();
    const body = await (await GET(request("?dryRun=1"))).json();
    expect(JSON.stringify(body.messages[0])).toContain('"uri":"https://market-routine.vercel.app/"');
  });
});

describe("broadcast", () => {
  it("sends the card once with a retry key for the JST day", async () => {
    const fetchMock = mockUpstreams();
    const res = await GET(request());

    expect(res.status).toBe(200);
    expect(await res.clone().json()).toMatchObject({ mode: "broadcast", status: "sent", requestId: "req-sent", fallback: false });
    expect(sentMessage(fetchMock).type).toBe("flex");
    const [[, init]] = callsTo(fetchMock, "/message/broadcast");
    expect((init?.headers as Record<string, string>)["X-Line-Retry-Key"]).toBe(dailyRetryKey("2026-09-14"));
    await expectNoSecrets(res);
  });

  it("returns already_sent when the same day was already broadcast", async () => {
    mockUpstreams({
      line: () => new Response("{}", { status: 409, headers: { "x-line-accepted-request-id": "req-first" } }),
    });
    const res = await GET(request());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "already_sent", requestId: "req-first" });
  });
});

describe("data source failures", () => {
  it("marks failed rows and still broadcasts the card when some sources fail", async () => {
    const fetchMock = mockUpstreams({ fred: () => new Response("", { status: 500 }) });
    const res = await GET(request());
    const body = await res.clone().json();

    expect(res.status).toBe(200);
    expect(body.fallback).toBe(false);
    expect(body.indicators.filter((i: { ok: boolean }) => !i.ok).map((i: { id: string }) => i.id)).toEqual([
      "us10y",
      "us2y",
      "us10y2y",
      "vix",
    ]);
    const message = sentMessage(fetchMock);
    expect(message.type).toBe("flex");
    expect(JSON.stringify(message).match(/取得できませんでした/g)).toHaveLength(4);
    expect(logs[0]).toHaveBeenCalledWith("[line-market-summary]", "indicator fetch failed", expect.stringContaining("HTTP 500"));
    await expectNoSecrets(res);
  });

  it("sends the text fallback when every source fails", async () => {
    const fetchMock = mockUpstreams({ fred: networkError, ecb: networkError, mof: networkError });
    const res = await GET(request());

    expect(res.status).toBe(200);
    expect(await res.clone().json()).toMatchObject({ status: "sent", fallback: true });
    const message = sentMessage(fetchMock);
    expect(message.type).toBe("text");
    expect(message.text).toContain("【9月14日(月) 本日のマーケットルーティン】");
    expect(message.text).toContain("取得に失敗");
    expect(message.text).toContain("https://market-routine.vercel.app/");
    await expectNoSecrets(res);
  });

  it("reports a missing FRED_API_KEY per indicator without calling FRED", async () => {
    vi.stubEnv("FRED_API_KEY", undefined);
    const fetchMock = mockUpstreams();
    const body = await (await GET(request("?dryRun=1"))).json();

    expect(callsTo(fetchMock, "api.stlouisfed.org")).toHaveLength(0);
    expect(body.indicators.filter((i: { ok: boolean }) => !i.ok)).toHaveLength(4);
    expect(body.indicators[0].error).toBe("FRED_API_KEY is not set");
    expect(body.fallback).toBe(false);
  });
});

describe("LINE failures", () => {
  it("returns 500 without calling LINE when the token is missing", async () => {
    vi.stubEnv("LINE_CHANNEL_ACCESS_TOKEN_ACADEMY", undefined);
    const fetchMock = mockUpstreams();
    const res = await GET(request());
    expect(res.status).toBe(500);
    expect(callsTo(fetchMock, "api.line.me")).toHaveLength(0);
  });

  it("returns 502 when LINE rejects the broadcast, without leaking secrets", async () => {
    mockUpstreams({ line: () => new Response('{"message":"Authentication failed"}', { status: 401 }) });
    const res = await GET(request());
    expect(res.status).toBe(502);
    expect(await res.clone().json()).toMatchObject({ error: "LINE broadcast failed" });
    await expectNoSecrets(res);
  });
});

describe("validate mode", () => {
  it("checks the message with LINE without broadcasting", async () => {
    const fetchMock = mockUpstreams();
    const res = await GET(request("?validate=1"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ mode: "validate", valid: true });
    expect(callsTo(fetchMock, "/message/validate/broadcast")).toHaveLength(1);
    expect(callsTo(fetchMock, "/message/broadcast")).toHaveLength(0);
  });

  it("returns 422 with LINE's detail when the message is invalid", async () => {
    mockUpstreams({ line: () => new Response('{"message":"invalid flex"}', { status: 400 }) });
    const res = await GET(request("?validate=1"));
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ valid: false, detail: '{"message":"invalid flex"}' });
  });
});

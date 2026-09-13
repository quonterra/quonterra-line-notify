import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "@/lib/http";
import { broadcast, dailyRetryKey, validateBroadcast } from "@/lib/line";
import { LINE_TOKEN, callsTo, mockUpstreams } from "./helpers";

const messages = [{ type: "text", text: "hello" }];
const headersOf = (init: RequestInit | undefined) => init?.headers as Record<string, string>;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("dailyRetryKey", () => {
  it("is a deterministic UUID per JST day", () => {
    const key = dailyRetryKey("2026-09-14");
    expect(key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(dailyRetryKey("2026-09-14")).toBe(key);
    expect(dailyRetryKey("2026-09-15")).not.toBe(key);
  });
});

describe("broadcast", () => {
  it("posts the messages with the token and retry key", async () => {
    const fetchMock = mockUpstreams();
    await expect(broadcast(messages, LINE_TOKEN, "key-1")).resolves.toEqual({ status: "sent", requestId: "req-sent" });

    const [[, init]] = callsTo(fetchMock, "/message/broadcast");
    expect(headersOf(init).Authorization).toBe(`Bearer ${LINE_TOKEN}`);
    expect(headersOf(init)["X-Line-Retry-Key"]).toBe("key-1");
    expect(JSON.parse(init?.body as string)).toEqual({ messages });
  });

  it("treats a 409 with an accepted request id as already sent", async () => {
    mockUpstreams({
      line: () => new Response("{}", { status: 409, headers: { "x-line-accepted-request-id": "req-first" } }),
    });
    await expect(broadcast(messages, LINE_TOKEN, "key-1")).resolves.toEqual({
      status: "already_sent",
      requestId: "req-first",
    });
  });

  it("retries a 5xx with the same retry key", async () => {
    let attempts = 0;
    const fetchMock = mockUpstreams({
      line: () => (++attempts === 1 ? new Response("", { status: 500 }) : new Response("{}", { status: 200 })),
    });
    await expect(broadcast(messages, LINE_TOKEN, "key-1")).resolves.toMatchObject({ status: "sent" });
    expect(callsTo(fetchMock, "/message/broadcast").map(([, init]) => headersOf(init)["X-Line-Retry-Key"])).toEqual([
      "key-1",
      "key-1",
    ]);
  });

  it("throws on a 4xx without exposing the token", async () => {
    mockUpstreams({ line: () => new Response('{"message":"The request body has 1 error(s)"}', { status: 400 }) });
    const error = await broadcast(messages, LINE_TOKEN, "key-1").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(400);
    expect((error as HttpError).message).not.toContain(LINE_TOKEN);
  });
});

describe("validateBroadcast", () => {
  it("calls the validate endpoint and never broadcasts", async () => {
    const fetchMock = mockUpstreams();
    await expect(validateBroadcast(messages, LINE_TOKEN)).resolves.toEqual({ valid: true });
    expect(callsTo(fetchMock, "/message/validate/broadcast")).toHaveLength(1);
    expect(callsTo(fetchMock, "/message/broadcast")).toHaveLength(0);
  });

  it("returns LINE's error detail for an invalid message", async () => {
    mockUpstreams({ line: () => new Response('{"message":"invalid flex"}', { status: 400 }) });
    await expect(validateBroadcast(messages, LINE_TOKEN)).resolves.toEqual({
      valid: false,
      detail: '{"message":"invalid flex"}',
    });
  });
});

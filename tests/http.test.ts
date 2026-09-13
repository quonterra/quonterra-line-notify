import { afterEach, describe, expect, it, vi } from "vitest";
import { errorMessage, fetchWithRetry } from "@/lib/http";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("errorMessage", () => {
  it("masks API keys and bearer tokens", () => {
    const message = errorMessage(
      new Error("GET https://api.stlouisfed.org/x?series_id=DGS10&api_key=abc123 failed; Authorization: Bearer tok-xyz"),
    );
    expect(message).not.toMatch(/abc123|tok-xyz/);
    expect(message).toContain("api_key=***");
  });
});

describe("fetchWithRetry", () => {
  it("retries a 5xx and returns the recovered response", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("", { status: 503 }))
      .mockResolvedValueOnce(new Response("ok"));
    vi.stubGlobal("fetch", fetchMock);

    const res = await fetchWithRetry("test", "https://example.com");
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry a 4xx", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("", { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);

    expect((await fetchWithRetry("test", "https://example.com")).status).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reports network errors by label only, without the URL", async () => {
    const url = "https://api.stlouisfed.org/fred/series/observations?api_key=secret-key";
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError(`fetch failed: ${url}`)));

    await expect(fetchWithRetry("FRED DGS10", url, {}, { retries: 0 })).rejects.toThrow(
      /^FRED DGS10: network error \(TypeError\)$/,
    );
  });
});

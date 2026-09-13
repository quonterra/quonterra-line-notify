import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchJgbYield, parseJgbCsv } from "@/lib/sources/mof";
import { callsTo, fixture, mockUpstreams } from "./helpers";

const decode = (name: string) => new TextDecoder("shift_jis").decode(fixture(name));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("parseJgbCsv", () => {
  it("reads the 10-year column newest first, converting Reiwa dates", () => {
    expect(parseJgbCsv(decode("jgbcm-current.csv"), "10年").slice(0, 2)).toEqual([
      { date: "2026-09-10", value: 2.92 },
      { date: "2026-09-09", value: 2.891 },
    ]);
  });

  it("skips missing values, notes, and pre-Reiwa rows", () => {
    expect(parseJgbCsv(decode("jgbcm-all.csv"), "10年").map((o) => o.date)).toEqual(["2026-09-30", "2026-09-29"]);
  });

  it("throws when the column is missing", () => {
    expect(() => parseJgbCsv("基準日,1年\nR8.9.10,1.5", "10年")).toThrow(/column/);
  });
});

describe("fetchJgbYield", () => {
  it("uses only the current-month CSV when it has two or more rows", async () => {
    const fetchMock = mockUpstreams();
    await expect(fetchJgbYield("10年")).resolves.toHaveLength(3);
    expect(callsTo(fetchMock, "jgbcm_all.csv")).toHaveLength(0);
  });

  it("falls back to the all-period CSV at the start of a month", async () => {
    const fetchMock = mockUpstreams({
      mof: (url) => new Response(fixture(url.pathname.endsWith("jgbcm_all.csv") ? "jgbcm-all.csv" : "jgbcm-month-start.csv")),
    });
    expect((await fetchJgbYield("10年")).slice(0, 2)).toEqual([
      { date: "2026-10-01", value: 2.95 },
      { date: "2026-09-30", value: 2.94 },
    ]);
    expect(callsTo(fetchMock, "jgbcm_all.csv")).toHaveLength(1);
  });
});

import { describe, expect, it } from "vitest";
import { asOfLabel, formatChange, formatValue, jstDay } from "@/lib/format";

describe("jstDay", () => {
  it("converts the cron time (22:00 UTC) to the next JST day", () => {
    expect(jstDay(new Date("2026-09-13T22:00:00Z"))).toEqual({
      isoDate: "2026-09-14",
      label: "9月14日(月)",
      short: "9/14(月)",
    });
  });

  it("stays on the same JST day across the Hobby plan's one-hour window", () => {
    expect(jstDay(new Date("2026-09-13T22:59:59Z")).isoDate).toBe("2026-09-14");
  });
});

describe("formatChange", () => {
  it.each([
    [4.95, 4.83, "bp", 2, "▲+12bp", "up"],
    [4.95 - 4.56, 4.83 - 4.43, "bp", 2, "▼−1bp", "down"],
    [2.92, 2.891, "bp", 3, "▲+2.9bp", "up"],
    [4.95, 4.95, "bp", 2, "±0bp", "flat"],
    [4.950001, 4.95, "bp", 2, "±0bp", "flat"],
    [154.04, 154.18, "abs", 2, "▼−0.14", "down"],
    [52573.29, 52064.1, "pct", 2, "▲+0.98%", "up"],
  ] as const)("%s vs %s (%s) → %s", (latest, previous, format, decimals, text, direction) => {
    expect(formatChange(latest, previous, format, decimals)).toEqual({ text, direction });
  });
});

describe("formatValue / asOfLabel", () => {
  it("formats thousands separators and negative values", () => {
    expect(formatValue(64011.34, 2, "")).toBe("64,011.34");
    expect(formatValue(-0.12, 2, "%")).toBe("-0.12%");
    expect(formatValue(2.92, 3, "%")).toBe("2.920%");
  });

  it("labels the observation date", () => {
    expect(asOfLabel("2026-09-05")).toBe("9/5時点");
  });
});

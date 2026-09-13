import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isAuthorizedCron } from "@/lib/auth";
import { CRON_SECRET } from "./helpers";

const request = (authorization?: string) =>
  new Request("http://localhost/api/cron/line-market-summary", {
    headers: authorization === undefined ? {} : { authorization },
  });

describe("isAuthorizedCron", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("accepts the exact bearer token", () => {
    vi.stubEnv("CRON_SECRET", CRON_SECRET);
    expect(isAuthorizedCron(request(`Bearer ${CRON_SECRET}`))).toBe(true);
  });

  it.each([
    ["a missing header", undefined],
    ["a wrong token", "Bearer wrong-secret-0123456789abcdef"],
    ["Bearer undefined", "Bearer undefined"],
    ["the secret without the scheme", CRON_SECRET],
    ["a lowercase scheme", `bearer ${CRON_SECRET}`],
    ["a prefix of the token", `Bearer ${CRON_SECRET.slice(0, -1)}`],
  ])("rejects %s", (_, authorization) => {
    vi.stubEnv("CRON_SECRET", CRON_SECRET);
    expect(isAuthorizedCron(request(authorization))).toBe(false);
  });

  it.each([
    ["unset", undefined, "Bearer undefined"],
    ["empty", "", "Bearer "],
    ["the string 'undefined'", "undefined", "Bearer undefined"],
    ["shorter than 16 characters", "short-secret", "Bearer short-secret"],
  ])("rejects every request when CRON_SECRET is %s", (_, secret, authorization) => {
    vi.stubEnv("CRON_SECRET", secret);
    expect(isAuthorizedCron(request(authorization))).toBe(false);
  });
});

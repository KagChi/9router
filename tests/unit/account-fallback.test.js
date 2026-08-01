import { describe, expect, it } from "vitest";
import { checkFallbackError } from "../../open-sse/services/accountFallback.js";

describe("account fallback classification", () => {
  it("does not switch accounts for unmatched deterministic client errors", () => {
    expect(checkFallbackError(400, "Argument not supported"))
      .toEqual({ shouldFallback: false, cooldownMs: 0 });
    expect(checkFallbackError(422, "Failed to deserialize"))
      .toEqual({ shouldFallback: false, cooldownMs: 0 });
  });

  it("keeps capacity and rate-limit text above client status", () => {
    expect(checkFallbackError(400, "Selected model is at capacity").shouldFallback).toBe(true);
    expect(checkFallbackError(422, "Rate limit reached").shouldFallback).toBe(true);
  });

  it("retains account fallback for auth and transient failures", () => {
    expect(checkFallbackError(401, "Unauthorized").shouldFallback).toBe(true);
    expect(checkFallbackError(503, "Unavailable").shouldFallback).toBe(true);
  });
});

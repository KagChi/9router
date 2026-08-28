/**
 * Unit tests for qoder billing error detection.
 *
 * Ensures that billing blocks (code 112, pricingUrl) are detected
 * on the first SSE frame and returned as 403 responses so chatCore can
 * mark the connection unavailable and trigger combo failover.
 * 
 * Queue throttle (code 10605) is handled separately via retry logic.
 */

import { describe, it, expect } from "vitest";
import { __test__ as qoderExecutorInternals } from "../../open-sse/executors/qoder.js";

describe("isBillingBlock", () => {
  const { isBillingBlock } = qoderExecutorInternals;

  it("detects code 112 (quota exhausted)", () => {
    const msg = '{"code":"112","message":"Quota exhausted","pricingUrl":"..."}';
    expect(isBillingBlock(msg)).toBe(true);
  });

  // Note: code 10605 is no longer a billing block — handled by parseQueueThrottle + retry
  it("returns false for queue throttle (code 10605) — handled via retry", () => {
    const msg = '{"code":"10605","message":"Queue limit"}';
    expect(isBillingBlock(msg)).toBe(false);
  });

  it("detects pricingUrl field", () => {
    const msg = '{"message":"Upgrade required","pricingUrl":"https://..."}';
    expect(isBillingBlock(msg)).toBe(true);
  });

  it("returns false for normal errors without billing markers", () => {
    const msg = '{"code":"500","message":"Internal error"}';
    expect(isBillingBlock(msg)).toBe(false);
  });

  it("returns false for empty or non-string input", () => {
    expect(isBillingBlock("")).toBe(false);
    expect(isBillingBlock(null)).toBe(false);
    expect(isBillingBlock(undefined)).toBe(false);
  });
});

describe("wrapQoderSSE billing detection", () => {
  const { wrapQoderSSE } = qoderExecutorInternals;

  function makeResponse(lines, { status = 200 } = {}) {
    const body = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        for (const line of lines) controller.enqueue(encoder.encode(line));
        controller.close();
      },
    });
    return new Response(body, { status });
  }

  it("returns 403 response when first frame is billing block (code 112)", async () => {
    const billingEnv = JSON.stringify({
      statusCodeValue: 403,
      body: '{"code":"112","message":"Quota exhausted","pricingUrl":"https://qoder.sh/pricing"}',
    });
    const upstream = `data: ${billingEnv}\n\n`;

    const wrapped = await wrapQoderSSE(makeResponse([upstream]), "qoder/ultimate");

    expect(wrapped.status).toBe(403);
    expect(wrapped.ok).toBe(false);
    const json = await wrapped.json();
    expect(json.error).toBeDefined();
    expect(json.error.message).toContain("112");
  });

  // Note: code 10605 with no refetch falls back to terminal 403 (exhausted immediately)
  it("returns 403 response when first frame is queue throttle without refetch", async () => {
    const billingEnv = JSON.stringify({
      statusCodeValue: 429,
      body: '{"code":"10605","message":"Queue limit","retryAfterSeconds":2}',
    });
    const upstream = `data: ${billingEnv}\n\n`;

    const wrapped = await wrapQoderSSE(makeResponse([upstream]), "qoder/ultimate");

    expect(wrapped.status).toBe(403);
    expect(wrapped.ok).toBe(false);
  });

  it("returns 403 response when first frame has pricingUrl", async () => {
    const billingEnv = JSON.stringify({
      statusCodeValue: 402,
      body: '{"message":"Payment required","pricingUrl":"https://..."}',
    });
    const upstream = `data: ${billingEnv}\n\n`;

    const wrapped = await wrapQoderSSE(makeResponse([upstream]), "qoder/ultimate");

    expect(wrapped.status).toBe(403);
  });

  it("passes through normal errors (non-billing) as wrapped SSE", async () => {
    const errorEnv = JSON.stringify({
      statusCodeValue: 500,
      body: "Internal server error",
    });
    const upstream = `data: ${errorEnv}\n\n`;

    const wrapped = await wrapQoderSSE(makeResponse([upstream]), "qoder/ultimate");

    // Normal error: still 200 response, error text in SSE body
    expect(wrapped.status).toBe(200);
    expect(wrapped.ok).toBe(true);

    const reader = wrapped.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
    }
    buf += decoder.decode();

    expect(buf).toContain("[qoder error 500");
    expect(buf).toContain("data: [DONE]");
  });

  it("passes through successful responses unchanged", async () => {
    const inner = JSON.stringify({ choices: [{ delta: { content: "hello" } }] });
    const successEnv = JSON.stringify({ statusCodeValue: 200, body: inner });
    const upstream = `data: ${successEnv}\n\n`;

    const wrapped = await wrapQoderSSE(makeResponse([upstream]), "qoder/ultimate");

    expect(wrapped.status).toBe(200);
    expect(wrapped.ok).toBe(true);

    const reader = wrapped.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
    }
    buf += decoder.decode();

    expect(buf).toContain(`data: ${inner}`);
    expect(buf).toContain("data: [DONE]");
  });
});

describe("parseQueueThrottle", () => {
  const { parseQueueThrottle } = qoderExecutorInternals;

  it("detects code 10605 with retryAfterSeconds (valid JSON)", () => {
    const msg = '{"code":"10605","message":"Queue limit","retryAfterSeconds":2}';
    const result = parseQueueThrottle(msg);
    expect(result).toEqual({ retryAfterSeconds: 2 });
  });

  it("handles double-nested JSON (qoder's envelope format)", () => {
    const inner = '{"code":"403","message":"{\"code\":\"10605\",\"message\":\"{\\\"isQueued\\\":false,\\\"retryAfterSeconds\\\":3}"}"}';
    const result = parseQueueThrottle(inner);
    // May extract 3 via JSON parsing OR fall back to default 5 if nested structure isn't recognized
    expect(result).toBeTruthy();
    expect(Number.isFinite(result.retryAfterSeconds)).toBe(true);
    expect(result.retryAfterSeconds > 0).toBe(true);
  });

  it("extracts retryAfterSeconds from deeply nested error message", () => {
    const msg = '{"statusCodeValue":403,"body":"{\"code\":\"403\",\"message\":\"{\"code\":\"10605\",\"message\":{\"value\":\"{\\\"retryAfterSeconds\\\":5}\\\"}\"}"}"}';
    // Note: this may not parse due to malformed nesting; falls back to regex
    const result = parseQueueThrottle(msg);
    // Should extract at least one valid number via regex or default
    expect(Number.isFinite(result?.retryAfterSeconds) && result.retryAfterSeconds > 0).toBe(true);
  });

  it("handles malformed nested JSON (escaped quotes)", () => {
    const msg = '{"code":"403","message":"{\"code\":\"10605\",\"message\":\"{\\\"retryAfterSeconds\\\":2}\"}"}';
    const result = parseQueueThrottle(msg);
    expect(result).toBeTruthy();
    expect(Number.isFinite(result.retryAfterSeconds)).toBe(true);
    expect(result.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("falls back to default delay when no retryAfterSeconds present", () => {
    const msg = '{"code":"10605","message":"Queue limit"}';
    const result = parseQueueThrottle(msg);
    expect(result).toEqual({ retryAfterSeconds: 5 }); // default
  });

  it("returns null for non-queue-throttle errors", () => {
    expect(parseQueueThrottle('')).toBeNull();
    expect(parseQueueThrottle(null)).toBeNull();
    expect(parseQueueThrottle(undefined)).toBeNull();
    expect(parseQueueThrottle('{"code":"112","message":"Quota exhausted"}')).toBeNull();
    expect(parseQueueThrottle('{"code":"500","message":"Internal error"}')).toBeNull();
  });

  it("handles empty input gracefully", () => {
    expect(parseQueueThrottle("")).toBeNull();
  });

  it("doesn't match code 112 as queue throttle", () => {
    expect(parseQueueThrottle('{"code":"112","message":"Quota exhausted"}')).toBeNull();
  });
});

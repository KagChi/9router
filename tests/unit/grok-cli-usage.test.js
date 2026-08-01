import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: vi.fn(),
}));

import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";
import { getUsageForProvider } from "../../open-sse/services/usage.js";
import { parseGrokCliBilling } from "../../open-sse/services/usage/grok-cli.js";
import { USAGE_SUPPORTED_PROVIDERS } from "../../src/shared/constants/providers.js";
import { PROVIDERS } from "../../open-sse/providers/index.js";
import { parseQuotaData } from "../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const EXHAUSTED_BILLING = {
  config: {
    currentPeriod: {
      type: "USAGE_PERIOD_TYPE_WEEKLY",
      start: "2026-07-08T00:00:00+00:00",
      end: "2026-07-15T00:00:00+00:00",
    },
    onDemandCap: { val: 0 },
    onDemandUsed: { val: 0 },
    isUnifiedBillingUser: true,
    prepaidBalance: { val: 0 },
    topUpMethod: "TOP_UP_METHOD_SAVED_PAYMENT_METHOD",
    billingPeriodStart: "2026-07-08T00:00:00+00:00",
    billingPeriodEnd: "2026-07-15T00:00:00+00:00",
  },
};

const ACTIVE_BILLING = {
  config: {
    currentPeriod: {
      type: "USAGE_PERIOD_TYPE_WEEKLY",
      start: "2026-07-08T00:00:00+00:00",
      end: "2026-07-15T00:00:00+00:00",
    },
    onDemandCap: { val: 100 },
    onDemandUsed: { val: 35 },
    isUnifiedBillingUser: true,
    prepaidBalance: { val: 12.5 },
    billingPeriodStart: "2026-07-08T00:00:00+00:00",
    billingPeriodEnd: "2026-07-15T00:00:00+00:00",
  },
};

const USER_PROFILE = {
  userId: "d84768dd-224d-4052-ba49-0d336fa9160c",
  email: "user@example.com",
  hasGrokCodeAccess: true,
  subscriptionTier: null,
};

describe("grok-cli registry usage flag", () => {
  it("exposes transport.usage urls", () => {
    const cfg = PROVIDERS["grok-cli"];
    expect(cfg.usage?.url).toContain("/v1/billing");
    expect(cfg.usage?.userUrl).toContain("/v1/user");
  });

  it("is listed in USAGE_SUPPORTED_PROVIDERS", () => {
    expect(USAGE_SUPPORTED_PROVIDERS).toContain("grok-cli");
  });
});

describe("parseGrokCliBilling", () => {
  it("maps on-demand cap/used + prepaid balance", () => {
    const parsed = parseGrokCliBilling(ACTIVE_BILLING, USER_PROFILE);
    expect(parsed.plan).toBe("Grok Code");
    expect(parsed.quotas["On-demand"]).toMatchObject({
      used: 35,
      total: 100,
      remainingPercentage: 65,
    });
    // Prepaid is remaining-balance style: 0 used of current pot
    expect(parsed.quotas.Prepaid).toMatchObject({
      used: 0,
      total: 12.5,
      remainingPercentage: 100,
    });
    expect(parsed.exhausted).toBe(false);
  });

  it("marks depleted free/promo account as exhausted", () => {
    const parsed = parseGrokCliBilling(EXHAUSTED_BILLING, USER_PROFILE);
    expect(parsed.quotas["On-demand"].remainingPercentage).toBe(0);
    expect(parsed.exhausted).toBe(true);
  });

  it("uses subscriptionTier for plan when present", () => {
    const parsed = parseGrokCliBilling(ACTIVE_BILLING, {
      ...USER_PROFILE,
      subscriptionTier: "super_grok",
    });
    expect(parsed.plan).toBe("Super Grok");
  });

  it("does not report paid subscription access as depleted on-demand credit", () => {
    const parsed = parseGrokCliBilling(EXHAUSTED_BILLING, {
      ...USER_PROFILE,
      subscriptionTier: "XPremiumPlus",
    });
    expect(parsed.plan).toBe("XPremiumPlus");
    expect(parsed.subscriptionAccess).toBe(true);
    expect(parsed.quotas).toEqual({});
    expect(parsed.exhausted).toBe(false);
  });

  it("maps current monthly fields and snake-case subscription tier", () => {
    const parsed = parseGrokCliBilling({
      monthlyLimit: { val: 1000 },
      includedUsed: { val: 275 },
      totalUsed: { val: 300 },
      resetAt: "2026-08-01T00:00:00Z",
    }, {
      subscription_tier: "premium_plus",
    });
    expect(parsed.plan).toBe("Premium Plus");
    expect(parsed.quotas["Monthly included"]).toMatchObject({
      used: 275,
      total: 1000,
      remainingPercentage: 72.5,
      resetAt: "2026-08-01T00:00:00.000Z",
    });
  });

  it("prefers current credit usage percentage and shows percentage-only quota", () => {
    const withLimit = parseGrokCliBilling({
      creditUsagePercent: 27.5,
      monthlyLimit: { val: 1000 },
      used: { val: 900 },
    });
    expect(withLimit.quotas["Monthly included"]).toMatchObject({
      used: 275,
      total: 1000,
      remainingPercentage: 72.5,
    });

    const percentageOnly = parseGrokCliBilling({ creditUsagePercent: 42.5 });
    expect(percentageOnly.quotas["Monthly included"]).toMatchObject({
      used: 42.5,
      total: 100,
    });
    expect(percentageOnly.quotas["Monthly included"].remainingPercentage).toBeCloseTo(57.5);
  });

function accessTokenWithTier(tier) {
  const payload = Buffer.from(JSON.stringify({ tier })).toString("base64url");
  return `header.${payload}.signature`;
}

const EMPTY_GRPC_WEB_FRAME = Buffer.from([0, 0, 0, 0, 0]);
const GRPC_CREDITS_URL =
  "https://grok.com/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig";

describe("getUsageForProvider(grok-cli)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns normalized quotas from billing + user endpoints", async () => {
    proxyAwareFetch
      .mockResolvedValueOnce(jsonResponse(ACTIVE_BILLING))
      .mockResolvedValueOnce(jsonResponse(USER_PROFILE));

    const usage = await getUsageForProvider({
      provider: "grok-cli",
      accessToken: "test-token",
      providerSpecificData: {
        email: "user@example.com",
        userId: "d84768dd-224d-4052-ba49-0d336fa9160c",
      },
    });

    expect(usage.message).toBeUndefined();
    expect(usage.plan).toBe("Grok Code");
    expect(usage.quotas["On-demand"]).toMatchObject({
      used: 35,
      total: 100,
      remainingPercentage: 65,
    });
    expect(usage.quotas.Prepaid).toMatchObject({
      used: 0,
      total: 12.5,
      remainingPercentage: 100,
    });

    // Official CLI fingerprint headers
    const billingCall = proxyAwareFetch.mock.calls[0];
    expect(billingCall[0]).toContain("/v1/billing");
    expect(billingCall[1].headers.Authorization).toBe("Bearer test-token");
    expect(billingCall[1].headers["x-xai-token-auth"]).toBe("xai-grok-cli");
    expect(billingCall[1].headers["x-grok-client-version"]).toBe("0.2.99");
    expect(billingCall[1].headers["x-grok-client-identifier"]).toBe("grok-shell");
    expect(billingCall[1].headers["x-userid"]).toBe(
      "d84768dd-224d-4052-ba49-0d336fa9160c",
    );
  });

  it("surfaces auth-expired message on 401", async () => {
    proxyAwareFetch
      .mockResolvedValueOnce(jsonResponse({ error: "unauthorized" }, 401))
      .mockResolvedValueOnce(jsonResponse(USER_PROFILE));

    const usage = await getUsageForProvider({
      provider: "grok-cli",
      accessToken: "expired",
    });

    expect(usage.message).toMatch(/expired|re-authorize/i);
  });

  it("returns depleted on-demand bar without blocking message when cap is zero", async () => {
    proxyAwareFetch
      .mockResolvedValueOnce(jsonResponse(EXHAUSTED_BILLING))
      .mockResolvedValueOnce(jsonResponse(USER_PROFILE));

    const usage = await getUsageForProvider({
      provider: "grok-cli",
      accessToken: "test-token",
    });

    // Dashboard hides QuotaTable when `message` is set — keep message empty
    // so the 0% bar still renders for exhausted free/promo accounts.
    expect(usage.message).toBeUndefined();
    expect(usage.quotas["On-demand"].remainingPercentage).toBe(0);
    expect(usage.quotas["On-demand"].total).toBe(1);
  });

  it("falls back to GetGrokCreditsConfig gRPC when paid sub has no REST numeric quota", async () => {
    const accessToken = accessTokenWithTier(5);
    const resetSeconds = 1784825940;
    const resetNanos = 867850000;
    const resetAt = new Date(
      resetSeconds * 1000 + Math.round(resetNanos / 1_000_000),
    ).toISOString();

    proxyAwareFetch
      .mockResolvedValueOnce(jsonResponse(EXHAUSTED_BILLING))
      .mockResolvedValueOnce(
        jsonResponse({
          ...USER_PROFILE,
          subscriptionTier: "XPremiumPlus",
        }),
      )
      .mockResolvedValueOnce(binaryResponse(buildCreditsResponseBuffer(0.35, resetSeconds, resetNanos)));

    const usage = await getUsageForProvider({
      provider: "grok-cli",
      accessToken,
    });

    expect(usage.message).toBeUndefined();
    expect(usage.plan).toBe("SuperGrok Heavy");
    expect(usage.quotas["Weekly SuperGrok"]).toMatchObject({
      used: 35,
      total: 100,
      remainingPercentage: 65,
      resetAt,
      unlimited: false,
    });

    const grpcCall = proxyAwareFetch.mock.calls[2];
    expect(grpcCall[0]).toBe(GRPC_CREDITS_URL);
    expect(grpcCall[1].method).toBe("POST");
    expect(grpcCall[1].headers.Authorization).toBe(`Bearer ${accessToken}`);
    expect(grpcCall[1].headers["Content-Type"]).toBe("application/grpc-web+proto");
    expect(grpcCall[1].headers["X-Grpc-Web"]).toBe("1");
    // Empty gRPC-web request frame is required (flag 0 + length 0)
    expect(Buffer.from(grpcCall[1].body)).toEqual(EMPTY_GRPC_WEB_FRAME);
  });

  it("keeps subscription message when REST empty and gRPC fails open", async () => {
    proxyAwareFetch
      .mockResolvedValueOnce(jsonResponse(EXHAUSTED_BILLING))
      .mockResolvedValueOnce(
        jsonResponse({
          ...USER_PROFILE,
          subscriptionTier: "XPremiumPlus",
        }),
      )
      .mockResolvedValueOnce(binaryResponse(Buffer.alloc(0), 500));

    const usage = await getUsageForProvider({
      provider: "grok-cli",
      accessToken: "test-token",
    });

    expect(usage.plan).toBe("XPremiumPlus");
    expect(usage.message).toMatch(/active.*numeric included quota/i);
    expect(usage.quotas).toEqual({});
  });
});

describe("parseQuotaData(grok-cli)", () => {
  it("forwards remainingPercentage for dashboard bars", () => {
    const rows = parseQuotaData("grok-cli", {
      plan: "Grok Code",
      quotas: {
        "On-demand": {
          used: 35,
          total: 100,
          remaining: 65,
          remainingPercentage: 65,
          resetAt: "2026-07-15T00:00:00.000Z",
        },
      },
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      name: "On-demand",
      used: 35,
      total: 100,
      remainingPercentage: 65,
    });
  });
});

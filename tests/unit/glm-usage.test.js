import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: vi.fn(),
}));

import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";
import { getUsageForProvider } from "../../open-sse/services/usage.js";
import { getGlmUsage } from "../../open-sse/services/usage/glm.js";
import {
  USAGE_SUPPORTED_PROVIDERS,
  USAGE_APIKEY_PROVIDERS,
} from "../../src/shared/constants/providers.js";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const SAMPLE_GLM_CREDIT_USAGE = {
  code: 200,
  msg: "Operation successful",
  data: {
    limits: [
      {
        type: "CREDIT_LIMIT",
        unit: 3,
        number: 5,
        usage: 2000,
        currentValue: 0,
        remaining: 1999,
        percentage: 25,
        nextResetTime: 1787905548392,
      },
      {
        type: "CREDIT_LIMIT",
        unit: 6,
        number: 1,
        usage: 10000,
        currentValue: 0,
        remaining: 9999,
        percentage: 10,
        nextResetTime: 1788492142997,
      },
    ],
    level: "lite",
  },
  success: true,
};

const SAMPLE_GLM_TOKENS_USAGE = {
  code: 200,
  msg: "Operation successful",
  data: {
    limits: [
      {
        type: "TOKENS_LIMIT",
        percentage: 40,
        nextResetTime: 1787905548392,
      },
    ],
    level: "standard",
  },
  success: true,
};

describe("glm registry usage flags", () => {
  it("is listed for apikey quota dashboard", () => {
    expect(USAGE_SUPPORTED_PROVIDERS).toContain("glm");
    expect(USAGE_SUPPORTED_PROVIDERS).toContain("glm-cn");
    expect(USAGE_APIKEY_PROVIDERS).toContain("glm");
    expect(USAGE_APIKEY_PROVIDERS).toContain("glm-cn");
  });
});

describe("getGlmUsage and getUsageForProvider(glm)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });


  it("handles CREDIT_LIMIT with session 5h and weekly 7d quotas", async () => {
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse(SAMPLE_GLM_CREDIT_USAGE));

    const usage = await getUsageForProvider({
      provider: "glm",
      apiKey: "glm-key-123",
    });

    expect(usage.message).toBeUndefined();
    expect(usage.plan).toBe("Lite");
    expect(usage.quotas["Session (5h)"]).toEqual({
      used: 25,
      total: 100,
      remaining: 75,
      remainingPercentage: 75,
      resetAt: new Date(1787905548392).toISOString(),
      unlimited: false,
    });
    expect(usage.quotas["Weekly (7d)"]).toEqual({
      used: 100 ? 10 : 10,
      total: 100,
      remaining: 90,
      remainingPercentage: 90,
      resetAt: new Date(1788492142997).toISOString(),
      unlimited: false,
    });
  });

  it("handles TOKENS_LIMIT quotas", async () => {
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse(SAMPLE_GLM_TOKENS_USAGE));

    const usage = await getUsageForProvider({
      provider: "glm-cn",
      apiKey: "glm-cn-key",
    });

    expect(usage.message).toBeUndefined();
    expect(usage.plan).toBe("Standard");
    expect(usage.quotas["Tokens"]).toEqual({
      used: 40,
      total: 100,
      remaining: 60,
      remainingPercentage: 60,
      resetAt: new Date(1787905548392).toISOString(),
      unlimited: false,
    });
  });

  it("handles fallback key for custom limit units", async () => {
    proxyAwareFetch.mockResolvedValueOnce(
      jsonResponse({
        code: 200,
        data: {
          limits: [
            {
              type: "CREDIT_LIMIT",
              unit: 99,
              number: 12,
              percentage: 5,
              nextResetTime: 0,
            },
          ],
          level: "pro",
        },
      })
    );

    const usage = await getGlmUsage("glm-key", "glm");
    expect(usage.plan).toBe("Pro");
    expect(usage.quotas["Limit (12)"]).toEqual({
      used: 5,
      total: 100,
      remaining: 95,
      remainingPercentage: 95,
      resetAt: null,
      unlimited: false,
    });
  });

  it("surfaces invalid key message on 401", async () => {
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse({ error: "unauthorized" }, 401));

    const usage = await getUsageForProvider({
      provider: "glm",
      apiKey: "invalid-key",
    });

    expect(usage.message).toMatch(/invalid or expired/i);
  });

  it("handles non-200 error response", async () => {
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse({ error: "server error" }, 500));

    const usage = await getUsageForProvider({
      provider: "glm",
      apiKey: "valid-key",
    });

    expect(usage.message).toMatch(/GLM quota API error \(500\)/);
  });

  it("returns message when apiKey is missing", async () => {
    const usage = await getUsageForProvider({
      provider: "glm",
      apiKey: "",
    });

    expect(usage.message).toBe("GLM API key not available.");
  });
});

describe("GLM Coding Plan usage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("parses per-model token balances from billing/balance", async () => {
    proxyAwareFetch
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            plans: [{ name: "ZCode Start Plan", description: "Trial", starts_at: 1700000000, ends_at: 1800000000 }],
          },
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            balances: [
              {
                show_name: "GLM-5.2",
                total_units: 3000000,
                used_units: 223000,
                remaining_units: 2777000,
                expires_at: 1781625599,
              },
              {
                show_name: "GLM-5-Turbo",
                total_units: 2000000,
                used_units: 0,
                remaining_units: 2000000,
                expires_at: 1781625599,
              },
            ],
          },
        })
      );

    const usage = await getUsageForProvider({
      provider: "glm",
      authType: "oauth",
      accessToken: "jwt-token",
      providerSpecificData: {
        authMethod: "zcode_oauth",
        useCodingPlan: true,
        zcodeJwtToken: "jwt-token",
      },
    });

    expect(usage.plan).toBe("ZCode Start Plan");
    expect(usage.quotas["GLM-5.2"]).toMatchObject({
      used: 223000,
      total: 3000000,
      remainingPercentage: 93,
      unit: "token",
    });
    expect(usage.quotas["GLM-5-Turbo"]).toMatchObject({
      used: 0,
      total: 2000000,
      remainingPercentage: 100,
      unit: "token",
    });
    expect(usage.quotas["GLM-5.2"].resetAt).toBe("2026-06-16T15:59:59.000Z");
  });

  it("returns auth message when billing/current is unauthorized", async () => {
    proxyAwareFetch
      .mockResolvedValueOnce(jsonResponse({ message: "unauthorized" }, 401))
      .mockResolvedValueOnce(jsonResponse({ data: { balances: [] } }));

    const usage = await getUsageForProvider({
      provider: "glm",
      providerSpecificData: { zcodeJwtToken: "bad-jwt" },
    });

    expect(usage.message).toMatch(/invalid or expired/i);
    expect(usage.quotas).toBeUndefined();
  });
});

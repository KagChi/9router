import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: vi.fn(),
}));

import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";
import { getUsageForProvider } from "../../open-sse/services/usage.js";
import {
  USAGE_SUPPORTED_PROVIDERS,
  USAGE_APIKEY_PROVIDERS,
} from "../../src/shared/constants/providers.js";
import { parseQuotaData } from "../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js";
import {
  isQoderPat,
  normalizeQoderPat,
  clearQoderPatCache,
} from "../../open-sse/shared/qoder/patToken.js";

const QODER_QUOTA_URL = "https://openapi.qoder.sh/api/v2/quota/usage";
const QODER_EXCHANGE_URL = "https://openapi.qoder.sh/api/v1/jobToken/exchange";
const QODER_USERINFO_URL = "https://openapi.qoder.sh/api/v1/userinfo";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Shape mirrors the live /api/v2/quota/usage response parsed by getQoderUsage.
const QUOTA_BODY = {
  userQuota: { total: 500, used: 120, remaining: 380, unit: "credits" },
  orgResourcePackage: { total: 0, used: 0, remaining: 0, unit: "credits" },
  totalUsagePercentage: 24,
  isQuotaExceeded: false,
  expiresAt: 1790000000000,
};

const EXCHANGE_RESPONSE = {
  token: "jt-test-job-token",
  refresh_token: "rt-test",
  expires_at: "2030-01-01T00:00:00Z",
};

/** Queue: exchange → userinfo → quota. */
function mockPatFlow(quotaBody = QUOTA_BODY, quotaStatus = 200) {
  proxyAwareFetch
    .mockResolvedValueOnce(jsonResponse(EXCHANGE_RESPONSE))
    .mockResolvedValueOnce(jsonResponse({ id: "user-123" }))
    .mockResolvedValueOnce(jsonResponse(quotaBody, quotaStatus));
}

describe("qoder registry usage flags", () => {
  it("exposes usage + usageApikey so OAuth and apikey cards appear on /quota", () => {
    expect(USAGE_SUPPORTED_PROVIDERS).toContain("qoder");
    expect(USAGE_APIKEY_PROVIDERS).toContain("qoder");
  });
});

describe("patToken helpers", () => {
  it("isQoderPat only matches pt- tokens", () => {
    expect(isQoderPat("pt-abc")).toBe(true);
    expect(isQoderPat("dt-abc")).toBe(false);
    expect(isQoderPat("jt-abc")).toBe(false);
    expect(isQoderPat("")).toBe(false);
    expect(isQoderPat(null)).toBe(false);
  });

  it("normalizeQoderPat re-attaches the pt- prefix when missing", () => {
    expect(normalizeQoderPat("abc123")).toBe("pt-abc123");
    expect(normalizeQoderPat("pt-abc123")).toBe("pt-abc123");
    expect(normalizeQoderPat("  pt-x  ")).toBe("pt-x");
    expect(normalizeQoderPat("")).toBe("");
  });
});

describe("getUsageForProvider(qoder) auth selection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearQoderPatCache();
  });

  it("OAuth path: device token used directly as Bearer (no exchange)", async () => {
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse(QUOTA_BODY));

    const usage = await getUsageForProvider({
      provider: "qoder",
      accessToken: "dt-device-token",
    });

    expect(usage.message).toBeUndefined();
    expect(usage.quotas.user).toMatchObject({
      total: 500,
      used: 120,
      remaining: 380,
      unit: "credits",
    });

    expect(proxyAwareFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = proxyAwareFetch.mock.calls[0];
    expect(url).toBe(QODER_QUOTA_URL);
    expect(opts.headers.Authorization).toBe("Bearer dt-device-token");
  });

  it("apikey path: PAT exchanged for job token, then quota fetched with jt-", async () => {
    mockPatFlow();

    const usage = await getUsageForProvider({
      provider: "qoder",
      apiKey: "pt-personal-token",
    });

    expect(usage.message).toBeUndefined();
    expect(usage.quotas.user).toMatchObject({ total: 500, used: 120 });

    expect(proxyAwareFetch).toHaveBeenCalledTimes(3);

    // 1) PAT → job token exchange
    const [exUrl, exOpts] = proxyAwareFetch.mock.calls[0];
    expect(exUrl).toBe(QODER_EXCHANGE_URL);
    expect(exOpts.method).toBe("POST");
    expect(JSON.parse(exOpts.body)).toEqual({ personal_token: "pt-personal-token" });

    // 2) userId lookup with the fresh job token
    const [uiUrl, uiOpts] = proxyAwareFetch.mock.calls[1];
    expect(uiUrl).toBe(QODER_USERINFO_URL);
    expect(uiOpts.headers.Authorization).toBe("Bearer jt-test-job-token");

    // 3) quota endpoint authenticated with the job token (NOT the raw PAT)
    const [qUrl, qOpts] = proxyAwareFetch.mock.calls[2];
    expect(qUrl).toBe(QODER_QUOTA_URL);
    expect(qOpts.headers.Authorization).toBe("Bearer jt-test-job-token");
  });

  it("apikey path normalizes keys stored without the pt- prefix", async () => {
    mockPatFlow();

    await getUsageForProvider({ provider: "qoder", apiKey: "bare-token" });

    const [, exOpts] = proxyAwareFetch.mock.calls[0];
    expect(JSON.parse(exOpts.body)).toEqual({ personal_token: "pt-bare-token" });
  });

  it("prefers apiKey over accessToken when both present", async () => {
    mockPatFlow();

    await getUsageForProvider({
      provider: "qoder",
      accessToken: "dt-device-token",
      apiKey: "pt-personal-token",
    });

    // Exchange happened → apiKey won.
    const [exUrl] = proxyAwareFetch.mock.calls[0];
    expect(exUrl).toBe(QODER_EXCHANGE_URL);
    const [qUrl, qOpts] = proxyAwareFetch.mock.calls[2];
    expect(qUrl).toBe(QODER_QUOTA_URL);
    expect(qOpts.headers.Authorization).toBe("Bearer jt-test-job-token");
  });

  it("caches the PAT exchange so repeat quota refreshes don't re-exchange", async () => {
    mockPatFlow();
    await getUsageForProvider({ provider: "qoder", apiKey: "pt-cached" });
    expect(proxyAwareFetch).toHaveBeenCalledTimes(3);

    // Second refresh: only the quota endpoint is hit again.
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse(QUOTA_BODY));
    const usage = await getUsageForProvider({
      provider: "qoder",
      apiKey: "pt-cached",
    });
    expect(usage.message).toBeUndefined();
    expect(proxyAwareFetch).toHaveBeenCalledTimes(4);
    const [url, opts] = proxyAwareFetch.mock.calls[3];
    expect(url).toBe(QODER_QUOTA_URL);
    expect(opts.headers.Authorization).toBe("Bearer jt-test-job-token");
  });

  it("surfaces PAT exchange failures as a message (no quota call)", async () => {
    proxyAwareFetch.mockResolvedValueOnce(
      jsonResponse({ message: "invalid personal token" }, 401),
    );

    const usage = await getUsageForProvider({
      provider: "qoder",
      apiKey: "pt-revoked",
    });

    expect(usage.message).toMatch(/Personal Access Token exchange failed/i);
    expect(usage.quotas).toBeUndefined();
    expect(proxyAwareFetch).toHaveBeenCalledTimes(1);
    // Must not trip the usage-route AUTH_EXPIRED_PATTERNS force-refresh loop
    // for OAuth connections (apikey connections never refresh anyway).
    expect(usage.message.toLowerCase()).not.toContain("expired");
  });

  it("maps quota-endpoint 401/403 to invalid-or-expired message", async () => {
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse({}, 401));

    const usage = await getUsageForProvider({
      provider: "qoder",
      accessToken: "dt-expired",
    });

    expect(usage.message).toMatch(/invalid or expired/i);
    expect(usage.quotas).toBeUndefined();
  });

  it("returns missing-credentials message when neither token nor key", async () => {
    const usage = await getUsageForProvider({ provider: "qoder" });
    expect(usage.message).toMatch(/token|key/i);
    expect(proxyAwareFetch).not.toHaveBeenCalled();
  });
});

describe("parseQuotaData(qoder)", () => {
  it("renders Personal row from user quota and skips empty organization", () => {
    const rows = parseQuotaData("qoder", {
      quotas: {
        user: {
          total: 500,
          used: 120,
          remaining: 380,
          unit: "credits",
          resetAt: "2026-09-01T00:00:00.000Z",
        },
        organization: { total: 0, used: 0, remaining: 0, unit: "credits" },
      },
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      name: "Personal",
      used: 120,
      total: 500,
      unit: "credits",
    });
    // Absolute `remaining` must not leak through — QuotaTable would treat
    // 380 credits as 380%.
    expect(rows[0].remaining).toBeUndefined();
  });

  it("renders Organization row when the package has a real total", () => {
    const rows = parseQuotaData("qoder", {
      quotas: {
        user: { total: 500, used: 120, remaining: 380, unit: "credits" },
        organization: { total: 2000, used: 800, remaining: 1200, unit: "credits" },
      },
    });

    expect(rows.map((r) => r.name)).toEqual(["Personal", "Organization"]);
    expect(rows[1]).toMatchObject({ used: 800, total: 2000 });
  });
});

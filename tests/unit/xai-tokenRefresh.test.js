import { describe, it, expect, vi } from "vitest";

// We can't easily import the open-sse switch logic without real PROVIDERS config,
// so verify the wrapper function shape directly via dynamic import.

describe("xai/token-refresh wrapper", () => {
  it("refreshXaiToken module loads without throwing", async () => {
    // Just verify the file imports cleanly. The actual wrapper is internal.
    const mod = await import("../../open-sse/services/tokenRefresh.js");
    expect(typeof mod.refreshTokenByProvider).toBe("function");
    expect(typeof mod.formatProviderCredentials).toBe("function");
  });

  it("formatProviderCredentials returns Bearer-shape for xai", async () => {
    const mod = await import("../../open-sse/services/tokenRefresh.js");
    const out = mod.formatProviderCredentials(
      "xai",
      { apiKey: "k", accessToken: "t", refreshToken: "r" },
      null
    );
    expect(out).toEqual({ apiKey: "k", accessToken: "t" });
  });

  it("refreshTokenByProvider returns null when refreshToken missing", async () => {
    const mod = await import("../../open-sse/services/tokenRefresh.js");
    const out = await mod.refreshTokenByProvider("xai", { refreshToken: "" }, null);
    expect(out).toBeNull();
  });

  it("refreshTokenByProvider returns expiresIn for refreshed xai tokens", async () => {
    vi.resetModules();
    vi.doMock("../../src/lib/oauth/services/xai.js", () => ({
      XaiService: class {
        async refreshAccessToken(refreshToken) {
          return {
            access_token: "new-access",
            refresh_token: `${refreshToken}-rotated`,
            expires_in: 21600, // xAI claims 6 hours (bogus)
            id_token: "id-token",
          };
        }
      },
    }));

    const mod = await import("../../open-sse/services/tokenRefresh.js");
    const out = await mod.refreshTokenByProvider(
      "xai",
      { refreshToken: "old-refresh" },
      null
    );

    // Fix for issue #2546: expiresIn is overridden to 2700 (45 min) instead of
    // the bogus 21600 (6h) that xAI claims, so tokens refresh before expiry.
    expect(out).toEqual({
      accessToken: "new-access",
      refreshToken: "old-refresh-rotated",
      expiresIn: 2700, // Corrected to 45 min, not xAI's bogus 21600
      idToken: "id-token",
    });
    expect(out).not.toHaveProperty("expiresAt");

    vi.doUnmock("../../src/lib/oauth/services/xai.js");
    vi.resetModules();
  });
});

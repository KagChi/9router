import {
  BulkImportManager,
  buildLookupResponse,
  parseBulkAccounts,
} from "./bulkImportManager.js";
import { LIVSCENE_CONFIG } from "../constants/oauth.js";

const LIVSCENE_PROVIDER_ID = LIVSCENE_CONFIG.providerId;
const LIVSCENE_LABEL = LIVSCENE_CONFIG.label;
const LIVSCENE_TIMEOUT_MS = 5 * 60_000;

/**
 * Default connection saver for Livscene. Stores the API key (sk-...) as the
 * access token — that's the only credential livscene automation produces.
 */
async function defaultSaveLivsceneConnection({
  apiKey,
  email,
  userId,
  aff,
  sessionCookies,
  initialQuota,
}) {
  const { createProviderConnection } = await import("../../../models/index.js");
  const connection = await createProviderConnection({
    provider: LIVSCENE_PROVIDER_ID,
    authType: "apikey",
    apiKey,
    name: email,
    email,
    providerSpecificData: {
      sourceId: "livscene",
      livsceneUserId: userId,
      aff,
      automation: "google-signup-bulk",
      sessionCookies: sessionCookies || null,
      initialQuota: initialQuota ?? null,
    },
    expiresAt: null,
    testStatus: "active",
  });
  return { connection };
}

/**
 * Livscene bulk import manager.
 *
 * Flow per account:
 *   1. Navigate to /sign-up?aff=<referral>
 *   2. Check #legal-consent checkbox (dispatchEvent click)
 *   3. Click "Continue with Google" button
 *   4. Google login (email → password → consent) via runGoogleAccountAutomation
 *   5. Wait for /dashboard redirect
 *   6. Get user ID from localStorage("uid")
 *   7. POST /api/token/ to create API key
 *   8. GET /api/token/?p=0&size=10 to get key ID
 *   9. POST /api/token/{id}/key to get full unmasked key
 *  10. Save connection with API key
 *
 * Unlike AutoClaw, no proxy server or callback port is needed — livscene
 * handles the OAuth callback server-side and sets a session cookie.
 * Concurrency > 1 is safe (no port collision).
 */
export class LivsceneBulkImportManager extends BulkImportManager {
  constructor({
    saveConnection = defaultSaveLivsceneConnection,
    storageName = "livscene-bulk-import",
  } = {}) {
    super({ storageName });
    this.saveConnection = saveConnection;
  }

  async startJob({
    accounts,
    concurrency,
    engine: _ignoredEngine,
    proxyUrl,
    proxyPoolIds,
    aff,
  }) {
    this.aff = aff || LIVSCENE_CONFIG.defaultAff;
    return super.startJob({
      accounts,
      concurrency: concurrency || 1,
      engine: "camoufox",
      proxyUrl,
      proxyPoolIds,
    });
  }

  async processAccount(job, account, _workerId) {
    console.log(`[livscene-bulk] processAccount START for ${account.email}`);
    if (job.cancelRequested) {
      this.finalizeAccount(account, "cancelled", { error: "Job cancelled" });
      return;
    }

    // Short-circuit: skip if connection already exists
    try {
      const { getProviderConnections } =
        await import("../../../models/index.js");
      const existing = await getProviderConnections({
        provider: LIVSCENE_PROVIDER_ID,
        isActive: true,
      });
      const target = String(account.email || "").toLowerCase();
      const match = existing.find(
        (c) => String(c.email || c.name || "").toLowerCase() === target,
      );
      if (match) {
        this.setAccountStep(
          account,
          "connection_exists",
          "Connection already exists — skipping login",
        );
        this.finalizeAccount(account, "success", {
          connectionId: match.id,
          step: "connection_exists",
          message: "Already exists — skipped bulk login",
        });
        account.password = undefined;
        await this.persistJobSnapshot(job, { forcePreview: true });
        return;
      }
    } catch (error) {
      console.warn(
        `[livscene-bulk] duplicate-check failed for ${account.email}: ${error.message}`,
      );
    }

    const result = await this._runLivsceneLoginAttempt(job, account);
    account.password = undefined;
    await this.persistJobSnapshot(job, { forcePreview: true });
    return result;
  }

  async _runLivsceneLoginAttempt(job, account) {
    console.log(
      `[livscene-bulk] _runLivsceneLoginAttempt START for ${account.email}`,
    );
    const { createFreshContext } = await import("./bulkImportManager.js");
    const { runGoogleAccountAutomation } =
      await import("./kiroGoogleAutomation.js");

    this.setAccountStep(
      account,
      "launching_browser",
      "Launching camoufox for Livscene",
    );
    await this.persistJobSnapshot(job, { forcePreview: true });

    const { launchBulkImportBrowser } =
      await import("./bulkImportBrowserEngine.js");
    console.log(`[livscene-bulk] launching browser for ${account.email}...`);
    const browser = await launchBulkImportBrowser({
      engine: "camoufox",
      headless: true,
      proxyUrl: account.resolvedProxyUrl || null,
    });

    let outcome = { status: "failed" };
    try {
      const { context, page } = await createFreshContext(browser);
      // Set runtimeSession so the parent class can capture live preview
      // screenshots while the browser is running.
      account.runtimeSession = { context, page, browser };

      // Step 1: Navigate to sign-up page with referral code
      this.setAccountStep(
        account,
        "opening_signup",
        `Opening Livscene sign-up page (aff=${this.aff})`,
      );
      await this.persistJobSnapshot(job, { forcePreview: true });

      const signupUrl = `${LIVSCENE_CONFIG.baseUrl}/sign-up?aff=${this.aff}`;
      await page.goto(signupUrl, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      await page.waitForTimeout(3000);

      // Step 2: Check checkbox #legal-consent via dispatchEvent
      this.setAccountStep(account, "checking_consent", "Checking agreement");
      await page.evaluate(() => {
        const cb = document.getElementById("legal-consent");
        if (cb)
          cb.dispatchEvent(
            new MouseEvent("click", { bubbles: true, cancelable: true }),
          );
      });
      await page.waitForTimeout(500);

      // Step 3: Click "Continue with Google" button
      this.setAccountStep(
        account,
        "clicking_google",
        "Clicking Continue with Google",
      );
      // Wait for Google button to appear, then click it
      let googleBtnClicked = false;
      for (let i = 0; i < 10; i++) {
        googleBtnClicked = await page.evaluate(() => {
          const btns = [...document.querySelectorAll("button")];
          const g = btns.find((b) => /google/i.test(b.innerText || ""));
          if (g) {
            g.click();
            return true;
          }
          return false;
        });
        if (googleBtnClicked) break;
        await page.waitForTimeout(1000);
      }
      if (!googleBtnClicked) {
        throw new Error("Could not find Continue with Google button");
      }
      // Wait for redirect to Google login
      await page
        .waitForURL("**/accounts.google.com/**", { timeout: 15_000 })
        .catch(() => {});

      // Verify we're on Google login page
      if (!page.url().includes("accounts.google.com")) {
        throw new Error(
          "Did not redirect to Google login page after clicking Continue with Google",
        );
      }

      // Step 4: Run Google account automation (email → password → consent)
      this.setAccountStep(
        account,
        "google_login",
        "Running Google login automation",
      );
      await this.persistJobSnapshot(job, { forcePreview: true });

      // runGoogleAccountAutomation expects a successPromise that resolves
      // when OAuth callback fires. Livscene has no callback proxy — success
      // is detected via URL redirect to ai.livscene.com. Create a promise
      // that resolves when the page URL changes to livscene.
      let resolveSuccess;
      const successPromise = new Promise((resolve) => {
        resolveSuccess = resolve;
      });
      successPromise.catch(() => {});

      // Watch for URL change to livscene — resolves successPromise.
      // Require 2 consecutive checks to avoid false positives from
      // brief redirect bounces (Google → livscene → back to Google).
      let livsceneHits = 0;
      const urlPollInterval = setInterval(() => {
        try {
          const url = page.url();
          if (
            url.includes("ai.livscene.com") &&
            !url.includes("accounts.google.com")
          ) {
            livsceneHits++;
            if (livsceneHits >= 2) {
              resolveSuccess({ redirected: true });
              clearInterval(urlPollInterval);
            }
          } else {
            livsceneHits = 0;
          }
        } catch {}
      }, 300);

      await runGoogleAccountAutomation({
        page,
        authUrl: page.url(),
        email: account.email,
        password: account.password,
        successPromise,
        shortTimeoutMs: LIVSCENE_TIMEOUT_MS,
        serviceLabel: LIVSCENE_LABEL,
        openingStep: "google_login",
        openingMessage: "Running Google login automation",
        successStep: "livscene_dashboard",
        successMessage: "Livscene dashboard reached",
        onStep: (step, message) => {
          this.setAccountStep(account, step, message);
          void this.persistJobSnapshot(job, { forcePreview: true });
        },
      });

      clearInterval(urlPollInterval);

      // runGoogleAccountAutomation returns when successPromise resolves
      // (URL changed to livscene) or timeout. Verify we're on livscene.
      const currentUrl = page.url();
      if (!currentUrl.includes("ai.livscene.com")) {
        // Shorten URL in error — full Google OAuth URL is very long
        const shortUrl =
          currentUrl.length > 80 ? currentUrl.slice(0, 80) + "..." : currentUrl;
        const isGoogleStuck = currentUrl.includes("accounts.google.com");
        throw new Error(
          isGoogleStuck
            ? `Google OAuth stuck (likely proxy/anti-bot). URL: ${shortUrl}`
            : `Did not redirect to Livscene. URL: ${shortUrl}`,
        );
      }

      // Step 5: Wait for livscene to finish OAuth exchange + redirect to
      // dashboard. Livscene is a SPA — client-side route changes don't
      // trigger waitForURL, so we poll the URL instead.
      this.setAccountStep(
        account,
        "dashboard_reached",
        "Waiting for Livscene dashboard",
      );
      let dashboardReached = false;
      for (let i = 0; i < 30; i++) {
        const url = page.url();
        if (url.includes("/dashboard")) {
          dashboardReached = true;
          break;
        }
        // If redirected back to Google or to sign-in, OAuth exchange failed
        if (
          url.includes("accounts.google.com") ||
          url.includes("/sign-in") ||
          url.includes("/login")
        ) {
          throw new Error(
            "OAuth session failed — Google or Livscene rejected the login (likely proxy/anti-bot). Try a different proxy.",
          );
        }
        await page.waitForTimeout(1000);
      }
      if (!dashboardReached) {
        const url = page.url();
        const shortUrl = url.length > 80 ? url.slice(0, 80) + "..." : url;
        throw new Error(`Livscene dashboard not reached. URL: ${shortUrl}`);
      }
      // Give the SPA time to initialize + set localStorage
      await page.waitForTimeout(3000);

      // Step 6: Get user ID from localStorage (retry — JS app needs time
      // to initialize and set uid after page load)
      let userId = null;
      for (let i = 0; i < 15; i++) {
        userId = await page.evaluate(() => localStorage.getItem("uid"));
        if (userId) break;
        await page.waitForTimeout(1000);
      }
      if (!userId) {
        const url = page.url();
        throw new Error(
          `Could not get user ID from localStorage. URL: ${url.slice(0, 80)}`,
        );
      }
      console.log(`[livscene-bulk] ${account.email} userId=${userId}`);

      // Step 6.5: Fetch user balance + session cookies for later use
      this.setAccountStep(
        account,
        "fetching_balance",
        "Fetching account balance",
      );
      await this.persistJobSnapshot(job, { forcePreview: true });
      const userInfo = await page
        .evaluate(async (uid) => {
          const resp = await fetch("/api/user/self", {
            headers: { "new-api-user": String(uid) },
            credentials: "include",
          });
          return {
            status: resp.status,
            data: resp.ok ? await resp.json() : null,
          };
        }, userId)
        .catch((e) => ({ status: 0, data: null, error: e.message }));
      const userQuota = userInfo.data?.data?.quota ?? null;
      console.log(`[livscene-bulk] ${account.email} quota=${userQuota}`);

      // Capture session cookies for balance refresh later
      const cookies = await context.cookies();
      const livsceneCookies = cookies
        .filter((c) => c.domain?.includes("livscene"))
        .map((c) => `${c.name}=${c.value}`)
        .join("; ");

      // Step 7: Create API key via POST /api/token/
      this.setAccountStep(account, "creating_key", "Creating API key");
      await this.persistJobSnapshot(job, { forcePreview: true });

      const createResult = await page.evaluate(
        async (opts) => {
          const resp = await fetch("/api/token/", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "new-api-user": String(opts.uid),
            },
            credentials: "include",
            body: JSON.stringify({
              name: "9router",
              remain_quota: 0,
              expired_time: -1,
              unlimited_quota: true,
              model_limits_enabled: false,
              model_limits: "",
              allow_ips: "",
              group: "",
              cross_group_retry: false,
            }),
          });
          return { status: resp.status, text: await resp.text() };
        },
        { uid: userId },
      );

      if (createResult.status !== 200) {
        throw new Error(
          `Create key failed: ${createResult.status} ${createResult.text}`,
        );
      }

      // Step 8: Get key ID from list
      const listText = await page.evaluate(
        async (opts) => {
          const resp = await fetch("/api/token/?p=0&size=10", {
            headers: { "new-api-user": String(opts.uid) },
            credentials: "include",
          });
          return await resp.text();
        },
        { uid: userId },
      );

      const keyId = JSON.parse(listText).data?.items?.[0]?.id;
      if (!keyId) {
        throw new Error("Could not get key ID from token list");
      }

      // Step 9: Get full unmasked key via POST /api/token/{id}/key
      this.setAccountStep(account, "fetching_key", "Fetching API key");
      await this.persistJobSnapshot(job, { forcePreview: true });

      let apiKey = null;
      for (let retry = 0; retry < 3; retry++) {
        const fullKeyResult = await page.evaluate(
          async (opts) => {
            const resp = await fetch(`/api/token/${opts.id}/key`, {
              method: "POST",
              headers: {
                accept: "application/json, text/plain, */*",
                "new-api-user": String(opts.uid),
              },
              credentials: "include",
            });
            return { status: resp.status, text: await resp.text() };
          },
          { id: keyId, uid: userId },
        );

        if (fullKeyResult.status === 200) {
          const keyData = JSON.parse(fullKeyResult.text);
          apiKey = keyData.data?.key;
          if (apiKey) break;
        }
        if (fullKeyResult.status === 429) {
          await page.waitForTimeout(3000);
        }
      }

      if (!apiKey) {
        throw new Error("Could not get full API key");
      }

      // Livscene keys are prefixed with sk- in the UI
      const fullKey = apiKey.startsWith("sk-") ? apiKey : `sk-${apiKey}`;

      // Step 10: Save connection
      this.setAccountStep(account, "saving_connection", "Saving connection");
      await this.persistJobSnapshot(job, { forcePreview: true });

      const { connection } = await this.saveConnection({
        apiKey: fullKey,
        email: account.email,
        userId,
        aff: this.aff,
        sessionCookies: livsceneCookies,
        initialQuota: userQuota,
      });

      this.finalizeAccount(account, "success", {
        connectionId: connection.id,
        step: "connection_saved",
        message: "Livscene API key saved successfully",
      });
      outcome = { status: "success" };
    } catch (error) {
      console.error(
        `[livscene-bulk] ERROR for ${account.email}:`,
        error.message,
        error.stack,
      );
      const isCancel = job.cancelRequested;
      this.finalizeAccount(account, isCancel ? "cancelled" : "failed", {
        error: isCancel
          ? "Job cancelled"
          : error.message || "Livscene automation failed.",
        step: isCancel ? "cancelled" : "failed",
        message: isCancel
          ? "Job cancelled while processing this account"
          : error.message || "Livscene automation failed.",
      });
      outcome = { status: isCancel ? "cancelled" : "failed" };
    } finally {
      account.runtimeSession = null;
      await browser.close().catch(() => null);
    }
    return outcome;
  }
}

function getSingletonStore() {
  if (!globalThis.__livsceneBulkImportSingleton) {
    globalThis.__livsceneBulkImportSingleton = {
      manager: new LivsceneBulkImportManager(),
    };
  }
  return globalThis.__livsceneBulkImportSingleton;
}

export function getLivsceneBulkImportManager() {
  return getSingletonStore().manager;
}

export { parseBulkAccounts, buildLookupResponse };

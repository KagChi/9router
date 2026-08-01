import {
  BulkImportManager,
  buildLookupResponse,
  parseBulkAccounts,
} from "./bulkImportManager.js";

const CODEBUDDY_PROVIDER_ID = "codebuddy-intl";
const CODEBUDDY_LABEL = "CodeBuddy";
const CODEBUDDY_TIMEOUT_MS = 5 * 60_000;

/**
 * Handler untuk region page CodeBuddy — klik input, pilih Singapore,
 * submit, tunggu URL/DOM keluar. Return true kalau sukses.
 */
async function handleRegionSelectionMouse(page, emailForLog = "") {
  const tag = `[codebuddy-region] ${emailForLog}`;
  for (let i = 0; i < 5; i++) {
    try {
      const inputSel =
        'input[placeholder="Registration location"], input.t-input__inner[readonly]';
      await page.waitForSelector(inputSel, { timeout: 15_000 });
      const regionInput = page.locator(inputSel).first();
      await regionInput.scrollIntoViewIfNeeded().catch(() => {});
      await page.waitForTimeout(400);
      await regionInput.click({ timeout: 8_000 });
      await page.waitForTimeout(1200);

      const optionSelectors = [
        'li:has-text("Singapore")',
        '[role="option"]:has-text("Singapore")',
        '.t-select-option:has-text("Singapore")',
        'ul.dropdown-section li:has-text("Singapore")',
        '.dropdown-section li:has-text("Singapore")',
        '[class*="option"]:has-text("Singapore")',
      ];
      let sgClicked = false;
      for (const sel of optionSelectors) {
        try {
          const loc = page.locator(sel).first();
          if ((await loc.count()) > 0) {
            await loc.scrollIntoViewIfNeeded().catch(() => {});
            await loc.click({ timeout: 5_000 });
            sgClicked = true;
            break;
          }
        } catch {}
      }
      if (!sgClicked) {
        sgClicked = await page.evaluate(() => {
          const els = Array.from(
            document.querySelectorAll(
              "li, [role='option'], .t-select-option, div, span",
            ),
          );
          for (const el of els) {
            const txt = (el.textContent || "").trim();
            if (/^singapore$/i.test(txt)) {
              const r = el.getBoundingClientRect();
              if (r.width > 0 && r.height > 0) {
                el.click();
                return true;
              }
            }
          }
          return false;
        });
      }
      console.log(`${tag} iter ${i + 1} Singapore clicked=${sgClicked}`);
      if (!sgClicked) {
        await page.waitForTimeout(2000);
        continue;
      }
      await page.waitForTimeout(800);

      const submitSelectors = [
        'button:has-text("Get started")',
        'button:has-text("Get Started")',
        'button:has-text("Start")',
        'button:has-text("Submit")',
        'button:has-text("Continue")',
        'button:has-text("Confirm")',
        'button:has-text("OK")',
        'button:has-text("Ok")',
        'div[class*="cursor-pointer"]:has-text("Submit")',
        'div:has-text("Submit")',
        ".page-region button.t-button--primary",
        ".page-region button:not([disabled])",
        "button.t-button--primary",
        'button[type="submit"]',
      ];
      let submitClicked = false;
      for (const sel of submitSelectors) {
        try {
          const loc = page.locator(sel).first();
          if ((await loc.count()) > 0) {
            const disabled = await loc
              .getAttribute("disabled")
              .catch(() => null);
            if (disabled !== null) continue;
            await loc.click({ timeout: 5_000 });
            submitClicked = true;
            break;
          }
        } catch {}
      }
      if (!submitClicked) {
        submitClicked = await page.evaluate(() => {
          const btns = Array.from(
            document.querySelectorAll(
              "button, [role='button'], div[class*='cursor-pointer'], div[class*='bg-#28B894']",
            ),
          );
          for (const b of btns) {
            if (b.disabled || b.getAttribute("aria-disabled") === "true")
              continue;
            const r = b.getBoundingClientRect();
            if (r.width < 20 || r.height < 20) continue;
            const t = (b.textContent || "").trim().toLowerCase();
            if (/submit|get started|start|continue|confirm|ok|next/.test(t)) {
              b.click();
              return true;
            }
          }
          return false;
        });
      }
      console.log(`${tag} iter ${i + 1} submit clicked=${submitClicked}`);

      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        const u = page.url();
        const inputStillThere = await page
          .locator('input[placeholder="Registration location"]')
          .count()
          .then((c) => c > 0)
          .catch(() => false);
        if (!u.includes("/register/user/complete") && !inputStillThere) {
          console.log(`${tag} region done, url=${u}`);
          await page.waitForTimeout(1500);
          return true;
        }
        await page.waitForTimeout(500);
      }
    } catch (err) {
      console.log(`${tag} iter ${i + 1} error: ${err?.message || err}`);
    }
    await page.waitForTimeout(2000);
  }
  return false;
}

/**
 * Default connection saver for CodeBuddy. Stores the API key as the
 * access token — the only credential CodeBuddy automation produces.
 */
async function defaultSaveCodeBuddyConnection({
  apiKey,
  email,
  sessionCookies,
}) {
  const { createProviderConnection } = await import("../../../models/index.js");
  const connection = await createProviderConnection({
    provider: CODEBUDDY_PROVIDER_ID,
    authType: "apikey",
    apiKey,
    name: email,
    email,
    providerSpecificData: {
      sourceId: "codebuddy-intl",
      automation: "google-login-bulk",
      sessionCookies: sessionCookies || null,
    },
    expiresAt: null,
    testStatus: "active",
  });
  return { connection };
}

/**
 * CodeBuddy International bulk import manager.
 *
 * Flow per account:
 *   1. Navigate to codebuddy.ai login page, click Google sign-in
 *   2. Google login (email → password → consent)
 *   3. Wait for redirect back to codebuddy.ai
 *   4. Navigate to /profile/keys
 *   5. POST /console/api/client/v1/api-keys to create API key
 *   6. Extract key from response
 *   7. Save connection with API key
 */
export class CodeBuddyIntlBulkImportManager extends BulkImportManager {
  constructor({
    saveConnection = defaultSaveCodeBuddyConnection,
    storageName = "codebuddy-intl-bulk-import",
  } = {}) {
    super({ storageName });
    this.saveConnection = saveConnection;
  }

  /**
   * Capture screenshots from ALL running workers (not just the first one).
   * Returns an array so the UI can render a grid of live previews.
   * Falls back to a single preview when only one worker is active.
   */
  async capturePreview(job) {
    const PREVIEW_TIMEOUT = 2500;
    const runningAccounts = job.accounts.filter(
      (a) => a.runtimeSession?.page && a.status === "running",
    );

    if (runningAccounts.length === 0) {
      // Fall back to manual sessions or any runtime session (base behaviour)
      const fallback =
        job.accounts.find(
          (a) => a.manualSession?.page && a.status === "needs_manual",
        ) ||
        job.accounts.find((a) => a.runtimeSession?.page) ||
        null;
      if (!fallback) return null;
      runningAccounts.push(fallback);
    }

    const previews = [];
    for (const account of runningAccounts) {
      const page = account.runtimeSession?.page || account.manualSession?.page;
      if (!page) continue;

      const meta = {
        email: account.email,
        workerId: account.workerId || null,
        status: account.status,
        step: account.currentStep || null,
        updatedAt: account.updatedAt || new Date().toISOString(),
      };

      const prevPreview = Array.isArray(job.lastPreview)
        ? job.lastPreview.find((p) => p.workerId === account.workerId)
        : null;
      const previousImage = prevPreview?.imageData || null;

      let screenshot = null;
      try {
        screenshot = await Promise.race([
          page.screenshot({
            type: "jpeg",
            quality: 45,
            fullPage: false,
            animations: "disabled",
            caret: "hide",
            timeout: PREVIEW_TIMEOUT,
          }),
          new Promise((r) => setTimeout(() => r(null), PREVIEW_TIMEOUT)),
        ]);
      } catch {
        // screenshot failed — use previous image
      }

      previews.push({
        ...meta,
        imageData: screenshot
          ? `data:image/jpeg;base64,${screenshot.toString("base64")}`
          : previousImage,
      });
    }

    // Return single object when only 1 preview (backward compat), array when multiple
    return previews.length === 1 ? previews[0] : previews;
  }

  async startJob({
    accounts,
    concurrency,
    engine: _ignoredEngine,
    proxyUrl,
    proxyPoolIds,
  }) {
    return super.startJob({
      accounts,
      concurrency: concurrency || 1,
      engine: "camoufox",
      proxyUrl,
      proxyPoolIds,
    });
  }

  /**
   * Override cancelJob to actively tear down in-flight browser sessions.
   * Base only flips `cancelRequested`; workers blocked inside
   * `runGoogleAccountAutomation` won't observe it until Playwright ops
   * timeout. Closing context/browser forces those awaits to reject so the
   * worker loop exits immediately.
   */
  async cancelJob(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) return super.cancelJob(jobId);

    job.cancelRequested = true;
    if (job.status === "queued") {
      job.status = "cancelled";
      job.finishedAt = new Date().toISOString();
      job.accounts.forEach((account) => {
        if (account.status === "queued") account.status = "cancelled";
      });
    }

    for (const account of job.accounts) {
      const session = account.runtimeSession || account.manualSession;
      if (session) {
        const { context, browser } = session;
        if (context) void context.close().catch(() => null);
        if (browser) void browser.close().catch(() => null);
      }
    }

    void this.persistJobSnapshot(job, { forcePreview: true });
    return this.getJob(jobId);
  }

  async processAccount(job, account, _workerId) {
    console.log(`[codebuddy-bulk] processAccount START for ${account.email}`);
    if (job.cancelRequested) {
      this.finalizeAccount(account, "cancelled", { error: "Job cancelled" });
      return;
    }

    // Short-circuit: skip if connection already exists
    try {
      const { getProviderConnections } =
        await import("../../../models/index.js");
      const existing = await getProviderConnections({
        provider: CODEBUDDY_PROVIDER_ID,
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
        `[codebuddy-bulk] duplicate-check failed for ${account.email}: ${error.message}`,
      );
    }

    // Retry loop: proxy residential kadang refuse (403/connection refused)
    // atau timeout awal. Retry sampai MAX_RETRIES dengan backoff sebelum
    // menyerah. ponytail: skipped: retry per-step, tambah kalau butuh resume
    // di tengah flow.
    const MAX_RETRIES = 3;
    let result = null;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      if (job.cancelRequested) break;
      result = await this._runCodeBuddyLoginAttempt(job, account, {
        attempt,
        maxAttempts: MAX_RETRIES,
      });
      if (result?.status !== "retryable") break;
      if (attempt < MAX_RETRIES) {
        const delayMs = 2000 * attempt; // 2s, 4s
        this.setAccountStep(
          account,
          "retrying",
          `Proxy error, retrying in ${delayMs / 1000}s (attempt ${attempt + 1}/${MAX_RETRIES})`,
        );
        await this.persistJobSnapshot(job, { forcePreview: true });
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }

    // Retries exhausted for a retryable error → finalize as failed here.
    if (result?.status === "retryable") {
      this.finalizeAccount(account, "failed", {
        error: result.error || "Proxy error after retries",
        step: "failed",
        message: result.error || "Proxy error after retries",
      });
    }

    account.password = undefined;
    await this.persistJobSnapshot(job, { forcePreview: true });
    return result;
  }

  /**
   * Classify an error as retryable (proxy-related transient failure) or not.
   * Retryable errors trigger a fresh browser + backoff.
   */
  _isRetryableProxyError(error) {
    if (!error) return false;
    const msg = String(error.message || error).toLowerCase();
    return (
      msg.includes("proxy server is refusing") ||
      msg.includes("proxy_connection_refused") ||
      msg.includes("ns_error_proxy") ||
      msg.includes("ns_error_connection_refused") ||
      msg.includes("ns_error_net_timeout") ||
      msg.includes("ns_error_unknown_proxy_host") ||
      msg.includes("403 forbidden") ||
      msg.includes("tunnel connection failed") ||
      msg.includes("proxy authentication required") ||
      msg.includes("net::err_tunnel_connection_failed") ||
      msg.includes("net::err_proxy_connection_failed") ||
      msg.includes("err_proxy") ||
      msg.includes("socket hang up") ||
      msg.includes("econnrefused") ||
      msg.includes("econnreset")
    );
  }

  async _runCodeBuddyLoginAttempt(job, account, retryCtx = {}) {
    const { attempt = 1, maxAttempts = 1 } = retryCtx;
    console.log(
      `[codebuddy-bulk] _runCodeBuddyLoginAttempt START for ${account.email} (attempt ${attempt}/${maxAttempts})`,
    );
    const { createFreshContext } = await import("./bulkImportManager.js");
    const { runGoogleAccountAutomation } =
      await import("./kiroGoogleAutomation.js");

    // Helper: check cancel and throw to short-circuit the flow.
    // The catch block below detects cancelRequested and finalises accordingly.
    const _checkCancel = () => {
      if (job.cancelRequested) throw new Error("__CANCEL__");
    };

    this.setAccountStep(
      account,
      "launching_browser",
      "Launching camoufox for CodeBuddy",
    );
    await this.persistJobSnapshot(job, { forcePreview: true });
    _checkCancel();

    const { launchBulkImportBrowser } =
      await import("./bulkImportBrowserEngine.js");
    console.log(`[codebuddy-bulk] launching browser for ${account.email}...`);
    const browser = await launchBulkImportBrowser({
      engine: "camoufox",
      headless: true,
      proxyUrl: account.resolvedProxyUrl || null,
    });
    _checkCancel();

    let outcome = { status: "failed" };
    try {
      const { context, page } = await createFreshContext(browser);
      account.runtimeSession = { context, page, browser };

      // Block resource yang tak esensial supaya proxy tak dibanjiri
      // request image/font/media/analytics. Google login page berat karena
      // load banyak asset — ini bottleneck utama saat pakai proxy.
      // Hanya block di host Google — biarkan Keycloak + codebuddy load full.
      // ponytail: skipped: block per-host granular, add when perlu tuning
      // beda per provider.
      await context.route("**/*", (route) => {
        try {
          const req = route.request();
          const url = req.url();
          const type = req.resourceType();
          // Skip resource berat di Google (accounts.google.com, gstatic).
          const isGoogleHost =
            /accounts\.google\.com|gstatic\.com|googleusercontent\.com|google-analytics|googletagmanager|doubleclick/i.test(
              url,
            );
          if (
            isGoogleHost &&
            (type === "image" ||
              type === "font" ||
              type === "media" ||
              type === "stylesheet")
          ) {
            return route.abort();
          }
          // Kill known tracking pixels/beacons di manapun.
          if (
            /googletagmanager|google-analytics|doubleclick\.net|sentry\.io|hotjar|amplitude|segment\.io|mixpanel/i.test(
              url,
            )
          ) {
            return route.abort();
          }
          return route.continue();
        } catch {
          try {
            return route.continue();
          } catch {}
        }
      });

      // Step 1: Navigate to CodeBuddy login page and click Google sign-in
      this.setAccountStep(
        account,
        "opening_login",
        "Opening CodeBuddy login page",
      );
      await this.persistJobSnapshot(job, { forcePreview: true });
      _checkCancel();

      // The /login?redirect_uri=... page is a React SPA that does NOT render
      // #social-google directly. That button lives on the Keycloak auth page
      // (/auth/realms/copilot/protocol/openid-connect/auth). The SPA normally
      // navigates there via a JS helper; we short-circuit and hit Keycloak
      // straight away. ponytail: skipped: SPA-driven flow, add when Keycloak
      // path changes.
      const keycloakUrl =
        "https://www.codebuddy.ai/auth/realms/copilot/protocol/openid-connect/auth" +
        "?client_id=console&response_type=code" +
        "&redirect_uri=" +
        encodeURIComponent("https://www.codebuddy.ai/home");
      await page.goto(keycloakUrl, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      _checkCancel();

      // Deteksi Camoufox/Firefox neterror page (proxy refused / DNS fail /
      // connection reset). Halaman ini bertitle di dokumen dan URL diawali
      // "about:neterror". Kalau ketemu → throw supaya masuk jalur retry.
      const currentUrl0 = page.url();
      if (
        currentUrl0.startsWith("about:neterror") ||
        currentUrl0.includes("neterror")
      ) {
        const bodyText = await page
          .evaluate(() => document.body?.textContent?.slice(0, 500) || "")
          .catch(() => "");
        throw new Error(
          `Proxy/network error: ${bodyText.replace(/\s+/g, " ").slice(0, 200)}`,
        );
      }
      // Fallback: dokumen HTML mungkin tampilkan "proxy server is refusing"
      // meski URL sudah rewrite. Cek body text.
      const bodyProbe = await page
        .evaluate(() => document.body?.textContent?.slice(0, 500) || "")
        .catch(() => "");
      if (
        /proxy server is refusing|the proxy server is|unable to connect|403 forbidden/i.test(
          bodyProbe,
        )
      ) {
        throw new Error(
          `Proxy server is refusing connections (attempt ${attempt}/${maxAttempts})`,
        );
      }

      this.setAccountStep(
        account,
        "waiting_login_form",
        "Waiting for login form to render",
      );
      await this.persistJobSnapshot(job, { forcePreview: true });

      const googleSelectors = [
        "#social-google",
        "#kc-social-google",
        "#kc-social-providers a[href*='google']",
        "#social-providers a[href*='google']",
        "a[href*='broker/google']",
      ];

      const findGoogleHrefInFrame = async (frameOrPage) => {
        for (const sel of googleSelectors) {
          try {
            const el = await frameOrPage.$(sel);
            if (el) {
              const href = await el.evaluate((node) => node.href);
              // Keycloak broker link is same-origin; it 302s to Google after
              // click. Accept any href that looks like the Google broker.
              if (href && /broker\/google\/login/.test(href)) return href;
            }
          } catch {
            // try next
          }
        }
        return null;
      };

      let googleHref = null;
      for (let attempt = 0; attempt < 20; attempt++) {
        _checkCancel();

        googleHref = await findGoogleHrefInFrame(page);
        if (googleHref) break;

        for (const frame of page.frames()) {
          if (frame === page.mainFrame()) continue;
          googleHref = await findGoogleHrefInFrame(frame);
          if (googleHref) break;
        }
        if (googleHref) break;

        if (attempt === 3 || attempt === 10) {
          const frames = page.frames();
          const frameUrls = frames.map((f) => f.url().slice(0, 100));
          console.log(
            `[codebuddy-bulk] ${account.email} [${attempt}] url=${page.url().slice(0, 80)} frames=${frames.length} urls=${JSON.stringify(frameUrls)}`,
          );
        }

        await page.waitForTimeout(1500);
      }

      if (!googleHref) {
        const currentUrl = page.url();
        throw new Error(
          `Google sign-in button not found. Current URL: ${currentUrl.slice(0, 120)}`,
        );
      }

      // Follow the Keycloak broker link. Keycloak will 302 to Google's OAuth
      // page.
      await page.goto(googleHref, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      _checkCancel();

      // Wait until we actually land on accounts.google.com (Keycloak may show
      // an interstitial before redirecting).
      for (let i = 0; i < 20; i++) {
        _checkCancel();
        if (page.url().includes("accounts.google.com")) break;
        await page.waitForTimeout(500);
      }

      // Verify we're on Google login page
      if (!page.url().includes("accounts.google.com")) {
        throw new Error("Did not reach Google OAuth page");
      }

      // Step 2: Run Google account automation
      this.setAccountStep(
        account,
        "google_login",
        "Running Google login automation",
      );
      await this.persistJobSnapshot(job, { forcePreview: true });
      _checkCancel();

      // Detect success when redirected back to codebuddy.ai.
      // The interval also watches for cancel — if the job is cancelled
      // we close the browser so runGoogleAccountAutomation exits promptly.
      let resolveSuccess;
      const successPromise = new Promise((resolve) => {
        resolveSuccess = resolve;
      });
      successPromise.catch(() => {});

      let cbHits = 0;
      const urlPollInterval = setInterval(() => {
        try {
          if (job.cancelRequested) {
            void browser.close().catch(() => null);
            clearInterval(urlPollInterval);
            return;
          }
          const url = page.url();
          // Success = balik ke codebuddy.ai DAN sudah di halaman yang bisa
          // di-handle (bukan intermediate Keycloak). /register/user/complete
          // JUGA success signal — worker akan lanjut ke step 2b (pilih region).
          const backOnProvider =
            url.includes("www.codebuddy.ai") &&
            !url.includes("accounts.google.com") &&
            !url.includes("/auth/realms/");
          if (backOnProvider) {
            cbHits++;
            if (cbHits >= 2) {
              resolveSuccess({ redirected: true });
              clearInterval(urlPollInterval);
            }
          } else {
            cbHits = 0;
          }
        } catch {}
      }, 300);

      await runGoogleAccountAutomation({
        page,
        authUrl: page.url(),
        email: account.email,
        password: account.password,
        successPromise,
        shortTimeoutMs: CODEBUDDY_TIMEOUT_MS,
        serviceLabel: CODEBUDDY_LABEL,
        openingStep: "google_login",
        openingMessage: "Running Google login automation",
        successStep: "codebuddy_home",
        successMessage: "CodeBuddy home reached",
        onStep: (step, message) => {
          this.setAccountStep(account, step, message);
          void this.persistJobSnapshot(job, { forcePreview: true });
        },
      });

      clearInterval(urlPollInterval);
      _checkCancel();

      // Verify we're back on codebuddy.ai
      const currentUrl = page.url();
      if (!currentUrl.includes("www.codebuddy.ai")) {
        const shortUrl =
          currentUrl.length > 80 ? currentUrl.slice(0, 80) + "..." : currentUrl;
        const isGoogleStuck = currentUrl.includes("accounts.google.com");
        throw new Error(
          isGoogleStuck
            ? `Google OAuth stuck (likely proxy/anti-bot). URL: ${shortUrl}`
            : `Did not redirect to CodeBuddy. URL: ${shortUrl}`,
        );
      }

      // Wait for session to fully initialize
      await page.waitForTimeout(3000);
      _checkCancel();

      // Step 2b: Kalau kena redirect ke /register/user/complete ATAU
      // halaman lain tapi ada input "Registration location" (SPA mount
      // belakangan), pilih region Singapore. Kalau benar-benar tidak,
      // skip — langsung ke buat API key.

      // Wait URL stabilize dulu.
      for (let i = 0; i < 10; i++) {
        _checkCancel();
        const u = page.url();
        if (
          u.includes("/home") ||
          u.includes("/register/user/complete") ||
          u.includes("/profile") ||
          u.includes("/console")
        ) {
          break;
        }
        await page.waitForTimeout(1000);
      }

      // Detect region page — bisa URL /register/user/complete, atau halaman
      // lain tapi ada input "Registration location" (SPA render telat).
      const postLoginUrl = page.url();
      let needsRegionSelect = postLoginUrl.includes("/register/user/complete");
      if (!needsRegionSelect) {
        const inputFound = await page
          .locator('input[placeholder="Registration location"]')
          .count()
          .then((c) => c > 0)
          .catch(() => false);
        if (inputFound) {
          needsRegionSelect = true;
          console.log(
            `[codebuddy-bulk] ${account.email} region input found despite url=${postLoginUrl}`,
          );
        }
      }
      console.log(
        `[codebuddy-bulk] ${account.email} post-login url=${postLoginUrl} needsRegion=${needsRegionSelect}`,
      );

      if (needsRegionSelect) {
        try {
          // Pilih region via klik dropdown DOM (bukan API — API return 200
          // tapi backend tak beneran commit tanpa SPA state update). Flow:
          //   1. Klik input placeholder="Registration location"
          //   2. Klik opsi Singapore di dropdown yang muncul
          //   3. Klik tombol submit (Get started / Confirm / OK / dll)
          let regionHandled = false;
          for (let i = 0; i < 10 && !regionHandled; i++) {
            _checkCancel();
            const preKeysUrl = page.url();
            const needsRegion =
              preKeysUrl.includes("/register/user/complete") ||
              preKeysUrl.includes("/register/user/");

            // Kalau URL bukan /register/user/complete, cek apakah input
            // region masih ada (SPA render telat atau sticky).
            let inputPresent = false;
            if (!needsRegion) {
              inputPresent = await page
                .locator('input[placeholder="Registration location"]')
                .count()
                .then((c) => c > 0)
                .catch(() => false);
            }

            console.log(
              `[codebuddy-bulk] ${account.email} step 2b iter ${i + 1} url=${preKeysUrl} needsRegion=${needsRegion} inputPresent=${inputPresent}`,
            );

            if (!needsRegion && !inputPresent) {
              regionHandled = true;
              break;
            }

            this.setAccountStep(
              account,
              "completing_region",
              "Completing CodeBuddy region (Singapore)",
            );
            await this.persistJobSnapshot(job, { forcePreview: true });

            try {
              // 1) Klik input Registration location untuk buka dropdown
              const inputSel =
                'input[placeholder="Registration location"], input.t-input__inner[readonly]';
              await page.waitForSelector(inputSel, { timeout: 15_000 });
              const regionInput = page.locator(inputSel).first();
              await regionInput.scrollIntoViewIfNeeded().catch(() => {});
              await page.waitForTimeout(400);
              await regionInput.click({ timeout: 8_000 });
              await page.waitForTimeout(1200);

              // 2) Klik opsi Singapore
              const optionSelectors = [
                'li:has-text("Singapore")',
                '[role="option"]:has-text("Singapore")',
                '.t-select-option:has-text("Singapore")',
                'ul.dropdown-section li:has-text("Singapore")',
                '.dropdown-section li:has-text("Singapore")',
                '[class*="option"]:has-text("Singapore")',
              ];
              let sgClicked = false;
              for (const sel of optionSelectors) {
                try {
                  const loc = page.locator(sel).first();
                  if ((await loc.count()) > 0) {
                    await loc.scrollIntoViewIfNeeded().catch(() => {});
                    await loc.click({ timeout: 5_000 });
                    sgClicked = true;
                    break;
                  }
                } catch {}
              }
              if (!sgClicked) {
                // DOM scan fallback
                sgClicked = await page.evaluate(() => {
                  const els = Array.from(
                    document.querySelectorAll(
                      "li, [role='option'], .t-select-option, div, span",
                    ),
                  );
                  for (const el of els) {
                    const txt = (el.textContent || "").trim();
                    if (/^singapore$/i.test(txt)) {
                      const r = el.getBoundingClientRect();
                      if (r.width > 0 && r.height > 0) {
                        el.click();
                        return true;
                      }
                    }
                  }
                  return false;
                });
              }
              console.log(
                `[codebuddy-bulk] ${account.email} region: Singapore clicked=${sgClicked}`,
              );
              if (!sgClicked) {
                await page.waitForTimeout(2000);
                continue;
              }
              await page.waitForTimeout(800);

              // 3) Klik submit — coba berbagai variant
              const submitSelectors = [
                'button:has-text("Get started")',
                'button:has-text("Get Started")',
                'button:has-text("Start")',
                'button:has-text("Submit")',
                'button:has-text("Continue")',
                'button:has-text("Confirm")',
                'button:has-text("OK")',
                'button:has-text("Ok")',
                ".page-region button.t-button--primary",
                ".page-region button:not([disabled])",
                "button.t-button--primary",
                'button[type="submit"]',
              ];
              let submitClicked = false;
              for (const sel of submitSelectors) {
                try {
                  const loc = page.locator(sel).first();
                  if ((await loc.count()) > 0) {
                    const disabled = await loc
                      .getAttribute("disabled")
                      .catch(() => null);
                    if (disabled !== null) continue;
                    await loc.click({ timeout: 5_000 });
                    submitClicked = true;
                    break;
                  }
                } catch {}
              }
              if (!submitClicked) {
                submitClicked = await page.evaluate(() => {
                  const btns = Array.from(
                    document.querySelectorAll("button, [role='button']"),
                  );
                  for (const b of btns) {
                    if (
                      b.disabled ||
                      b.getAttribute("aria-disabled") === "true"
                    )
                      continue;
                    const r = b.getBoundingClientRect();
                    if (r.width < 20 || r.height < 20) continue;
                    const t = (b.textContent || "").trim().toLowerCase();
                    if (
                      /get started|start|submit|continue|confirm|ok|next|\u786e\u5b9a|\u63d0\u4ea4/.test(
                        t,
                      )
                    ) {
                      b.click();
                      return true;
                    }
                  }
                  return false;
                });
              }
              console.log(
                `[codebuddy-bulk] ${account.email} region: submit clicked=${submitClicked}`,
              );

              // 4) Tunggu URL berubah keluar dari /register/user/complete
              const deadline = Date.now() + 15_000;
              while (Date.now() < deadline) {
                const u = page.url();
                if (
                  !u.includes("/register/user/complete") &&
                  !u.includes("/register/user/")
                ) {
                  regionHandled = true;
                  break;
                }
                await page.waitForTimeout(500);
              }
              if (regionHandled) {
                console.log(
                  `[codebuddy-bulk] ${account.email} region done, url=${page.url()}`,
                );
                await page.waitForTimeout(1500);
                break;
              }
            } catch (err) {
              console.log(
                `[codebuddy-bulk] ${account.email} region attempt ${i + 1} error: ${err?.message || err}`,
              );
            }
            await page.waitForTimeout(2000);
          }

          if (!regionHandled) {
            throw new Error(
              "Region selection failed after 10 attempts — /register/user/complete still active",
            );
          }
        } catch (regionErr) {
          console.log(
            `[codebuddy-bulk] ${account.email} region handler error: ${regionErr?.message || regionErr}`,
          );
          throw regionErr;
        }
      }

      // Step 3: Navigate to profile/keys page
      this.setAccountStep(account, "opening_keys", "Opening API keys page");
      await this.persistJobSnapshot(job, { forcePreview: true });
      _checkCancel();

      // Sniff auth headers the SPA sends to /api-keys. APISIX gateway
      // requires the same header set the SPA uses (often Authorization
      // Bearer from localStorage, or custom X-* headers). Attach listener
      // BEFORE navigation so we catch the SPA's own GET on mount.
      let sniffedHeaders = null;
      const sniffHandler = (req) => {
        try {
          const url = req.url();
          if (
            url.includes("/console/api/client/v1/api-keys") &&
            !sniffedHeaders
          ) {
            sniffedHeaders = req.headers();
          }
        } catch {}
      };
      page.on("request", sniffHandler);

      try {
        await page.goto("https://www.codebuddy.ai/profile/keys", {
          waitUntil: "domcontentloaded",
          timeout: 30_000,
        });
      } catch (e) {
        // SPA may redirect to /register/user/complete before
        // domcontentloaded — aborted navigation is expected.
        console.log(
          `[codebuddy-bulk] ${account.email} keys nav aborted: ${e?.message?.slice(0, 80)}`,
        );
      }
      _checkCancel();

      // Combined sniff + region guard: wait up to 15s for SPA to fire
      // its /api-keys request while ALSO monitoring URL. SPA guard may
      // redirect to /register/user/complete at any point during this
      // wait — if it does, handle region FIRST, then re-navigate.
      let guardUrl = page.url();
      console.log(`[codebuddy-bulk] ${account.email} pre-keys url=${guardUrl}`);

      const keysDeadline = Date.now() + 15_000;
      while (Date.now() < keysDeadline) {
        await page.waitForTimeout(500);
        guardUrl = page.url();

        if (guardUrl.includes("/register/user/complete")) {
          // SPA redirect ke region page — handle sekarang
          console.log(
            `[codebuddy-bulk] ${account.email} region page detected during wait — running mouse flow`,
          );
          this.setAccountStep(
            account,
            "completing_region",
            "Completing CodeBuddy region (guard)",
          );
          await this.persistJobSnapshot(job, { forcePreview: true });

          const ok = await handleRegionSelectionMouse(page, account.email);
          if (!ok) {
            throw new Error(
              "Region selection failed — /register/user/complete still active",
            );
          }
          // Re-navigate ke keys
          try {
            await page.goto("https://www.codebuddy.ai/profile/keys", {
              waitUntil: "domcontentloaded",
              timeout: 30_000,
            });
          } catch (e) {
            console.log(
              `[codebuddy-bulk] ${account.email} keys re-nav aborted: ${e?.message?.slice(0, 80)}`,
            );
          }
          await page.waitForTimeout(3000);

          guardUrl = page.url();
          if (guardUrl.includes("/register/user/complete")) {
            throw new Error(
              "Region still present after retry — backend rejected",
            );
          }
          console.log(
            `[codebuddy-bulk] ${account.email} region cleared, url=${guardUrl}`,
          );
          break;
        }

        // Stop early if headers already sniffed AND URL is stable at
        // a non-region page (/profile/keys or /home).
        if (
          sniffedHeaders &&
          (guardUrl.includes("/profile/keys") || guardUrl.includes("/home"))
        ) {
          break;
        }
      }
      page.off("request", sniffHandler);
      _checkCancel();

      // Capture session cookies
      const cookies = await context.cookies();
      const cbCookies = cookies
        .filter((c) => c.domain?.includes("codebuddy"))
        .map((c) => `${c.name}=${c.value}`)
        .join("; ");

      if (sniffedHeaders) {
        const preview = Object.keys(sniffedHeaders)
          .filter((k) => /auth|token|key|x-/i.test(k))
          .join(",");
        console.log(
          `[codebuddy-bulk] ${account.email} sniffed SPA headers: ${preview || "none"}`,
        );
      } else {
        console.warn(
          `[codebuddy-bulk] ${account.email} could not sniff SPA request — falling back to cookie-only auth`,
        );
      }

      // Step 4: Create API key via POST.
      // Bypass browser context (page.evaluate) — hindari risiko RCE +
      // execution-context-destroyed. Panggil endpoint langsung dari Node
      // pakai Playwright request context (share cookies + proxy dari
      // context yang sudah login) + sniffed SPA headers + bearer token
      // yang di-baca sekali dari localStorage.
      this.setAccountStep(account, "creating_key", "Creating API key");
      await this.persistJobSnapshot(job, { forcePreview: true });
      _checkCancel();

      // Baca bearer token dari localStorage/sessionStorage sekali saja
      // (read-only, no dynamic string eval — aman dari RCE).
      let storageToken = null;
      try {
        storageToken = await page.evaluate(() => {
          try {
            for (const store of [localStorage, sessionStorage]) {
              for (let i = 0; i < store.length; i++) {
                const k = store.key(i);
                const v = store.getItem(k);
                if (!v) continue;
                if (/^ey[A-Za-z0-9_-]+\./.test(v)) return v;
                if (v.startsWith("{")) {
                  try {
                    const j = JSON.parse(v);
                    const t =
                      j?.token ||
                      j?.access_token ||
                      j?.accessToken ||
                      j?.jwt ||
                      j?.data?.token ||
                      j?.data?.access_token ||
                      null;
                    if (t) return t;
                  } catch {}
                }
              }
            }
          } catch {}
          return null;
        });
      } catch {}

      const rand = () => Math.random().toString(36).slice(2, 10);
      const baseKeyName = `9r-${rand()}`;

      // Build header set dari sniff + fallback + bearer.
      const buildHeaders = () => {
        const headers = {
          Accept: "application/json, text/plain, */*",
          "Content-Type": "application/json",
          Origin: "https://www.codebuddy.ai",
          Referer: "https://www.codebuddy.ai/profile/keys",
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:120.0) Gecko/20100101 Firefox/120.0",
        };
        if (sniffedHeaders) {
          for (const [k, v] of Object.entries(sniffedHeaders)) {
            const lk = k.toLowerCase();
            if (
              lk === "host" ||
              lk === "content-length" ||
              lk === "connection" ||
              lk === "accept-encoding" ||
              lk.startsWith(":")
            )
              continue;
            headers[k] = v;
          }
        }
        if (storageToken && !headers.Authorization && !headers.authorization) {
          headers.Authorization = `Bearer ${storageToken}`;
        }
        return headers;
      };

      let createResult = null;
      let currentKeyName = baseKeyName;
      for (let keyAttempt = 0; keyAttempt < 4; keyAttempt++) {
        _checkCancel();
        try {
          const headers = buildHeaders();
          // context.request share cookies + proxy dari browser context.
          const resp = await context.request.post(
            "https://www.codebuddy.ai/console/api/client/v1/api-keys",
            {
              headers,
              data: {
                name: currentKeyName,
                expire_in_days: 365,
                user_enterprise_id: "personal-edition-user-id",
              },
              timeout: 20_000,
            },
          );
          const text = await resp.text();
          createResult = {
            status: resp.status(),
            text,
            usedAuth: !!(headers.Authorization || headers.authorization),
          };
          _checkCancel();

          // 12502 = name collision. Check raw text (JSON parse may fail
          // if SPA injects HTML instead of JSON into the response).
          if (createResult.status === 400 || createResult.status === 409) {
            const raw = createResult.text || "";
            if (/12502|name\s*exists/i.test(raw)) {
              console.warn(
                `[codebuddy-bulk] ${account.email} key "${currentKeyName}" exists, retry random...`,
              );
              currentKeyName = `9r-${rand()}`;
              await page
                .goto("https://www.codebuddy.ai/profile/keys", {
                  waitUntil: "domcontentloaded",
                  timeout: 30_000,
                })
                .catch(() => {});
              await page.waitForTimeout(2000);
              continue;
            }
          }
          // 401 = APISIX gateway auth failure. Re-navigate + re-sniff
          // headers + re-read bearer, lalu retry.
          if (createResult.status === 401) {
            console.warn(
              `[codebuddy-bulk] ${account.email} 401 from APISIX (usedAuth=${createResult.usedAuth}, attempt=${keyAttempt + 1}), refreshing session...`,
            );
            sniffedHeaders = null;
            const reSniff = (req) => {
              try {
                if (
                  req.url().includes("/console/api/client/v1/api-keys") &&
                  !sniffedHeaders
                ) {
                  sniffedHeaders = req.headers();
                }
              } catch {}
            };
            page.on("request", reSniff);
            await page
              .goto("https://www.codebuddy.ai/profile/keys", {
                waitUntil: "domcontentloaded",
                timeout: 30_000,
              })
              .catch(() => {});
            for (let i = 0; i < 16 && !sniffedHeaders; i++) {
              await page.waitForTimeout(500);
            }
            page.off("request", reSniff);
            // Re-baca bearer token (mungkin sudah rotate).
            try {
              storageToken = await page.evaluate(() => {
                try {
                  for (const store of [localStorage, sessionStorage]) {
                    for (let i = 0; i < store.length; i++) {
                      const k = store.key(i);
                      const v = store.getItem(k);
                      if (!v) continue;
                      if (/^ey[A-Za-z0-9_-]+\./.test(v)) return v;
                      if (v.startsWith("{")) {
                        try {
                          const j = JSON.parse(v);
                          const t =
                            j?.token ||
                            j?.access_token ||
                            j?.accessToken ||
                            j?.jwt ||
                            j?.data?.token ||
                            j?.data?.access_token ||
                            null;
                          if (t) return t;
                        } catch {}
                      }
                    }
                  }
                } catch {}
                return null;
              });
            } catch {}
            continue;
          }
          break;
        } catch (reqError) {
          if (reqError?.permanent) throw reqError;
          const msg = String(reqError.message || "");
          if (
            keyAttempt < 2 &&
            /timeout|network|econnreset|socket|abort/i.test(msg)
          ) {
            console.warn(
              `[codebuddy-bulk] ${account.email} request failed (${msg.slice(0, 80)}), retrying...`,
            );
            await page.waitForTimeout(1500);
            continue;
          }
          throw reqError;
        }
      }

      if (!createResult) {
        throw new Error("Failed to create API key — no response after retries");
      }

      if (createResult.status !== 200 && createResult.status !== 201) {
        throw new Error(
          `Create key failed: ${createResult.status} ${createResult.text}`,
        );
      }

      let apiKey = null;
      try {
        const keyData = JSON.parse(createResult.text);
        apiKey =
          keyData?.data?.key ||
          keyData?.data?.api_key ||
          keyData?.key ||
          keyData?.api_key ||
          null;
      } catch {
        const match = createResult.text.match(/sk-[a-zA-Z0-9]+/);
        apiKey = match ? match[0] : null;
      }

      if (!apiKey) {
        throw new Error(
          `Could not extract API key from response: ${createResult.text.slice(0, 200)}`,
        );
      }

      console.log(
        `[codebuddy-bulk] ${account.email} key created: ${apiKey.slice(0, 12)}...`,
      );

      // Step 5: Save connection
      this.setAccountStep(account, "saving_connection", "Saving connection");
      await this.persistJobSnapshot(job, { forcePreview: true });

      const { connection } = await this.saveConnection({
        apiKey,
        email: account.email,
        sessionCookies: cbCookies,
      });

      this.finalizeAccount(account, "success", {
        connectionId: connection.id,
        step: "connection_saved",
        message: "CodeBuddy API key saved successfully",
      });
      outcome = { status: "success" };
    } catch (error) {
      console.error(
        `[codebuddy-bulk] ERROR for ${account.email}:`,
        error.message,
        error.stack,
      );
      const isCancel = job.cancelRequested || error.message === "__CANCEL__";
      const isRetryable =
        !isCancel &&
        attempt < maxAttempts &&
        this._isRetryableProxyError(error);

      if (isRetryable) {
        // Jangan finalize — biarkan processAccount coba lagi dengan browser
        // fresh. Update step untuk visibility.
        this.setAccountStep(
          account,
          "proxy_error",
          `Proxy error: ${error.message?.slice(0, 100) || "refused"} (attempt ${attempt}/${maxAttempts})`,
        );
        outcome = { status: "retryable", error: error.message };
      } else {
        this.finalizeAccount(account, isCancel ? "cancelled" : "failed", {
          error: isCancel
            ? "Job cancelled"
            : error.message === "__CANCEL__"
              ? undefined
              : error.message || "CodeBuddy automation failed.",
          step: isCancel ? "cancelled" : "failed",
          message: isCancel
            ? "Job cancelled while processing this account"
            : error.message === "__CANCEL__"
              ? undefined
              : error.message || "CodeBuddy automation failed.",
        });
        outcome = { status: isCancel ? "cancelled" : "failed" };
      }
    } finally {
      account.runtimeSession = null;
      await browser.close().catch(() => null);
    }
    return outcome;
  }
}

function getSingletonStore() {
  if (!globalThis.__codebuddyIntlBulkImportSingleton) {
    globalThis.__codebuddyIntlBulkImportSingleton = {
      manager: new CodeBuddyIntlBulkImportManager(),
    };
  }
  return globalThis.__codebuddyIntlBulkImportSingleton;
}

export function getCodeBuddyIntlBulkImportManager() {
  return getSingletonStore().manager;
}

export { parseBulkAccounts, buildLookupResponse };

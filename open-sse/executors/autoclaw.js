import { randomUUID, createHash } from "crypto";
import { DefaultExecutor } from "./default.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";
import {
  getModelUpstreamId,
  PROVIDER_ID_TO_ALIAS,
} from "../config/providerModels.js";
import { PROVIDER_OAUTH } from "../providers/index.js";

/**
 * AutoClawExecutor — talks to AutoClaw's OpenAI-compatible LLM proxy.
 *
 * Contract quirks (see spec: re-atclaw.md):
 *  1. Model is selected by the `X-Request-Model` header, NOT the JSON body "model".
 *     The body field is ignored upstream — we keep it for 9router's own routing.
 *  2. DeepSeek-backed labels return 500 on `stream:false`, so we always force
 *     `stream:true` upstream; 9router re-aggregates SSE → JSON for non-streaming
 *     clients (handled by chatCore's non-streaming path).
 *  3. Auth uses `X-Authorization: Bearer <access_token>` (not the standard
 *     Authorization header).
 *  4. Each request carries a fresh `X-Request-Id` (uuid).
 */
export class AutoClawExecutor extends DefaultExecutor {
  constructor() {
    super("autoclaw");
  }

  transformRequest(model, body, stream, credentials) {
    const transformed = super.transformRequest(
      model,
      body,
      stream,
      credentials,
    );
    // Upstream MUST be stream (DeepSeek-backed labels 500 on stream:false).
    transformed.stream = true;
    return transformed;
  }

  buildHeaders(credentials, stream = true) {
    const headers = {
      "Content-Type": "application/json",
      ...(this.config.headers || {}),
    };

    // AutoClaw uses X-Authorization (not Authorization) for the LLM proxy.
    const token = credentials?.accessToken || credentials?.apiKey;
    if (token) {
      headers["X-Authorization"] = `Bearer ${token}`;
    }

    // X-Request-Id: fresh per request.
    headers["X-Request-Id"] = randomUUID();

    // X-Request-Model: the upstream model selector (body "model" is ignored).
    // Stashed by execute() before super.execute() calls buildHeaders.
    if (this._currentRequestModel) {
      headers["X-Request-Model"] = this._currentRequestModel;
    }

    if (stream) headers["Accept"] = "text/event-stream";
    return headers;
  }

  /**
   * Resolve the upstream model selector for the given client model id and stash
   * it so buildHeaders (called by super.execute) can set X-Request-Model.
   * Registry models[].upstreamModelId is the source of truth; fall back to the
   * raw model id (passthrough) when no mapping exists.
   */
  async execute(args) {
    const { model } = args;
    this._currentRequestModel = this.resolveUpstreamModel(model);
    try {
      return await super.execute(args);
    } finally {
      this._currentRequestModel = null;
    }
  }

  resolveUpstreamModel(model) {
    const alias = PROVIDER_ID_TO_ALIAS[this.provider] || this.provider;
    return getModelUpstreamId(alias, model) || model;
  }

  /**
   * AutoClaw refresh uses a custom endpoint with app-signing headers
   * (X-Auth-Appid / X-Auth-Sign = md5(appId&ts&appKey)), not standard OAuth.
   */
  async refreshCredentials(credentials, log, proxyOptions = null) {
    if (!credentials?.refreshToken) return null;
    const cfg = PROVIDER_OAUTH.autoclaw;
    if (!cfg?.refreshUrl || !cfg?.appId || !cfg?.appKey) return null;

    const ts = String(Math.floor(Date.now() / 1000));
    const sign = createHash("md5")
      .update(`${cfg.appId}&${ts}&${cfg.appKey}`)
      .digest("hex");
    const deviceId = credentials?.providerSpecificData?.deviceId || "";

    try {
      const res = await proxyAwareFetch(
        cfg.refreshUrl,
        {
          method: "POST",
          headers: {
            "X-Auth-Appid": cfg.appId,
            "X-Auth-TimeStamp": ts,
            "X-Auth-Sign": sign,
            "X-Product": "autoclaw",
            "X-Version": "1.11.0",
            "X-Tm": "win",
            "X-Trace-Id": randomUUID(),
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            refresh_token: credentials.refreshToken,
            device_id: deviceId,
          }),
        },
        proxyOptions,
      );

      if (!res.ok) {
        log?.error?.("TOKEN", `autoclaw refresh failed: ${res.status}`);
        return null;
      }

      const data = await res.json();
      let accessToken = data.access_token || "";
      let refreshToken = data.refresh_token || credentials.refreshToken;
      if (accessToken.startsWith("Bearer ")) accessToken = accessToken.slice(7);
      if (refreshToken.startsWith("Bearer "))
        refreshToken = refreshToken.slice(7);

      if (!accessToken) return null;

      log?.info?.("TOKEN", "autoclaw refreshed");
      return { accessToken, refreshToken };
    } catch (error) {
      log?.error?.("TOKEN", `autoclaw refresh error: ${error.message}`);
      return null;
    }
  }
}

export default AutoClawExecutor;

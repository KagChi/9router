/**
 * Qoder PAT (Personal Access Token, pt-...) → job token (jt-...) exchange.
 *
 * PATs cannot authenticate Qoder API calls directly — neither COSY-signed
 * inference requests nor the plain-Bearer openapi endpoints accept them
 * as-is. They must first be exchanged for a short-lived job token via
 * /api/v1/jobToken/exchange (plain JSON POST, NOT COSY-signed).
 *
 * Shared by the chat executor (open-sse/executors/qoder.js) and the quota
 * usage handler (open-sse/services/usage/misc.js) so both paths reuse the
 * same per-PAT cache instead of re-exchanging on every request.
 */

import { proxyAwareFetch } from "../../utils/proxyFetch.js";
import {
  QODER_JOB_TOKEN_EXCHANGE_URL,
  QODER_USERINFO_URL,
  QODER_IDE_VERSION,
  QODER_CLIENT_TYPE,
} from "./constants.js";

const PAT_PREFIX = "pt-";
const PAT_REFRESH_BUFFER_MS = 5 * 60 * 1000;

/** @type {Map<string, { accessToken: string, userId: string, expiresAt: number }>} */
const patJobCache = new Map();

/**
 * True when the token looks like a Qoder Personal Access Token (pt-...).
 * Device tokens (dt-...) and job tokens (jt-...) return false.
 */
export function isQoderPat(token) {
  return typeof token === "string" && token.startsWith(PAT_PREFIX);
}

/**
 * Normalize a user-supplied PAT: the dashboard accepts keys with or without
 * the `pt-` prefix (see providers/[id]/test testUtils), so re-attach it when
 * missing before hitting the exchange endpoint.
 */
export function normalizeQoderPat(token) {
  const raw = typeof token === "string" ? token.trim() : "";
  if (!raw) return "";
  return raw.startsWith(PAT_PREFIX) ? raw : `${PAT_PREFIX}${raw}`;
}

async function exchangeJobToken(pat, proxyOptions = null, signal = null) {
  const res = await proxyAwareFetch(
    QODER_JOB_TOKEN_EXCHANGE_URL,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": "qodercli/1.0.0",
        "Cosy-Version": QODER_IDE_VERSION,
        "Cosy-ClientType": QODER_CLIENT_TYPE,
      },
      body: JSON.stringify({ personal_token: pat }),
      signal,
    },
    proxyOptions,
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`qoder PAT exchange failed: ${res.status} ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  if (!data.token) throw new Error("qoder PAT exchange returned no job token");

  let expiresAt = Date.now() + 24 * 60 * 60 * 1000;
  if (data.expires_at) {
    const parsed = Date.parse(data.expires_at);
    if (!Number.isNaN(parsed)) expiresAt = parsed;
  } else if (typeof data.expires_in === "number" && data.expires_in > 0) {
    expiresAt = Date.now() + data.expires_in;
  }
  return { jobToken: data.token, jobRefreshToken: data.refresh_token || "", expiresAt };
}

async function fetchUserIdForJobToken(jobToken, proxyOptions = null, signal = null) {
  try {
    const res = await proxyAwareFetch(
      QODER_USERINFO_URL,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${jobToken}`,
          Accept: "application/json",
          "User-Agent": "qodercli/1.0.0",
        },
        signal,
      },
      proxyOptions,
    );
    if (!res.ok) return "";
    const info = await res.json().catch(() => ({}));
    return info.id || info.userId || info.user_id || "";
  } catch {
    return "";
  }
}

/**
 * Exchange a PAT for a job token + userId, caching until near-expiry so
 * repeat calls (chat requests, quota refreshes) don't re-exchange.
 * Returns { accessToken, userId, expiresAt } where accessToken is the jt-.
 */
export async function resolveQoderPatCredential(pat, proxyOptions = null, signal = null) {
  const normalized = normalizeQoderPat(pat);
  const cached = patJobCache.get(normalized);
  if (cached && cached.expiresAt - Date.now() > PAT_REFRESH_BUFFER_MS) {
    return cached;
  }
  const { jobToken, expiresAt } = await exchangeJobToken(normalized, proxyOptions, signal);
  const userId = await fetchUserIdForJobToken(jobToken, proxyOptions, signal);
  const entry = { accessToken: jobToken, userId, expiresAt };
  patJobCache.set(normalized, entry);
  return entry;
}

/** Test hook — drop all cached PAT→job-token entries. */
export function clearQoderPatCache() {
  patJobCache.clear();
}

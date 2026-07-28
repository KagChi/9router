/**
 * CodeBuddy (international) usage handler
 *
 * Mirrors codebuddy-cn but scoped to the "codebuddy" provider (international edition).
 * Quota lives behind the same billing endpoint shape (POST, payload wrapped twice
 * under data.Response.Data). It mixes two credit types that must NOT be merged:
 *
 *  - Refill / base: a recurring allowance whose cycle resets long before the
 *    resource itself expires (CycleEndTime << DeductionEndTime).
 *  - Bonus: one-shot credits that run a single cycle and then expire for good.
 */

import { proxyAwareFetch } from "../../utils/proxyFetch.js";
import { PROVIDERS } from "../../providers/index.js";
import { U, parseResetTime } from "./shared.js";

const PROVIDER_ID = "codebuddy";

function num(precise, plain) {
  const n = Number(precise ?? plain);
  return Number.isFinite(n) ? n : 0;
}

function refillCadence(acc) {
  const start = parseResetTime(acc.CycleStartTime);
  const end = parseResetTime(acc.CycleEndTime);
  if (start && end) {
    const days = (new Date(end).getTime() - new Date(start).getTime()) / 86400000;
    if (days <= 1.5) return "Daily";
    if (days <= 10) return "Weekly";
  }
  return "Monthly";
}

export async function getCodeBuddyUsage(accessToken, apiKey, providerSpecificData, proxyOptions = null) {
  const token = accessToken || apiKey;
  if (!token) {
    return { message: "CodeBuddy credential not available." };
  }

  try {
    const response = await proxyAwareFetch(U(PROVIDER_ID).url, {
      method: "POST",
      headers: {
        ...(PROVIDERS[PROVIDER_ID]?.headers || {}),
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: "{}",
    }, proxyOptions);

    if (response.status === 401 || response.status === 403) {
      return { message: "CodeBuddy credential invalid or expired." };
    }
    if (!response.ok) {
      return { message: `CodeBuddy quota API error (${response.status}).` };
    }

    const json = await response.json();
    if (json?.code !== 0) {
      return { message: `CodeBuddy quota error: ${json?.msg || "unknown"}` };
    }

    const data = json?.data?.Response?.Data || {};
    const accounts = Array.isArray(data.Accounts) ? data.Accounts : [];
    if (accounts.length === 0) {
      return { message: "CodeBuddy connected. No credit package found." };
    }

    const cycleEndMs = (acc) => {
      const r = parseResetTime(acc.CycleEndTime);
      return r ? new Date(r).getTime() : Number.POSITIVE_INFINITY;
    };
    const REFILL_GAP_MS = 2 * 24 * 60 * 60 * 1000;
    const isRefill = (acc) => {
      const ce = cycleEndMs(acc);
      const de = Number(acc.DeductionEndTime);
      return Number.isFinite(ce) && Number.isFinite(de) && de - ce > REFILL_GAP_MS;
    };
    const byExpiry = (a, b) => cycleEndMs(a) - cycleEndMs(b);

    const refills = accounts.filter(isRefill).sort(byExpiry);
    const bonuses = accounts.filter((a) => !isRefill(a)).sort(byExpiry);

    const quotas = {};
    const seenRefill = {};
    refills.forEach((acc) => {
      const base = refillCadence(acc);
      seenRefill[base] = (seenRefill[base] || 0) + 1;
      const name = seenRefill[base] > 1 ? `${base} ${seenRefill[base]}` : base;
      quotas[name] = {
        used: num(acc.CycleCapacityUsedPrecise, acc.CycleCapacityUsed),
        total: num(acc.CycleCapacitySizePrecise, acc.CycleCapacitySize),
        resetAt: parseResetTime(acc.CycleEndTime),
        unlimited: false,
        recurring: true,
      };
    });
    bonuses.forEach((acc, i) => {
      quotas[`Bonus Pack ${i + 1}`] = {
        used: num(acc.CapacityUsedPrecise, acc.CapacityUsed),
        total: num(acc.CapacitySizePrecise, acc.CapacitySize),
        resetAt: parseResetTime(acc.CycleEndTime),
        unlimited: false,
        recurring: false,
      };
    });

    const basePkg = refills[0] || accounts[0] || {};
    const plan = basePkg.PackageName || basePkg.SubProductName || "CodeBuddy";

    return { plan, quotas };
  } catch (error) {
    return { message: `CodeBuddy error: ${error.message}` };
  }
}

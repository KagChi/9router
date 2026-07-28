"use client";

import { useState, useEffect } from "react";
import { Card, Button, Input, Modal } from "@/shared/components";

function fmt(n) {
  return (Number(n) || 0).toLocaleString();
}

const WINDOW_LABEL = { total: "Total (lifetime)", daily: "Daily", monthly: "Monthly" };

const PERIODS = [
  { value: "", label: "As configured" },
  { value: "today", label: "Today" },
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
  { value: "all", label: "All time" },
];

const SORTS = [
  { value: "tokens", label: "Tokens" },
  { value: "requests", label: "Requests" },
  { value: "name", label: "Name" },
];

function maskKey(k) {
  if (!k) return "";
  if (k.length <= 12) return k;
  return `${k.slice(0, 8)}…${k.slice(-4)}`;
}

export default function UsageCheckPage() {
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [data, setData] = useState(null);
  const [lastName, setLastName] = useState("");
  const [period, setPeriod] = useState("");
  const [origin, setOrigin] = useState("");

  useEffect(() => {
    try { setOrigin(window.location.origin); } catch {}
    // Restore a previous session (survives refresh, cleared on tab close / New lookup).
    try {
      const savedName = sessionStorage.getItem("9r_usage_name");
      const savedPwd = sessionStorage.getItem("9r_usage_pwd");
      const savedPeriod = sessionStorage.getItem("9r_usage_period") || "";
      if (savedName && savedPwd) {
        setName(savedName);
        setPassword(savedPwd);
        setPeriod(savedPeriod);
        runLookup(savedName, savedPeriod, savedPwd);
      }
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const runLookup = async (q, p, pwd) => {
    if (!q) return;
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/public/key-usage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: q, password: pwd, period: p || undefined }),
      });
      const json = await res.json();
      if (res.ok) {
        setData(json);
        setLastName(q);
        // Persist session so a refresh keeps the user in the detail view.
        try {
          sessionStorage.setItem("9r_usage_name", q);
          sessionStorage.setItem("9r_usage_pwd", pwd);
          sessionStorage.setItem("9r_usage_period", p || "");
        } catch {}
      } else {
        setError(json.error || "Lookup failed");
        setData(null);
        if (res.status === 401 || res.status === 403) {
          try {
            sessionStorage.removeItem("9r_usage_name");
            sessionStorage.removeItem("9r_usage_pwd");
            sessionStorage.removeItem("9r_usage_period");
          } catch {}
        }
      }
    } catch {
      setError("An error occurred. Please try again.");
      setData(null);
    } finally {
      setLoading(false);
    }
  };

  const onSubmit = (e) => {
    e?.preventDefault();
    const q = name.trim();
    if (!q || !password) return;
    runLookup(q, period, password);
  };

  const onPeriodChange = (p) => {
    setPeriod(p);
    try { sessionStorage.setItem("9r_usage_period", p || ""); } catch {}
    if (lastName) runLookup(lastName, p, password);
  };

  const resetLookup = () => {
    setData(null);
    setError("");
    setName("");
    setPassword("");
    setPeriod("");
    try {
      sessionStorage.removeItem("9r_usage_name");
      sessionStorage.removeItem("9r_usage_pwd");
      sessionStorage.removeItem("9r_usage_period");
    } catch {}
  };

  // Once a successful lookup with results is in, hide the form and show detail.
  const inDetail = data && data.count > 0;

  return (
    <div className="min-h-screen flex items-start justify-center bg-bg p-4 relative overflow-hidden">
      <div className="landing-grid absolute inset-0 pointer-events-none" aria-hidden="true" />
      <div className="relative z-10 w-full max-w-2xl mt-12">
        {!inDetail ? (
          <>
            <div className="text-center mb-8">
              <h1 className="text-3xl font-bold text-primary mb-2">Token Usage</h1>
              <p className="text-text-muted">Enter an API key name and the lookup password to view usage.</p>
            </div>
            <Card>
              <form onSubmit={onSubmit} className="flex flex-col gap-3">
                <Input
                  placeholder="API key name, e.g. yudha"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  autoFocus
                />
                <div className="flex gap-2">
                  <Input
                    type="password"
                    placeholder="Lookup password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="flex-1"
                  />
                  <Button type="submit" variant="primary" loading={loading} disabled={!name.trim() || !password}>
                    Check
                  </Button>
                </div>
                {error && <p className="text-xs text-red-500">{error}</p>}
              </form>
            </Card>

            {data && data.count === 0 && (
              <Card className="mt-4">
                <p className="text-sm text-text-muted text-center">
                  No API key found with the name &quot;{data.name}&quot;.
                </p>
              </Card>
            )}
          </>
        ) : (
          <>
            {/* Detail header */}
            <div className="flex items-center justify-between mb-5">
              <div>
                <h1 className="text-2xl font-bold text-primary">{data.name}</h1>
                <p className="text-xs text-text-muted">{data.count} key(s) found</p>
              </div>
              <Button variant="ghost" size="sm" icon="search" onClick={resetLookup}>
                New lookup
              </Button>
            </div>

            {/* Period filter */}
            <div className="flex flex-col gap-1.5 mb-4">
              <label className="text-xs font-medium text-text-muted">Period</label>
              <div className="flex flex-wrap gap-1.5">
                {PERIODS.map((p) => (
                  <button
                    key={p.value}
                    onClick={() => onPeriodChange(p.value)}
                    className={`text-xs px-2.5 py-1.5 rounded-full border transition-colors ${
                      period === p.value
                        ? "bg-brand-500 text-white border-brand-500"
                        : "border-border text-text-muted hover:text-text-main"
                    }`}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex flex-col gap-3">
              {data.results.map((r, i) => (
                <KeyCard key={i} r={r} origin={origin} period={period} aliases={data.aliases || {}} excludedProviders={data.excludedProviders || []} />
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function copyText(value) {
  // navigator.clipboard only works in secure contexts (HTTPS/localhost).
  // Fall back to a temporary textarea + execCommand for plain HTTP access.
  try {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(value);
    }
  } catch {}
  try {
    const ta = document.createElement("textarea");
    ta.value = value;
    ta.style.position = "fixed";
    ta.style.top = "-9999px";
    ta.setAttribute("readonly", "");
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
    return Promise.resolve();
  } catch (e) {
    return Promise.reject(e);
  }
}

function CopyBtn({ value, title = "Copy" }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await copyText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  };
  return (
    <button onClick={copy} className="p-1 rounded text-text-muted hover:text-primary" title={title} type="button">
      <span className="material-symbols-outlined text-[15px]">{copied ? "check" : "content_copy"}</span>
    </button>
  );
}

function Stat({ label, value, danger }) {
  return (
    <div className="bg-surface-2 rounded-[10px] px-3 py-2">
      <p className="text-[11px] text-text-muted">{label}</p>
      <p className={`text-sm font-semibold ${danger ? "text-red-500" : ""}`}>{value}</p>
    </div>
  );
}

function CodeBlock({ code, label }) {
  return (
    <div className="relative">
      {label && <p className="text-[11px] text-text-muted mb-1">{label}</p>}
      <div className="relative bg-bg border border-border-subtle rounded-lg">
        <pre className="text-[11px] leading-relaxed p-3 pr-9 overflow-x-auto"><code>{code}</code></pre>
        <div className="absolute top-1.5 right-1.5">
          <CopyBtn value={code} title="Copy" />
        </div>
      </div>
    </div>
  );
}

function KeyCard({ r, origin, period, aliases = {}, excludedProviders = [] }) {
  const [showKey, setShowKey] = useState(false);
  const [availModels, setAvailModels] = useState(null); // null = loading
  const [showModelsModal, setShowModelsModal] = useState(false);
  const [availFilter, setAvailFilter] = useState("");
  const [modelFilter, setModelFilter] = useState("");
  const [sortBy, setSortBy] = useState("tokens");
  const [showDocs, setShowDocs] = useState(false);

  const v1Url = origin ? `${origin}/v1` : "/v1";
  const restricted = Array.isArray(r.allowedModels) && r.allowedModels.length > 0;

  // Reverse map: target model → [alias names]. Keyed by both the full target
  // string and the bare model id (after the first "/") to tolerate prefix
  // differences (e.g. alias target "mm/mimo-v2.5" vs listed "mm/mimo-v2.5").
  const bareId = (s) => {
    const str = String(s);
    const i = str.indexOf("/");
    return i >= 0 ? str.slice(i + 1) : str;
  };
  const aliasesByTarget = (() => {
    const map = {};
    for (const [aliasName, target] of Object.entries(aliases || {})) {
      const t = String(target);
      (map[t] ||= []).push(aliasName);
      const b = bareId(t);
      if (b !== t) (map[`bare:${b}`] ||= []).push(aliasName);
    }
    return map;
  })();
  const aliasesFor = (m) => {
    const set = new Set([...(aliasesByTarget[m] || []), ...(aliasesByTarget[`bare:${bareId(m)}`] || [])]);
    return [...set];
  };

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (restricted) {
        setAvailModels(r.allowedModels);
        return;
      }
      if (!r.key) { setAvailModels([]); return; }
      try {
        const res = await fetch(`${origin}/v1/models`, { headers: { Authorization: `Bearer ${r.key}` } });
        const json = await res.json();
        const list = (json?.data || json?.models || []).map((m) => m.id || m.name).filter(Boolean);
        if (!cancelled) setAvailModels(list);
      } catch {
        if (!cancelled) setAvailModels([]);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [r, origin, restricted]);

  const breakdownTotal = period && period !== "" ? r.usedPeriod : (r.usedWindowActual ?? r.usedWindow);
  const rangeLabel = r.period
    ? PERIODS.find((p) => p.value === r.period)?.label || r.period
    : WINDOW_LABEL[r.limitWindow] || r.limitWindow;

  const models = (() => {
    const filtered = (r.models || []).filter((m) => {
      const q = modelFilter.toLowerCase();
      return !q || m.model.toLowerCase().includes(q) || (m.provider || "").toLowerCase().includes(q);
    });
    const sorted = [...filtered];
    if (sortBy === "tokens") sorted.sort((a, b) => b.totalTokens - a.totalTokens);
    else if (sortBy === "requests") sorted.sort((a, b) => b.requests - a.requests);
    else sorted.sort((a, b) => a.model.localeCompare(b.model));
    return sorted;
  })();

  const filteredAvail = (availModels || []).filter((m) => {
    if (!availFilter) return true;
    const q = availFilter.toLowerCase();
    if (m.toLowerCase().includes(q)) return true;
    return aliasesFor(m).some((a) => a.toLowerCase().includes(q));
  });

  // Sample model for the curl docs: first allowed/available, else a generic placeholder.
  const docModel =
    (restricted && r.allowedModels[0]) ||
    (Array.isArray(availModels) && availModels[0]) ||
    "cc/claude-opus-4.7";

  // Flatten to callable names: if a model has alias(es), show the alias(es)
  // instead of the raw model id (the alias is what clients should call).
  const availEntries = (() => {
    const out = [];
    for (const m of filteredAvail) {
      const al = aliasesFor(m);
      if (al.length > 0) {
        for (const a of al) out.push({ display: a, model: m, isAlias: true });
      } else {
        out.push({ display: m, model: m, isAlias: false });
      }
    }
    return out;
  })();
  const copyAllValue = availEntries.map((e) => e.display).join("\n");

  return (
    <Card>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">{r.name}</span>
          {!r.isActive && (
            <span className="text-xs text-orange-500 border border-orange-500/40 rounded px-1.5 py-0.5">Paused</span>
          )}
        </div>
        {r.tokenLimit > 0 && r.exceeded && (
          <span className="text-xs text-red-500 font-medium">Limit reached</span>
        )}
      </div>

      {/* Connection info */}
      <div className="flex flex-col gap-2 mb-4">
        <div className="flex items-center gap-2 bg-surface-2 rounded-[10px] px-3 py-2">
          <span className="text-[11px] text-text-muted w-16 shrink-0">Base URL</span>
          <code className="text-xs flex-1 truncate">{v1Url}</code>
          <CopyBtn value={v1Url} title="Copy URL" />
        </div>
        {r.key && (
          <div className="flex items-center gap-2 bg-surface-2 rounded-[10px] px-3 py-2">
            <span className="text-[11px] text-text-muted w-16 shrink-0">API key</span>
            <code className="text-xs flex-1 truncate font-mono">{showKey ? r.key : maskKey(r.key)}</code>
            <button onClick={() => setShowKey((s) => !s)} className="p-1 rounded text-text-muted hover:text-primary" title={showKey ? "Hide" : "Show"} type="button">
              <span className="material-symbols-outlined text-[15px]">{showKey ? "visibility_off" : "visibility"}</span>
            </button>
            <CopyBtn value={r.key} title="Copy API key" />
          </div>
        )}
        <button
          type="button"
          onClick={() => setShowModelsModal(true)}
          className="flex items-center justify-between gap-2 bg-surface-2 rounded-[10px] px-3 py-2 hover:border-brand-500/30 border border-transparent transition-all"
        >
          <span className="text-[11px] text-text-muted">Available models</span>
          <span className="flex items-center gap-1 text-xs text-text-main">
            {availModels === null ? "…" : `${availEntries.length}${restricted ? " (restricted)" : ""}`}
            <span className="material-symbols-outlined text-[16px] text-text-muted">chevron_right</span>
          </span>
        </button>
      </div>

      {/* Summary */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3">
        <Stat label={`Used (${rangeLabel})`} value={fmt(breakdownTotal)} />
        <Stat label="Limit" value={r.tokenLimit > 0 ? fmt(r.tokenLimit) : "—"} danger={r.tokenLimit > 0 && r.exceeded} />
        <Stat label="Remaining" value={r.tokenLimit > 0 ? fmt(r.remaining) : "—"} />
        <Stat label="All-time" value={fmt(r.usedTotal)} />
      </div>

      {(r.tokenLimit > 0 || excludedProviders.length > 0) && (
        <div className="mb-3 text-xs">
          {r.tokenLimit > 0 && (
            <p className={r.exceeded ? "text-red-500" : "text-text-main"}>
              <span className="material-symbols-outlined text-[13px] align-middle">savings</span>{" "}
              {r.exceeded ? "No tokens remaining" : <>{fmt(r.remaining)} tokens remaining</>} ({rangeLabel})
            </p>
          )}
          {excludedProviders.length > 0 && (
            <p className="text-text-muted mt-0.5">
              Not counted (excluded): {excludedProviders.map((e) => (typeof e === "string" ? e : e.name)).join(", ")}
            </p>
          )}
        </div>
      )}

      {/* API usage docs / examples */}
      <div className="border-t border-black/[0.06] dark:border-white/[0.06] pt-3 mb-3">
        <button
          type="button"
          onClick={() => setShowDocs((s) => !s)}
          className="w-full flex items-center justify-between text-xs font-medium text-text-muted hover:text-text-main"
        >
          <span className="flex items-center gap-1">
            <span className="material-symbols-outlined text-[15px]">terminal</span>
            API usage example (curl)
          </span>
          <span className="material-symbols-outlined text-[18px]">{showDocs ? "expand_less" : "expand_more"}</span>
        </button>
        {showDocs && (
          <div className="mt-2 flex flex-col gap-3">
            <CodeBlock
              label="Chat completion"
              code={`curl ${v1Url}/chat/completions \\
  -H "Authorization: Bearer ${r.key || "YOUR_API_KEY"}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "${docModel}",
    "messages": [{ "role": "user", "content": "Hello!" }]
  }'`}
            />
            <CodeBlock
              label="List available models"
              code={`curl ${v1Url}/models \\
  -H "Authorization: Bearer ${r.key || "YOUR_API_KEY"}"`}
            />
            <p className="text-[11px] text-text-muted">
              Base URL: <code>{v1Url}</code>{r.key ? <> · API key: <code>{maskKey(r.key)}</code></> : null}
              {restricted ? " · This key is restricted to its allowed models." : ""}
            </p>
          </div>
        )}
      </div>

      {/* Per-model usage breakdown */}
      <div className="border-t border-black/[0.06] dark:border-white/[0.06] pt-3">
        <div className="flex items-center justify-between mb-2">
          <p className="text-xs font-medium text-text-muted">Models used ({rangeLabel})</p>
          <div className="flex items-center gap-1.5">
            {SORTS.map((s) => (
              <button
                key={s.value}
                onClick={() => setSortBy(s.value)}
                className={`text-[11px] px-2 py-1 rounded-full border transition-colors ${
                  sortBy === s.value ? "bg-surface-2 text-text-main border-border" : "border-transparent text-text-muted hover:text-text-main"
                }`}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>
        <Input placeholder="Filter used models..." value={modelFilter} onChange={(e) => setModelFilter(e.target.value)} icon="filter_list" inputClassName="text-xs" />
        {models.length === 0 ? (
          <p className="text-xs text-text-muted py-2 mt-2">No usage recorded in this range.</p>
        ) : (
          <div className="mt-2 max-h-80 overflow-y-auto rounded-lg border border-border-subtle">
            <table className="w-full border-collapse text-xs">
              <thead className="sticky top-0 bg-surface-2 z-10">
                <tr className="border-b border-border-subtle text-text-muted">
                  <th className="py-2 px-3 text-left font-semibold">Model</th>
                  <th className="py-2 px-2 text-right font-semibold">In</th>
                  <th className="py-2 px-2 text-right font-semibold">Out</th>
                  <th className="py-2 px-2 text-right font-semibold">Total</th>
                  <th className="py-2 px-2 text-right font-semibold">Req</th>
                </tr>
              </thead>
              <tbody>
                {models.map((m, j) => (
                  <tr key={j} className="border-b border-border-subtle/60 last:border-0">
                    <td className="py-2 px-3">
                      <div className="font-medium truncate max-w-[200px]">{m.model}</div>
                      {m.provider && <div className="text-[11px] text-text-muted truncate">{m.provider}</div>}
                    </td>
                    <td className="py-2 px-2 text-right text-text-muted tabular-nums">{fmt(m.promptTokens)}</td>
                    <td className="py-2 px-2 text-right text-text-muted tabular-nums">{fmt(m.completionTokens)}</td>
                    <td className="py-2 px-2 text-right font-medium tabular-nums">{fmt(m.totalTokens)}</td>
                    <td className="py-2 px-2 text-right text-text-muted tabular-nums">{fmt(m.requests)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Available models dialog */}
      <Modal
        isOpen={showModelsModal}
        title={`Available models${restricted ? " (restricted)" : ""} · ${r.name}`}
        onClose={() => setShowModelsModal(false)}
      >
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <Input
              placeholder="Filter models..."
              value={availFilter}
              onChange={(e) => setAvailFilter(e.target.value)}
              icon="search"
              className="flex-1"
            />
            {availEntries.length > 0 && (
              <Button size="sm" variant="ghost" icon="content_copy" onClick={() => copyText(copyAllValue)}>
                Copy all
              </Button>
            )}
          </div>
          {availModels === null ? (
            <p className="text-sm text-text-muted py-4 text-center">Loading models…</p>
          ) : availEntries.length === 0 ? (
            <p className="text-sm text-text-muted py-4 text-center">No models{availFilter ? " match the filter" : " available"}.</p>
          ) : (
            <div className="max-h-[55vh] overflow-y-auto flex flex-col gap-1">
              {availEntries.map((e, idx) => (
                <div key={`${e.display}-${idx}`} className="flex items-start gap-2 px-2 py-1.5 rounded hover:bg-black/5 dark:hover:bg-white/5">
                  <div className="flex-1 min-w-0">
                    <code className="text-xs block truncate">{e.display}</code>
                    {e.isAlias && (
                      <div className="text-[10px] text-text-muted truncate">model: {e.model}</div>
                    )}
                  </div>
                  <CopyBtn value={e.display} title="Copy model" />
                </div>
              ))}
            </div>
          )}
          <p className="text-[11px] text-text-muted">{availEntries.length} model(s)</p>
        </div>
      </Modal>
    </Card>
  );
}

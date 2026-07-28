export default {
  id: "codebuddy",
  // Short model prefix (cbai). "cbai" = CodeBuddy AI (international);
  // the full id "codebuddy" still resolves. Sibling of "codebuddy-cn" (China).
  // Global edition uses www.codebuddy.ai as base; CN uses copilot.tencent.com.
  alias: "cbai",
  uiAlias: "cbai",
  hidden: false,
  priority: 91,
  display: {
    name: "CodeBuddy",
    icon: "smart_toy",
    color: "#006EFF",
    website: "https://www.codebuddy.ai",
    notice: {
      signupUrl: "https://www.codebuddy.ai/profile/keys",
    },
  },
  category: "apikey",
  authModes: ["apikey"],
  hasOAuth: false,
  transport: {
    baseUrl: "https://www.codebuddy.ai/v2/chat/completions",
    forceStream: true,
    thinkingFormat: "openai",
    headers: {
      "User-Agent": "CLI/2.52.0 CodeBuddy/2.52.0",
      "X-Product": "SaaS",
      "X-IDE-Type": "CLI",
      "X-IDE-Name": "CLI",
      "X-IDE-Version": "2.52.0",
      "X-Agent-Intent": "craft",
      "x-requested-with": "XMLHttpRequest",
      "X-Domain": "www.codebuddy.ai",
    },
    auth: {
      combined: true,
      header: "Authorization",
      scheme: "bearer",
    },
    // Quota endpoint differs from the chat gateway: POST returns nested billing
    // payload (data.Response.Data.Accounts[]). See services/usage/codebuddy.js.
    usage: {
      url: "https://www.codebuddy.ai/v2/billing/meter/get-user-resource",
    },
  },
  models: [
    { id: "gemini-3.1-pro", name: "Gemini 3.1 Pro" },
    { id: "gemini-3.1-flash-lite", name: "Gemini 3.1 Flash Lite" },
    { id: "gemini-3.0-flash", name: "Gemini 3.0 Flash" },
    { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro" },
    { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash" },
    { id: "gpt-5.5", name: "GPT-5.5" },
    { id: "gpt-5.4", name: "GPT-5.4" },
    { id: "gpt-5.2", name: "GPT-5.2" },
    { id: "gpt-5.3-codex", name: "GPT-5.3 Codex" },
    { id: "gpt-5.2-codex", name: "GPT-5.2 Codex" },
    { id: "gpt-5.1", name: "GPT-5.1" },
    { id: "gpt-5.1-codex", name: "GPT-5.1 Codex" },
    { id: "gpt-5.1-codex-max", name: "GPT-5.1 Codex Max" },
    { id: "gpt-5.1-codex-mini", name: "GPT-5.1 Codex Mini" },
    { id: "deepseek-v3-2-volc", name: "DeepSeek V3.2" },
    { id: "claude-opus-4.6", name: "Claude Opus 4.6" },
    { id: "claude-opus-4.7-1m", name: "Claude Opus 4.7 (1M)" },
    { id: "kimi-k2.5", name: "Kimi K2.5" },
  ],
  oauth: {
    baseUrl: "https://www.codebuddy.ai",
    stateUrl: "https://www.codebuddy.ai/v2/plugin/auth/state",
    tokenUrl: "https://www.codebuddy.ai/v2/plugin/auth/token",
    refreshUrl: "https://www.codebuddy.ai/v2/plugin/auth/token/refresh",
    userAgent: "CLI/2.52.0 CodeBuddy/2.52.0",
    platform: "CLI",
    pollInterval: 5000,
  },
  features: {
    usage: true,
    usageApikey: true,
  },
};

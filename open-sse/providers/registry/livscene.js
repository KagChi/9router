// Livscene — unified AI API platform (OpenAI-compatible).
// Multi-model proxy: Claude, GPT, Gemini, etc. through one endpoint.
// Auth: API key (sk-...) obtained via Google sign-up automation.
// Base URL: https://ai.livscene.com/v1
const livsceneProvider = {
  id: "livscene",
  alias: "livscene",
  priority: 50,
  display: {
    name: "Livscene",
    icon: "livscene",
    color: "#8B5CF6",
    textIcon: "LV",
    website: "https://ai.livscene.com",
    notice: {
      signupUrl: "https://ai.livscene.com/sign-up?aff=Km2H",
      text: "API key created automatically via bulk Google sign-up automation.",
      apiKeyUrl: "https://ai.livscene.com/keys",
    },
  },
  category: "apikey",
  hasOAuth: false,
  authModes: ["apikey"],
  transport: {
    baseUrl: "https://ai.livscene.com/v1/chat/completions",
    format: "openai",
    // Livscene returns non-streaming JSON by default — force stream:true
    // in the upstream request so the proxy receives SSE chunks.
    forceStream: true,
    headers: {
      "Content-Type": "application/json",
    },
  },
  // Fetch model list dynamically from /v1/models — livscene catalog changes
  // frequently (new models added, old ones retired).
  modelsFetcher: {
    url: "https://ai.livscene.com/v1/models",
    // Response shape: { data: [{ id: "model-id" }, ...] } (OpenAI-compatible)
    path: "data",
    labelKey: "id",
    idKey: "id",
  },
  // Static fallback models (used before first fetch or if fetch fails).
  models: [
    { id: "claude-opus-4-6", name: "Claude Opus 4.6" },
    { id: "claude-opus-4-7", name: "Claude Opus 4.7" },
    { id: "claude-opus-4-8", name: "Claude Opus 4.8" },
    { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
    { id: "codex-auto-review", name: "Codex Auto Review" },
    { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash" },
    { id: "DeepSeek-V4-Pro", name: "DeepSeek V4 Pro" },
    { id: "gemini-3.1-pro-preview", name: "Gemini 3.1 Pro Preview" },
    { id: "gemini-3.5-flash", name: "Gemini 3.5 Flash" },
    { id: "glm-4.7", name: "GLM 4.7" },
    { id: "glm-5.1", name: "GLM 5.1" },
    { id: "GLM-5.2", name: "GLM 5.2" },
    {
      id: "gpt-5.3-codex-openai-compact",
      name: "GPT 5.3 Codex OpenAI Compact",
    },
    { id: "gpt-5.3-codex-spark", name: "GPT 5.3 Codex Spark" },
    { id: "gpt-5.4", name: "GPT 5.4" },
    { id: "gpt-5.4-mini", name: "GPT 5.4 Mini" },
    { id: "gpt-5.4-openai-compact", name: "GPT 5.4 OpenAI Compact" },
    { id: "gpt-5.5", name: "GPT 5.5" },
    { id: "gpt-5.5-openai-compact", name: "GPT 5.5 OpenAI Compact" },
    { id: "grok-3-mini", name: "Grok 3 Mini" },
    { id: "grok-4.20-0309-non-reasoning", name: "Grok 4.20 Non-Reasoning" },
    { id: "grok-4.20-0309-reasoning", name: "Grok 4.20 Reasoning" },
    { id: "grok-4.20-multi-agent-0309", name: "Grok 4.20 Multi-Agent" },
    { id: "grok-4.3", name: "Grok 4.3" },
    { id: "grok-build-0.1", name: "Grok Build 0.1" },
    { id: "Kimi-K2.6", name: "Kimi K2.6" },
    { id: "mimo-v2.5", name: "MiMo V2.5" },
    { id: "mimo-v2.5-pro", name: "MiMo V2.5 Pro" },
    { id: "MiniMax-M2.7", name: "MiniMax M2.7" },
    { id: "minimax-m3", name: "MiniMax M3" },
  ],
  serviceKinds: ["llm"],
  features: {
    usage: true,
    usageApikey: true,
  },
};

export default livsceneProvider;

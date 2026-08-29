import { describe, expect, it } from "vitest";
import { PROVIDER_MODELS, getModelSupportedFormats, getModelTargetFormat } from "../../open-sse/config/providerModels.js";
import { PROVIDERS } from "../../open-sse/config/providers.js";
import { resolveTransport } from "../../open-sse/services/provider.js";

// Chat-only models (no /messages, no /responses support on opencode-go)
const CHAT_ONLY = [
  "glm-5.2", "glm-5.1", "kimi-k2.7-code", "kimi-k2.6",
  "mimo-v2.5", "mimo-v2.5-pro",
];
// Models that also expose the Anthropic /messages endpoint
const CLAUDE_CAPABLE = ["minimax-m3", "minimax-m2.7", "minimax-m2.5", "qwen3.7-max", "qwen3.7-plus", "qwen3.6-plus"];
// Official OpenCode Go docs expose DeepSeek only through /chat/completions.
const DEEPSEEK_CHAT_ONLY = ["deepseek-v4-pro", "deepseek-v4-flash"];

// Mirror of chatCore's per-model transport guard: use the sourceFormat-matched
// transport only when the model declares support for that sourceFormat.
// Undeclared models (null) keep the transport — same as chatCore.js.
function pickTransport(provider, sourceFormat, alias, model) {
  const supported = getModelSupportedFormats(alias, model);
  const rt = resolveTransport(provider, sourceFormat);
  return (!supported || supported.includes(sourceFormat)) ? rt : null;
}

describe("OpenCode Go model catalog", () => {
  it("matches the documented model IDs", () => {
    const ids = (PROVIDER_MODELS["opencode-go"] || []).map((m) => m.id);
    expect(ids).toEqual([
      "deepseek-flash",
      "glm-5.3-flash", "glm-5.3", "glm-5.2", "glm-5.1", "glm-5", "kimi-k2.7-code", "kimi-k2.6", "kimi-k2.5", "kimi-k3",
      "deepseek-v4-pro", "deepseek-v4-flash", "deepseek-v4-flash-vision-exp", "deepseek-v4.1-flash",
      "longcat-2.0", "mimo-v2.6-flash", "mimo-v2.6-pro", "mimo-v2.5", "mimo-v2.5-pro", "mimo-v2-pro", "mimo-v2-omni",
      "minimax-m3", "minimax-m2.7", "minimax-m2.5", "space-bunny-free",
      "qwen3.8-max", "qwen3.8-flash", "qwen3.7-max", "qwen3.7-plus", "qwen3.6-plus", "qwen3.5-plus",
      "hy4-preview", "hy3", "hy3-preview", "omen-alpha",
      "grok-4.7", "grok-4.6", "grok-4.5", "gpt-5.6-luna", "gpt-6-luna",
      "muse-spark-1.2-contributor", "muse-spark-1.3-contributor",
    ]);
  });
});

describe("OpenCode Go family fallback (unknown/passthrough ids)", () => {
  it("routes unknown grok/gpt ids to the responses lane", () => {
    expect(getModelSupportedFormats("opencode-go", "grok-4.8")).toEqual(["openai-responses"]);
    expect(getModelTargetFormat("opencode-go", "gpt-6-foo")).toBe("openai-responses");
  });

  it("gives unknown chat-family ids the chat-only lane, never /messages", () => {
    for (const m of ["kimi-k4", "glm-6", "mimo-v3", "omen-beta"]) {
      expect(getModelSupportedFormats("opencode-go", m)).toEqual(["openai"]);
    }
  });

  it("keeps unknown minimax/qwen ids on the /messages lane too", () => {
    for (const m of ["minimax-m9", "qwen4-max"]) {
      expect(getModelSupportedFormats("opencode-go", m)).toEqual(["openai", "claude"]);
    }
  });

  it("curated entries win over the family regex", () => {
    expect(getModelSupportedFormats("opencode-go", "deepseek-flash")).toEqual(["openai"]);
    expect(getModelSupportedFormats("opencode-go", "deepseek-v4-pro")).toEqual(["openai", "claude", "openai-responses"]);
  });
});

describe("OpenCode Go thinking-suffix model lookup", () => {
  it("preserves Responses routing for gpt-5.6-luna thinking variants", () => {
    expect(getModelSupportedFormats("opencode-go", "gpt-5.6-luna(high)")).toEqual(["openai-responses"]);
    expect(getModelTargetFormat("opencode-go", "gpt-5.6-luna(high)")).toBe("openai-responses");
  });

  it("preserves Responses routing for grok-4.6 thinking variants", () => {
    expect(getModelSupportedFormats("opencode-go", "grok-4.6(high)")).toEqual(["openai-responses"]);
    expect(getModelTargetFormat("opencode-go", "grok-4.6(high)")).toBe("openai-responses");
  });
});

describe("OpenCode Go per-model supportedFormats", () => {
  it("declares [openai, claude] for MiniMax + Qwen models", () => {
    for (const m of CLAUDE_CAPABLE) {
      expect(getModelSupportedFormats("opencode-go", m)).toEqual(["openai", "claude"]);
    }
  });

  it("declares [openai] only for chat-only models (GLM/Kimi/MiMo)", () => {
    for (const m of CHAT_ONLY) {
      expect(getModelSupportedFormats("opencode-go", m)).toEqual(["openai"]);
    }
  });

  it("declares [openai] only for DeepSeek until other endpoints are officially supported", () => {
    for (const m of DEEPSEEK_CHAT_ONLY) {
      expect(getModelSupportedFormats("opencode-go", m)).toEqual(["openai"]);
    }
  });

  it("treats thinking suffix (max) as the same model for metadata lookup", () => {
    expect(getModelSupportedFormats("opencode-go", "deepseek-v4-flash(max)")).toEqual(["openai"]);
    expect(getModelSupportedFormats("opencode-go", "glm-5.2(max)")).toEqual(["openai"]);
    expect(getModelSupportedFormats("opencode-go", "minimax-m3(max)")).toEqual(["openai", "claude"]);
  });
});

describe("OpenCode Go multi-endpoint transports", () => {
  it("declares openai / claude / openai-responses transports", () => {
    const formats = (PROVIDERS["opencode-go"].transports || []).map((t) => t.format);
    expect(formats).toEqual(["openai", "claude", "openai-responses"]);
  });

  it("resolveTransport picks the endpoint matching the client sourceFormat", () => {
    expect(resolveTransport("opencode-go", "claude").baseUrl).toBe("https://opencode.ai/zen/go/v1/messages");
    expect(resolveTransport("opencode-go", "openai-responses").baseUrl).toBe("https://opencode.ai/zen/go/v1/responses");
    expect(resolveTransport("opencode-go", "openai").baseUrl).toBe("https://opencode.ai/zen/go/v1/chat/completions");
  });

  it("uses x-api-key + anthropicVersion on the claude transport", () => {
    const t = resolveTransport("opencode-go", "claude");
    expect(t.auth.header).toBe("x-api-key");
    expect(t.auth.anthropicVersion).toBe(true);
  });
});

describe("Custom multi-protocol transports", () => {
  const credentials = {
    providerSpecificData: {
      transports: [
        { format: "openai", baseUrl: "https://multi.test/v1/chat/completions" },
        { format: "claude", baseUrl: "https://multi.test/v1/messages" },
      ],
    },
  };

  it("resolves a custom transport matching the incoming format", () => {
    expect(resolveTransport("openai-compatible-multi-test", "claude", credentials)).toEqual({
      format: "claude",
      baseUrl: "https://multi.test/v1/messages",
    });
  });

  it("returns null when the custom provider has no matching endpoint", () => {
    expect(resolveTransport("openai-compatible-multi-test", "openai-responses", credentials)).toBeNull();
  });
});

describe("OpenCode Go per-model transport guard (chatCore logic)", () => {
  it("routes MiniMax/Qwen + claude-format client to /messages", () => {
    for (const m of CLAUDE_CAPABLE) {
      expect(pickTransport("opencode-go", "claude", "opencode-go", m)?.baseUrl).toBe("https://opencode.ai/zen/go/v1/messages");
    }
  });

  it("does NOT route chat-only models to /messages on a claude-format request", () => {
    for (const m of CHAT_ONLY) {
      expect(pickTransport("opencode-go", "claude", "opencode-go", m)).toBeNull();
    }
  });

  it("does NOT route DeepSeek to /messages or /responses", () => {
    for (const m of DEEPSEEK_CHAT_ONLY) {
      expect(pickTransport("opencode-go", "claude", "opencode-go", m)).toBeNull();
      expect(pickTransport("opencode-go", "openai-responses", "opencode-go", m)).toBeNull();
    }
  });

  it("routes Muse Spark (responses-only) to /responses, never to /messages", () => {
    for (const m of ["muse-spark-1.2-contributor", "muse-spark-1.3-contributor", "grok-4.7", "grok-4.6", "grok-4.5", "gpt-5.6-luna", "gpt-6-luna"]) {
      expect(getModelSupportedFormats("opencode-go", m)).toEqual(["openai-responses"]);
      expect(pickTransport("opencode-go", "openai-responses", "opencode-go", m)?.baseUrl).toBe("https://opencode.ai/zen/go/v1/responses");
      expect(pickTransport("opencode-go", "claude", "opencode-go", m)).toBeNull();
      expect(pickTransport("opencode-go", "openai", "opencode-go", m)).toBeNull();
    }
  });

  it("does NOT route MiniMax (no responses support) to /responses", () => {
    for (const m of CLAUDE_CAPABLE) {
      expect(pickTransport("opencode-go", "openai-responses", "opencode-go", m)).toBeNull();
    }
  });

  it("does NOT route DeepSeek(max) to /messages or /responses", () => {
    expect(pickTransport("opencode-go", "claude", "opencode-go", "deepseek-v4-flash(max)")).toBeNull();
    expect(pickTransport("opencode-go", "openai-responses", "opencode-go", "deepseek-v4-flash(max)")).toBeNull();
  });

  it("does NOT route GLM(max) to /messages on a claude-format request", () => {
    expect(pickTransport("opencode-go", "claude", "opencode-go", "glm-5.2(max)")).toBeNull();
  });

  it("still routes MiniMax(max) + claude-format client to /messages", () => {
    expect(pickTransport("opencode-go", "claude", "opencode-go", "minimax-m3(max)")?.baseUrl)
      .toBe("https://opencode.ai/zen/go/v1/messages");
  });

  it("does NOT route GLM/Kimi/MiniMax to /responses", () => {
    for (const m of [...CHAT_ONLY, ...CLAUDE_CAPABLE]) {
      expect(pickTransport("opencode-go", "openai-responses", "opencode-go", m)).toBeNull();
    }
  });
});

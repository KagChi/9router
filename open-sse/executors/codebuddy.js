import { DefaultExecutor } from "./default.js";

/**
 * CodeBuddyIntlExecutor — talks to https://www.codebuddy.ai/v2/chat/completions
 *
 * CodeBuddy is OpenAI-compatible but rejects non-stream chat requests
 * (HTTP 400, code 11101 "Non-stream chat request is currently not supported").
 * The same-format (openai→openai) translator path leaves body.stream as the
 * client sent it, so we force it true here — 9router still re-aggregates the
 * SSE into a JSON response for non-streaming clients.
 */
export class CodeBuddyIntlExecutor extends DefaultExecutor {
  constructor() {
    super("codebuddy");
  }

  transformRequest(model, body, stream, credentials) {
    const transformed = super.transformRequest(
      model,
      body,
      stream,
      credentials,
    );
    transformed.stream = true;

    // CodeBuddy only surfaces model reasoning when the request carries the CLI's
    // OpenAI-style params: reasoning_effort + reasoning_summary:"auto". 9router's
    // thinking pipeline sets reasoning_effort only when the client asks, and never
    // sets reasoning_summary — so reasoning never shows. Mirror the CLI here.
    const eff = transformed.reasoning_effort;
    if (eff === "none" || eff === "off") {
      delete transformed.reasoning_effort; // gateway has no "none" — just omit
    } else if (eff) {
      // Client explicitly asked for reasoning — mirror the CLI's reasoning_summary
      // so CodeBuddy surfaces the model's reasoning.
      transformed.reasoning_summary = "auto";
    }
    // No reasoning requested: leave both unset. Forcing reasoning_effort:"medium"
    // + reasoning_summary on plain requests makes CodeBuddy trip its content
    // filter and return an error (#2071).
    return transformed;
  }

  /**
   * CodeBuddy pakai format error non-OpenAI: {"error":{"data":{"code":14018,"msg":"..."}}}
   * atau {"code":14018,"msg":"..."}. Kode 14018 = credits exhausted → force 429
   * supaya markAccountUnavailable + cooldown quota kick in dan koneksi disabled.
   */
  parseError(response, bodyText) {
    let json = null;
    try {
      json = JSON.parse(bodyText);
    } catch {
      return { status: response.status, message: bodyText };
    }
    // Bentuk bervariasi — coba semua.
    const inner = json?.error?.data || json?.error || json?.data || json;
    const code = inner?.code ?? json?.code;
    const msg = inner?.msg || inner?.message || json?.msg || json?.message;

    // 14018 = Credits exhausted. Paksa status 429 supaya errorConfig
    // klasifikasi sebagai quota-exhausted (bukan transient 30s cooldown).
    if (code === 14018 || /credits?\s*exhausted/i.test(msg || "")) {
      return {
        status: 429,
        message: msg || "Credits exhausted",
      };
    }
    return {
      status: response.status,
      message: msg || bodyText,
    };
  }
}

export default CodeBuddyIntlExecutor;

export const GROK_CLI_VERSION = "0.2.99";
export const GROK_CLI_MODEL = "grok-build";
export const GROK_CLI_BASE_URL = "https://cli-chat-proxy.grok.com/v1";
export const GROK_CLI_CLIENT_IDENTIFIER = "grok-shell";
export const GROK_CLI_USER_AGENT = `grok-shell/${GROK_CLI_VERSION} (linux; x86_64)`;

// xAI OAuth claims expires_in: 21600 (6h), but tokens actually expire after
// 40-45 minutes. Hardcode the empirically correct lifetime so proactive refresh
// fires before the token dies (45 min - 5 min lead = 40 min refresh trigger).
// See: https://github.com/decolua/9router/issues/2546
export const XAI_TOKEN_LIFETIME_SECONDS = 2700; // 45 minutes

export function supportsGrokCliReasoningEffort(model) {
  // ponytail: unknown models omit effort until live metadata reaches dispatch.
  return /^grok-4\.5(?:$|-)/.test(String(model || ""));
}

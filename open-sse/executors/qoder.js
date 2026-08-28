/**
 * QoderExecutor — sends OpenAI-format chat requests to Qoder's COSY-signed
 * inference endpoint at api3.qoder.sh, then unwraps Qoder's `{statusCodeValue,
 * body}` SSE envelope back into plain OpenAI SSE for the rest of the pipeline.
 *
 * Differences vs the previous placeholder:
 *   - URL is api3.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation
 *     with `&Encode=1` so we can ship the body through the WAF-bypass
 *     encoder.
 *   - Authentication is COSY (RSA + AES + MD5 + ~17 Cosy-* headers), not
 *     a static HMAC.
 *   - The request shape Qoder expects is non-trivial (chat_context with
 *     mirrored modelConfig, business block with stable IDs, system text
 *     hoisted out of the messages array). All ported from the reference.
 *   - Model identifier is one of the canonical Qoder keys (auto / ultimate /
 *     performance / efficient / lite + frontier "*model" ids); the
 *     translator layer feeds us "qoder/<key>" so we strip the prefix.
 *   - Per-model `model_config` is fetched live from /algo/api/v2/model/list
 *     and cached. Sending the wrong block silently downgrades to a
 *     different model upstream, so a missing entry is a hard error.
 */

import { qoderEncodeBody } from "../shared/qoder/encoding.js";
import { buildCosyHeaders } from "../shared/qoder/cosy.js";
import { v4 as uuidv4 } from "uuid";
import { createHash } from "crypto";

import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";
import { SSE_DONE } from "../utils/sseConstants.js";
import { FETCH_CONNECT_TIMEOUT_MS } from "../config/runtimeConfig.js";
import {
  QODER_CHAT_URL_ENCODED,
  QODER_CHAT_BASE_ALT,
  QODER_CHAT_SIG_PATH,
  QODER_MODEL_MAP,
} from "../shared/qoder/constants.js";
import { getQoderModelConfig, resolveQoderModels, isQoderPat, resolveQoderCredentials } from "../services/qoderModels.js";
import { QODER_QUEUE_MAX_RETRIES, QODER_QUEUE_RETRY_AFTER_SECONDS_CAP, QODER_QUEUE_RETRY_AFTER_SECONDS_DEFAULT } from "../shared/qoder/constants.js";

/**
 * Parse nested JSON structure to detect and extract retry information from queue throttle errors.
 * 
 * Handles Qoder's double-JSON format:
 * - envelope.body = '{"statusCodeValue":403,"body":"{\"code\":\"403\",\"message\":\"{\\\"code\\\":\\\"10605\\\",...}"}"}'
 * 
 * Returns { retryAfterSeconds: number } if code 10605 detected, null otherwise.
 */
function parseQueueThrottle(inner) {
  if (!inner || typeof inner !== "string") return null;
  
  const lowerInner = inner.toLowerCase();
  
  // Check for code 10605 anywhere in the message text
  if (!lowerInner.includes('"code"') || !lowerInner.includes('10605')) {
    return null;
  }
  
  try {
    // First attempt: try parsing as top-level JSON object with code field
    let parsed;
    try {
      parsed = JSON.parse(inner);
    } catch {
      // Try extracting inner message object
      // Pattern: {"code":"10605",...} or nested {"message":"{\"code\":\"10605\",...}"}}
      const regex = /"code"\s*:\s*"10605"/i;
      if (!regex.test(inner)) return null;
      
      // Attempt to find retryAfterSeconds from raw string using regex
      // Handle both single and double escaped JSON
      const retryMatch = inner.match(/"retryAfterSeconds"\s*:\s*(\d+)/);
      if (retryMatch) {
        return { retryAfterSeconds: parseInt(retryMatch[1], 10) };
      }
      return { retryAfterSeconds: QODER_QUEUE_RETRY_AFTER_SECONDS_DEFAULT };
    }
    
    // Direct code 10605 match
    if (parsed.code === "10605") {
      if (typeof parsed.retryAfterSeconds === "number") {
        return { retryAfterSeconds: parsed.retryAfterSeconds };
      }
      if (typeof parsed.message === "object" && parsed.message.retryAfterSeconds) {
        return { retryAfterSeconds: parsed.message.retryAfterSeconds };
      }
      return { retryAfterSeconds: QODER_QUEUE_RETRY_AFTER_SECONDS_DEFAULT };
    }
    
    // Nested structure: {"code":"403","message":"{\"code\":\"10605\",...}"}
    if (typeof parsed.message === "string") {
      try {
        const nested = JSON.parse(parsed.message);
        if (nested.code === "10605") {
          if (typeof nested.retryAfterSeconds === "number") {
            return { retryAfterSeconds: nested.retryAfterSeconds };
          }
          if (typeof nested.message === "object" && nested.message.retryAfterSeconds) {
            return { retryAfterSeconds: nested.message.retryAfterSeconds };
          }
          return { retryAfterSeconds: QODER_QUEUE_RETRY_AFTER_SECONDS_DEFAULT };
        }
      } catch {}
    }
    
    // Double-nested: {"message":{"value":"{\"code\":\"10605\",...}"}}
    if (typeof parsed.message === "object" && typeof parsed.message.value === "string") {
      try {
        const deepNested = JSON.parse(parsed.message.value);
        if (deepNested.code === "10605") {
          if (typeof deepNested.retryAfterSeconds === "number") {
            return { retryAfterSeconds: deepNested.retryAfterSeconds };
          }
          return { retryAfterSeconds: QODER_QUEUE_RETRY_AFTER_SECONDS_DEFAULT };
        }
      } catch {}
    }
  } catch (err) {
    // If all parsing attempts fail, fall back to regex matching
    const retryMatch = inner.match(/"retryAfterSeconds"\s*:\s*(\d+)/);
    if (retryMatch) {
      return { retryAfterSeconds: parseInt(retryMatch[1], 10) };
    }
  }
  
  return null;
}

/**
 * Hoist role:"system" messages out of the messages array (Qoder rejects
 * system in messages) and flatten any multipart content arrays.
 */
function normalizeMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return { messages: [], systemText: "" };
  }
  const systemParts = [];
  const out = [];
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    const text = extractText(msg.content);
    if (msg.role === "system") {
      if (text) systemParts.push(text);
      continue;
    }
    const cloned = { ...msg };
    cloned.content = text;
    out.push(cloned);
  }
  return { messages: out, systemText: systemParts.join("\n\n") };
}

function extractText(content) {
  if (typeof content === "string") return content;
  if (content == null) return "";
  if (Array.isArray(content)) {
    const parts = [];
    for (const item of content) {
      if (item && typeof item === "object") {
        if (item.type === "text" && typeof item.text === "string") {
          parts.push(item.text);
        } else if (typeof item.text === "string") {
          parts.push(item.text);
        }
      }
    }
    return parts.join("\n");
  }
  return String(content);
}

function lastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === "user" && typeof m.content === "string") {
      return m.content;
    }
  }
  return "";
}

function stableHash(prefix, ...parts) {
  const h = createHash("sha256");
  h.update(prefix);
  for (const p of parts) {
    h.update("\0");
    h.update(String(p ?? ""));
  }
  return h.digest("hex").slice(0, 16);
}

function stableChatRecordId(model, messages, tools, maxTokens) {
  const h = createHash("sha256");
  h.update("qoder-record\0");
  h.update(String(model));
  for (const m of messages) {
    if (!m || typeof m !== "object") continue;
    if (m.role) { h.update("\0"); h.update(m.role); }
    if (typeof m.content === "string" && m.content) {
      h.update("\0"); h.update(m.content);
    }
  }
  if (tools) {
    h.update("\0");
    try { h.update(JSON.stringify(tools)); } catch {}
  }
  h.update(`\0mt=${maxTokens}`);
  return h.digest("hex").slice(0, 16);
}

function truncate(s, n) {
  return s && s.length > n ? `${s.slice(0, n)}...` : s || "";
}

/**
 * Map the OpenAI-style request body into the exact shape Qoder expects.
 */
async function buildQoderRequestBody({ model, body, credentials, log, proxyOptions, signal }) {
  const qoderKey = String(model || "").replace(/^qoder\//, "");
  
  // Fetch model config from dynamic API instead of relying on static QODER_MODEL_MAP.
  // This allows support for new Qoder models (e.g., qmodel_latest) without code changes.
  let modelConfig = await getQoderModelConfig(credentials, qoderKey, { log, proxyOptions, signal });
  if (!modelConfig) {
    // Try a forced refresh once before giving up — the cache may simply
    // not be populated yet on first ever call for this credential.
    const refreshed = await resolveQoderModels(credentials, { forceRefresh: true, log, proxyOptions, signal });
    const retried = refreshed?.rawConfigs.get(qoderKey);
    if (!retried) {
      throw new Error(
        `qoder: model_config for "${qoderKey}" not yet known (run a model list fetch or check upstream connectivity)`,
      );
    }
    modelConfig = { ...retried, key: qoderKey };
  }

  const { messages, systemText } = normalizeMessages(body.messages || []);
  const tools = body.tools;
  const isReasoning = !!modelConfig.is_reasoning;
  const maxOutputTokens = Number(modelConfig.max_output_tokens) || 0;

  let maxTokens = 32_768;
  if (maxOutputTokens > 0) maxTokens = maxOutputTokens;
  if (typeof body.max_tokens === "number" && body.max_tokens > 0 && body.max_tokens < maxTokens) {
    maxTokens = body.max_tokens;
  }
  if (typeof body.max_completion_tokens === "number" && body.max_completion_tokens > 0 && body.max_completion_tokens < maxTokens) {
    maxTokens = body.max_completion_tokens;
  }

  const lastUser = lastUserText(messages);
  const psd = credentials.providerSpecificData || {};
  const sessionId = stableHash("qoder-session", psd.userId, qoderKey);
  const recordId = stableChatRecordId(qoderKey, messages, tools, maxTokens);

  return {
    qoderKey,
    payload: {
      request_id: uuidv4(),
      request_set_id: recordId,
      chat_record_id: recordId,
      session_id: sessionId,
      stream: true,
      chat_task: "FREE_INPUT",
      is_reply: true,
      is_retry: false,
      source: 1,
      version: "3",
      session_type: "qodercli",
      agent_id: "agent_common",
      task_id: "common",
      code_language: "",
      chat_prompt: "",
      image_urls: null,
      aliyun_user_type: "",
      system: systemText,
      messages,
      tools: Array.isArray(tools) ? tools : [],
      parameters: { max_tokens: maxTokens },
      chat_context: {
        chatPrompt: "",
        imageUrls: null,
        extra: {
          context: [],
          modelConfig: { key: qoderKey, is_reasoning: isReasoning },
          originalContent: lastUser,
        },
        features: [],
        text: lastUser,
      },
      model_config: modelConfig,
      business: {
        product: "cli",
        version: "1.0.0",
        type: "agent",
        stage: "start",
        id: uuidv4(),
        name: truncate(lastUser, 30),
        begin_at: Date.now(),
      },
    },
    modelConfig,
  };
}

/**
 * Check if a qoder error message indicates a billing/quota block.
 * Signatures: code 112 (quota exhausted), pricingUrl field.
 * Queue throttle (code 10605) is handled separately via parseQueueThrottle + retry.
 */
function isBillingBlock(inner) {
  if (!inner || typeof inner !== "string") return false;
  const lowerMsg = inner.toLowerCase();
  // Match: {"code":"112",...} or pricingUrl field
  return /\"code\"\s*:\s*\"112\"/.test(inner) || lowerMsg.includes("pricingurl");
}

/**
 * Peek the first SSE frame to detect billing/queue errors before piping.
 * Returns { kind: "ok"|"billing"|"queue_throttle", consumed, ... } — `consumed`
 * is every byte read so far (including the peeked line) so the caller can
 * re-process it and nothing is dropped from the stream.
 */
async function peekFirstQoderFrame(reader, decoder) {
  let consumed = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) return { kind: "ok", consumed, upstreamDone: true };

    consumed += decoder.decode(value, { stream: true });
    const nl = consumed.indexOf("\n");
    if (nl === -1) continue; // need a full line first

    const line = consumed.slice(0, nl).replace(/\r$/, "").trim();
    if (!line.startsWith("data:")) continue;

    const data = line.slice(5).trimStart();
    if (data === "[DONE]") return { kind: "ok", consumed };

    let envelope;
    try { envelope = JSON.parse(data); } catch { return { kind: "ok", consumed }; }

    const statusVal = typeof envelope.statusCodeValue === "number" ? envelope.statusCodeValue : 200;
    const inner = typeof envelope.body === "string" ? envelope.body : "";

    if (statusVal !== 200) {
      const queue = parseQueueThrottle(inner);
      if (queue) {
        return { kind: "queue_throttle", statusVal, retryAfterSeconds: queue.retryAfterSeconds, message: inner, consumed };
      }
      if (isBillingBlock(inner)) {
        return { kind: "billing", statusVal, message: inner || `qoder billing block (${statusVal})`, consumed };
      }
    }
    return { kind: "ok", consumed };
  }
}

/**
 * Sleep for ms milliseconds, but resolve early if signal is aborted.
 */
function sleepMs(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      try { signal?.removeEventListener?.("abort", onAbort); } catch {}
    };
    const onAbort = () => { cleanup(); resolve(); };
    timer = setTimeout(() => { cleanup(); resolve(); }, ms);
    signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}

/**
 * Wrap the upstream's `{statusCodeValue, body}` SSE envelope into plain
 * OpenAI SSE chunks the rest of the chatCore pipeline understands.
 *
 * Each upstream line looks like:
 *   data: {"statusCodeValue":200,"body":"{\"choices\":[{\"delta\":{...}}]}"}
 * The inner body is an OpenAI streaming chunk (or "[DONE]"). We unwrap it
 * and re-emit as `data: <inner>\n\n`. Errors become a synthetic OpenAI error
 * chunk + [DONE].
 *
 * Critical: Qoder's SSE often keeps the socket open after the terminal
 * [DONE]/error frame (agent keepalive). Non-streaming clients drain via
 * response.text() which hangs until the socket closes — so on terminal
 * events we cancel the upstream reader and close our stream immediately.
 *
 * Billing blocks (code 112/pricingUrl) detected on the first frame return a
 * 403 response so chatCore marks the connection unavailable.
 *
 * Queue throttle (code 10605) triggers a retry: the upstream reader is
 * cancelled, we wait for retryAfterSeconds (capped), then re-fetch via the
 * opt.refetch callback. Retries happen up to maxQueueRetries times, only if
 * no content has been emitted to the client yet.
 */
async function wrapQoderSSE(response, model, opts = {}) {
  const {
    refetch = null,
    maxQueueRetries = QODER_QUEUE_MAX_RETRIES,
    retryCapSeconds = QODER_QUEUE_RETRY_AFTER_SECONDS_CAP,
    signal = null,
    log = null,
  } = opts;

  if (!response.ok || !response.body) return response;

  let currentResponse = response;
  let reader = currentResponse.body.getReader();
  let decoder = new TextDecoder();
  let retriesLeft = maxQueueRetries;
  let queueRetryCount = 0;
  let peek = null;

  // ---- First-frame retry loop (billing / queue_throttle / ok) ----
  while (true) {
    peek = await peekFirstQoderFrame(reader, decoder);

    if (peek.kind === "billing") {
      await reader.cancel().catch(() => {});
      return new Response(
        JSON.stringify({ error: { message: peek.message, code: peek.statusVal } }),
        { status: 403, headers: { "Content-Type": "application/json" } }
      );
    }

    if (peek.kind === "queue_throttle") {
      await reader.cancel().catch(() => {});
      if (!refetch || retriesLeft <= 0 || signal?.aborted) {
        // Exhausted → terminal 403 (same as billing)
        return new Response(
          JSON.stringify({ error: { message: peek.message, code: peek.statusVal } }),
          { status: 403, headers: { "Content-Type": "application/json" } }
        );
      }
      const waitSeconds = Math.min(
        Math.max(1, Number(peek.retryAfterSeconds) || QODER_QUEUE_RETRY_AFTER_SECONDS_DEFAULT),
        retryCapSeconds,
      );
      queueRetryCount++;
      retriesLeft--;
      log?.warn?.("QODER", `queue throttle (10605) — retry ${queueRetryCount}/${maxQueueRetries + 1} after ${waitSeconds}s`);
      await sleepMs(waitSeconds * 1000, signal);
      if (signal?.aborted) {
        return new Response(
          JSON.stringify({ error: { message: "qoder queue retry aborted", code: 499 } }),
          { status: 499, headers: { "Content-Type": "application/json" } }
        );
      }
      try {
        const next = await refetch();
        if (!next || !next.ok || !next.body) {
          log?.warn?.("QODER", `queue retry refetch failed (status ${next?.status || "?"})`);
          return new Response(
            JSON.stringify({ error: { message: peek.message, code: peek.statusVal } }),
            { status: 403, headers: { "Content-Type": "application/json" } }
          );
        }
        currentResponse = next;
      } catch (err) {
        log?.warn?.("QODER", `queue retry refetch threw: ${err.message}`);
        return new Response(
          JSON.stringify({ error: { message: peek.message, code: peek.statusVal } }),
          { status: 403, headers: { "Content-Type": "application/json" } }
        );
      }
      reader = currentResponse.body.getReader();
      decoder = new TextDecoder();
      continue;
    }

    // kind === "ok" → proceed to stream
    break;
  }

  // ---- Build the output ReadableStream ----
  let buffer = peek.consumed || "";
  let upstreamDrained = peek.upstreamDone === true;
  const encoder = new TextEncoder();
  let doneEmitted = false;
  let contentEmitted = false;
  let lastErrorInfo = null; // { statusVal, inner } for terminal fallback

  const stream = new ReadableStream({
    async start(controller) {
      /**
       * Process one SSE line. Returns:
       *   "skip"    — nothing to forward
       *   "content" — a non-error chunk was forwarded
       *   "queue"   — queue throttle detected (the caller should retry)
       *   "done"    — terminal frame emitted ([DONE] or error chunk)
       */
      const processLine = (line) => {
        const trimmed = line.replace(/\r$/, "").trim();
        if (!trimmed) return "skip";
        if (!trimmed.startsWith("data:")) return "skip";
        if (doneEmitted) return "skip";

        const data = trimmed.slice(5).trimStart();
        if (data === "[DONE]") {
          controller.enqueue(encoder.encode(SSE_DONE));
          doneEmitted = true;
          return "done";
        }

        let envelope;
        try { envelope = JSON.parse(data); } catch { return "skip"; }
        const statusVal = typeof envelope.statusCodeValue === "number" ? envelope.statusCodeValue : 200;
        const inner = typeof envelope.body === "string" ? envelope.body : "";

        if (statusVal !== 200) {
          lastErrorInfo = { statusVal, inner };
          const queue = parseQueueThrottle(inner);
          if (queue && !contentEmitted) {
            return "queue";
          }
          // Terminal error: emit synthetic error chunk
          const msg = inner || `upstream status ${statusVal}`;
          const errChunk = JSON.stringify({
            id: `qoder-error-${Date.now()}`,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{ index: 0, delta: { content: `\n[qoder error ${statusVal}: ${truncate(msg, 200)}]` }, finish_reason: "stop" }],
          });
          try { controller.enqueue(encoder.encode(`data: ${errChunk}\n\n`)); } catch {}
          try { controller.enqueue(encoder.encode(SSE_DONE)); } catch {}
          doneEmitted = true;
          return "done";
        }

        if (!inner) return "skip";
        if (inner === "[DONE]") {
          controller.enqueue(encoder.encode(SSE_DONE));
          doneEmitted = true;
          return "done";
        }

        // Strip embedded newlines so the SSE frame stays a single event.
        const sanitized = inner.replace(/\r?\n/g, "");
        controller.enqueue(encoder.encode(`data: ${sanitized}\n\n`));
        contentEmitted = true;
        return "content";
      };

      /** Drain buffered lines; returns processLine result or "more" if buffer is empty. */
      const drainBuffer = () => {
        let nl;
        while ((nl = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          const res = processLine(line);
          if (res === "queue" || res === "done") return res;
        }
        return "more";
      };

      /**
       * Read from the current reader until queue-throttle / terminal / EOF.
       * Returns "queue" | "done" | "eof".
       */
      const drainCurrent = async () => {
        let res = drainBuffer();
        if (res !== "more") return res;

        if (upstreamDrained) {
          buffer += decoder.decode();
          if (buffer.length > 0) {
            res = processLine(buffer);
            buffer = "";
            if (res === "queue" || res === "done") return res;
          }
          return "eof";
        }

        while (!doneEmitted) {
          let value, done;
          try {
            ({ done, value } = await reader.read());
          } catch {
            return "eof";
          }
          if (done) {
            buffer += decoder.decode();
            if (buffer.length > 0) {
              res = processLine(buffer);
              buffer = "";
              if (res === "queue" || res === "done") return res;
            }
            return "eof";
          }
          buffer += decoder.decode(value, { stream: true });
          res = drainBuffer();
          if (res === "queue" || res === "done") return res;
        }
        return "done";
      };

      try {
        let status = await drainCurrent();

        // Mid-stream queue-throttle retry loop
        while (status === "queue") {
          if (!refetch || retriesLeft <= 0 || signal?.aborted) {
            // Exhausted — emit terminal error chunk
            if (lastErrorInfo) {
              const { statusVal, inner } = lastErrorInfo;
              const msg = inner || `upstream status ${statusVal}`;
              const errChunk = JSON.stringify({
                id: `qoder-error-${Date.now()}`,
                object: "chat.completion.chunk",
                created: Math.floor(Date.now() / 1000),
                model,
                choices: [{ index: 0, delta: { content: `\n[qoder error ${statusVal}: ${truncate(msg, 200)}]` }, finish_reason: "stop" }],
              });
              try { controller.enqueue(encoder.encode(`data: ${errChunk}\n\n`)); } catch {}
              try { controller.enqueue(encoder.encode(SSE_DONE)); } catch {}
              doneEmitted = true;
            }
            break;
          }

          // Cancel old reader, wait, refetch, swap
          await reader.cancel().catch(() => {});
          const waitSeconds = Math.min(
            Math.max(1, lastErrorInfo?.inner ? (parseQueueThrottle(lastErrorInfo.inner)?.retryAfterSeconds || QODER_QUEUE_RETRY_AFTER_SECONDS_DEFAULT) : QODER_QUEUE_RETRY_AFTER_SECONDS_DEFAULT),
            retryCapSeconds,
          );
          queueRetryCount++;
          retriesLeft--;
          log?.warn?.("QODER", `queue throttle (10605) mid-stream — retry ${queueRetryCount}/${maxQueueRetries + 1} after ${waitSeconds}s`);
          await sleepMs(waitSeconds * 1000, signal);
          if (signal?.aborted) break;

          try {
            const next = await refetch();
            if (!next || !next.ok || !next.body) {
              log?.warn?.("QODER", `queue retry refetch failed (status ${next?.status || "?"})`);
              // Emit terminal error
              if (lastErrorInfo) {
                const { statusVal, inner } = lastErrorInfo;
                const msg = inner || `upstream status ${statusVal}`;
                const errChunk = JSON.stringify({
                  id: `qoder-error-${Date.now()}`,
                  object: "chat.completion.chunk",
                  created: Math.floor(Date.now() / 1000),
                  model,
                  choices: [{ index: 0, delta: { content: `\n[qoder error ${statusVal}: ${truncate(msg, 200)}]` }, finish_reason: "stop" }],
                });
                try { controller.enqueue(encoder.encode(`data: ${errChunk}\n\n`)); } catch {}
                try { controller.enqueue(encoder.encode(SSE_DONE)); } catch {}
                doneEmitted = true;
              }
              break;
            }
            currentResponse = next;
          } catch (err) {
            log?.warn?.("QODER", `queue retry refetch threw: ${err.message}`);
            if (lastErrorInfo) {
              const { statusVal, inner } = lastErrorInfo;
              const msg = inner || `upstream status ${statusVal}`;
              const errChunk = JSON.stringify({
                id: `qoder-error-${Date.now()}`,
                object: "chat.completion.chunk",
                created: Math.floor(Date.now() / 1000),
                model,
                choices: [{ index: 0, delta: { content: `\n[qoder error ${statusVal}: ${truncate(msg, 200)}]` }, finish_reason: "stop" }],
              });
              try { controller.enqueue(encoder.encode(`data: ${errChunk}\n\n`)); } catch {}
              try { controller.enqueue(encoder.encode(SSE_DONE)); } catch {}
              doneEmitted = true;
            }
            break;
          }

          // Swap reader/decoder and reset for the new response
          reader = currentResponse.body.getReader();
          decoder = new TextDecoder();
          buffer = "";
          upstreamDrained = false;
          lastErrorInfo = null;

          status = await drainCurrent();
        }
      } catch {
        // fall through to terminal [DONE] + close
      } finally {
        if (!doneEmitted) {
          try {
            controller.enqueue(encoder.encode(SSE_DONE));
            doneEmitted = true;
          } catch { /* already closed */ }
        }
        try { controller.close(); } catch { /* already closed */ }
        await reader.cancel().catch(() => {});
      }
    },
    cancel() {
      return reader.cancel().catch(() => {});
    },
  });

  return new Response(stream, {
    status: currentResponse.status,
    statusText: currentResponse.statusText,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
    },
  });
}

export class QoderExecutor extends BaseExecutor {
  constructor() {
    super("qoder", PROVIDERS.qoder);
  }

  buildUrl(credentials) {
    // Job-token (jt-...) traffic must hit api2.qoder.sh — api3 rejects jt-
    // with "Login expired" (403). Device tokens (dt-...) stay on api3.
    const raw = credentials?.apiKey || credentials?.accessToken;
    if (typeof raw === "string" && !raw.startsWith("pt-") && (raw.startsWith("jt-") || (credentials?.accessToken || "").startsWith("jt-"))) {
      return `${QODER_CHAT_BASE_ALT}/algo${QODER_CHAT_SIG_PATH}?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1`;
    }
    return QODER_CHAT_URL_ENCODED;
  }

  // Override execute entirely — Qoder needs:
  //   - body built from translated chat completion payload
  //   - body encoded with QoderEncodeBody before signing
  //   - COSY headers built from the *encoded* body bytes
  //   - response stream re-wrapped from {statusCodeValue, body} to OpenAI SSE
  async execute({ model, body, stream, credentials, signal, log, proxyOptions = null }) {
    // PAT (pt-...) → exchange for short-lived job token + resolve userId so
    // downstream COSY signing + catalog fetch work. Device tokens (dt-...) and
    // job tokens (jt-...) skip this and are used directly.
    const rawToken = credentials?.apiKey || credentials?.accessToken;
    if (isQoderPat(rawToken)) {
      try {
        credentials = await resolveQoderCredentials(credentials, proxyOptions, signal);
      } catch (err) {
        log?.error?.("QODER", `PAT exchange failed: ${err.message}`);
        const fakeResp = new Response(
          JSON.stringify({ error: { message: `qoder PAT exchange failed: ${err.message}` } }),
          { status: 401, headers: { "Content-Type": "application/json" } },
        );
        return { response: fakeResp, url: this.buildUrl(credentials), headers: {}, transformedBody: body };
      }
    }

    const url = this.buildUrl(credentials);
    const psd = credentials?.providerSpecificData || {};
    if (!psd.userId) {
      // No user id → no way to sign. Surface a 401 so the dashboard nudges
      // the user back to OAuth.
      const fakeResp = new Response(
        JSON.stringify({ error: { message: "qoder credential is missing userId; reconnect the account" } }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      );
      return { response: fakeResp, url, headers: {}, transformedBody: body };
    }
    if (!credentials?.accessToken) {
      // Same shape as the userId guard — clean 401 so chatCore reports
      // "reconnect" rather than bubbling cosy.js's synchronous throw as 500.
      const fakeResp = new Response(
        JSON.stringify({ error: { message: "qoder credential is missing accessToken; reconnect the account" } }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      );
      return { response: fakeResp, url, headers: {}, transformedBody: body };
    }

    let qoderKey;
    let payload;
    try {
      ({ qoderKey, payload } = await buildQoderRequestBody({ model, body, credentials, log, proxyOptions, signal }));
    } catch (err) {
      const fakeResp = new Response(
        JSON.stringify({ error: { message: err.message } }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
      return { response: fakeResp, url, headers: {}, transformedBody: body };
    }

    const plainBody = Buffer.from(JSON.stringify(payload), "utf8");
    const encodedBodyStr = qoderEncodeBody(plainBody);
    const encodedBodyBuf = Buffer.from(encodedBodyStr, "latin1");

    // Helper: build COSY headers (may throw on bad credentials)
    const buildCosy = () => {
      return buildCosyHeaders(
        encodedBodyBuf,
        url,
        {
          userId: psd.userId,
          authToken: credentials.accessToken,
          name: credentials.displayName || "",
          email: credentials.email || "",
          machineId: psd.machineId || "",
        },
      );
    };

    // Helper: single fetch attempt (called once initially and on retries)
    // Returns { response, headers } or { error: err }.
    const doFetch = async () => {
      let cosyHeaders;
      try {
        cosyHeaders = buildCosy();
      } catch (err) {
        return { error: err };
      }

      const modelSource = (payload.model_config && payload.model_config.source) || "system";
      const headers = {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        "Cache-Control": "no-cache",
        "X-Model-Key": qoderKey,
        "X-Model-Source": modelSource,
        // gzip triggers signature validation on Qoder's CDN; force identity.
        "Accept-Encoding": "identity",
        ...cosyHeaders,
      };

      // Abort if upstream doesn't return response headers within connect timeout.
      const timeoutMs = this.config?.timeoutMs || FETCH_CONNECT_TIMEOUT_MS;
      const connectCtrl = new AbortController();
      const connectTimer = setTimeout(() => connectCtrl.abort(new Error("fetch connect timeout")), timeoutMs);
      const mergedSignal = signal ? AbortSignal.any([signal, connectCtrl.signal]) : connectCtrl.signal;

      try {
        const response = await proxyAwareFetch(
          url,
          { method: "POST", headers, body: encodedBodyBuf, signal: mergedSignal },
          proxyOptions,
        );
        clearTimeout(connectTimer);
        return { response, headers };
      } catch (err) {
        clearTimeout(connectTimer);
        return { error: err };
      }
    };

    // ---- Initial fetch (with PAT exchange/cosy guards already applied) ----
    const initialResult = await doFetch();
    if (initialResult.error) {
      // Signing failure
      const fakeResp = new Response(
        JSON.stringify({ error: { message: `qoder cosy signing failed: ${initialResult.error.message}` } }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      );
      return { response: fakeResp, url, headers: {}, transformedBody: body };
    }
    const { response: initResponse, headers: initHeaders } = initialResult;

    if (!initResponse.ok) {
      // Non-ok HTTP response — pass through unchanged
      return { response: initResponse, url, headers: initHeaders, transformedBody: payload };
    }

    // ---- First-frame / mid-stream queue throttle retry enabled via refetch ----
    const refetch = async () => {
      const result = await doFetch();
      if (result.error) return null;
      return result.response;
    };

    const wrapped = await wrapQoderSSE(initResponse, `qoder/${qoderKey}`, {
      refetch,
      maxQueueRetries: QODER_QUEUE_MAX_RETRIES,
      retryCapSeconds: QODER_QUEUE_RETRY_AFTER_SECONDS_CAP,
      signal,
      log,
    });

    return { response: wrapped, url, headers: initHeaders, transformedBody: payload };
  }

  // Qoder device tokens don't refresh through OAuth — the upstream returns
  // 403 for our flow. Surfacing failure via 401-on-chat is enough; the
  // dashboard tells users to re-login when their token expires (~30 days).
  async refreshCredentials() {
    return null;
  }

  needsRefresh() {
    return false;
  }
}

export default QoderExecutor;

// Internals exposed for unit tests. Not part of the public API — callers
// should import QoderExecutor and use its public methods.
export const __test__ = {
  normalizeMessages,
  wrapQoderSSE,
  buildQoderRequestBody,
  isBillingBlock,
  parseQueueThrottle,
};

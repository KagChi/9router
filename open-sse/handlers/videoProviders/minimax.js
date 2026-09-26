// MiniMax video jobs — https://platform.minimax.io (v2 video_generation).
//
// Creation reshapes an OpenAI-style text-to-video request into the v2 schema
// ({ model, content:[{type:"text",text}], resolution, duration, ratio }); polling
// maps the provider task shape onto the shared { request_id, status, video } output.

const STATUS_MAP = {
  queued: "pending",
  running: "processing",
  succeeded: "done",
  failed: "failed",
  cancelled: "cancelled",
};

function headers(token) {
  return {
    Accept: "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

export default {
  buildRequest({ config, action, requestId, rawBody, contentType, token }) {
    if (requestId) {
      return {
        method: "GET",
        url: `${config.queryUrl.replace(/\/$/, "")}/${encodeURIComponent(requestId)}`,
        headers: headers(token),
      };
    }

    if (action !== "generations") {
      return { error: "MiniMax video generation supports the generations action only" };
    }
    if (!contentType?.includes("application/json")) {
      return { error: "MiniMax video generation requires an application/json request body" };
    }

    let input;
    try {
      input = JSON.parse(String(rawBody || ""));
    } catch {
      return { error: "Invalid JSON body" };
    }

    const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
    if (!prompt) return { error: "MiniMax video generation requires a prompt" };
    if (prompt.length > config.maxPromptCharacters) {
      return { error: `MiniMax video generation prompts must not exceed ${config.maxPromptCharacters} characters` };
    }

    const model = input.model || config.defaultModel;
    if (!config.models.includes(model)) return { error: `Unsupported MiniMax video model: ${model}` };

    const resolution = input.resolution;
    if (!config.resolutions.includes(resolution)) {
      return { error: `MiniMax video resolution must be one of: ${config.resolutions.join(", ")}` };
    }

    const duration = input.duration;
    if (!Number.isInteger(duration) || duration < config.duration.min || duration > config.duration.max) {
      return { error: `MiniMax video duration must be an integer from ${config.duration.min} to ${config.duration.max} seconds` };
    }

    const ratio = input.ratio || input.aspect_ratio;
    if (!config.textToVideoRatios.includes(ratio)) {
      return { error: `MiniMax text-to-video ratio must be one of: ${config.textToVideoRatios.join(", ")}` };
    }

    const body = {
      model,
      content: [{ type: "text", text: prompt }],
      resolution,
      duration,
      ratio,
    };
    if (typeof input.callback_url === "string" && input.callback_url) body.callback_url = input.callback_url;
    if (config.supportsAigcWatermark && typeof input.aigc_watermark === "boolean") {
      body.aigc_watermark = input.aigc_watermark;
    }

    return {
      method: "POST",
      url: config.createUrl,
      headers: { ...headers(token), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    };
  },

  transformResponse(payload) {
    if (payload?.task) {
      const task = payload.task;
      const normalized = {
        request_id: task.id,
        status: STATUS_MAP[task.status] || task.status,
      };
      if (task.content?.url) {
        normalized.video = {
          url: task.content.url,
          ...(Number.isInteger(task.duration) ? { duration: task.duration } : {}),
          ...(task.resolution ? { resolution: task.resolution } : {}),
          ...(task.ratio ? { aspect_ratio: task.ratio } : {}),
        };
      }
      if (task.error) normalized.error = task.error;
      if (task.usage) normalized.usage = task.usage;
      return normalized;
    }
    if (payload?.task_id) return { request_id: payload.task_id };
    return payload;
  },
};

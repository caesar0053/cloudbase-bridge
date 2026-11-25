/**
 * aiProxy — CloudBase Event Function (普通云函数, entry: index.main).
 *
 * Bridges the CloudBase "小程序成长计划" AI models (which can only be spent
 * from CloudBase SDK channels; direct `/v1/ai/*` HTTP calls are rejected with
 * AI_CHANNEL_NOT_ALLOWED) into an OpenAI Chat Completions compatible JSON
 * reply that the CloudBase Bridge plugin can consume. Text chat and image
 * generation share one function; `action` selects the channel.
 *
 * Event contract (sent by the plugin as the invocation body):
 *   { action?: "chat" | "image" | "ping",  // default "chat"
 *     model: string,                  // e.g. "hy3" or "hy-image-v3.5-preview"
 *     messages: [{ role, content }],  // chat: string, text parts, and (for
 *                                     // vision-capable models) image_url
 *                                     // parts; image: text + image_url parts
 *                                     // (Chat/Messages)
 *     // --- chat only ---
 *     temperature?: number,           // 0..2
 *     topP?: number,                  // 0..1
 *     maxTokens?: number,             // positive integer
 *     tools?: [{ type: "function", function: { name, description?, parameters? } }],
 *     toolChoice?: "auto" | "none" | "required" | { type: "function", function: { name } },
 *     // --- image only (hy-image-v3.5-preview) ---
 *     size?: string,                  // "WxH", 256..8192, area <= 4096x4096
 *     seed?: number,                  // [0, 2^63-1]
 *     generate_max_pixels?: number,   // 1048576 | 2359296 | 4194304
 *     resize_max_pixels?: number,     // default 1048576
 *     session?: string,               // stable id across multi-turn edits
 *     footnote?: string,              // watermark, <= 16 chars
 *     use_search_tool?: { value: boolean } }
 *
 * Reply on success (HTTP 200 body = this return value, per the functions
 * OpenAPI — there is no wrapper envelope):
 *   - chat:  { id, object: "chat.completion", created, model,
 *              choices: [{ index, message: { role, content, tool_calls? }, finish_reason }],
 *              usage: { prompt_tokens, completion_tokens, total_tokens } }
 *   - image: the CloudBase generateImage result, passed through verbatim
 *            (object: "image.chat.completion.chunk",
 *             choices[0].delta.image.{url,width,height,...},
 *             assembled_history, ...). The plugin reshapes the image URL
 *            into a Chat Completions message.
 *
 * Reply on failure:
 *   { error: { code, message, requestId? } }
 *   Codes: INVALID_REQUEST, IMAGE_INPUT_NOT_SUPPORTED (image parts sent to a
 *   text-only model, or unsupported part types), IMAGE_REQUEST_INVALID,
 *   MODEL_NOT_ALLOWED, AI_CHANNEL_NOT_ALLOWED, AI_MODEL_NOT_SUPPORTED,
 *   EXCEED_TOKEN_QUOTA_LIMIT, TCB_ENV_MISSING, UPSTREAM_ERROR — mapped to
 *   HTTP statuses by the plugin.
 *
 * Vision capability (chat channel): per the CloudBase model matrix
 * (https://docs.cloudbase.net/ai/available-models), `hy4`, `hy4-flash`,
 * `deepseek-v4.1-flash` and `deepseek-v4.1-flash-1017` accept `image_url`
 * content parts; `hy3` is text-only and `hy4-preview` is not listed as a
 * vision model. Override the set with AI_PROXY_VISION_MODELS (comma-separated).
 *
 * Deployment notes:
 * - Runtime: Node.js (Nodejs18.15 or newer). Dependencies are installed by
 *   the platform from package.json (`installDependency: true`) or shipped in
 *   the upload zip.
 * - `@cloudbase/node-sdk` >= 3.18.3 (resolves `@cloudbase/ai` >= 2.32.0) is
 *   REQUIRED for `hy-image-v3.5-preview`. Redeploy with `installDependency`
 *   after bumping the version so the platform reinstalls the dependency.
 * - The environment id is read from TCB_ENV, which the CloudBase function
 *   runtime injects automatically. No personal environment id is hard-coded.
 * - Set the function timeout to 900 s: image generation (especially 4K) is
 *   slow and the official docs recommend 900 s. 120 s is not enough.
 * - Never put an API Key in this function: the model channel is
 *   authenticated by the environment itself.
 */

"use strict";

/** Allowlist of callable models. Defaults to the superset used by the
 * plugin catalog: the three models confirmed by the official growth-plan
 * notice (checked 2026-11-09, https://docs.cloudbase.net/ai/ai-inspire-plan-new-models),
 * plus `deepseek-v4.1-flash-1017` (verified through this proxy in my own
 * environment, 2026-11; not in the official notice) and the unverified
 * `hy4`. CloudBase itself rejects unsupported ids with
 * AI_MODEL_NOT_SUPPORTED. Override with the AI_PROXY_ALLOWED_MODELS env var
 * (comma-separated). */
const DEFAULT_ALLOWED_MODELS = [
  "hy4-flash",
  "hy4",
  "hy4-preview",
  "hy3",
  "deepseek-v4.1-flash",
  "deepseek-v4.1-flash-1017",
];

/** Image-generation models. `hy-image-v3.5-preview` uses the Chat/Messages
 * protocol (createImageModel + generateImage), not generateText, so it gets
 * its own allowlist and code path. Override with AI_PROXY_ALLOWED_IMAGE_MODELS
 * (comma-separated). Docs: https://docs.cloudbase.net/ai/image-model/node-sdk */
const DEFAULT_ALLOWED_IMAGE_MODELS = ["hy-image-v3.5-preview"];

/** Text models that accept image input (multimodal understanding). Per the
 * CloudBase capability matrix (https://docs.cloudbase.net/ai/available-models)
 * `hy4`, `hy4-flash`, `deepseek-v4.1-flash` and `deepseek-v4.1-flash-1017`
 * have 图片=✅. `hy3` is ❌ and `hy4-preview` is not listed — the growth-plan
 * docs describe it as text-only. Override with AI_PROXY_VISION_MODELS
 * (comma-separated) when the console for your environment differs. */
const DEFAULT_VISION_MODELS = [
  "hy4-flash",
  "hy4",
  "deepseek-v4.1-flash",
  "deepseek-v4.1-flash-1017",
];

// CloudBase caps cloud-function request bodies at 6 MB (application/json;
// error code EXCEED_MAX_PAYLOAD_SIZE). The plugin enforces that in UTF-8
// bytes before invoking; these char limits are a second line of defence for
// direct invocations and are set to the same ~6 M magnitude so they never
// reject a request the plugin already accepted. base64 is ASCII, so chars
// and bytes coincide there.
// https://docs.cloudbase.net/error-code/EXCEED_MAX_PAYLOAD_SIZE
const MAX_MESSAGES = 10_000;
const MAX_SINGLE_MESSAGE_CHARS = 6_291_456;
const MAX_TOTAL_MESSAGE_CHARS = 6_291_456;
const MAX_IMAGE_MESSAGES = 10_000;
const MAX_IMAGE_SINGLE_MESSAGE_CHARS = 6_291_456;
const MAX_IMAGE_TOTAL_MESSAGE_CHARS = 6_291_456;
const MAX_MODEL_ID_LENGTH = 64;
const MAX_TOOLS = 128;
const MAX_TOOL_CALLS_PER_MESSAGE = 64;
const MAX_TOOL_NAME_LENGTH = 128;
const MAX_FOOTNOTE_LENGTH = 16;
const MAX_SESSION_LENGTH = 128;
const AI_PROXY_VERSION = "1.2.0";

/** Group name for the managed model pool — required by the official
 * growth-plan notice ("createModel 的参数改为 cloudbase"). The concrete
 * model id goes into the `model` field of generateText. */
const AI_MODEL_GROUP = "cloudbase";

/* ------------------------------------------------------------------ *
 * Error envelope.                                                    *
 * ------------------------------------------------------------------ */

function errorEnvelope(code, message, requestId) {
  const error = { code, message };
  if (requestId) error.requestId = requestId;
  return { error };
}

function safeErrorMessage(err) {
  let message = "(no message)";
  if (err && typeof err.message === "string" && err.message.length > 0) {
    message = err.message;
  } else if (typeof err === "string" && err.length > 0) {
    message = err;
  }
  // Never echo secrets (none should be present) and keep it bounded.
  return message.length > 300 ? message.slice(0, 300) + "…" : message;
}

function pickUpstreamCode(err) {
  if (err && typeof err.code === "string" && err.code.length > 0) return err.code;
  if (err && err.err && typeof err.err.code === "string") return err.err.code;
  return null;
}

/* ------------------------------------------------------------------ *
 * Model allowlist.                                                   *
 * ------------------------------------------------------------------ */

function allowedModels() {
  const raw = process.env.AI_PROXY_ALLOWED_MODELS;
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return DEFAULT_ALLOWED_MODELS.slice();
  }
  const parsed = raw
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return parsed.length > 0 ? parsed : DEFAULT_ALLOWED_MODELS.slice();
}

function allowedImageModels() {
  const raw = process.env.AI_PROXY_ALLOWED_IMAGE_MODELS;
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return DEFAULT_ALLOWED_IMAGE_MODELS.slice();
  }
  const parsed = raw
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return parsed.length > 0 ? parsed : DEFAULT_ALLOWED_IMAGE_MODELS.slice();
}

/** Models whose chat messages may contain `image_url` content parts. */
function visionModels() {
  const raw = process.env.AI_PROXY_VISION_MODELS;
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return DEFAULT_VISION_MODELS.slice();
  }
  const parsed = raw
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return parsed.length > 0 ? parsed : DEFAULT_VISION_MODELS.slice();
}

/* ------------------------------------------------------------------ *
 * Image request validation (pure functions, unit-tested via _internal).*
 * ------------------------------------------------------------------ */

/**
 * Normalize one image message's `content` to the Chat/Messages array shape
 * the hy-image model expects: [{ type: "text", text }, { type: "image_url",
 * image_url: { url } }]. A plain string becomes a single text part; an
 * OpenAI multimodal array keeps only text/image_url parts (base64 data URLs
 * and public URLs are both valid). Returns { content, chars } or { error }.
 */
function normalizeImageContent(content, index) {
  if (typeof content === "string") {
    return { content: [{ type: "text", text: content }], chars: content.length };
  }
  if (content === null || content === undefined) {
    // assistant messages that only trigger a tool call may omit content.
    return { content: [], chars: 0 };
  }
  if (!Array.isArray(content)) {
    return errorEnvelope(
        "IMAGE_REQUEST_INVALID",
        `messages[${index}].content must be a string or an array of text/image_url parts (image action).`,
      );
  }
  const parts = [];
  let chars = 0;
  for (let partIndex = 0; partIndex < content.length; partIndex += 1) {
    const part = content[partIndex];
    if (!isPlainObject(part)) {
      return errorEnvelope("IMAGE_REQUEST_INVALID", `messages[${index}].content[${partIndex}] must be an object.`);
    }
    if (part.type === "text" && typeof part.text === "string") {
      parts.push({ type: "text", text: part.text });
      chars += part.text.length;
      continue;
    }
    if (part.type === "image_url" && isPlainObject(part.image_url) && typeof part.image_url.url === "string" && part.image_url.url.length > 0) {
      parts.push({ type: "image_url", image_url: { url: part.image_url.url } });
      chars += part.image_url.url.length;
      continue;
    }
    const partType = typeof part.type === "string" ? part.type.slice(0, 24) : "unknown";
    return errorEnvelope(
        "IMAGE_REQUEST_INVALID",
        `messages[${index}].content[${partIndex}] has unsupported type "${partType}". Image action accepts only text and image_url parts.`,
      );
  }
  return { content: parts, chars };
}

/** All roles the image Chat/Messages protocol documents, plus `system` for
 * tolerance (the server takes the last role=user message as the prompt). */
const IMAGE_ALLOWED_ROLES = new Set(["system", "user", "assistant", "tool"]);

/**
 * Normalize one image message, keeping the fields needed to replay
 * `assembled_history` in multi-turn edits (reasoning, tool_calls,
 * tool_call_id). Returns { message, chars } or { error }.
 */
function normalizeImageMessage(message, index) {
  if (!isPlainObject(message)) {
    return errorEnvelope("IMAGE_REQUEST_INVALID", `messages[${index}] must be an object.`);
  }
  const role = typeof message.role === "string" ? message.role : "";
  if (!IMAGE_ALLOWED_ROLES.has(role)) {
    return errorEnvelope(
        "IMAGE_REQUEST_INVALID",
        `messages[${index}].role "${role.slice(0, 24)}" is not supported. Image action accepts: system, user, assistant, tool.`,
      );
  }
  const normalizedContent = normalizeImageContent(message.content, index);
  if (normalizedContent.error) return { error: normalizedContent.error };
  const normalized = { role, content: normalizedContent.content };
  let chars = normalizedContent.chars;
  // Keep multi-turn edit fields verbatim (assembled_history replay).
  if (typeof message.reasoning === "string") {
    normalized.reasoning = message.reasoning;
    chars += message.reasoning.length;
  }
  if (Array.isArray(message.tool_calls)) {
    normalized.tool_calls = message.tool_calls;
    chars += JSON.stringify(message.tool_calls).length;
  }
  if (typeof message.tool_call_id === "string" && message.tool_call_id.length > 0) {
    normalized.tool_call_id = message.tool_call_id;
  }
  if (chars > MAX_IMAGE_SINGLE_MESSAGE_CHARS) {
    return errorEnvelope(
        "IMAGE_REQUEST_INVALID",
        `messages[${index}] is too large (${chars} chars; limit ${MAX_IMAGE_SINGLE_MESSAGE_CHARS}).`,
      );
  }
  return { message: normalized, chars };
}

/**
 * Validate and normalize the "image" event. Returns { params } or { error }.
 * `params` is the object passed straight to `imageModel.generateImage()`.
 */
function validateImageEvent(event) {
  if (!isPlainObject(event)) {
    return errorEnvelope("IMAGE_REQUEST_INVALID", "Event must be a JSON object.");
  }
  const model = typeof event.model === "string" ? event.model.trim() : "";
  if (model.length === 0 || model.length > MAX_MODEL_ID_LENGTH || !/^[A-Za-z0-9._-]+$/.test(model)) {
    return errorEnvelope("IMAGE_REQUEST_INVALID", "event.model must be a non-empty model id (letters, digits, . _ -).");
  }
  const allowList = allowedImageModels();
  if (!allowList.includes(model)) {
    return errorEnvelope(
        "MODEL_NOT_ALLOWED",
        `Image model "${model}" is not in the aiProxy image allowlist. Allowed: ${allowList.join(", ")}. Adjust AI_PROXY_ALLOWED_IMAGE_MODELS if your environment supports more.`,
      );
  }
  if (!Array.isArray(event.messages) || event.messages.length === 0) {
    return errorEnvelope("IMAGE_REQUEST_INVALID", "event.messages must be a non-empty array.");
  }
  if (event.messages.length > MAX_IMAGE_MESSAGES) {
    return errorEnvelope("IMAGE_REQUEST_INVALID", `Too many messages (${event.messages.length}; limit ${MAX_IMAGE_MESSAGES}).`);
  }

  const messages = [];
  let totalChars = 0;
  for (let index = 0; index < event.messages.length; index += 1) {
    const result = normalizeImageMessage(event.messages[index], index);
    if (result.error) return { error: result.error };
    totalChars += result.chars;
    if (totalChars > MAX_IMAGE_TOTAL_MESSAGE_CHARS) {
      return errorEnvelope(
          "IMAGE_REQUEST_INVALID",
          `Conversation too large (${totalChars} chars; limit ${MAX_IMAGE_TOTAL_MESSAGE_CHARS}). Trim reference images.`,
        );
    }
    messages.push(result.message);
  }

  const params = { model, messages };
  // size: "WxH", each side 256..8192, area <= 4096*4096.
  if (event.size !== undefined && event.size !== null) {
    if (typeof event.size !== "string" || !/^\d+x\d+$/i.test(event.size)) {
      return errorEnvelope("IMAGE_REQUEST_INVALID", 'event.size must look like "1024x1024".');
    }
    const [w, h] = event.size.toLowerCase().split("x").map(Number);
    if (w < 256 || h < 256 || w > 8192 || h > 8192 || w * h > 4096 * 4096) {
      return errorEnvelope("IMAGE_REQUEST_INVALID", "event.size sides must be within [256, 8192] and area <= 4096x4096.");
    }
    params.size = `${w}x${h}`;
  }
  if (event.seed !== undefined && event.seed !== null) {
    if (!Number.isInteger(event.seed) || event.seed < 0 || event.seed > Number.MAX_SAFE_INTEGER) {
      return errorEnvelope("IMAGE_REQUEST_INVALID", "event.seed must be a non-negative integer.");
    }
    params.seed = event.seed;
  }
  for (const key of ["generate_max_pixels", "resize_max_pixels"]) {
    if (event[key] !== undefined && event[key] !== null) {
      if (!Number.isInteger(event[key]) || event[key] <= 0) {
        return errorEnvelope("IMAGE_REQUEST_INVALID", `event.${key} must be a positive integer.`);
      }
      params[key] = event[key];
    }
  }
  if (event.session !== undefined && event.session !== null) {
    if (typeof event.session !== "string" || event.session.length === 0 || event.session.length > MAX_SESSION_LENGTH) {
      return errorEnvelope("IMAGE_REQUEST_INVALID", `event.session must be a non-empty string up to ${MAX_SESSION_LENGTH} chars.`);
    }
    params.session = event.session;
  }
  if (event.footnote !== undefined && event.footnote !== null) {
    if (typeof event.footnote !== "string" || event.footnote.length > MAX_FOOTNOTE_LENGTH) {
      return errorEnvelope("IMAGE_REQUEST_INVALID", `event.footnote must be a string up to ${MAX_FOOTNOTE_LENGTH} chars.`);
    }
    params.footnote = event.footnote;
  }
  if (event.use_search_tool !== undefined && event.use_search_tool !== null) {
    if (!isPlainObject(event.use_search_tool) || typeof event.use_search_tool.value !== "boolean") {
      return errorEnvelope("IMAGE_REQUEST_INVALID", "event.use_search_tool must look like { value: boolean }.");
    }
    params.use_search_tool = { value: event.use_search_tool.value };
  }
  return { params };
}

/* ------------------------------------------------------------------ *
 * Request validation (pure functions, unit-tested via _internal).    *
 * ------------------------------------------------------------------ */

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const ALLOWED_ROLES = new Set(["system", "user", "assistant", "tool"]);

/**
 * Normalize OpenAI message content for the chat channel.
 *
 * - A string stays a string; null/undefined is allowed for assistant messages
 *   that only carry tool_calls.
 * - A pure-text array is flattened to a string (legacy behaviour).
 * - An array containing `image_url` parts is preserved as a content-block
 *   array when `allowImages` is true (the model is vision-capable), otherwise
 *   it is rejected with IMAGE_INPUT_NOT_SUPPORTED.
 * - video_url / file / unknown parts are always rejected: no model in the
 *   default allowlist accepts them.
 *
 * Returns { content, hasImages, chars } or { error }.
 */
function normalizeContent(content, index, allowEmpty, allowImages = false, model = "") {
  if (typeof content === "string") return { content, hasImages: false, chars: content.length };
  if ((content === null || content === undefined) && allowEmpty) return { content: "", hasImages: false, chars: 0 };
  if (Array.isArray(content)) {
    const parts = [];
    let hasImages = false;
    let chars = 0;
    for (let partIndex = 0; partIndex < content.length; partIndex += 1) {
      const part = content[partIndex];
      if (isPlainObject(part) && part.type === "text" && typeof part.text === "string") {
        parts.push({ type: "text", text: part.text });
        chars += part.text.length;
        continue;
      }
      if (
        isPlainObject(part) && part.type === "image_url" &&
        isPlainObject(part.image_url) && typeof part.image_url.url === "string" &&
        part.image_url.url.length > 0
      ) {
        if (!allowImages) {
          return errorEnvelope(
              "IMAGE_INPUT_NOT_SUPPORTED",
              `messages[${index}].content[${partIndex}] is an image_url part, but model "${model}" does not accept image input. Use a vision-capable model (${visionModels().join(", ")}) or remove the image. Override with AI_PROXY_VISION_MODELS if your environment supports it.`,
            );
        }
        parts.push({ type: "image_url", image_url: { url: part.image_url.url } });
        hasImages = true;
        chars += part.image_url.url.length;
        continue;
      }
      const partType = isPlainObject(part) && typeof part.type === "string" ? part.type : "unknown";
      return errorEnvelope(
          "IMAGE_INPUT_NOT_SUPPORTED",
          `messages[${index}].content[${partIndex}] has type "${partType.slice(0, 24)}". This proxy forwards only text and (for vision models) image_url parts.`,
        );
    }
    if (!hasImages) {
      return { content: parts.map((part) => part.text).join("\n"), hasImages: false, chars };
    }
    return { content: parts, hasImages: true, chars };
  }
  return errorEnvelope(
      "INVALID_REQUEST",
      `messages[${index}].content must be a string or an array of text/image_url parts.`,
    );
}

/**
 * Validate the `tool_calls` of an assistant message and keep only the
 * OpenAI fields ({ id, type: "function", function: { name, arguments } }).
 * Returns { toolCalls, chars } or { error }.
 */
function normalizeToolCalls(toolCalls, index) {
  if (!Array.isArray(toolCalls) || toolCalls.length > MAX_TOOL_CALLS_PER_MESSAGE) {
    return errorEnvelope(
        "INVALID_REQUEST",
        `messages[${index}].tool_calls must be an array of at most ${MAX_TOOL_CALLS_PER_MESSAGE} items.`,
      );
  }
  const out = [];
  let chars = 0;
  for (let callIndex = 0; callIndex < toolCalls.length; callIndex += 1) {
    const call = toolCalls[callIndex];
    const fn = isPlainObject(call) && isPlainObject(call.function) ? call.function : null;
    if (
      !fn ||
      typeof call.id !== "string" || call.id.length === 0 ||
      typeof fn.name !== "string" || fn.name.length === 0 || fn.name.length > MAX_TOOL_NAME_LENGTH
    ) {
      return errorEnvelope(
          "INVALID_REQUEST",
          `messages[${index}].tool_calls[${callIndex}] must look like { id, type: "function", function: { name, arguments } }.`,
        );
    }
    const args = typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments ?? {});
    chars += fn.name.length + args.length;
    out.push({ id: call.id, type: "function", function: { name: fn.name, arguments: args } });
  }
  return { toolCalls: out, chars };
}

/**
 * Normalize one OpenAI-style message to the generateText input shape:
 * { role, content: string | ContentBlock[] } plus `tool_calls` on assistant
 * messages and `tool_call_id` on tool messages. Image parts are forwarded
 * only for vision-capable models. Returns { message, chars, hasImages } or
 * { error }.
 */
function normalizeMessage(message, index, allowImages = false, model = "") {
  if (!isPlainObject(message)) {
    return errorEnvelope("INVALID_REQUEST", `messages[${index}] must be an object.`);
  }
  const role = typeof message.role === "string" ? message.role : "";
  if (!ALLOWED_ROLES.has(role)) {
    return errorEnvelope(
        "INVALID_REQUEST",
        `messages[${index}].role "${role.slice(0, 24)}" is not supported. Supported roles: system, user, assistant, tool.`,
      );
  }
  const hasToolCalls = role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
  const normalizedContent = normalizeContent(message.content, index, hasToolCalls, allowImages, model);
  if (normalizedContent.error) return { error: normalizedContent.error };
  const content = normalizedContent.content;
  const normalized = { role, content };
  let chars = normalizedContent.chars;

  if (hasToolCalls) {
    const calls = normalizeToolCalls(message.tool_calls, index);
    if (calls.error) return { error: calls.error };
    normalized.tool_calls = calls.toolCalls;
    chars += calls.chars;
  }
  if (role === "tool") {
    if (typeof message.tool_call_id !== "string" || message.tool_call_id.length === 0) {
      return errorEnvelope("INVALID_REQUEST", `messages[${index}] (role "tool") needs a tool_call_id.`);
    }
    normalized.tool_call_id = message.tool_call_id;
  }
  // Vision messages carry base64 data URLs that are far larger than plain
  // text; reuse the image-channel ceilings for those requests.
  const singleLimit = allowImages ? MAX_IMAGE_SINGLE_MESSAGE_CHARS : MAX_SINGLE_MESSAGE_CHARS;
  if (chars > singleLimit) {
    return errorEnvelope(
        "INVALID_REQUEST",
        `messages[${index}] is too large (${chars} chars; limit ${singleLimit}).`,
      );
  }
  return { message: normalized, chars, hasImages: normalizedContent.hasImages };
}

/**
 * Validate OpenAI `tools` (function tools only) and keep the documented
 * fields. Returns { tools } or { error }.
 */
function normalizeTools(tools) {
  if (!Array.isArray(tools) || tools.length > MAX_TOOLS) {
    return errorEnvelope("INVALID_REQUEST", `event.tools must be an array of at most ${MAX_TOOLS} function tools.`);
  }
  const out = [];
  for (let index = 0; index < tools.length; index += 1) {
    const tool = tools[index];
    const fn = isPlainObject(tool) && tool.type === "function" && isPlainObject(tool.function) ? tool.function : null;
    if (!fn || typeof fn.name !== "string" || fn.name.length === 0 || fn.name.length > MAX_TOOL_NAME_LENGTH) {
      return errorEnvelope(
          "INVALID_REQUEST",
          `event.tools[${index}] must look like { type: "function", function: { name, description?, parameters? } }.`,
        );
    }
    out.push({
      type: "function",
      function: {
        name: fn.name,
        description: typeof fn.description === "string" ? fn.description : "",
        parameters: isPlainObject(fn.parameters) ? fn.parameters : { type: "object", properties: {} },
      },
    });
  }
  return { tools: out };
}

/** Returns { toolChoice } or { error }. */
function normalizeToolChoice(toolChoice) {
  if (toolChoice === "auto" || toolChoice === "none" || toolChoice === "required") return { toolChoice };
  if (
    isPlainObject(toolChoice) && toolChoice.type === "function" &&
    isPlainObject(toolChoice.function) && typeof toolChoice.function.name === "string" && toolChoice.function.name.length > 0
  ) {
    return { toolChoice: { type: "function", function: { name: toolChoice.function.name } } };
  }
  return errorEnvelope(
      "INVALID_REQUEST",
      'event.toolChoice must be "auto", "none", "required" or { type: "function", function: { name } }.',
    );
}

/**
 * Validate and normalize the "chat" event. Returns
 * { params } on success or { error } on failure.
 */
function validateChatEvent(event) {
  if (!isPlainObject(event)) {
    return errorEnvelope("INVALID_REQUEST", "Event must be a JSON object.");
  }
  const model = typeof event.model === "string" ? event.model.trim() : "";
  if (model.length === 0 || model.length > MAX_MODEL_ID_LENGTH || !/^[A-Za-z0-9._-]+$/.test(model)) {
    return errorEnvelope("INVALID_REQUEST", "event.model must be a non-empty model id (letters, digits, . _ -).");
  }
  if (!Array.isArray(event.messages) || event.messages.length === 0) {
    return errorEnvelope("INVALID_REQUEST", "event.messages must be a non-empty array.");
  }
  if (event.messages.length > MAX_MESSAGES) {
    return errorEnvelope("INVALID_REQUEST", `Too many messages (${event.messages.length}; limit ${MAX_MESSAGES}).`);
  }

  // Only models declared vision-capable may receive image_url parts; the
  // rest keep the text-only contract and get a diagnostic error instead.
  const allowImages = visionModels().includes(model);
  const totalLimit = allowImages ? MAX_IMAGE_TOTAL_MESSAGE_CHARS : MAX_TOTAL_MESSAGE_CHARS;
  const messages = [];
  let totalChars = 0;
  for (let index = 0; index < event.messages.length; index += 1) {
    const result = normalizeMessage(event.messages[index], index, allowImages, model);
    if (result.error) return { error: result.error };
    const normalized = result.message;
    totalChars += result.chars;
    if (totalChars > totalLimit) {
      return errorEnvelope(
          "INVALID_REQUEST",
          `Conversation too large (${totalChars} chars; limit ${totalLimit}). Trim the history or use a public image URL instead of base64.`,
        );
    }
    messages.push(normalized);
  }

  const params = { model, messages };
  if (typeof event.temperature === "number" && Number.isFinite(event.temperature)) {
    if (event.temperature < 0 || event.temperature > 2) {
      return errorEnvelope("INVALID_REQUEST", "event.temperature must be between 0 and 2.");
    }
    params.temperature = event.temperature;
  }
  if (typeof event.topP === "number" && Number.isFinite(event.topP)) {
    if (event.topP <= 0 || event.topP > 1) {
      return errorEnvelope("INVALID_REQUEST", "event.topP must be in (0, 1].");
    }
    params.topP = event.topP;
  }
  if (event.maxTokens !== undefined && event.maxTokens !== null) {
    if (!Number.isInteger(event.maxTokens) || event.maxTokens < 1) {
      return errorEnvelope("INVALID_REQUEST", "event.maxTokens must be a positive integer.");
    }
    params.maxTokens = event.maxTokens;
  }
  if (Array.isArray(event.tools) && event.tools.length > 0) {
    const tools = normalizeTools(event.tools);
    if (tools.error) return { error: tools.error };
    params.tools = tools.tools;
    if (event.toolChoice !== undefined && event.toolChoice !== null) {
      const choice = normalizeToolChoice(event.toolChoice);
      if (choice.error) return { error: choice.error };
      params.toolChoice = choice.toolChoice;
    }
  }

  const allowList = allowedModels();
  if (!allowList.includes(model)) {
    return errorEnvelope(
        "MODEL_NOT_ALLOWED",
        `Model "${model}" is not in the aiProxy allowlist (code AI_MODEL_NOT_SUPPORTED). Allowed models: ${allowList.join(", ")}. Adjust AI_PROXY_ALLOWED_MODELS if your environment supports more.`,
      );
  }
  return { params };
}

/* ------------------------------------------------------------------ *
 * Response builders.                                                 *
 * ------------------------------------------------------------------ */

function newCompletionId() {
  return "chatcmpl-" + Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
}

function normalizeUsage(usage) {
  const toInt = (value) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : 0);
  const promptTokens = toInt(usage && usage.prompt_tokens);
  const completionTokens = toInt(usage && usage.completion_tokens);
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: toInt(usage && usage.total_tokens) || promptTokens + completionTokens,
  };
}

/**
 * The assistant message of the model's last reply. generateText keeps the
 * upstream Chat Completions object in `rawResponses`; older SDKs only
 * expose it as the message appended to `messages`.
 */
function pickLastChoice(result, inputMessageCount) {
  const raw = result && Array.isArray(result.rawResponses) ? result.rawResponses[result.rawResponses.length - 1] : null;
  const choice = isPlainObject(raw) && Array.isArray(raw.choices) ? raw.choices[0] : null;
  if (isPlainObject(choice) && isPlainObject(choice.message)) {
    return { message: choice.message, finishReason: choice.finish_reason };
  }
  const messages = result && Array.isArray(result.messages) ? result.messages : [];
  const last = messages[messages.length - 1];
  if (typeof inputMessageCount === "number" && messages.length > inputMessageCount && isPlainObject(last) && last.role === "assistant") {
    return { message: last, finishReason: undefined };
  }
  return { message: null, finishReason: undefined };
}

function pickToolCalls(message) {
  if (!isPlainObject(message) || !Array.isArray(message.tool_calls)) return [];
  const out = [];
  for (const call of message.tool_calls) {
    const fn = isPlainObject(call) && isPlainObject(call.function) ? call.function : null;
    if (!fn || typeof fn.name !== "string" || fn.name.length === 0) continue;
    out.push({
      id: typeof call.id === "string" && call.id.length > 0 ? call.id : "call_" + Math.random().toString(36).slice(2, 14),
      type: "function",
      function: {
        name: fn.name,
        arguments: typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments ?? {}),
      },
    });
  }
  return out;
}

/**
 * Map the @cloudbase/node-sdk generateText result
 * ({ text, messages, usage, rawResponses, error? }) to an OpenAI Chat
 * Completions object, including the model's tool calls. Pure; unit-tested
 * via _internal.
 */
function buildChatCompletion(result, model, requestId, inputMessageCount) {
  const text = result && typeof result.text === "string" ? result.text : "";
  const { message: lastMessage, finishReason } = pickLastChoice(result, inputMessageCount);
  const toolCalls = pickToolCalls(lastMessage);
  const message = { role: "assistant", content: toolCalls.length > 0 && text.length === 0 ? null : text };
  if (toolCalls.length > 0) message.tool_calls = toolCalls;
  return {
    id: newCompletionId(),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message,
        finish_reason:
          toolCalls.length > 0
            ? "tool_calls"
            : typeof finishReason === "string" && finishReason.length > 0 && finishReason !== "tool_calls"
              ? finishReason
              : "stop",
      },
    ],
    usage: normalizeUsage(result && result.usage),
    ...(requestId ? { request_id: requestId } : {}),
  };
}

function pingResult() {
  return {
    ok: true,
    service: "aiProxy",
    version: AI_PROXY_VERSION,
    env: process.env.TCB_ENV || null,
    models: allowedModels(),
    imageModels: allowedImageModels(),
    timestamp: new Date().toISOString(),
  };
}

/* ------------------------------------------------------------------ *
 * CloudBase SDK wiring (lazy, so unit tests can inject callModel).   *
 * ------------------------------------------------------------------ */

let sdkModule = null;
let app = null;
/**
 * Map validated params to the generateText input. The SDK posts every
 * field it does not consume itself to the model's chat/completions
 * endpoint (topP -> top_p, toolChoice -> tool_choice). Pure; unit-tested.
 */
function buildGenerateInput(params) {
  return {
    model: params.model,
    messages: params.messages,
    ...(typeof params.temperature === "number" ? { temperature: params.temperature } : {}),
    ...(typeof params.topP === "number" ? { topP: params.topP } : {}),
    ...(typeof params.maxTokens === "number" ? { max_tokens: params.maxTokens } : {}),
    ...(params.tools
      ? {
          tools: params.tools,
          ...(params.toolChoice ? { toolChoice: params.toolChoice } : {}),
          // The SDK would otherwise try to run the tools itself; one step
          // hands the model's tool calls back to the agent, which owns them.
          maxSteps: 1,
        }
      : {}),
  };
}

let chatModel = null;

function loadSdk() {
  if (sdkModule) return sdkModule;
  try {
    sdkModule = require("@cloudbase/node-sdk");
  } catch (err) {
    throw new Error(
      "The @cloudbase/node-sdk dependency is missing. Deploy with installDependency enabled (cloudbaserc) or upload node_modules with the function code.",
    );
  }
  return sdkModule;
}

function getApp() {
  if (app) return app;
  const tcb = loadSdk();
  const envId = process.env.TCB_ENV;
  if (!envId) {
    const missing = new Error(
      "TCB_ENV is not set. The CloudBase runtime normally injects it; add it to the function environment variables if you run this outside CloudBase.",
    );
    missing.code = "TCB_ENV_MISSING";
    throw missing;
  }
  app = tcb.init({ env: envId });
  return app;
}

function getChatModel() {
  if (chatModel) return chatModel;
  const ai = getApp().ai();
  // Group "cloudbase" per the official growth-plan notice; the concrete id
  // (e.g. "hy3") is passed in the `model` field of generateText below.
  chatModel = ai.createModel(AI_MODEL_GROUP);
  return chatModel;
}

let imageModel = null;

function getImageModel() {
  if (imageModel) return imageModel;
  const ai = getApp().ai();
  // hy-image-v3.5-preview uses the managed "cloudbase" image provider
  // (createImageModel), NOT createModel/generateText. See
  // https://docs.cloudbase.net/ai/image-model/node-sdk
  imageModel = ai.createImageModel(AI_MODEL_GROUP);
  return imageModel;
}

/**
 * Map validated image params to the generateImage input. Kept as a pure
 * function so tests can lock the shape. Every field has already been
 * validated by validateImageEvent, so this is a straight copy.
 */
function buildImageGenerateInput(params) {
  const input = { model: params.model, messages: params.messages };
  for (const key of ["size", "seed", "generate_max_pixels", "resize_max_pixels", "session", "footnote", "use_search_tool"]) {
    if (params[key] !== undefined && params[key] !== null) input[key] = params[key];
  }
  return input;
}

/**
 * Perform the image model call with @cloudbase/node-sdk. The result is
 * passed through VERBATIM (the plugin reshapes it): it carries
 * choices[0].delta.image, assembled_history, request_id, usage, etc.
 * Tests can inject a fake via `exports._callImageModelOverride`, which
 * replaces only the SDK call and returns a raw generateImage result; the
 * validation below then applies to both real and injected results.
 */
async function callImageModel(params, requestId) {
  let result;
  try {
    result = typeof exports._callImageModelOverride === "function"
      ? await exports._callImageModelOverride(params, requestId)
      : await getImageModel().generateImage(buildImageGenerateInput(params));
  } catch (err) {
    const code = pickUpstreamCode(err);
    if (code) {
      return errorEnvelope(code, safeErrorMessage(err), requestId);
    }
    return errorEnvelope("UPSTREAM_ERROR", safeErrorMessage(err), requestId);
  }
  if (!result || typeof result !== "object") {
    return errorEnvelope("UPSTREAM_ERROR", "The image model returned an empty result.", requestId);
  }
  if (result.error) {
    const code = pickUpstreamCode(result.error) || "UPSTREAM_ERROR";
    return errorEnvelope(code, safeErrorMessage(result.error), requestId);
  }
  // The docs say success is determined by choices[0].delta.image, not by
  // finish_reason. Guard against a structurally-empty success response.
  const choice = Array.isArray(result.choices) ? result.choices[0] : null;
  const image = isPlainObject(choice) && isPlainObject(choice.delta) ? choice.delta.image : null;
  if (!isPlainObject(image) || typeof image.url !== "string" || image.url.length === 0) {
    return errorEnvelope(
        "UPSTREAM_ERROR",
        "The image model reply has no choices[0].delta.image.url. Check the function logs and the model's availability.",
        requestId,
      );
  }
  return { imageResult: result };
}

/**
 * Perform the model call with @cloudbase/node-sdk. Tests can inject a fake
 * via `exports._callModelOverride` (never used in production deployments).
 */
async function callModel(params, requestId) {
  if (typeof exports._callModelOverride === "function") {
    return exports._callModelOverride(params, requestId);
  }
  try {
    const result = await getChatModel().generateText(buildGenerateInput(params));
    if (result && result.error) {
      const code = pickUpstreamCode(result.error) || "UPSTREAM_ERROR";
      return errorEnvelope(code, safeErrorMessage(result.error), requestId);
    }
    return { completion: buildChatCompletion(result, params.model, requestId, params.messages.length) };
  } catch (err) {
    const code = pickUpstreamCode(err);
    if (code) {
      return errorEnvelope(code, safeErrorMessage(err), requestId);
    }
    return errorEnvelope("UPSTREAM_ERROR", safeErrorMessage(err), requestId);
  }
}

/* ------------------------------------------------------------------ *
 * Entry point.                                                       *
 * ------------------------------------------------------------------ */

exports.main = async (event, context) => {
  const requestId =
    context && typeof context === "object"
      ? (typeof context.request_id === "string" && context.request_id) ||
        (typeof context.requestId === "string" && context.requestId) ||
        undefined
      : undefined;
  try {
    const action = isPlainObject(event) && typeof event.action === "string" ? event.action : "chat";
    if (action === "ping") {
      return pingResult();
    }
    if (action === "image") {
      const validated = validateImageEvent(event);
      if (validated.error) {
        return { error: validated.error };
      }
      const outcome = await callImageModel(validated.params, requestId);
      if (outcome.error) {
        return { error: outcome.error };
      }
      return outcome.imageResult;
    }
    if (action === "chat") {
      const validated = validateChatEvent(event);
      if (validated.error) {
        return { error: validated.error };
      }
      const outcome = await callModel(validated.params, requestId);
      if (outcome.error) {
        return { error: outcome.error };
      }
      return outcome.completion;
    }
    return errorEnvelope("INVALID_REQUEST", `Unknown action "${action}". Expected chat, image or ping.`);
  } catch (err) {
    const code = pickUpstreamCode(err) || (err && err.code) || "UPSTREAM_ERROR";
    return errorEnvelope(code, safeErrorMessage(err), requestId);
  }
};

/**
 * Test surface (pure helpers + injectable callModel). Exported as an
 * object so hosts never treat it as a second plugin/entry.
 */
exports._internal = {
  AI_PROXY_VERSION,
  AI_MODEL_GROUP,
  DEFAULT_ALLOWED_MODELS,
  DEFAULT_ALLOWED_IMAGE_MODELS,
  DEFAULT_VISION_MODELS,
  MAX_MESSAGES,
  MAX_SINGLE_MESSAGE_CHARS,
  MAX_TOTAL_MESSAGE_CHARS,
  MAX_IMAGE_MESSAGES,
  MAX_IMAGE_SINGLE_MESSAGE_CHARS,
  MAX_IMAGE_TOTAL_MESSAGE_CHARS,
  allowedModels,
  allowedImageModels,
  visionModels,
  validateChatEvent,
  normalizeContent,
  normalizeMessage,
  normalizeTools,
  normalizeToolChoice,
  buildGenerateInput,
  buildChatCompletion,
  normalizeUsage,
  normalizeImageContent,
  normalizeImageMessage,
  validateImageEvent,
  buildImageGenerateInput,
  errorEnvelope,
  pingResult,
  safeErrorMessage,
  pickUpstreamCode,
};

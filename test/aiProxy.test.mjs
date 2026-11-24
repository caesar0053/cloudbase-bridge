/**
 * Unit tests for the aiProxy cloud function (pure logic only — the
 * @cloudbase/node-sdk dependency is never loaded here; callModel is
 * injected).
 *
 * Run: npm test  (node --test)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const aiProxy = require("../cloudfunctions/aiProxy/index.js");
const { _internal } = aiProxy;

/* ---------------- validateChatEvent ---------------- */

test("validateChatEvent accepts a valid chat event", () => {
  const result = _internal.validateChatEvent({
    model: "hy3",
    messages: [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
    ],
    temperature: 0.5,
    topP: 0.9,
  });
  assert(!result.error);
  assert.deepEqual(result.params.model, "hy3");
  assert.deepEqual(result.params.messages, [
    { role: "system", content: "sys" },
    { role: "user", content: "hi" },
  ]);
  assert.deepEqual(result.params.temperature, 0.5);
  assert.deepEqual(result.params.topP, 0.9);
});

test("validateChatEvent rejects missing/invalid model", () => {
  for (const model of [undefined, "", "has space", "a".repeat(80), { x: 1 }]) {
    const result = _internal.validateChatEvent({ model, messages: [{ role: "user", content: "hi" }] });
    assert(result.error, `expected rejection for ${JSON.stringify(model)}`);
    assert.deepEqual(result.error.code, "INVALID_REQUEST");
  }
});

test("validateChatEvent rejects unknown roles and malformed tool messages", () => {
  const unknownRole = _internal.validateChatEvent({
    model: "hy3",
    messages: [{ role: "function", content: "{}" }],
  });
  assert.deepEqual(unknownRole.error.code, "INVALID_REQUEST");
  assert.match(unknownRole.error.message, /is not supported/);

  const noCallId = _internal.validateChatEvent({
    model: "hy3",
    messages: [{ role: "tool", content: "{}" }],
  });
  assert.deepEqual(noCallId.error.code, "INVALID_REQUEST");
  assert.match(noCallId.error.message, /tool_call_id/);

  const badCall = _internal.validateChatEvent({
    model: "hy3",
    messages: [{ role: "assistant", content: null, tool_calls: [{ id: "call_1", function: {} }] }],
  });
  assert.deepEqual(badCall.error.code, "INVALID_REQUEST");
});

const READ_FILE_TOOL = {
  type: "function",
  function: {
    name: "read_file",
    description: "Read a file",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
};

test("validateChatEvent keeps tools, toolChoice, maxTokens and a tool-call round trip", () => {
  const result = _internal.validateChatEvent({
    model: "hy4",
    messages: [
      { role: "user", content: "read note.txt" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"note.txt"}' }, extra: 1 }],
      },
      { role: "tool", tool_call_id: "call_1", content: [{ type: "text", text: "hello" }] },
    ],
    tools: [READ_FILE_TOOL],
    toolChoice: "required",
    maxTokens: 64,
  });
  assert(!result.error, JSON.stringify(result.error));
  assert.deepEqual(result.params.messages, [
    { role: "user", content: "read note.txt" },
    {
      role: "assistant",
      content: "",
      tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"note.txt"}' } }],
    },
    { role: "tool", content: "hello", tool_call_id: "call_1" },
  ]);
  assert.deepEqual(result.params.tools, [READ_FILE_TOOL]);
  assert.deepEqual(result.params.toolChoice, "required");
  assert.deepEqual(result.params.maxTokens, 64);
});

test("validateChatEvent rejects malformed tools, toolChoice and maxTokens", () => {
  const base = { model: "hy3", messages: [{ role: "user", content: "hi" }] };
  for (const extra of [
    { tools: [{ type: "function" }] },
    { tools: [{ type: "web_search", function: { name: "x" } }] },
    { tools: [READ_FILE_TOOL], toolChoice: "sometimes" },
    { maxTokens: 0 },
    { maxTokens: 1.5 },
    { maxTokens: "64" },
  ]) {
    const result = _internal.validateChatEvent({ ...base, ...extra });
    assert(result.error, `expected rejection for ${JSON.stringify(extra)}`);
    assert.deepEqual(result.error.code, "INVALID_REQUEST");
  }
  // toolChoice without tools is dropped rather than sent upstream.
  const noTools = _internal.validateChatEvent({ ...base, toolChoice: "auto" });
  assert(!noTools.error);
  assert.equal("toolChoice" in noTools.params, false);
});

test("buildGenerateInput forwards max_tokens and tools in a single model step", () => {
  const plain = _internal.buildGenerateInput({ model: "hy3", messages: [{ role: "user", content: "hi" }], topP: 0.9 });
  assert.deepEqual(plain, { model: "hy3", messages: [{ role: "user", content: "hi" }], topP: 0.9 });

  const withTools = _internal.buildGenerateInput({
    model: "hy4",
    messages: [{ role: "user", content: "hi" }],
    maxTokens: 64,
    tools: [READ_FILE_TOOL],
    toolChoice: "auto",
  });
  assert.deepEqual(withTools.max_tokens, 64);
  assert.deepEqual(withTools.tools, [READ_FILE_TOOL]);
  assert.deepEqual(withTools.toolChoice, "auto");
  assert.deepEqual(withTools.maxSteps, 1, "the SDK must not execute the agent's tools itself");
});

test("validateChatEvent rejects image parts with IMAGE_INPUT_NOT_SUPPORTED", () => {
  const result = _internal.validateChatEvent({
    model: "deepseek-v4.1-flash",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "what is this?" },
          { type: "image_url", image_url: { url: "https://example.com/cat.png" } },
        ],
      },
    ],
  });
  assert.deepEqual(result.error.code, "IMAGE_INPUT_NOT_SUPPORTED");
});

test("validateChatEvent flattens text array parts", () => {
  const result = _internal.validateChatEvent({
    model: "hy3",
    messages: [{ role: "user", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }],
  });
  assert(!result.error);
  assert.deepEqual(result.params.messages, [{ role: "user", content: "a\nb" }]);
});

test("validateChatEvent enforces model allowlist", () => {
  const result = _internal.validateChatEvent({
    model: "not-a-model",
    messages: [{ role: "user", content: "hi" }],
  });
  assert.deepEqual(result.error.code, "MODEL_NOT_ALLOWED");
  assert.match(result.error.message, /AI_PROXY_ALLOWED_MODELS/);
});

test("validateChatEvent rejects out-of-range sampling params and oversized input", () => {
  const badTemp = _internal.validateChatEvent({
    model: "hy3",
    messages: [{ role: "user", content: "hi" }],
    temperature: 5,
  });
  assert.deepEqual(badTemp.error.code, "INVALID_REQUEST");

  const tooBig = _internal.validateChatEvent({
    model: "hy3",
    messages: [{ role: "user", content: "x".repeat(_internal.MAX_SINGLE_MESSAGE_CHARS + 1) }],
  });
  assert.deepEqual(tooBig.error.code, "INVALID_REQUEST");
  assert.match(tooBig.error.message, /too large/);
});

/* ---------------- allowlist ---------------- */

test("default allowlist includes the verified deepseek-v4.1-flash-1017", () => {
  assert.ok(_internal.DEFAULT_ALLOWED_MODELS.includes("deepseek-v4.1-flash-1017"));
  const result = _internal.validateChatEvent({
    model: "deepseek-v4.1-flash-1017",
    messages: [{ role: "user", content: "hi" }],
  });
  assert.ok(!result.error, result.error?.message);
  assert.equal(result.params.model, "deepseek-v4.1-flash-1017");
});

/* ---------------- buildChatCompletion / usage ---------------- */

test("buildChatCompletion maps generateText result to chat.completion", () => {
  const completion = _internal.buildChatCompletion(
    {
      text: "hello world",
      messages: [],
      usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
      rawResponses: [],
    },
    "hy3",
    "req-1",
  );
  assert.deepEqual(completion.object, "chat.completion");
  assert.match(completion.id, /^chatcmpl-/);
  assert.deepEqual(completion.model, "hy3");
  assert.deepEqual(completion.choices.length, 1);
  assert.deepEqual(completion.choices[0].message, { role: "assistant", content: "hello world" });
  assert.deepEqual(completion.choices[0].finish_reason, "stop");
  assert.deepEqual(completion.usage, { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 });
  assert.deepEqual(completion.request_id, "req-1");
});

test("buildChatCompletion tolerates missing usage and text", () => {
  const completion = _internal.buildChatCompletion({}, "hy3");
  assert.deepEqual(completion.choices[0].message.content, "");
  assert.deepEqual(completion.usage, { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
});

test("buildChatCompletion returns the model's tool calls with finish_reason tool_calls", () => {
  const toolCall = { id: "call_9", type: "function", function: { name: "read_file", arguments: '{"path":"note.txt"}' } };
  const upstreamMessage = { role: "assistant", content: "", tool_calls: [toolCall] };
  const usage = { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 };

  const fromRaw = _internal.buildChatCompletion(
    { text: "", messages: [{ role: "user", content: "hi" }, upstreamMessage], usage, rawResponses: [{ choices: [{ message: upstreamMessage, finish_reason: "tool_calls" }] }] },
    "hy4",
    "rid-tc",
    1,
  );
  assert.deepEqual(fromRaw.choices[0].message, { role: "assistant", content: null, tool_calls: [toolCall] });
  assert.deepEqual(fromRaw.choices[0].finish_reason, "tool_calls");
  assert.deepEqual(fromRaw.usage, usage);

  // SDKs without rawResponses: the reply is the message appended to `messages`.
  const fromMessages = _internal.buildChatCompletion(
    { text: "", messages: [{ role: "user", content: "hi" }, upstreamMessage], usage },
    "hy4",
    "rid-tc",
    1,
  );
  assert.deepEqual(fromMessages.choices[0].message.tool_calls, [toolCall]);

  // Tool calls from the conversation history are never echoed as a new reply.
  const history = _internal.buildChatCompletion(
    { text: "done", messages: [{ role: "user", content: "hi" }, upstreamMessage], usage },
    "hy4",
    "rid-tc",
    2,
  );
  assert.deepEqual(history.choices[0].message, { role: "assistant", content: "done" });
  assert.deepEqual(history.choices[0].finish_reason, "stop");

  const truncated = _internal.buildChatCompletion(
    { text: "cut", usage, rawResponses: [{ choices: [{ message: { role: "assistant", content: "cut" }, finish_reason: "length" }] }] },
    "hy4",
  );
  assert.deepEqual(truncated.choices[0].finish_reason, "length");
});

/* ---------------- main entry with injected callModel ---------------- */

function withInjectedCallModel(fake) {
  const original = aiProxy._callModelOverride;
  aiProxy._callModelOverride = fake;
  return () => {
    aiProxy._callModelOverride = original;
  };
}

test("exports.main ping returns ok + models and leaks nothing sensitive", async () => {
  const reply = await aiProxy.main({ action: "ping" }, { request_id: "rid" });
  assert.deepEqual(reply.ok, true);
  assert.deepEqual(reply.service, "aiProxy");
  assert(Array.isArray(reply.models));
  assert(reply.models.includes("hy3"));
  assert(!JSON.stringify(reply).includes("apikey"));
});

test("exports.main chat forwards to callModel and returns completion", async () => {
  const seen = [];
  const restore = withInjectedCallModel(async (params, requestId) => {
    seen.push({ params, requestId });
    return {
      completion: _internal.buildChatCompletion(
        { text: "ok", usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } },
        params.model,
      ),
    };
  });
  try {
    const reply = await aiProxy.main(
      { model: "hy3", messages: [{ role: "user", content: "hi" }] },
      { request_id: "rid-2" },
    );
    assert.deepEqual(reply.choices[0].message.content, "ok");
    assert.deepEqual(seen.length, 1);
    assert.deepEqual(seen[0].params.model, "hy3");
    assert.deepEqual(seen[0].requestId, "rid-2");
  } finally {
    restore();
  }
});

test("exports.main surfaces upstream error codes from callModel", async () => {
  const restore = withInjectedCallModel(async () => ({
    error: { code: "AI_MODEL_NOT_SUPPORTED", message: "model not enabled" },
  }));
  try {
    const reply = await aiProxy.main({ model: "hy3", messages: [{ role: "user", content: "hi" }] });
    assert.deepEqual(reply.error.code, "AI_MODEL_NOT_SUPPORTED");
    assert.match(reply.error.message, /model not enabled/);
  } finally {
    restore();
  }
});

test("exports.main returns error envelope for invalid events", async () => {
  const reply = await aiProxy.main({ model: "hy3" }, {});
  assert(reply.error);
  assert.deepEqual(reply.error.code, "INVALID_REQUEST");
});

test("exports.main catches thrown SDK errors as UPSTREAM_ERROR with upstream code kept", async () => {
  const restore = withInjectedCallModel(async () => {
    const err = new Error("channel refused");
    err.code = "AI_CHANNEL_NOT_ALLOWED";
    throw err;
  });
  try {
    const reply = await aiProxy.main({ model: "hy3", messages: [{ role: "user", content: "hi" }] });
    assert.deepEqual(reply.error.code, "AI_CHANNEL_NOT_ALLOWED");
  } finally {
    restore();
  }
});

/* ---------------- safeErrorMessage ---------------- */

test("safeErrorMessage bounds length and handles primitives", () => {
  assert.deepEqual(_internal.safeErrorMessage(new Error("boom")), "boom");
  assert.deepEqual(_internal.safeErrorMessage("plain"), "plain");
  assert.deepEqual(_internal.safeErrorMessage(undefined), "(no message)");
  assert.ok(_internal.safeErrorMessage("x".repeat(500)).length <= 301);
});

/* ---------------- image action ---------------- */

const IMAGE_MODEL = "hy-image-v3.5-preview";

function imageResult(overrides = {}) {
  return {
    id: "trace-img-1",
    object: "image.chat.completion.chunk",
    created: 1_762_700_000,
    model: "internal-hy-image",
    round: 0,
    choices: [
      {
        index: 0,
        delta: {
          type: "image",
          image: {
            url: "https://example.com/generated.png",
            width: 1024,
            height: 1024,
            source: "generated",
            tool_call_id: "call_img_1",
          },
        },
        finish_reason: null,
      },
    ],
    usage: { total_tokens: 20 },
    request_id: "req-img-1",
    assembled_history: [{ role: "tool", tool_call_id: "call_img_1", content: [] }],
    ...overrides,
  };
}

test("default image allowlist includes hy-image-v3.5-preview", () => {
  assert.ok(_internal.DEFAULT_ALLOWED_IMAGE_MODELS.includes(IMAGE_MODEL));
  assert.deepEqual(_internal.allowedImageModels(), [IMAGE_MODEL]);
});

test("validateImageEvent turns a plain string prompt into a text part", () => {
  const result = _internal.validateImageEvent({
    action: "image",
    model: IMAGE_MODEL,
    messages: [{ role: "user", content: "画一只在沙滩上奔跑的金毛犬" }],
  });
  assert(!result.error, JSON.stringify(result.error));
  assert.deepEqual(result.params.model, IMAGE_MODEL);
  assert.deepEqual(result.params.messages, [
    { role: "user", content: [{ type: "text", text: "画一只在沙滩上奔跑的金毛犬" }] },
  ]);
});

test("validateImageEvent forwards reference images and every documented option", () => {
  const result = _internal.validateImageEvent({
    model: IMAGE_MODEL,
    size: "4096x4096",
    seed: 42,
    generate_max_pixels: 4_194_304,
    resize_max_pixels: 1_048_576,
    session: "demo-session-001",
    footnote: "by-bridge",
    use_search_tool: { value: true },
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "参考这张图的风格，画一只猫" },
          { type: "image_url", image_url: { url: "https://example.com/dog.png" } },
        ],
      },
    ],
  });
  assert(!result.error, JSON.stringify(result.error));
  assert.deepEqual(result.params.messages[0].content, [
    { type: "text", text: "参考这张图的风格，画一只猫" },
    { type: "image_url", image_url: { url: "https://example.com/dog.png" } },
  ]);
  assert.equal(result.params.size, "4096x4096");
  assert.equal(result.params.seed, 42);
  assert.equal(result.params.generate_max_pixels, 4_194_304);
  assert.equal(result.params.resize_max_pixels, 1_048_576);
  assert.equal(result.params.session, "demo-session-001");
  assert.equal(result.params.footnote, "by-bridge");
  assert.deepEqual(result.params.use_search_tool, { value: true });
});

test("validateImageEvent keeps assembled_history replay fields", () => {
  const result = _internal.validateImageEvent({
    model: IMAGE_MODEL,
    messages: [
      { role: "assistant", content: null, reasoning: "chain", tool_calls: [{ id: "c1", type: "function", function: { name: "gen", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "c1", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AAA" } }] },
      { role: "user", content: "把它换成布偶猫" },
    ],
  });
  assert(!result.error, JSON.stringify(result.error));
  assert.equal(result.params.messages[0].reasoning, "chain");
  assert.equal(result.params.messages[0].tool_calls.length, 1);
  assert.equal(result.params.messages[1].tool_call_id, "c1");
  assert.deepEqual(result.params.messages[1].content, [{ type: "image_url", image_url: { url: "data:image/png;base64,AAA" } }]);
});

test("validateImageEvent rejects bad models, sizes, parts and options", () => {
  const base = { model: IMAGE_MODEL, messages: [{ role: "user", content: "hi" }] };
  const cases = [
    [{ model: "hy3" }, "MODEL_NOT_ALLOWED"],
    [{ model: "not a model" }, "IMAGE_REQUEST_INVALID"],
    [{ size: "1024" }, "IMAGE_REQUEST_INVALID"],
    [{ size: "128x128" }, "IMAGE_REQUEST_INVALID"],
    [{ size: "8192x8192" }, "IMAGE_REQUEST_INVALID"],
    [{ seed: -1 }, "IMAGE_REQUEST_INVALID"],
    [{ footnote: "x".repeat(17) }, "IMAGE_REQUEST_INVALID"],
    [{ session: "" }, "IMAGE_REQUEST_INVALID"],
    [{ use_search_tool: { value: "yes" } }, "IMAGE_REQUEST_INVALID"],
    [{ messages: [] }, "IMAGE_REQUEST_INVALID"],
    [{ messages: [{ role: "user", content: [{ type: "audio", text: "x" }] }] }, "IMAGE_REQUEST_INVALID"],
    [{ messages: [{ role: "function", content: "x" }] }, "IMAGE_REQUEST_INVALID"],
  ];
  for (const [extra, expectedCode] of cases) {
    const result = _internal.validateImageEvent({ ...base, ...extra });
    assert(result.error, `expected rejection for ${JSON.stringify(extra)}`);
    assert.equal(result.error.code, expectedCode, JSON.stringify(extra));
  }
});

test("buildImageGenerateInput forwards only validated options", () => {
  const input = _internal.buildImageGenerateInput({
    model: IMAGE_MODEL,
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    size: "1024x1024",
    seed: 7,
    session: "s1",
  });
  assert.deepEqual(input, {
    model: IMAGE_MODEL,
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    size: "1024x1024",
    seed: 7,
    session: "s1",
  });
  assert.equal("temperature" in input, false);
});

function withInjectedCallImageModel(fake) {
  const original = aiProxy._callImageModelOverride;
  aiProxy._callImageModelOverride = fake;
  return () => {
    aiProxy._callImageModelOverride = original;
  };
}

test("exports.main image passes the generateImage result through verbatim", async () => {
  const seen = [];
  const restore = withInjectedCallImageModel(async (params, requestId) => {
    seen.push({ params, requestId });
    return imageResult(); // a raw generateImage result, like the SDK returns
  });
  try {
    const reply = await aiProxy.main(
      { action: "image", model: IMAGE_MODEL, size: "1024x1024", messages: [{ role: "user", content: "一只橘猫" }] },
      { request_id: "rid-img" },
    );
    assert.equal(reply.object, "image.chat.completion.chunk");
    assert.equal(reply.choices[0].delta.image.url, "https://example.com/generated.png");
    assert.ok(Array.isArray(reply.assembled_history), "multi-turn history must survive");
    assert.equal(reply.request_id, "req-img-1");
    assert.equal(seen.length, 1);
    assert.equal(seen[0].params.size, "1024x1024");
    assert.equal(seen[0].requestId, "rid-img");
  } finally {
    restore();
  }
});

test("callImageModel surfaces upstream error and empty-image replies", async () => {
  const upstream = withInjectedCallImageModel(async () => ({
    error: { code: "AI_MODEL_NOT_SUPPORTED", message: "image model not enabled" },
  }));
  try {
    const reply = await aiProxy.main({ action: "image", model: IMAGE_MODEL, messages: [{ role: "user", content: "hi" }] });
    assert.equal(reply.error.code, "AI_MODEL_NOT_SUPPORTED");
    assert.match(reply.error.message, /not enabled/);
  } finally {
    upstream();
  }

  const empty = withInjectedCallImageModel(async () => ({ choices: [{ delta: {} }] }));
  try {
    const reply = await aiProxy.main({ action: "image", model: IMAGE_MODEL, messages: [{ role: "user", content: "hi" }] });
    assert.equal(reply.error.code, "UPSTREAM_ERROR");
    assert.match(reply.error.message, /delta.image.url/);
  } finally {
    empty();
  }

  const thrown = withInjectedCallImageModel(async () => {
    const err = new Error("content safety blocked");
    err.code = "CONTENT_SAFETY";
    throw err;
  });
  try {
    const reply = await aiProxy.main({ action: "image", model: IMAGE_MODEL, messages: [{ role: "user", content: "hi" }] });
    assert.equal(reply.error.code, "CONTENT_SAFETY");
  } finally {
    thrown();
  }
});

test("exports.main ping reports both text and image model lists", async () => {
  const reply = await aiProxy.main({ action: "ping" }, {});
  assert.deepEqual(reply.ok, true);
  assert.ok(reply.models.includes("hy3"));
  assert.ok(reply.imageModels.includes(IMAGE_MODEL));
  assert.equal(reply.version, "1.2.0");
});

test("exports.main rejects an unknown action", async () => {
  const reply = await aiProxy.main({ action: "translate", model: "hy3", messages: [{ role: "user", content: "hi" }] }, {});
  assert.equal(reply.error.code, "INVALID_REQUEST");
  assert.match(reply.error.message, /Unknown action/);
});

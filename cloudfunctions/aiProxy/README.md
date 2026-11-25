# aiProxy — CloudBase Event Function

A normal (Event) CloudBase cloud function that calls CloudBase AI models via
`@cloudbase/node-sdk` and returns an OpenAI Chat Completions compatible JSON
reply (text chat) or the raw CloudBase image result (image generation) that
the **CloudBase Bridge** Magpie plugin reshapes. The plugin invokes this
function through the official function-invocation HTTP endpoint, so **the
function must be deployed in the same CloudBase environment as the API Key
you configure in the plugin**, under the name **`aiProxy`** (or a custom name
you also set during plugin login).

Two channels share this function, selected by `event.action`:

| action | SDK call | Models | Reply |
| --- | --- | --- | --- |
| `chat` | `ai.createModel("cloudbase").generateText(...)` | `hy3`/`hy4`/`deepseek…` | OpenAI Chat Completions JSON |
| `image` | `ai.createImageModel("cloudbase").generateImage(...)` | `hy-image-v3.5-preview` | CloudBase `image.chat.completion.chunk`, passed through verbatim |
| `ping` | — | — | `{ ok, service, version, env, models, imageModels }` |

Why a cloud function? The "小程序成长计划" (mini-program growth plan) AI
quota is only spendable from CloudBase SDK channels — direct calls to
`/v1/ai/*` model endpoints fail with `AI_CHANNEL_NOT_ALLOWED`. Inside a cloud
function the Node SDK channel is allowed and the gift quota is deducted
automatically.

## Files

| File | Purpose |
| --- | --- |
| `index.js` | Function entry: `exports.main(event, context)` |
| `package.json` | Declares `@cloudbase/node-sdk` (**^3.18.3**, required for `hy-image-v3.5-preview`: it resolves `@cloudbase/ai >= 2.32.0`) |

## What it accepts

```jsonc
// event (the plugin builds this from the Chat Completions request)
{
  "action": "chat",            // or "ping" (returns ok/env/model list)
  "model": "hy3",
  "messages": [
    { "role": "system", "content": "You are a helpful assistant." },
    { "role": "user", "content": "Hello" }
  ],
  "temperature": 0.7,          // optional, 0..2
  "topP": 0.9,                 // optional, (0, 1]
  "maxTokens": 1024,           // optional, positive integer
  "tools": [                   // optional, OpenAI function tools
    { "type": "function", "function": { "name": "read_file", "description": "...", "parameters": { "type": "object" } } }
  ],
  "toolChoice": "auto"         // optional: "auto" | "none" | "required" | { type: "function", function: { name } }
}
```

Messages may also use the `tool` role (with `tool_call_id`) and assistant
messages may carry `tool_calls`, so an agent can send tool results back.
The function never runs a tool itself: it asks the model for one step and
returns the model's `tool_calls` (with `finish_reason: "tool_calls"`) to
the caller.

**Chat** image parts are forwarded only for vision-capable models. Per the
[CloudBase model matrix](https://docs.cloudbase.net/ai/available-models),
`hy4`, `hy4-flash`, `deepseek-v4.1-flash` and `deepseek-v4.1-flash-1017`
accept `image_url` content blocks (public URL or base64 data URL) — this is
multimodal understanding, i.e. image in, text out. `hy3` is explicitly
text-only (图片 ❌) and `hy4-preview` is not listed as a vision model, so
image parts sent to those are rejected with `IMAGE_INPUT_NOT_SUPPORTED`.
`video_url` / `file` content parts are never forwarded. Override the vision
set with the `AI_PROXY_VISION_MODELS` env var (comma-separated).

### Image event (`action: "image"`)

The plugin builds this from a Chat Completions request whose model is an
image-generation model (`hy-image-v3.5-preview`):

```jsonc
{
  "action": "image",
  "model": "hy-image-v3.5-preview",
  "messages": [
    { "role": "user", "content": [{ "type": "text", "text": "一只在沙滩上奔跑的金毛犬" }] }
  ],
  // optional (see https://docs.cloudbase.net/ai/image-model/hy-image-3.5-preview)
  "size": "1024x1024",            // sides 256..8192, area <= 4096x4096; 4K needs this
  "seed": 42,                     // integer >= 0
  "generate_max_pixels": 2359296, // 1048576 | 2359296 | 4194304 (ignored if size set)
  "resize_max_pixels": 1048576,   // reference-image area cap
  "session": "demo-session-001",  // keep stable across multi-turn edits
  "footnote": "by-bridge",        // watermark, <= 16 chars
  "use_search_tool": { "value": false }
}
```

`messages[].content` may be a plain string (converted to a single `text`
part) or an array of `{ type: "text", text }` and
`{ type: "image_url", image_url: { url } }` parts (public URL or Base64 data
URL; single image ≤ 20 MB, up to 20 images). For multi-turn editing, replay
the previous reply's `assembled_history` plus a new `user` message; the
function keeps `reasoning`, `tool_calls` and `tool_call_id` verbatim.

Invalid fields are rejected with `IMAGE_REQUEST_INVALID`; a model outside
the image allowlist with `MODEL_NOT_ALLOWED`.

## What it returns

Success — the raw HTTP body (the function-invocation API has no wrapper
envelope).

**Chat** — OpenAI Chat Completions JSON:

```json
{
  "id": "chatcmpl-…",
  "object": "chat.completion",
  "created": 1762700000,
  "model": "hy3",
  "choices": [{ "index": 0, "message": { "role": "assistant", "content": "…" }, "finish_reason": "stop" }],
  "usage": { "prompt_tokens": 10, "completion_tokens": 42, "total_tokens": 52 }
}
```

**Image** — the CloudBase `generateImage` result, passed through **verbatim**
so no information (e.g. `assembled_history`) is lost. The plugin renders
`choices[0].delta.image.url` as a markdown image:

```json
{
  "id": "trace-…",
  "object": "image.chat.completion.chunk",
  "created": 1762700000,
  "model": "internal-hy-image",
  "choices": [{ "index": 0, "delta": { "image": { "url": "https://…", "width": 1024, "height": 1024 } }, "finish_reason": null }],
  "usage": { "total_tokens": 20 },
  "request_id": "…",
  "assembled_history": [ … ]
}
```

> The image URL is temporary (**12 hours**). Download it or transfer it to
> CloudBase cloud storage before it expires.

Failure — `{ "error": { "code": "…", "message": "…", "requestId": "…" } }`
with codes such as `INVALID_REQUEST`, `IMAGE_INPUT_NOT_SUPPORTED`,
`IMAGE_REQUEST_INVALID`, `MODEL_NOT_ALLOWED`, `AI_CHANNEL_NOT_ALLOWED`,
`AI_MODEL_NOT_SUPPORTED`, `EXCEED_TOKEN_QUOTA_LIMIT`, `TCB_ENV_MISSING`,
`UPSTREAM_ERROR`.

## Deploy — Option A: console (控制台上传)

1. Open <https://tcb.cloud.tencent.com>, select your environment.
2. **云函数 / Cloud Functions → 新建函数**:
   - Name: `aiProxy`
   - Runtime: **Nodejs18.15**（或更新；创建后运行时不可更改）
   - Function type: **事件函数 (Event Function)**
   - Memory: 512 MB, **Timeout: 900 s**（生图很慢，4K 更久；官方生图文档建议 900 s。文本生成 120 s 够，但两者共用同一函数，取大值）
3. Paste `index.js` as the entry (execution method `index.main`), and
   `package.json` alongside it. Enable **云端安装依赖 (installDependency)**
   so `@cloudbase/node-sdk` is installed by the platform, or zip the folder
   with `node_modules` included.
   **Upgrading from aiProxy 1.1.0?** You MUST bump `@cloudbase/node-sdk`
   to `^3.18.3` and let the platform reinstall dependencies (delete any
   uploaded `node_modules`): `hy-image-v3.5-preview` needs
   `@cloudbase/ai >= 2.32.0`, which only that node-sdk range resolves.
4. Environment variables: none required — **`TCB_ENV` is injected by the
   CloudBase runtime automatically**. Optionally set
   `AI_PROXY_ALLOWED_MODELS` (comma-separated text model ids) — default
   `hy4-flash,hy4,hy4-preview,hy3,deepseek-v4.1-flash,deepseek-v4.1-flash-1017`
   — and `AI_PROXY_ALLOWED_IMAGE_MODELS` (default
   `hy-image-v3.5-preview`), and `AI_PROXY_VISION_MODELS` (comma-separated
   text model ids allowed to receive `image_url` parts — default
   `hy4-flash,hy4,deepseek-v4.1-flash,deepseek-v4.1-flash-1017`). CloudBase
   itself rejects unsupported ids with `AI_MODEL_NOT_SUPPORTED`.
5. Deploy, then verify with the console's inline test: invoke with
   `{"action":"ping"}` — expect `{"ok":true,"service":"aiProxy","version":"1.2.0","models":[…],"imageModels":[…]}`. The
   `imageModels` field is what makes the plugin offer the image model.

## Deploy — Option B: CLI (`tcb fn deploy`)

```bash
npm install -g @cloudbase/cli   # or: npm install -g @cloudbase/cli@latest
tcb login

# from the repository root
cp cloudbaserc.example.json cloudbaserc.json
# edit cloudbaserc.json: set envId to your environment id

tcb fn deploy aiProxy --force   # Event Function (no --httpFn)
tcb fn list                     # verify
tcb fn invoke aiProxy --params '{"action":"ping"}'
```

`installDependency: true` in the example config makes the platform install
`@cloudbase/node-sdk@^3.18.3` from `package.json` (do **not** also upload
`node_modules`, they conflict). The example config sets `timeout: 900` and
`memorySize: 512` for image generation.

Verify both channels without Magpie:

```bash
tcb fn invoke aiProxy --params '{"action":"ping"}'
tcb fn invoke aiProxy --params '{"action":"image","model":"hy-image-v3.5-preview","messages":[{"role":"user","content":"一只橘猫"}],"size":"1024x1024"}'
# image call returns choices[0].delta.image.url, width, height
```

## Security notes

- The function contains **no API Key and no environment id**. It trusts the
  CloudBase runtime (`TCB_ENV`) and authenticates to the model channel by
  the environment itself.
- Function invocation permissions are governed by **cloud function security
  rules + identity auth**. Admin identities (your server-side API Key)
  normally pass the default rule; if you see `EXCEED_AUTHORITY`, review the
  function security rules in the console
  (see `docs/troubleshooting.md`).
- Size limits — both channels: ≤10 000 messages and ≤6 291 456 chars per
  message and in total. These are a second line of defence against runaway
  histories. The authoritative cap is the plugin's 6 MB serialized-event
  check, which measures real UTF-8 bytes and matches the documented
  CloudBase cloud-function request-body limit (error `EXCEED_MAX_PAYLOAD_SIZE`:
  JSON bodies 6 MB; text bodies only 100 KB). base64 is ASCII, so its chars
  and bytes coincide. Do not raise the event ceiling above 6 MB — the
  platform will cut the request off with 406 upstream.
  https://docs.cloudbase.net/error-code/EXCEED_MAX_PAYLOAD_SIZE

<p align="center"><img src="https://raw.githubusercontent.com/DaBinBinah/cloudbase-bridge/main/docs/images/logo.png" width="110" alt="CloudBase Bridge logo"></p>

# CloudBase Bridge

<p align="center">[English](README.md) | [简体中文](README.zh-CN.md) · **GitHub**: [DaBinBinah/cloudbase-bridge](https://github.com/DaBinBinah/cloudbase-bridge)</p>

Bring the AI quota of Tencent CloudBase's "小程序成长计划" (mini-program growth plan) into [Magpie](https://usemagpie.ai) as an ordinary OpenAI-compatible provider, through an `aiProxy` cloud function you deploy yourself. Once set up, it's just another provider on your account that any agent can use.

> Community project: not affiliated with Magpie or Tencent Cloud, and not reviewed or curated by Magpie.

![Growth-plan gift quota in the CloudBase console: 1B tokens + 100K image generations](docs/images/growth-plan-quota.png)

## Why a cloud function in the middle?

The gift quota only pays out on CloudBase SDK channels — calling the `/v1/ai/*` model endpoints directly is rejected (`403 AI_CHANNEL_NOT_ALLOWED`). So the plugin never talks to those endpoints. It calls your `aiProxy` cloud function through the official function-invocation endpoint, and the function calls the model with `@cloudbase/node-sdk`, which is allowed:

```
Agent ─► magpie gateway ─► plugin ── POST /v1/functions/aiProxy ──► aiProxy (your env) ── SDK ──► model
```

The function returns one complete result; the plugin reshapes it into OpenAI Chat Completions, and synthesizes SSE locally when the agent asked to stream.

## Models

| Model ID | Type | Context / output | Image input |
| --- | --- | --- | --- |
| `hy4-flash` | text chat | 1M | ✅ |
| `hy4` | text chat | 1M | ✅ |
| `hy4-preview` | text chat | 1M | — |
| `hy3` | text chat | 256K | ❌ |
| `deepseek-v4.1-flash` | text chat | 1M | ✅ |
| `deepseek-v4.1-flash-1017` | text chat | 1M | ✅ |
| `hy-image-v3.5-preview` | **image generation** | up to 4096x4096 | ✅ reference |

> The *Image input* column follows the
> [CloudBase model matrix](https://docs.cloudbase.net/ai/available-models):
> ✅ accepts `image_url` content parts (image in, text out), ❌ officially
> text-only, — not declared (this bridge treats it as text-only; override
> with `AI_PROXY_VISION_MODELS`).

No console opt-in needed; usage is deducted from the gift pack automatically
(tokens for text, the 100K image generations for images). Availability can
vary per environment — if CloudBase answers `AI_MODEL_NOT_SUPPORTED`, go by
what your environment actually supports.

### Using the image model

`hy-image-v3.5-preview` uses the Chat/Messages protocol
(`createImageModel` + `generateImage`), a different SDK channel from text
chat. The plugin routes it with `action: "image"`, but it stays one ordinary
OpenAI-compatible provider:

- Pick `cloudbase/hy-image-v3.5-preview` in your agent and send the prompt as
  a normal user message;
- The reply's `content` is a markdown image `![generated image](url)`.
  Non-streaming responses also carry a structured `image` field (`url`,
  `width`, `height`, `assembled_history`, `request_id`) for programmatic use;
- For 4K, a fixed seed, a watermark or reference images, add `size`
  (e.g. `4096x4096`), `seed`, `footnote`, `session` to the request body, or
  mix `{ type: "image_url", image_url: { url } }` parts (public URL or
  Base64) into `messages[].content`;
- Multi-turn editing: keep the same `session` and replay the previous reply's
  `image.assembled_history` into `messages` before the new user message
  (calling the cloud function directly exposes the full fields).

> ⚠️ Image URLs are temporary and **expire after 12 hours** — download them
> or transfer them to cloud storage promptly. See the
> [image model docs](https://docs.cloudbase.net/ai/image-model/hy-image-3.5-preview).

**Deployment requirements:** image generation needs aiProxy **1.2.0+**,
`@cloudbase/node-sdk ^3.18.3` (resolves `@cloudbase/ai >= 2.32.0`) and a
**900 s** cloud-function timeout. When upgrading from 1.1.0 you must redeploy
and let the platform reinstall dependencies — otherwise `ping` won't report
`imageModels` and the plugin won't list the model.

## What you need

1. A CloudBase environment with the growth plan (or an active Token Credits pack);
2. the `aiProxy` function deployed in that environment (next section);
3. a server-side API Key, created in the console under Environment settings → API Key.

> The API Key carries full admin rights over the environment. It lives only in Magpie's local auth store (`~/.config/magpie/plugin-auth.json`, mode 600) — don't commit it anywhere or hand it to anyone.

## Deploy aiProxy

Full steps (console upload, CLI, common pitfalls) live in [`cloudfunctions/aiProxy/README.md`](cloudfunctions/aiProxy/README.md). Quick CLI version:

```bash
cp cloudbaserc.example.json cloudbaserc.json   # set envId to yours
tcb login
tcb fn deploy aiProxy --force
tcb fn invoke aiProxy --params '{"action":"ping"}'   # expect {"ok":true,...}
```

Key points: a normal Event Function (not an HTTP function), Nodejs18.15 or newer, timeout **900 s** (image generation is slow, 4K especially; 120 s is enough for text chat alone, but both channels share one function — take the larger value), cloud dependency install enabled (`@cloudbase/node-sdk ^3.18.3`). No need to configure the environment id — the runtime injects `TCB_ENV` automatically. To add or remove models, set `AI_PROXY_ALLOWED_MODELS` (text) and `AI_PROXY_ALLOWED_IMAGE_MODELS` (image), comma-separated. **After upgrading from an older function, redeploy and reinstall dependencies**, or image generation won't be available.

## Install & login

```bash
magpie plugin add DaBinBinah/cloudbase-bridge   # or: the npm package opencode-cloudbase-bridge, or ./cloudbase-bridge for a local checkout
magpie plugin login cloudbase
```

Login walks you through the API Key, the environment ID, the region (mainland China / international), and the function name (press Enter to keep `aiProxy`). Models then appear as `cloudbase/hy3`, `cloudbase/hy4-preview`, and so on (if the `cloudbase` id is already taken, Magpie renames the provider to `cloudbase-plugin` — both prefixes work). Which models an account actually gets is decided by your deployed function's allowlist; the plugin queries it after login.

Sign out with `magpie plugin logout cloudbase`.

## Try it in a sandbox first

None of this touches your real magpie config or logins:

```bash
sb=$(mktemp -d)
m() { env HOME=$sb XDG_CONFIG_HOME=$sb/.config XDG_CACHE_HOME=$sb/.cache MAGPIE_ADDR=127.0.0.1:3499 magpie "$@"; }
m plugin add ./cloudbase-bridge </dev/null
m plugin login cloudbase
m provider test cloudbase        # or a single model: m provider test cloudbase hy3
```

No CloudBase environment yet? Walk the flow against the bundled mock gateway:

```bash
node scripts/mock-ai-proxy.mjs --port 8787
m plugin options cloudbase-bridge '{"gatewayBaseUrl":"http://127.0.0.1:8787"}'
```

`gatewayBaseUrl` is for testing only — it sends every request, including the API Key header, to that URL. Clear it afterwards with `m plugin options cloudbase-bridge off`.

## Options

| Option | What it does | Default |
| --- | --- | --- |
| `envId` / `region` / `functionName` | fallbacks beyond the login answers (handy under plain OpenCode, where the login prompts may not render) | — / `cn` / `aiProxy` |
| `timeoutMs` | how long one text function invocation may take; **image requests are automatically given 900 s** | 150000 |
| `gatewayBaseUrl` | testing-only gateway URL override | unset |

## When something goes wrong

Errors come back as OpenAI-style `{ error: { message, code } }`, and the message usually says what happened. The common ones: `FUNCTIONS_NOT_FOUND` (function not deployed, or wrong environment), `AI_CHANNEL_NOT_ALLOWED` (the function must call the model via the Node SDK), `AI_MODEL_NOT_SUPPORTED` (model not available in your environment), 401 `PERMISSION_DENIED` (wrong or wrong-type API Key), timeouts, and `EXCEED_TOKEN_QUOTA_LIMIT` (quota spent or expired). Fixes for each are in [`docs/troubleshooting.md`](docs/troubleshooting.md).

## Known limitations

- No true streaming: the upstream reply is one-shot, SSE is synthesized locally, so the first token only arrives when generation finishes — the same applies to images (the whole image must be generated first);
- tool calling needs aiProxy 1.1.0 or later — redeploy the function (`tcb fn deploy aiProxy --force`) after upgrading the plugin from 0.2.4 or earlier;
- image generation needs aiProxy 1.2.0+, `@cloudbase/node-sdk ^3.18.3` and a 900 s function timeout;
- **vision chat**: `hy4`, `hy4-flash`, `deepseek-v4.1-flash` and `deepseek-v4.1-flash-1017` accept `image_url` content parts (multimodal understanding — image in, text out); `hy3` and `hy4-preview` are text-only and return `IMAGE_INPUT_NOT_SUPPORTED`. Override that set with the function's `AI_PROXY_VISION_MODELS` env var. Video/file content parts are not forwarded;
- generated image URLs expire after **12 hours** — transfer them to cloud storage. Multi-turn `assembled_history` is currently exposed only in the non-streaming `image` structured field;
- very long outputs / 4K images can be slow; be patient;
- no quota reporting (no official API for it); the gift quota itself expires (6 months).

## Development

```bash
npm install
npm run check     # typecheck + build + 61 unit tests + host-like load check — no network, no real credentials
```

Publishing and listing steps are in [`docs/publish-checklist.md`](docs/publish-checklist.md).

## License

[MIT](LICENSE)

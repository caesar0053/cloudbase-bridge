# Deploy aiProxy (detailed guide)

The canonical, self-contained deployment guide lives with the function:
**[`cloudfunctions/aiProxy/README.md`](../cloudfunctions/aiProxy/README.md)**
(console upload + CLI + verification + security notes). This page is the
short version plus the checklist of things people commonly get wrong.

## TL;DR

```bash
# from the repository root
cp cloudbaserc.example.json cloudbaserc.json     # then set "envId"
tcb login
tcb fn deploy aiProxy --force                    # Event Function — no --httpFn
tcb fn invoke aiProxy --params '{"action":"ping"}'
# expect: {"ok":true,"service":"aiProxy","version":"1.2.0","env":"<your-env>","models":[…],"imageModels":["hy-image-v3.5-preview"]}
```

> **Upgrading for image generation:** you must redeploy aiProxy **1.2.0+**
> with `@cloudbase/node-sdk@^3.18.3` (let the platform reinstall
> dependencies) and raise the function timeout to **900 s**. Until the
> redeployed function reports `imageModels` in its ping, the plugin will not
> offer `hy-image-v3.5-preview`.

## Checklist

| Item | Value | Why |
| --- | --- | --- |
| Function type | **Event Function** (`exports.main`) | The plugin invokes it through the function-invocation endpoint, not HTTP triggers |
| Runtime | `Nodejs18.15`+ (locked after creation) | `@cloudbase/node-sdk` AI features need ≥ 3.16; **image model needs ≥ 3.18.3** (`@cloudbase/ai ≥ 2.32.0`) |
| Timeout | **900 s** | Image generation (especially 4K) is slow; the official image docs recommend 900 s. Text chat alone would need only 120 s, but the two channels share one function |
| Memory | 512 MB | Comfortable for validation + one SDK call + image payloads |
| Dependencies | `installDependency: true` (or zip `node_modules`) | Platform installs `@cloudbase/node-sdk@^3.18.3`; don't do both. Reinstall after bumping the version |
| Entry | `index.main` | Matches `exports.main(event, context)` |
| Env vars | none required (`TCB_ENV` is runtime-injected); optional `AI_PROXY_ALLOWED_MODELS` and `AI_PROXY_ALLOWED_IMAGE_MODELS` | No personal environment id is baked into the code |
| Same environment | The API Key used by the plugin must belong to **this environment** | Gateway URL is derived from the login envId |

## After deploying

1. In Magpie: `magpie plugin add …` + `magpie plugin login cloudbase`
   (env ID = this environment).
2. `magpie provider test cloudbase` — one tiny round-trip.
3. The provider model list now reflects the function's allowlist (via
   `{"action":"ping"}`).

If anything fails, match the error code against
[`docs/troubleshooting.md`](troubleshooting.md).

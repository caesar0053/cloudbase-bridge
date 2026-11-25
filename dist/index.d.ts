/**
 * CloudBase Bridge — Magpie/OpenCode provider plugin.
 *
 * Bridges Tencent CloudBase (Tencent CloudBase, "Mini Program Growth Plan")
 * models into an OpenCode-compatible provider by invoking a user-deployed
 * cloud function (default name: `aiProxy`) through the official CloudBase
 * HTTP function-invocation endpoint:
 *
 *   POST https://{envId}.api.tcloudbasegateway.com/v1/functions/{name}
 *   Authorization: Bearer <CloudBase API Key>
 *
 * The growth-plan quota is only spendable from CloudBase SDK channels; direct
 * calls to the HTTP AI model endpoints (`/v1/ai/...`) are rejected with
 * `AI_CHANNEL_NOT_ALLOWED`. The cloud function therefore calls the model with
 * `@cloudbase/node-sdk`. This plugin adapts the JSON into OpenAI Chat
 * Completions responses and synthesizes SSE frames when the agent requested
 * `stream: true`.
 *
 * Two channels share the same `aiProxy` function, selected by event.action:
 *   - "chat":  createModel("cloudbase").generateText  -> text chat models
 *              (hy3/hy4/deepseek...); aiProxy already returns a Chat
 *              Completions object.
 *   - "image": createImageModel("cloudbase").generateImage -> the
 *              hy-image-v3.5-preview image model. aiProxy passes the
 *              CloudBase image result through verbatim; this plugin
 *              reshapes choices[0].delta.image into a Chat Completions
 *              message (a markdown image + a structured `image` field), so
 *              the same OpenAI-compatible surface works for both.
 * Image requests allow a much longer timeout (900 s) and a larger payload
 * (base64 reference images), per the official image-model docs.
 *
 * Magpie plugin contract (verified against https://usemagpie.ai/docs/zh/plugins
 * on 2026-11-09):
 * - The module must only export the plugin entry function(s); every exported
 *   function is treated as a plugin by the host. Test helpers live on the
 *   exported `_internal` object (recommended by the official docs).
 * - `loader(getAuth, provider)` may return a custom `fetch(input, init)`; the
 *   gateway already converts agent requests into Chat Completions and hands
 *   them to that fetch. We never need a local HTTP server.
 * - Model-availability errors must be answered with 403/404 (never 401) so
 *   the gateway treats them as model rejections instead of a dead login.
 * - `dist/` must be committed so the GitHub-topic discovery path can load
 *   the plugin straight from the repository.
 */
export declare const PLUGIN_VERSION: "0.3.0";
/**
 * Model catalog (text chat models).
 *
 * Sources:
 * - https://docs.cloudbase.net/ai/ai-inspire-plan-new-models (checked
 *   2026-11-09): `hy4-preview` (1M ctx), `hy3` (256K ctx) and
 *   `deepseek-v4.1-flash` (1M ctx) are the growth-plan gift-quota text
 *   models; no console opt-in needed.
 * - 2026-11-23 model refresh: my environment now also offers `hy4` and
 *   `hy4-flash` (both enabled here), alongside `deepseek-v4.1-flash-1017`
 *   which I verified through aiProxy earlier (2026-11). Availability may
 *   differ per environment — CloudBase answers `AI_MODEL_NOT_SUPPORTED`
 *   where a model is not available, and the per-account model list follows
 *   the deployed function's allowlist (see the `provider.models` hook).
 *   Official docs do not list `hy4-flash` yet; its 1M context follows the
 *   hy4 family — adjust if your console says otherwise.
 *
 * `verified` means "enabled by default", not "officially documented".
 *
 * Image-generation models live in a separate IMAGE_MODEL_CATALOG below:
 * they use createImageModel/generateImage (Chat/Messages protocol), not
 * generateText, and are routed with event.action = "image".
 */
interface ModelSpec {
    name: string;
    context: number;
    output: number;
    verified: boolean;
}
/**
 * Image-generation model catalog. `hy-image-v3.5-preview` is the growth-plan
 * image model (the quota screenshot shows 100K image generations). It speaks
 * the Chat/Messages protocol and returns choices[0].delta.image; this plugin
 * reshapes that into a Chat Completions markdown image.
 * Docs: https://docs.cloudbase.net/ai/image-model/hy-image-3.5-preview
 *
 * `context`/`output` are nominal (the image model has no token context in
 * the chat sense); they only satisfy the provider model-spec shape.
 */
interface ImageModelSpec {
    name: string;
    context: number;
    output: number;
    verified: boolean;
}
declare function isImageModel(model: string): boolean;
type Json = Record<string, unknown>;
interface AuthData {
    type?: string;
    key?: string;
    metadata?: Record<string, unknown>;
}
interface AccountConfig {
    apiKey: string;
    envId: string;
    functionName: string;
    region: "cn" | "intl";
    timeoutMs: number;
    gatewayBaseUrl?: string;
}
interface PluginInput {
    client?: {
        app?: {
            log?: (args: {
                level: string;
                message: string;
                service?: string;
            }) => Promise<unknown>;
        };
    };
    project?: unknown;
    directory?: string;
    magpie?: {
        options?: Json;
    };
}
interface PluginOptions {
    envId?: string;
    functionName?: string;
    region?: "cn" | "intl";
    timeoutMs?: number;
    gatewayBaseUrl?: string;
}
interface ChatCompletionsBody {
    model: unknown;
    messages: unknown;
    stream?: unknown;
    temperature?: unknown;
    top_p?: unknown;
    max_tokens?: unknown;
    max_completion_tokens?: unknown;
    tools?: unknown;
    tool_choice?: unknown;
    size?: unknown;
    seed?: unknown;
    generate_max_pixels?: unknown;
    resize_max_pixels?: unknown;
    session?: unknown;
    footnote?: unknown;
    use_search_tool?: unknown;
}
interface ToolCall {
    id: string;
    type: "function";
    function: {
        name: string;
        arguments: string;
    };
}
/**
 * Strip a provider prefix (`cloudbase/`, `cloudbase-plugin/`) from a model
 * id, only at the leading boundary and only for known prefixes, collapsing
 * accidental repeats. Anything else is returned as-is.
 */
declare function normalizeModel(raw: unknown): string | null;
declare function isValidEnvId(envId: string): boolean;
declare function isValidFunctionName(name: string): boolean;
declare function gatewayBase(cfg: AccountConfig): string;
declare function invokeUrl(cfg: AccountConfig): string;
/**
 * Combine the agent's AbortSignal with our own timeout. Uses
 * AbortSignal.any when available (Bun and modern Node do), otherwise a
 * manual controller with forwarded listeners.
 */
declare function combineSignals(agentSignal: AbortSignal | undefined, timeoutSignal: AbortSignal | undefined): AbortSignal | undefined;
declare function chunkText(text: string, size: number): string[];
interface ErrorOptions {
    code?: string;
    requestId?: string;
    headers?: Record<string, string>;
}
declare function errorResponse(status: number, message: string, options?: ErrorOptions): Response;
/**
 * Map a gateway-level error (the CloudBase HTTP API answered non-2xx with
 * {code, message, requestId}) to an OpenAI-style response with the right
 * status semantics for Magpie failover:
 * - 401 only for genuinely bad credentials (marks the account for re-login);
 * - 403/404 for model/channel problems (gateway treats them as model
 *   rejections, per the Magpie plugin docs);
 * - 429 for quota/concurrency so failover can try another model/account;
 * - 504 for timeouts, 502 for function failures.
 */
declare function mapGatewayError(status: number, body: {
    code?: string;
    message?: string;
    requestId?: string;
}): Response;
/**
 * Map an error envelope returned by aiProxy itself
 * ({ error: { code, message } } inside a 200 response).
 */
declare function mapFunctionError(err: Json, requestId?: string): Response;
/**
 * True when any message carries an OpenAI `image_url` content part. Vision
 * chat requests need the same generous event ceiling as image-generation
 * requests, because base64 data URLs are far larger than plain text.
 */
declare function hasImageParts(messages: unknown): boolean;
/**
 * Build the aiProxy invocation event. Text models use action "chat";
 * image models use action "image" and carry the image-model extras straight
 * through (the cloud function validates them before calling generateImage).
 */
declare function buildInvokeEvent(body: ChatCompletionsBody, model: string): Json;
interface NormalizedCompletion {
    id: string;
    created: number;
    model: string;
    content: string;
    toolCalls: ToolCall[];
    finishReason: string;
    usage: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
    } | null;
    /** Present only for image results: the structured CloudBase image payload
     * (url/width/height/assembled_history/request_id/...), so callers that
     * talk to the plugin directly can consume the raw image, not just the
     * markdown rendering in `content`. */
    image?: Json;
}
/**
 * Validate the aiProxy reply (an OpenAI Chat Completions object) well enough
 * to adapt it. Returns null when the shape is unusable.
 */
declare function normalizeCompletion(value: unknown): NormalizedCompletion | null;
/**
 * Adapt a CloudBase generateImage result (passed through verbatim by
 * aiProxy's image action) into a NormalizedCompletion. The delivered image
 * is choices[0].delta.image; we render it as a markdown image in `content`
 * so any OpenAI-compatible agent can display/reference it, and keep the
 * full structured payload in `image` for programmatic consumers.
 *
 * Returns null when there is no usable image (the cloud function already
 * guards this, but the plugin stays defensive).
 */
declare function adaptImageResult(value: unknown): NormalizedCompletion | null;
/**
 * Synthesize an SSE stream from the one-shot completion. Frames follow the
 * OpenAI Chat Completions streaming format: a role chunk, content chunks
 * (split on code-point boundaries), a final chunk carrying finish_reason and
 * usage, then the `data: [DONE]` sentinel.
 */
declare function sseResponse(completion: NormalizedCompletion, echoModel: string): Response;
declare function jsonCompletionResponse(completion: NormalizedCompletion, echoModel: string): Response;
declare function resolveAccountConfig(auth: AuthData | undefined | null, options: PluginOptions | undefined, inputMagpieOptions: Json | undefined): AccountConfig | null;
/**
 * Magpie/OpenCode plugin entry. Only this function and the `_internal`
 * object are exported from the module (every exported *function* is loaded
 * as a plugin by the host).
 */
export declare const CloudbaseBridge: (input?: PluginInput, options?: PluginOptions) => Promise<{
    config: (cfg: {
        provider?: Record<string, Json>;
    } & Json) => Promise<void>;
    auth: {
        provider: string;
        methods: {
            type: string;
            label: string;
            placeholder: string;
            prompts: Array<Record<string, unknown>>;
        }[];
        loader(getAuth: () => Promise<AuthData | undefined>): Promise<{
            baseURL?: undefined;
            fetch?: undefined;
        } | {
            baseURL: string;
            fetch: (input: unknown, init?: {
                method?: string;
                headers?: unknown;
                body?: unknown;
                signal?: AbortSignal;
            } | undefined) => Promise<Response>;
        }>;
    };
    provider: {
        id: string;
        /**
         * Refine the per-account model list from aiProxy's allowlists
         * (`{ action: "ping" }` returns `models` + `imageModels` on v1.2.0+).
         * Older functions omit `imageModels`, in which case image models simply
         * don't appear until the function is redeployed. On any failure keep
         * provider.models so Magpie falls back gracefully, per the plugin docs.
         */
        models(provider: {
            models?: Record<string, Json>;
        }, ctx?: {
            auth?: AuthData;
        }): Promise<Record<string, Json>>;
    };
}>;
export declare const _internal: {
    PLUGIN_VERSION: "0.3.0";
    PROVIDER_ID: string;
    DEFAULT_FUNCTION_NAME: string;
    DEFAULT_TIMEOUT_MS: number;
    IMAGE_TIMEOUT_MS: number;
    DEFAULT_MAX_EVENT_BYTES: number;
    IMAGE_MAX_EVENT_BYTES: number;
    MODEL_CATALOG: Readonly<Record<string, ModelSpec>>;
    IMAGE_MODEL_CATALOG: Readonly<Record<string, ImageModelSpec>>;
    isImageModel: typeof isImageModel;
    hasImageParts: typeof hasImageParts;
    isValidEnvId: typeof isValidEnvId;
    isValidFunctionName: typeof isValidFunctionName;
    gatewayBase: typeof gatewayBase;
    invokeUrl: typeof invokeUrl;
    normalizeModel: typeof normalizeModel;
    resolveAccountConfig: typeof resolveAccountConfig;
    buildInvokeEvent: typeof buildInvokeEvent;
    normalizeCompletion: typeof normalizeCompletion;
    adaptImageResult: typeof adaptImageResult;
    chunkText: typeof chunkText;
    sseResponse: typeof sseResponse;
    jsonCompletionResponse: typeof jsonCompletionResponse;
    errorResponse: typeof errorResponse;
    mapGatewayError: typeof mapGatewayError;
    mapFunctionError: typeof mapFunctionError;
    combineSignals: typeof combineSignals;
};
export {};

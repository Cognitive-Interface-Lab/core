import { CoreError, type StoredCredential } from "@core/contracts";
import { startCallbackServer } from "./loopback.js";
import { createPkce } from "./pkce.js";

export type OpenUrl = (url: string) => void | Promise<void>;

export type FlowOptions = {
  /** Opens the sign-in page for the user. */
  openUrl: OpenUrl;
  fetch?: typeof fetch;
  signal?: AbortSignal;
  /** How long to wait for the browser to come back. Default 5 minutes. */
  timeoutMs?: number;
  /** Port for the local callback receiver. 0 picks a free one. */
  port?: number;
};

const AUTH_URL = "https://openrouter.ai/auth";
const KEYS_URL = "https://openrouter.ai/api/v1/auth/keys";
const MAX_PROVIDER_MESSAGE = 200;

/**
 * Browser sign-in to OpenRouter: PKCE with a localhost callback on any free port. OpenRouter then
 * issues an API key owned by the user's own account.
 */
export async function signInOpenRouter(opts: FlowOptions & { keyLabel?: string }): Promise<StoredCredential> {
  const server = await startCallbackServer({ path: "/callback", port: opts.port ?? 0 });
  try {
    const { verifier, challenge } = createPkce();
    const url = new URL(AUTH_URL);
    url.searchParams.set("callback_url", server.redirectUri);
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("key_label", opts.keyLabel ?? "core");
    await opts.openUrl(url.toString());

    const reply = await server.wait({
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    });
    const code = reply.get("code");
    if (!code) throw new CoreError("auth", "OpenRouter sign-in was cancelled");

    const key = await exchange(code, verifier, opts.fetch ?? fetch, opts.signal);
    return { kind: "api-key", apiKey: key };
  } finally {
    await server.close();
  }
}

async function exchange(code: string, verifier: string, doFetch: typeof fetch, signal?: AbortSignal): Promise<string> {
  const secrets = [code, verifier];
  let response: Response;
  try {
    response = await doFetch(KEYS_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: "S256" }),
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    throw networkFailure("OpenRouter", error, signal);
  }
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const message = providerMessage(body, secrets);
    throw new CoreError("auth", `OpenRouter sign-in failed (HTTP ${response.status})${message ? `: ${message}` : ""}`);
  }
  const key = typeof body === "object" && body !== null ? (body as { key?: unknown }).key : undefined;
  if (typeof key !== "string" || key.length === 0) {
    throw new CoreError("auth", "OpenRouter did not return a key");
  }
  return key;
}

/** OpenRouter's `error.message`, cleaned of anything secret and kept short. */
function providerMessage(body: unknown, secrets: string[]): string | undefined {
  const error = typeof body === "object" && body !== null ? (body as { error?: unknown }).error : undefined;
  const message =
    typeof error === "string"
      ? error
      : typeof error === "object" && error !== null
        ? (error as { message?: unknown }).message
        : undefined;
  if (typeof message !== "string" || message.length === 0) return undefined;
  const cleaned = secrets.filter((secret) => secret.length > 0).reduce((text, secret) => text.split(secret).join("[redacted]"), message);
  return cleaned.length > MAX_PROVIDER_MESSAGE ? `${cleaned.slice(0, MAX_PROVIDER_MESSAGE)}…` : cleaned;
}

function networkFailure(provider: string, error: unknown, signal?: AbortSignal): CoreError {
  const name = typeof error === "object" && error !== null ? (error as { name?: unknown }).name : undefined;
  if (name === "TimeoutError") return new CoreError("timeout", `${provider}: the request timed out`);
  if (name === "AbortError" || signal?.aborted) return new CoreError("aborted", "sign-in was cancelled");
  return new CoreError("unavailable", `cannot reach ${provider}`);
}

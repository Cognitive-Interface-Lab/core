import { CoreError, type StoredCredential } from "@core/contracts";
import type { ErrorCode } from "@core/contracts";
import type { OAuthCredential, Refresher } from "../persistent.js";
import { startCallbackServer } from "./loopback.js";
import { createPkce, randomState } from "./pkce.js";
import type { FlowOptions } from "./openrouter.js";

export const CLOUDFLARE_DEFAULT_SCOPES = "account-settings.read ai.read ai.write";
/** The owner registers `http://localhost:8976/oauth/callback` on the OAuth client, so the port is fixed. */
export const CLOUDFLARE_CALLBACK_PORT = 8976;

export type CloudflareAccount = { id: string; name: string };

const AUTH_URL = "https://dash.cloudflare.com/oauth2/auth";
const TOKEN_URL = "https://dash.cloudflare.com/oauth2/token";
const ACCOUNTS_URL = "https://api.cloudflare.com/client/v4/accounts";
const DEFAULT_LIFETIME_MS = 60_000;
const MAX_PROVIDER_MESSAGE = 200;
const GRANT_ERRORS = new Set(["invalid_grant", "invalid_client", "unauthorized_client", "access_denied"]);

/**
 * Browser sign-in to Cloudflare: authorization code with PKCE on a public OAuth client (no secret),
 * the same endpoints Trilix and `wrangler login` use. The token is short-lived; see `cloudflareRefresher`.
 * The credential has no account yet: the caller picks one of `accounts`.
 */
export async function signInCloudflare(
  opts: FlowOptions & { clientId: string; scopes?: string; clock?: () => number },
): Promise<{ credential: StoredCredential; accounts: CloudflareAccount[] }> {
  const doFetch = opts.fetch ?? fetch;
  const clock = opts.clock ?? Date.now;
  const server = await startCallbackServer({ path: "/oauth/callback", port: opts.port ?? CLOUDFLARE_CALLBACK_PORT });
  try {
    const { verifier, challenge } = createPkce();
    const state = randomState();
    const url = new URL(AUTH_URL);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", opts.clientId);
    url.searchParams.set("redirect_uri", server.redirectUri);
    url.searchParams.set("scope", opts.scopes ?? CLOUDFLARE_DEFAULT_SCOPES);
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    await opts.openUrl(url.toString());

    const reply = await server.wait({
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    });
    const error = reply.get("error");
    if (error) {
      const description = reply.get("error_description");
      throw new CoreError(
        "auth",
        `Cloudflare sign-in failed: ${shorten(error)}${description ? `: ${shorten(description)}` : ""}`,
      );
    }
    if (reply.get("state") !== state) {
      throw new CoreError("auth", "the sign-in reply did not match this request; try again");
    }
    const code = reply.get("code");
    if (!code) throw new CoreError("auth", "Cloudflare sign-in was cancelled");

    const token = await requestToken(
      doFetch,
      { grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: server.redirectUri, client_id: opts.clientId },
      [code, verifier],
      opts.signal,
    );
    const credential: StoredCredential = {
      kind: "oauth",
      accessToken: token.accessToken,
      expiresAt: clock() + token.lifetimeMs,
      clientId: opts.clientId,
      ...(token.refreshToken ? { refreshToken: token.refreshToken } : {}),
    };
    const accounts = await listCloudflareAccounts(token.accessToken, {
      fetch: doFetch,
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    return { credential, accounts };
  } finally {
    await server.close();
  }
}

/** Renews a Cloudflare sign-in. Keeps the old refresh token when none comes back, and keeps `accountId` and `clientId`. */
export function cloudflareRefresher(opts?: { fetch?: typeof fetch; clock?: () => number }): Refresher {
  const doFetch = opts?.fetch ?? fetch;
  const clock = opts?.clock ?? Date.now;
  return async (current: OAuthCredential, signal?: AbortSignal): Promise<StoredCredential> => {
    if (!current.refreshToken || !current.clientId) {
      throw new CoreError("auth", "Cloudflare: the saved sign-in cannot be renewed; sign in again");
    }
    const token = await requestToken(
      doFetch,
      { grant_type: "refresh_token", refresh_token: current.refreshToken, client_id: current.clientId },
      [current.refreshToken],
      signal,
    );
    return {
      kind: "oauth",
      accessToken: token.accessToken,
      refreshToken: token.refreshToken ?? current.refreshToken,
      expiresAt: clock() + token.lifetimeMs,
      clientId: current.clientId,
      ...(current.accountId !== undefined ? { accountId: current.accountId } : {}),
    };
  };
}

/** The accounts the token can use. A missing name falls back to the id. */
export async function listCloudflareAccounts(
  token: string,
  opts?: { fetch?: typeof fetch; signal?: AbortSignal },
): Promise<CloudflareAccount[]> {
  const doFetch = opts?.fetch ?? fetch;
  let response: Response;
  try {
    response = await doFetch(ACCOUNTS_URL, {
      method: "GET",
      headers: { authorization: `Bearer ${token}` },
      ...(opts?.signal ? { signal: opts.signal } : {}),
    });
  } catch (error) {
    throw networkFailure(error, opts?.signal);
  }
  if (!response.ok) {
    throw new CoreError(codeForStatus(response.status), `Cloudflare: could not list accounts (HTTP ${response.status})`);
  }
  const body: unknown = await response.json().catch(() => undefined);
  const result = typeof body === "object" && body !== null ? (body as { result?: unknown }).result : undefined;
  if (!Array.isArray(result)) throw new CoreError("unknown", "Cloudflare: unexpected response to the account listing");
  const accounts: CloudflareAccount[] = [];
  for (const item of result) {
    const { id, name } = (typeof item === "object" && item !== null ? item : {}) as { id?: unknown; name?: unknown };
    if (typeof id !== "string" || id.length === 0) continue;
    accounts.push({ id, name: typeof name === "string" && name.length > 0 ? name : id });
  }
  return accounts;
}

type Token = { accessToken: string; refreshToken?: string; lifetimeMs: number };

async function requestToken(
  doFetch: typeof fetch,
  form: Record<string, string>,
  secrets: string[],
  signal?: AbortSignal,
): Promise<Token> {
  let response: Response;
  try {
    response = await doFetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams(form).toString(),
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    throw networkFailure(error, signal);
  }
  const body: unknown = await response.json().catch(() => undefined);
  const fields = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;

  if (!response.ok) {
    const error = typeof fields["error"] === "string" ? fields["error"] : undefined;
    const description = typeof fields["error_description"] === "string" ? fields["error_description"] : undefined;
    const code: ErrorCode = error !== undefined && GRANT_ERRORS.has(error) ? "auth" : codeForStatus(response.status);
    const detail = [error, description]
      .filter((part): part is string => part !== undefined)
      .map((part) => shorten(redact(part, secrets)))
      .join(": ");
    throw new CoreError(code, `Cloudflare token request failed (HTTP ${response.status})${detail ? `: ${detail}` : ""}`);
  }
  const accessToken = fields["access_token"];
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    throw new CoreError("auth", "Cloudflare did not return an access token");
  }
  const refreshToken = fields["refresh_token"];
  const expiresIn = fields["expires_in"];
  const lifetimeMs =
    typeof expiresIn === "number" && Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn * 1000 : DEFAULT_LIFETIME_MS;
  return {
    accessToken,
    lifetimeMs,
    ...(typeof refreshToken === "string" && refreshToken.length > 0 ? { refreshToken } : {}),
  };
}

function networkFailure(error: unknown, signal?: AbortSignal): CoreError {
  const name = typeof error === "object" && error !== null ? (error as { name?: unknown }).name : undefined;
  if (name === "TimeoutError") return new CoreError("timeout", "Cloudflare: the request timed out");
  if (name === "AbortError" || signal?.aborted) return new CoreError("aborted", "sign-in was cancelled");
  return new CoreError("unavailable", "cannot reach Cloudflare");
}

function codeForStatus(status: number): ErrorCode {
  if (status === 401 || status === 403) return "auth";
  if (status === 404) return "not_found";
  if (status === 400 || status === 422) return "bad_request";
  if (status === 408) return "timeout";
  if (status === 429) return "rate_limit";
  if (status >= 500) return "unavailable";
  return "unknown";
}

function redact(text: string, secrets: string[]): string {
  return secrets.filter((secret) => secret.length > 0).reduce((result, secret) => result.split(secret).join("[redacted]"), text);
}

function shorten(text: string): string {
  return text.length > MAX_PROVIDER_MESSAGE ? `${text.slice(0, MAX_PROVIDER_MESSAGE)}…` : text;
}

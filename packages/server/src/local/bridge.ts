import { CoreError, PairRequestSchema } from "@core/contracts";
import { errorResponse, HttpError, jsonResponse, readBody } from "../errors.js";
import type { CoreHandlerOptions, Middleware } from "../handler.js";
import { timingSafeEqual, type ServeTokens } from "./tokens.js";

/** How long the user has to answer a pairing request. */
const PAIR_TIMEOUT_MS = 120_000;

/** How long an origin waits after a denied pairing before it may ask again. */
const DENIAL_COOLDOWN_MS = 60_000;

/** Asks the user whether `origin` may pair with the code. `signal` aborts on timeout or disconnect. */
export type PairApprover = (
  request: { origin: string; code: string; name?: string },
  signal: AbortSignal,
) => Promise<boolean>;

type Outcome = { kind: "answered"; approved: boolean } | { kind: "failed" } | { kind: "timeout" };

const CORS_METHODS = "GET, POST, DELETE";
const CORS_HEADERS = "authorization, content-type";

/**
 * The local bridge for `core serve`: who may reach the server on 127.0.0.1, and how. Every request
 * passes the Host check (DNS rebinding), then either comes from a program on the machine (no
 * Origin, local token) or from a website that the user paired (Origin, its own token). Every
 * other website is refused.
 */
export function localBridge(opts: {
  port: number;
  tokens: ServeTokens;
  localToken: string;
  approve: PairApprover;
  now?: () => number;
}): { authenticate: CoreHandlerOptions["authenticate"]; middleware: Middleware } {
  const { port, tokens, localToken, approve } = opts;
  const now = opts.now ?? (() => Date.now());

  /** Set while a pairing waits for the user. One at a time, from any origin. */
  let pending = false;
  /** When each origin was last denied a pairing. */
  const denied = new Map<string, number>();

  const hostOk = (host: string | null): boolean => {
    if (host === null) return false;
    const value = host.toLowerCase();
    return value === `127.0.0.1:${port}` || value === `localhost:${port}`;
  };

  const remember = (origin: string): void => {
    const at = now();
    for (const [key, when] of denied) {
      if (at - when >= DENIAL_COOLDOWN_MS) denied.delete(key);
    }
    denied.set(origin, at);
  };

  const cooling = (origin: string): boolean => {
    const when = denied.get(origin);
    return when !== undefined && now() - when < DENIAL_COOLDOWN_MS;
  };

  const pair = async (request: Request, origin: string): Promise<Response> => {
    const body = await readBody(request, PairRequestSchema);
    if (pending) return errorResponse(new HttpError("rate_limit", "a pairing is already pending", 429));
    if (cooling(origin)) return errorResponse(new HttpError("rate_limit", "try again later", 429));

    pending = true;
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    request.signal.addEventListener("abort", abort);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<Outcome>((resolve) => {
        timer = setTimeout(() => {
          controller.abort();
          resolve({ kind: "timeout" });
        }, PAIR_TIMEOUT_MS);
      });
      const approval = Promise.resolve()
        .then(() =>
          approve(
            { origin, code: body.code, ...(body.name !== undefined && { name: body.name }) },
            controller.signal,
          ),
        )
        .then(
          (approved): Outcome => ({ kind: "answered", approved }),
          (): Outcome => ({ kind: "failed" }),
        );
      const outcome = await Promise.race([approval, timeout]);

      if (outcome.kind === "timeout") return errorResponse(new HttpError("timeout", "pairing timed out", 504));
      if (outcome.kind === "failed") return errorResponse(new HttpError("unknown", "pairing failed", 500));
      if (outcome.approved !== true) {
        remember(origin);
        return errorResponse(new HttpError("auth", "pairing denied", 403));
      }
      const token = await tokens.issue(origin);
      return jsonResponse({ origin, token });
    } finally {
      pending = false;
      clearTimeout(timer);
      request.signal.removeEventListener("abort", abort);
    }
  };

  const middleware: Middleware = async (request, next) => {
    try {
      if (!hostOk(request.headers.get("host"))) {
        return errorResponse(new HttpError("bad_request", "unexpected Host", 421));
      }

      const path = new URL(request.url).pathname;
      const origin = request.headers.get("origin");

      if (origin === null) {
        if ((request.method === "POST" || request.method === "DELETE") && path === "/v1/pair") {
          return errorResponse(new CoreError("bad_request", "Origin required"));
        }
        return next(request);
      }

      const pairable = isPairable(origin);
      const paired = (await tokens.origins()).includes(origin);

      if (request.method === "OPTIONS" && request.headers.has("access-control-request-method")) {
        if (!paired && !(path === "/v1/pair" && pairable)) {
          return errorResponse(new HttpError("auth", "origin is not paired", 403));
        }
        const headers = new Headers({
          "access-control-allow-origin": origin,
          vary: "Origin",
          "access-control-allow-methods": CORS_METHODS,
          "access-control-allow-headers": CORS_HEADERS,
          "access-control-max-age": "600",
          "cache-control": "no-store",
        });
        if (request.headers.get("access-control-request-private-network") === "true") {
          headers.set("access-control-allow-private-network", "true");
        }
        return new Response(null, { status: 204, headers });
      }

      if (request.method === "POST" && path === "/v1/pair") {
        if (!pairable) return errorResponse(new HttpError("auth", "origin may not pair", 403));
        return withCors(await pair(request, origin), origin);
      }

      if (request.method === "DELETE" && path === "/v1/pair") {
        const token = bearer(request);
        if (token !== null && (await tokens.verify(origin, token))) {
          await tokens.forget(origin);
          return withCors(new Response(null, { status: 204, headers: { "cache-control": "no-store" } }), origin);
        }
        const answer = errorResponse(new HttpError("auth", "authentication required", 401));
        return paired ? withCors(answer, origin) : answer;
      }

      if (!paired) return errorResponse(new HttpError("auth", "origin is not paired", 403));
      return withCors(await next(request), origin);
    } catch (error) {
      return errorResponse(error);
    }
  };

  const authenticate: CoreHandlerOptions["authenticate"] = async (request) => {
    const token = bearer(request);
    if (token === null) return null;
    const origin = request.headers.get("origin");
    if (origin !== null) {
      return (await tokens.verify(origin, token)) ? { id: "local", channel: "web" } : null;
    }
    return (await timingSafeEqual(token, localToken)) ? { id: "local", channel: "local" } : null;
  };

  return { authenticate, middleware };
}

/** An origin a user may pair from: exactly a serialised origin, https anywhere or http on loopback. */
function isPairable(origin: string): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.origin !== origin) return false;
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
}

/** The token of `Authorization: Bearer <token>`, or null. */
function bearer(request: Request): string | null {
  const match = request.headers.get("authorization")?.match(/^bearer (\S+)$/i);
  return match?.[1] ?? null;
}

/** A copy of `response` that a site from `origin` may read. The body streams through untouched. */
function withCors(response: Response, origin: string): Response {
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", origin);
  headers.append("vary", "Origin");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

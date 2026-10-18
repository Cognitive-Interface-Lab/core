import type { Principal } from "@core/contracts";
import {
  MemoryCredentialStore,
  MockProvider,
  ProviderRegistry,
  type CredentialStore,
  type ModelProvider,
} from "@core/models";
import { createCoreHandler, type CoreHandler, type CoreHandlerOptions } from "../src/index.js";

/** Where every request builder points. The handler is called directly, so nothing listens here. */
export const BASE_URL = "http://127.0.0.1:8977";

/** The principal `authenticate` returns for a request carrying `AUTH_HEADER`. */
export const PRINCIPAL: Principal = { id: "user-1", channel: "web" };

/** The Authorization header value the default `authenticate` accepts. */
export const AUTH_HEADER = "Bearer test";

/** `authenticate` for tests: the principal for `authorization: Bearer test`, otherwise null. */
export async function testAuthenticate(request: Request): Promise<Principal | null> {
  return request.headers.get("authorization") === AUTH_HEADER ? PRINCIPAL : null;
}

/** A registry holding exactly the given providers (default: one `MockProvider({ id: "mock" })`). */
export function registryOf(...providers: ModelProvider[]): ProviderRegistry {
  const registry = new ProviderRegistry();
  for (const provider of providers.length > 0 ? providers : [new MockProvider({ id: "mock" })]) {
    registry.register(provider);
  }
  return registry;
}

/**
 * A handler with test defaults: local mode, version "0.0.0-test", `testAuthenticate`, a fresh
 * `MemoryCredentialStore` per request and a fresh registry holding one `MockProvider({ id: "mock" })`
 * per request. Any option can be overridden; pass `registryFor: undefined` explicitly to get the
 * server's own default (the presets) instead.
 */
export function createTestHandler(overrides: Partial<CoreHandlerOptions> = {}): CoreHandler {
  const options: CoreHandlerOptions = {
    mode: "local",
    version: "0.0.0-test",
    authenticate: testAuthenticate,
    credentialsFor: (): CredentialStore => new MemoryCredentialStore(),
    registryFor: () => registryOf(),
    ...overrides,
  };
  return createCoreHandler(options);
}

/** A handler whose registry holds exactly the given providers, with the other defaults of `createTestHandler`. */
export function createTestHandlerWith(
  providers: ModelProvider[],
  overrides: Partial<CoreHandlerOptions> = {},
): CoreHandler {
  return createTestHandler({ registryFor: () => registryOf(...providers), ...overrides });
}

/** Options for a request builder. `auth: false` omits the Authorization header. */
export type RequestOptions = Omit<RequestInit, "method" | "body"> & { auth?: boolean };

function build(method: string, path: string, body: BodyInit | undefined, init: RequestOptions = {}): Request {
  const { auth = true, headers, ...rest } = init;
  const merged = new Headers(headers);
  if (auth && !merged.has("authorization")) merged.set("authorization", AUTH_HEADER);
  return new Request(`${BASE_URL}${path}`, { ...rest, method, headers: merged, ...(body === undefined ? {} : { body }) });
}

/** A GET request with the auth header (unless `init.auth` is false). */
export function get(path: string, init?: RequestOptions): Request {
  return build("GET", path, undefined, init);
}

/** A POST request with a JSON body and `content-type: application/json`, plus the auth header by default. */
export function post(path: string, body: unknown, init?: RequestOptions): Request {
  const request = build("POST", path, JSON.stringify(body), init);
  if (!request.headers.has("content-type")) request.headers.set("content-type", "application/json");
  return request;
}

/** A DELETE request with the auth header (unless `init.auth` is false). */
export function del(path: string, init?: RequestOptions): Request {
  return build("DELETE", path, undefined, init);
}

/** The response body parsed as JSON. */
export async function readJson<T = unknown>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

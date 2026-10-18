import { CoreError, type ModelRef, type Principal } from "@core/contracts";
import type { GraphStore } from "@core/graph";
import { createPresetRegistry, type CredentialStore, type ProviderRegistry } from "@core/models";
import { Hono, type Context } from "hono";
import { errorResponse, HttpError, readBody, type BodySchema } from "./errors.js";
import { meta } from "./routes/meta.js";

/** One route as the API describes it, for the OpenAPI document and for the 405 check. */
export type RouteSpec = {
  method: "GET" | "POST" | "DELETE";
  /** Hono style, e.g. "/v1/graphs/:id". */
  path: string;
  summary: string;
  /** A contracts type name. */
  body?: string;
  /** A type name, "TurnEvent stream" or "none". */
  answer: string;
};

/** Wraps the request handling; call `next` with the request to continue, or answer without it. */
export type Middleware = (
  request: Request,
  next: (request: Request) => Promise<Response>,
) => Promise<Response>;

/** Which graphs a principal may read, write, create or list. The host app decides; the server enforces. */
export type GraphAccess = {
  canRead(principal: Principal, graphId: string): Promise<boolean>;
  canWrite(principal: Principal, graphId: string): Promise<boolean>;
  /** Called after a graph is created for the principal, so the host can record ownership. */
  created(principal: Principal, graphId: string): Promise<void>;
  list(principal: Principal): Promise<string[]>;
};

export type CoreHandlerOptions = {
  /** "local" when the core runs on the user's machine, "hosted" when a host app serves many users. */
  mode: "local" | "hosted";
  /** Reported by /v1/health. */
  version: string;
  /** Path the handler is mounted under, e.g. "/api/core". Default "": routes live at the root. */
  basePath?: string;
  /** Resolves the request to a principal, or null when the request is not authenticated. */
  authenticate(request: Request): Promise<Principal | null>;
  /** Provider credentials for this principal. The host app keeps the secrets; the server never stores them. */
  credentialsFor(principal: Principal, request: Request): CredentialStore | Promise<CredentialStore>;
  /** Builds the providers for a request. Default: the presets, configured from `credentialsFor`. */
  registryFor?(credentials: CredentialStore): ProviderRegistry;
  /** Passed to the preset providers, so a host can route their HTTP calls. */
  fetch?: typeof fetch;
  /** Timeout for a model call when the request does not set one. */
  defaultTimeoutMs?: number;
  /** The models to try when the request names no route. */
  defaultRoute?: ModelRef[] | ((principal: Principal) => ModelRef[]);
  /** Where graphs are kept, and who may touch which graph. Without it the graph routes are not served. */
  graph?: { store: GraphStore; access: GraphAccess };
  /** Runs around every request, outermost first. */
  middleware?: Middleware[];
  /** Largest request body accepted, in bytes. Default DEFAULT_MAX_BODY_BYTES (4 MiB). */
  maxBodyBytes?: number;
};

export type CoreHandler = {
  fetch(request: Request): Promise<Response>;
};

/** Hono environment: what authentication stores on each request. */
export type CoreEnv = {
  Variables: {
    principal: Principal;
    credentials?: Promise<CredentialStore>;
    registry?: Promise<ProviderRegistry>;
  };
};

/** What a route module can use. Internal: not exported from index.ts. */
export type RouteDeps = {
  options: CoreHandlerOptions;
  /** The authenticated principal of this request (routes run only after authentication). */
  principal(c: Context<CoreEnv>): Principal;
  /** This request's credentials (credentialsFor), computed once per request and cached on the context. */
  credentials(c: Context<CoreEnv>): Promise<CredentialStore>;
  /** This request's provider registry (registryFor or the preset default), computed once per request. */
  registry(c: Context<CoreEnv>): Promise<ProviderRegistry>;
  /** readBody with options.maxBodyBytes. */
  body<T>(c: Context<CoreEnv>, schema: BodySchema<T>): Promise<T>;
};

/** A group of routes. Internal: each module adds its routes in `register`, and its specs to `routeSpecs`. */
export type RouteModule = {
  specs: RouteSpec[];
  register(app: Hono<CoreEnv>, deps: RouteDeps): void;
};

/** Every route module, in registration order. Later slices append here. */
const MODULES: RouteModule[] = [meta];

/** Every route module's specs, in registration order. */
export function routeSpecs(): RouteSpec[] {
  return MODULES.flatMap((module) => module.specs);
}

/** A spec path matches a request path when each segment is equal, or a `:param` matching one non-empty segment. */
function matchesPath(pattern: string, path: string): boolean {
  const wanted = pattern.split("/");
  const actual = path.split("/");
  return (
    wanted.length === actual.length &&
    wanted.every((segment, i) => (segment.startsWith(":") ? actual[i] !== "" : segment === actual[i]))
  );
}

export function createCoreHandler(options: CoreHandlerOptions): CoreHandler {
  const base = options.basePath ?? "";
  const app = new Hono<CoreEnv>();
  const routes: Hono<CoreEnv> = base === "" ? app : app.basePath(base);
  const specs = routeSpecs();
  const publicPaths = new Set([`${base}/v1/health`, `${base}/v1/openapi.json`]);
  const stack = [...(options.middleware ?? [])];

  const principal = (c: Context<CoreEnv>): Principal => c.get("principal");

  const credentials = (c: Context<CoreEnv>): Promise<CredentialStore> => {
    let value = c.get("credentials");
    if (value === undefined) {
      value = (async () => options.credentialsFor(principal(c), c.req.raw))();
      c.set("credentials", value);
    }
    return value;
  };

  const registry = (c: Context<CoreEnv>): Promise<ProviderRegistry> => {
    let value = c.get("registry");
    if (value === undefined) {
      value = (async () => {
        const store = await credentials(c);
        if (options.registryFor) return options.registryFor(store);
        return options.fetch === undefined
          ? createPresetRegistry(store)
          : createPresetRegistry(store, { fetch: options.fetch });
      })();
      c.set("registry", value);
    }
    return value;
  };

  const deps: RouteDeps = {
    options,
    principal,
    credentials,
    registry,
    body: (c, schema) => readBody(c.req.raw, schema, options.maxBodyBytes),
  };

  // Outside the base path, and on unknown paths, nothing is registered: answer 404, or 405 for a known path.
  app.notFound((c) => {
    const path = c.req.path;
    if (base !== "" && !path.startsWith(`${base}/`)) {
      return errorResponse(new CoreError("not_found", "no such route"));
    }
    const local = path.slice(base.length);
    if (!specs.some((spec) => matchesPath(spec.path, local))) {
      return errorResponse(new CoreError("not_found", "no such route"));
    }
    return errorResponse(new HttpError("bad_request", "method not allowed", 405));
  });

  app.onError((error) => errorResponse(error));

  app.use("*", async (c, next) => {
    await next();
    if (!c.res.headers.has("cache-control")) c.header("cache-control", "no-store");
  });

  routes.use("*", async (c, next) => {
    if (c.req.method === "GET" && publicPaths.has(c.req.path)) return next();
    const authenticated = await options.authenticate(c.req.raw);
    if (authenticated === null) {
      return errorResponse(new CoreError("auth", "authentication required"));
    }
    c.set("principal", authenticated);
    return next();
  });

  for (const module of MODULES) module.register(routes, deps);

  const run = async (index: number, request: Request): Promise<Response> => {
    if (index >= stack.length) return app.fetch(request);
    const step = stack[index];
    if (step === undefined) return app.fetch(request);
    return step(request, (next) => run(index + 1, next));
  };

  return {
    fetch(request) {
      return run(0, request);
    },
  };
}

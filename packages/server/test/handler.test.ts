import { describe, expect, it } from "vitest";
import {
  ChatCallSchema,
  CoreError,
  ErrorCodeSchema,
  type ApiErrorBody,
  type ErrorCode,
  type HealthResponse,
  type ModelsResponse,
  type ProvidersResponse,
} from "@core/contracts";
import { MemoryCredentialStore, MockProvider, createPresetRegistry, type ModelProvider } from "@core/models";
import { errorResponse, readBody } from "../src/errors.js";
import { httpStatus, type Middleware } from "../src/index.js";
import { createTestHandler, createTestHandlerWith, del, get, post, readJson } from "./helpers.js";

const EXPECTED_STATUS: Record<ErrorCode, number> = {
  bad_request: 400,
  auth: 401,
  not_found: 404,
  conflict: 409,
  content_filter: 422,
  rate_limit: 429,
  aborted: 499,
  unknown: 500,
  unavailable: 503,
  timeout: 504,
};

/** A mock provider that can list models. */
function listingProvider(id: string, models: string[]): ModelProvider {
  const mock = new MockProvider({ id });
  return Object.assign(mock, { listModels: async () => models });
}

describe("auth", () => {
  it("answers GET /v1/health without a principal", async () => {
    const handler = createTestHandler({ mode: "hosted", version: "1.2.3" });
    const response = await handler.fetch(get("/v1/health", { auth: false }));
    expect(response.status).toBe(200);
    expect(await readJson<HealthResponse>(response)).toEqual({ ok: true, version: "1.2.3", mode: "hosted" });
  });

  it("answers 401 auth on GET /v1/providers without a principal", async () => {
    const response = await createTestHandler().fetch(get("/v1/providers", { auth: false }));
    expect(response.status).toBe(401);
    const body = await readJson<ApiErrorBody>(response);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("auth");
  });
});

describe("basePath", () => {
  it("serves routes under the base path only", async () => {
    const handler = createTestHandler({ basePath: "/api/core" });
    const inside = await handler.fetch(get("/api/core/v1/health", { auth: false }));
    expect(inside.status).toBe(200);
    expect((await readJson<HealthResponse>(inside)).ok).toBe(true);

    const outside = await handler.fetch(get("/v1/health", { auth: false }));
    expect(outside.status).toBe(404);
    expect((await readJson<ApiErrorBody>(outside)).error.code).toBe("not_found");
  });
});

describe("GET /v1/providers", () => {
  it("reports ready from the credential store for providers that need a key", async () => {
    const providersOf = async (store: MemoryCredentialStore) => {
      const handler = createTestHandler({
        credentialsFor: () => store,
        registryFor: (credentials) => createPresetRegistry(credentials),
      });
      const response = await handler.fetch(get("/v1/providers"));
      expect(response.status).toBe(200);
      return (await readJson<ProvidersResponse>(response)).providers;
    };

    const without = await providersOf(new MemoryCredentialStore());
    expect(without.find((p) => p.id === "openai")).toEqual({ id: "openai", requiresKey: true, ready: false });

    const withKey = await providersOf(new MemoryCredentialStore({ openai: { apiKey: "sk-test" } }));
    expect(withKey.find((p) => p.id === "openai")).toEqual({ id: "openai", requiresKey: true, ready: true });
    expect(withKey.find((p) => p.id === "anthropic")?.ready).toBe(false);
  });

  it("reports a provider that needs no key as ready without credentials", async () => {
    const handler = createTestHandler({ registryFor: (credentials) => createPresetRegistry(credentials) });
    const { providers } = await readJson<ProvidersResponse>(await handler.fetch(get("/v1/providers")));
    expect(providers.find((p) => p.id === "ollama")).toEqual({ id: "ollama", requiresKey: false, ready: true });
  });

  it("lists every registry id sorted, with a non-preset provider ready and not requiring a key", async () => {
    const handler = createTestHandlerWith([new MockProvider({ id: "zeta" }), new MockProvider({ id: "alpha" })]);
    const { providers } = await readJson<ProvidersResponse>(await handler.fetch(get("/v1/providers")));
    expect(providers).toEqual([
      { id: "alpha", requiresKey: false, ready: true },
      { id: "zeta", requiresKey: false, ready: true },
    ]);
  });
});

describe("GET /v1/models", () => {
  it("answers with the models the provider lists", async () => {
    const handler = createTestHandlerWith([listingProvider("fake", ["m-1", "m-2"])]);
    const response = await handler.fetch(get("/v1/models?provider=fake"));
    expect(response.status).toBe(200);
    expect(await readJson<ModelsResponse>(response)).toEqual({ provider: "fake", models: ["m-1", "m-2"] });
  });

  it("answers 400 bad_request when the provider parameter is missing", async () => {
    const response = await createTestHandler().fetch(get("/v1/models"));
    expect(response.status).toBe(400);
    expect((await readJson<ApiErrorBody>(response)).error.code).toBe("bad_request");
  });

  it("answers 404 not_found for an unknown provider", async () => {
    const response = await createTestHandler().fetch(get("/v1/models?provider=nope"));
    expect(response.status).toBe(404);
    expect((await readJson<ApiErrorBody>(response)).error.code).toBe("not_found");
  });

  it("answers 400 bad_request for a provider without listModels", async () => {
    const response = await createTestHandler().fetch(get("/v1/models?provider=mock"));
    expect(response.status).toBe(400);
    expect((await readJson<ApiErrorBody>(response)).error.code).toBe("bad_request");
  });
});

describe("httpStatus", () => {
  it("maps every error code to its HTTP status", () => {
    const codes = ErrorCodeSchema.options;
    expect(codes.length).toBe(Object.keys(EXPECTED_STATUS).length);
    for (const code of codes) expect(httpStatus(code), code).toBe(EXPECTED_STATUS[code]);
  });

  it("answers a thrown CoreError with its code's status and shape", async () => {
    const handler = createTestHandler({
      credentialsFor: () => {
        throw new CoreError("rate_limit", "slow down");
      },
    });
    const response = await handler.fetch(get("/v1/providers"));
    expect(response.status).toBe(429);
    const body = await readJson<ApiErrorBody>(response);
    expect(body.error).toMatchObject({ code: "rate_limit", message: "slow down" });
  });
});

describe("thrown non-CoreError", () => {
  it("answers 500 unknown with a generic message and never the original", async () => {
    const handler = createTestHandler({
      credentialsFor: () => {
        throw new Error("secret-xyz");
      },
    });
    const response = await handler.fetch(get("/v1/providers"));
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).not.toContain("secret-xyz");
    const body = JSON.parse(text) as ApiErrorBody;
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("unknown");
    expect(body.error.message).toBe("internal error");
  });

  it("does the same when registryFor throws", async () => {
    const handler = createTestHandler({
      registryFor: () => {
        throw new Error("secret-xyz");
      },
    });
    const response = await handler.fetch(get("/v1/providers"));
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).not.toContain("secret-xyz");
    expect((JSON.parse(text) as ApiErrorBody).error.message).toBe("internal error");
  });
});

describe("readBody", () => {
  const URL = "http://127.0.0.1:8977/v1/x";
  const valid = { messages: [{ role: "user", content: "hi" }] };

  /** The response a route would send for whatever readBody throws. */
  async function failure(request: Request, max?: number): Promise<{ status: number; body: ApiErrorBody }> {
    try {
      await readBody(request, ChatCallSchema, max);
    } catch (error) {
      const response = errorResponse(error);
      return { status: response.status, body: await readJson<ApiErrorBody>(response) };
    }
    throw new Error("readBody did not throw");
  }

  const json = (text: string, headers: Record<string, string> = {}): Request =>
    new Request(URL, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: text });

  it("returns the parsed body for valid JSON", async () => {
    expect(await readBody(json(JSON.stringify(valid)), ChatCallSchema)).toEqual(valid);
  });

  it("accepts a content type with parameters", async () => {
    const request = json(JSON.stringify(valid), { "content-type": "application/json; charset=utf-8" });
    expect(await readBody(request, ChatCallSchema)).toEqual(valid);
  });

  it("answers 415 bad_request for a content type other than application/json", async () => {
    const request = new Request(URL, { method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify(valid) });
    const { status, body } = await failure(request);
    expect(status).toBe(415);
    expect(body.error.code).toBe("bad_request");
  });

  it("answers 415 when there is no content type", async () => {
    const { status } = await failure(new Request(URL, { method: "POST" }));
    expect(status).toBe(415);
  });

  it("answers 413 bad_request for a body over maxBodyBytes", async () => {
    const { status, body } = await failure(json(JSON.stringify(valid)), 10);
    expect(status).toBe(413);
    expect(body.error.code).toBe("bad_request");
  });

  it("answers 413 for a streamed body without content-length that passes the limit", async () => {
    const encoder = new TextEncoder();
    const chunks = [encoder.encode('{"messages":'), encoder.encode('[{"role":"user",'), encoder.encode('"content":"hello"}]}')];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    });
    const request = new Request(URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: stream,
      duplex: "half",
    } as RequestInit);
    expect(request.headers.get("content-length")).toBeNull();
    const { status, body } = await failure(request, 20);
    expect(status).toBe(413);
    expect(body.error.code).toBe("bad_request");
  });

  it("accepts a body exactly at the limit", async () => {
    const text = JSON.stringify(valid);
    expect(await readBody(json(text), ChatCallSchema, new TextEncoder().encode(text).byteLength)).toEqual(valid);
  });

  it("answers 400 bad_request for invalid JSON", async () => {
    const { status, body } = await failure(json("{not json"));
    expect(status).toBe(400);
    expect(body.error.code).toBe("bad_request");
  });

  it("answers 400 naming the failing path but never the value on a schema failure", async () => {
    const { status, body } = await failure(json(JSON.stringify({ messages: [{ role: "user", content: "hi" }], temperature: "hot-secret-value" })));
    expect(status).toBe(400);
    expect(body.error.code).toBe("bad_request");
    expect(body.error.message).toContain("temperature");
    expect(body.error.message).not.toContain("hot-secret-value");
  });
});

describe("routing", () => {
  it("answers 404 not_found for an unknown path", async () => {
    const response = await createTestHandler().fetch(get("/v1/nothing-here"));
    expect(response.status).toBe(404);
    expect((await readJson<ApiErrorBody>(response)).error.code).toBe("not_found");
  });

  it("answers 405 bad_request for a known path with the wrong method", async () => {
    const handler = createTestHandler();
    for (const request of [post("/v1/health", {}), del("/v1/providers")]) {
      const response = await handler.fetch(request);
      expect(response.status).toBe(405);
      expect((await readJson<ApiErrorBody>(response)).error.code).toBe("bad_request");
    }
  });

  it("sends application/json and no-store on success and on error answers", async () => {
    const handler = createTestHandler();
    const answers = [
      await handler.fetch(get("/v1/health", { auth: false })),
      await handler.fetch(get("/v1/providers")),
      await handler.fetch(get("/v1/providers", { auth: false })),
      await handler.fetch(get("/v1/missing")),
      await handler.fetch(post("/v1/health", {})),
    ];
    for (const response of answers) {
      expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
  });
});

describe("middleware", () => {
  it("runs outermost first around routing, and unwinds in reverse", async () => {
    const order: string[] = [];
    const tag =
      (name: string): Middleware =>
      async (request, next) => {
        order.push(`${name}:in`);
        const response = await next(request);
        order.push(`${name}:out`);
        return response;
      };
    const handler = createTestHandler({ middleware: [tag("a"), tag("b")] });
    const response = await handler.fetch(get("/v1/health", { auth: false }));
    expect(response.status).toBe(200);
    expect(order).toEqual(["a:in", "b:in", "b:out", "a:out"]);
  });

  it("lets a middleware answer without calling next", async () => {
    let reached = false;
    let authenticated = false;
    const stop: Middleware = async () => new Response("stopped", { status: 418 });
    const after: Middleware = async (request, next) => {
      reached = true;
      return next(request);
    };
    const handler = createTestHandler({
      middleware: [stop, after],
      authenticate: async () => {
        authenticated = true;
        return null;
      },
    });
    const response = await handler.fetch(get("/v1/providers"));
    expect(response.status).toBe(418);
    expect(await response.text()).toBe("stopped");
    expect(reached).toBe(false);
    expect(authenticated).toBe(false);
  });
});

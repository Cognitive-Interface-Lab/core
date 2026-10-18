import { describe, expect, it } from "vitest";
import { routeSpecs } from "../src/index.js";
import { openApiDocument } from "../src/openapi.js";
import { createTestHandler, get, readJson } from "./helpers.js";

type Json = Record<string, unknown>;

const REF_PREFIX = "#/components/schemas/";

function document(basePath = ""): Json {
  return openApiDocument({ version: "9.9.9", basePath, routes: routeSpecs() });
}

/** Hono's `:id` becomes `{id}`. */
function toOpenApiPath(path: string): string {
  return path.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
}

function paramNames(path: string): string[] {
  return [...path.matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => m[1] as string);
}

function operationOf(doc: Json, method: string, path: string): Json {
  const paths = doc.paths as Record<string, Record<string, Json>>;
  const operation = paths[toOpenApiPath(path)]?.[method.toLowerCase()];
  if (operation === undefined) throw new Error(`no operation for ${method} ${path}`);
  return operation;
}

/** Every `$ref` value found anywhere in `node`. */
function collectRefs(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const item of node) collectRefs(item, out);
  } else if (node !== null && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      if (key === "$ref" && typeof value === "string") out.push(value);
      else collectRefs(value, out);
    }
  }
  return out;
}

describe("openApiDocument", () => {
  it("lists every routeSpecs() entry with its method", () => {
    const specs = routeSpecs();
    expect(specs.length).toBeGreaterThan(0);
    const paths = document().paths as Record<string, Record<string, unknown>>;
    for (const spec of specs) {
      const item = paths[toOpenApiPath(spec.path)];
      expect(item, `${spec.method} ${spec.path}: path missing`).toBeDefined();
      expect(item?.[spec.method.toLowerCase()], `${spec.method} ${spec.path}: method missing`).toBeDefined();
    }
  });

  it("resolves every $ref inside components.schemas", () => {
    const doc = document();
    const names = new Set(Object.keys((doc.components as { schemas: Json }).schemas));
    const refs = collectRefs(doc);
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      expect(ref.startsWith(REF_PREFIX), `unexpected $ref ${ref}`).toBe(true);
      expect(names.has(ref.slice(REF_PREFIX.length)), `dangling $ref ${ref}`).toBe(true);
    }
  });

  it("declares a required path parameter for every {param}, and no extra", () => {
    const doc = document();
    let withParams = 0;
    for (const spec of routeSpecs()) {
      const operation = operationOf(doc, spec.method, spec.path);
      const expected = paramNames(spec.path);
      const declared = ((operation.parameters ?? []) as Json[]).filter((p) => p.in === "path");
      if (expected.length > 0) withParams += 1;
      expect(
        declared.map((p) => p.name).sort(),
        `${spec.method} ${spec.path}: path parameters`,
      ).toEqual([...expected].sort());
      for (const parameter of declared) expect(parameter.required).toBe(true);
      // Nothing declared in other locations either.
      expect(((operation.parameters ?? []) as Json[]).length).toBe(expected.length);
    }
    expect(withParams).toBeGreaterThan(0);
  });

  it("is OpenAPI 3.1.0", () => {
    expect(document().openapi).toBe("3.1.0");
  });

  it("points servers[0].url at basePath, or / when there is none", () => {
    expect((document("/api/core").servers as Json[])[0]?.url).toBe("/api/core");
    expect((document("").servers as Json[])[0]?.url).toBe("/");
  });

  it("describes a request body, a stream and a 204 as the contract says", () => {
    const doc = document();
    for (const spec of routeSpecs()) {
      const operation = operationOf(doc, spec.method, spec.path);
      const responses = operation.responses as Record<string, Json>;
      if (spec.body !== undefined) {
        const body = operation.requestBody as { content: Record<string, { schema: Json }> };
        expect(body.content["application/json"]?.schema, `${spec.path} body`).toEqual({
          $ref: `${REF_PREFIX}${spec.body}`,
        });
      } else {
        expect(operation.requestBody, `${spec.method} ${spec.path}: unexpected body`).toBeUndefined();
      }
      if (spec.answer === "none") {
        expect(responses["204"], `${spec.method} ${spec.path}`).toBeDefined();
        expect(responses["200"]).toBeUndefined();
      } else if (spec.answer === "TurnEvent stream") {
        const content = (responses["200"] as { content: Record<string, { schema: Json }> }).content;
        expect(content["text/event-stream"]?.schema).toEqual({ $ref: `${REF_PREFIX}TurnEvent` });
      } else {
        const content = (responses["200"] as { content: Record<string, unknown> }).content;
        expect(content["application/json"], `${spec.method} ${spec.path}`).toBeDefined();
      }
    }
  });

  it("lists 400, 401, 404 and 500 as ApiErrorBody on every operation", () => {
    const doc = document();
    for (const spec of routeSpecs()) {
      const responses = operationOf(doc, spec.method, spec.path).responses as Record<
        string,
        { content: Record<string, { schema: Json }> }
      >;
      for (const status of ["400", "401", "404", "500"]) {
        expect(
          responses[status]?.content["application/json"]?.schema,
          `${spec.method} ${spec.path} ${status}`,
        ).toEqual({ $ref: `${REF_PREFIX}ApiErrorBody` });
      }
    }
  });
});

describe("GET /v1/openapi.json", () => {
  it("answers without a principal with the document", async () => {
    const handler = createTestHandler();
    const response = await handler.fetch(get("/v1/openapi.json", { auth: false }));
    expect(response.status).toBe(200);
    const body = await readJson<Json>(response);
    expect(body.openapi).toBe("3.1.0");
  });

  it("is in routeSpecs() and in the document it serves", async () => {
    expect(routeSpecs().some((s) => s.method === "GET" && s.path === "/v1/openapi.json")).toBe(true);
    const handler = createTestHandler();
    const body = await readJson<Json>(await handler.fetch(get("/v1/openapi.json", { auth: false })));
    const paths = body.paths as Record<string, Record<string, unknown>>;
    expect(paths["/v1/openapi.json"]?.get).toBeDefined();
  });
});

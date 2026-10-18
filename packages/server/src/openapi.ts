import { toJsonSchemas } from "@core/contracts";
import { jsonResponse } from "./errors.js";
import type { RouteModule, RouteSpec } from "./handler.js";

/** The `answer` of a route that streams turn events as server-sent events. */
const STREAM_ANSWER = "TurnEvent stream";
/** The `answer` of a route that answers with no content. */
const NONE_ANSWER = "none";
/** The `answer` of the OpenAPI document itself: contracts has no schema for it, so it is `{ type: "object" }`. */
const DOCUMENT_ANSWER = "OpenAPI document";

const STREAM_DESCRIPTION = [
  "Server-sent events. Each event is `event: turn`, then `data:` holding one TurnEvent as JSON,",
  "with a blank line between events. A `: keep-alive` comment line goes out every 15 seconds while",
  "the turn works. The stream ends after the `turn-finish` event.",
].join(" ");

export const openapi: RouteModule = {
  specs: [{ method: "GET", path: "/v1/openapi.json", summary: "This document", answer: DOCUMENT_ANSWER }],

  register(app, deps) {
    // Built on the first request, once per handler: by then every module has registered its specs.
    let document: Record<string, unknown> | undefined;
    app.get("/v1/openapi.json", () => {
      document ??= openApiDocument({
        version: deps.options.version,
        basePath: deps.options.basePath ?? "",
        routes: deps.specs,
      });
      return jsonResponse(document);
    });
  },
};

/**
 * The OpenAPI 3.1 document for these routes. Schemas are the contracts' JSON Schemas, referenced
 * from `components.schemas`. Throws when a spec names a type contracts does not export, or when two
 * routes would share an operationId.
 */
export function openApiDocument(opts: {
  version: string;
  basePath: string;
  routes: RouteSpec[];
}): Record<string, unknown> {
  const schemas = toJsonSchemas();
  const paths: Record<string, Record<string, unknown>> = {};
  const operationIds = new Set<string>();

  for (const spec of opts.routes) {
    const operationId = operationIdOf(spec);
    if (operationIds.has(operationId)) {
      throw new Error(`openApiDocument: two routes share the operationId "${operationId}"`);
    }
    operationIds.add(operationId);

    const path = openApiPath(spec.path);
    const item = paths[path] ?? {};
    item[spec.method.toLowerCase()] = operation(spec, operationId, schemas);
    paths[path] = item;
  }

  return {
    openapi: "3.1.0",
    info: { title: "core", version: opts.version },
    servers: [{ url: opts.basePath || "/" }],
    paths,
    components: { schemas },
  };
}

/** Method and path in one word, e.g. `post_v1_graphs_id_branches`. */
function operationIdOf(spec: RouteSpec): string {
  return `${spec.method} ${spec.path}`.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).join("_");
}

/** Hono's `:id` segments become OpenAPI's `{id}`. */
function openApiPath(path: string): string {
  return path
    .split("/")
    .map((segment) => (segment.startsWith(":") ? `{${segment.slice(1)}}` : segment))
    .join("/");
}

function operation(
  spec: RouteSpec,
  operationId: string,
  schemas: Record<string, unknown>,
): Record<string, unknown> {
  const where = `${spec.method} ${spec.path}`;
  const parameters = spec.path
    .split("/")
    .filter((segment) => segment.startsWith(":"))
    .map((segment) => ({ name: segment.slice(1), in: "path", required: true, schema: { type: "string" } }));

  const out: Record<string, unknown> = { operationId, summary: spec.summary };
  if (parameters.length > 0) out.parameters = parameters;
  if (spec.body !== undefined) {
    out.requestBody = {
      required: true,
      content: { "application/json": { schema: schemaRef(spec.body, schemas, `the body of ${where}`) } },
    };
  }
  out.responses = { ...answers(spec, schemas), ...errors(schemas) };
  return out;
}

/** The success response: the answer's type, the event stream, the empty 204, or the OpenAPI document. */
function answers(spec: RouteSpec, schemas: Record<string, unknown>): Record<string, unknown> {
  const where = `the answer of ${spec.method} ${spec.path}`;
  if (spec.answer === NONE_ANSWER) return { "204": { description: "No content." } };
  if (spec.answer === STREAM_ANSWER) {
    return {
      "200": {
        description: STREAM_DESCRIPTION,
        content: { "text/event-stream": { schema: schemaRef("TurnEvent", schemas, where) } },
      },
    };
  }
  const schema =
    spec.answer === DOCUMENT_ANSWER ? { type: "object" } : schemaRef(spec.answer, schemas, where);
  return { "200": { description: "The answer.", content: { "application/json": { schema } } } };
}

/** The errors every route can answer with, each an `ApiErrorBody`. */
function errors(schemas: Record<string, unknown>): Record<string, unknown> {
  const errorBody = (description: string): Record<string, unknown> => ({
    description,
    content: { "application/json": { schema: schemaRef("ApiErrorBody", schemas, "the error responses") } },
  });
  return {
    "400": errorBody("The request is not valid."),
    "401": errorBody("Authentication is required."),
    "404": errorBody("Not found."),
    "500": errorBody("Internal error."),
  };
}

function schemaRef(name: string, schemas: Record<string, unknown>, where: string): { $ref: string } {
  if (!Object.hasOwn(schemas, name)) {
    throw new Error(`openApiDocument: ${where} names "${name}", which contracts does not export`);
  }
  return { $ref: `#/components/schemas/${name}` };
}

import {
  ApiErrorBodySchema,
  AskResultSchema,
  CoreError,
  GraphEventsSchema,
  GraphListSchema,
  GraphStateSchema,
  GraphWriteResultSchema,
  HealthResponseSchema,
  ModelsResponseSchema,
  PairResponseSchema,
  ProvidersResponseSchema,
  type AskResult,
  type BranchCreate,
  type BranchTurnCall,
  type ChatCall,
  type CrossReferenceCall,
  type ForkCall,
  type GraphCreate,
  type GraphEvents,
  type GraphList,
  type GraphState,
  type GraphWriteResult,
  type HealthResponse,
  type MergeCall,
  type MessageAdd,
  type ModelsResponse,
  type PairRequest,
  type PairResponse,
  type ProvidersResponse,
  type TurnCall,
  type TurnEvent,
  type TurnRecord,
} from "@core/contracts";
import { parseTurnStream } from "./sse.js";

/** The core's HTTP API as typed methods. Answers are checked against the contract schemas. */
export type CoreClient = {
  health(): Promise<HealthResponse>;
  pair(req: PairRequest): Promise<PairResponse>;
  /** Forgets this client's token on the core. */
  unpair(): Promise<void>;
  providers(): Promise<ProvidersResponse>;
  models(provider: string): Promise<ModelsResponse>;
  /** One model answer. A failed answer is returned with `ok: false`, not thrown. */
  chat(call: ChatCall, opts?: { signal?: AbortSignal }): Promise<AskResult>;
  /** A whole turn, event by event. Breaking out of the loop cancels the stream. */
  turn(call: TurnCall, opts?: { signal?: AbortSignal }): AsyncIterable<TurnEvent>;
  graphs: {
    list(): Promise<GraphList>;
    create(req?: GraphCreate): Promise<GraphWriteResult>;
    get(id: string): Promise<GraphState>;
    events(id: string, after?: number): Promise<GraphEvents>;
    branch(id: string, req: BranchCreate): Promise<GraphWriteResult>;
    addMessage(id: string, req: MessageAdd): Promise<GraphWriteResult>;
    recordTurn(id: string, req: TurnRecord): Promise<GraphWriteResult>;
    merge(id: string, req: MergeCall): Promise<GraphWriteResult>;
    crossReference(id: string, req: CrossReferenceCall): Promise<GraphWriteResult>;
    fork(id: string, req: ForkCall): Promise<GraphWriteResult>;
    /** A turn on a branch of the graph. The branch holds the history, so only the new input is sent. */
    turn(id: string, req: BranchTurnCall, opts?: { signal?: AbortSignal }): AsyncIterable<TurnEvent>;
  };
};

/** What the client needs from a contract schema: zod's `safeParse`, described structurally. */
type Checked<T> = {
  safeParse(value: unknown): { success: true; data: T } | { success: false; error: unknown };
};

/** One request as the client builds it. */
type Sent = {
  method: "GET" | "POST" | "DELETE";
  path: string;
  body?: unknown;
  signal?: AbortSignal;
};

/**
 * A client for the core at `baseUrl`. Paths are joined to `baseUrl` as plain strings, so a relative
 * base such as "/api/core" works. `headers` is evaluated for every request.
 */
export function createCoreClient(opts: {
  baseUrl: string;
  token?: string;
  fetch?: typeof fetch;
  headers?: () => Record<string, string> | Promise<Record<string, string>>;
  credentials?: RequestCredentials;
}): CoreClient {
  // Called through a wrapper, so the global fetch is never invoked with a foreign `this`.
  const doFetch = opts.fetch ?? ((input: string, init: RequestInit) => globalThis.fetch(input, init));

  /** Sends one request. A fetch that rejects is `unavailable`, or `aborted` when the caller aborted. */
  const send = async (call: Sent): Promise<Response> => {
    const headers: Record<string, string> = { ...(await opts.headers?.()) };
    if (opts.token !== undefined) headers.authorization = `Bearer ${opts.token}`;
    if (call.body !== undefined) headers["content-type"] = "application/json";
    try {
      return await doFetch(`${opts.baseUrl}${call.path}`, {
        method: call.method,
        headers,
        signal: call.signal,
        ...(call.body !== undefined && { body: JSON.stringify(call.body) }),
        ...(opts.credentials !== undefined && { credentials: opts.credentials }),
      });
    } catch (cause) {
      if (call.signal?.aborted === true) throw new CoreError("aborted", "the request was aborted", { cause });
      throw new CoreError("unavailable", `core is not reachable at ${opts.baseUrl}`, { cause });
    }
  };

  /** A JSON request: a 2xx answer checked against `schema`, anything else thrown. */
  const json = async <T>(schema: Checked<T>, call: Sent): Promise<T> => {
    const response = await send(call);
    const body = await readJson(response, call.signal);
    if (!response.ok) throw failure(body);
    return parseAs(schema, body);
  };

  /** A server-sent turn. The request is sent when iteration starts, and errors throw then. */
  async function* stream(call: Sent): AsyncGenerator<TurnEvent> {
    const response = await send(call);
    if (!response.ok) throw failure(await readJson(response, call.signal));
    if (response.body === null) throw unexpected();
    yield* parseTurnStream(response.body);
  }

  /** A graph write: the ids it made and the state of the graph written to. */
  const graphWrite = (id: string, rest: string, body: unknown): Promise<GraphWriteResult> =>
    json(GraphWriteResultSchema, { method: "POST", path: graphPath(id, rest), body });

  return {
    health: () => json(HealthResponseSchema, { method: "GET", path: "/v1/health" }),
    pair: (req) => json(PairResponseSchema, { method: "POST", path: "/v1/pair", body: req }),
    unpair: async () => {
      const response = await send({ method: "DELETE", path: "/v1/pair" });
      if (!response.ok) throw failure(await readJson(response));
    },
    providers: () => json(ProvidersResponseSchema, { method: "GET", path: "/v1/providers" }),
    models: (provider) =>
      json(ModelsResponseSchema, {
        method: "GET",
        path: `/v1/models?provider=${encodeURIComponent(provider)}`,
      }),
    chat: async (call, { signal } = {}) => {
      const response = await send({ method: "POST", path: "/v1/chat", body: call, signal });
      const body = await readJson(response, signal);
      if (!response.ok) {
        // A failed model call answers with its AskResult, which carries the attempts, so it is returned.
        const failed = AskResultSchema.safeParse(body);
        if (failed.success && !failed.data.ok) return failed.data;
        throw failure(body);
      }
      return parseAs(AskResultSchema, body);
    },
    turn: (call, { signal } = {}) => stream({ method: "POST", path: "/v1/turns", body: call, signal }),
    graphs: {
      list: () => json(GraphListSchema, { method: "GET", path: "/v1/graphs" }),
      create: (req) => json(GraphWriteResultSchema, { method: "POST", path: "/v1/graphs", body: req ?? {} }),
      get: (id) => json(GraphStateSchema, { method: "GET", path: graphPath(id) }),
      events: (id, after) => {
        const query = after === undefined ? "" : `?after=${after}`;
        return json(GraphEventsSchema, { method: "GET", path: graphPath(id, `/events${query}`) });
      },
      branch: (id, req) => graphWrite(id, "/branches", req),
      addMessage: (id, req) => graphWrite(id, "/messages", req),
      recordTurn: (id, req) => graphWrite(id, "/turn-records", req),
      merge: (id, req) => graphWrite(id, "/merges", req),
      crossReference: (id, req) => graphWrite(id, "/cross-references", req),
      fork: (id, req) => graphWrite(id, "/forks", req),
      turn: (id, req, { signal } = {}) =>
        stream({ method: "POST", path: graphPath(id, "/turns"), body: req, signal }),
    },
  };
}

/** The path of a graph, with its id encoded, followed by `rest`. */
function graphPath(id: string, rest = ""): string {
  return `/v1/graphs/${encodeURIComponent(id)}${rest}`;
}

/** The body of an answer as JSON, or undefined when it is not JSON. */
async function readJson(response: Response, signal?: AbortSignal): Promise<unknown> {
  try {
    return await response.json();
  } catch (cause) {
    if (signal?.aborted === true) throw new CoreError("aborted", "the request was aborted", { cause });
    return undefined;
  }
}

/** The data of a 2xx JSON answer, checked against its schema. */
function parseAs<T>(schema: Checked<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw unexpected();
  return parsed.data;
}

/** The error of a non-2xx answer: its error shape when it has one, otherwise unexpected. */
function failure(body: unknown): CoreError {
  const parsed = ApiErrorBodySchema.safeParse(body);
  return parsed.success ? CoreError.fromShape(parsed.data.error) : unexpected();
}

/** The error for an answer the client cannot read. The answer itself is never included. */
function unexpected(): CoreError {
  return new CoreError("unknown", "unexpected answer from core");
}

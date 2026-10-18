import { describe, expect, it, vi } from "vitest";
import {
  CoreError,
  TurnEventSchema,
  type GraphState,
  type Message,
  type ModelRef,
  type TurnEvent,
} from "@core/contracts";
import { MemoryGraphStore } from "@core/graph";
import { MemoryCredentialStore, MockProvider, ProviderRegistry, type ModelProvider } from "@core/models";
import {
  ServeTokens,
  createCoreHandler,
  localBridge,
  type CoreHandler,
  type GraphAccess,
  type PairApprover,
  type TokenSecrets,
} from "@core/server";
import { createCoreClient, parseTurnStream, type CoreClient } from "../src/index.js";

const PORT = 8977;
const BASE = `http://127.0.0.1:${PORT}`;
const LOCAL_TOKEN = "local-token-for-tests";
const ORIGIN = "https://app.example";
const CODE = "ABC234";
const MOCK: ModelRef = { provider: "mock", model: "scripted" };
const BOOM: ModelRef = { provider: "boom", model: "scripted" };
const USER: Message = { role: "user", content: "hello" };
const ANSWER: Message = { role: "assistant", content: "hi back" };
const WAIT_MS = 2000;

/** Bounds a wait: the promise's value, or a rejection after `ms`. */
async function within<T>(promise: Promise<T>, ms = WAIT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`still pending after ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** The CoreError a promise rejects with. Anything else, including a resolution, fails the test. */
async function failure(promise: Promise<unknown>): Promise<CoreError> {
  try {
    await within(promise);
  } catch (error) {
    if (CoreError.is(error)) return error;
    throw error;
  }
  throw new Error("expected the call to reject");
}

/** Waits for a call to finish, whatever it does: for tests that only look at the request it sent. */
async function settle(promise: Promise<unknown>): Promise<void> {
  await promise.then(
    () => undefined,
    () => undefined,
  );
}

async function collect(events: AsyncIterable<TurnEvent>): Promise<TurnEvent[]> {
  const seen: TurnEvent[] = [];
  for await (const event of events) seen.push(event);
  return seen;
}

/** A GraphAccess that lets everyone do everything and lists what was created. */
class AllowAll implements GraphAccess {
  readonly ids: string[] = [];
  async canRead(): Promise<boolean> {
    return true;
  }
  async canWrite(): Promise<boolean> {
    return true;
  }
  async created(_principal: unknown, graphId: string): Promise<void> {
    this.ids.push(graphId);
  }
  async list(): Promise<string[]> {
    return [...this.ids];
  }
}

function mapSecrets(): TokenSecrets {
  const store = new Map<string, string>();
  return {
    get: async (name) => store.get(name),
    set: async (name, value) => {
      store.set(name, value);
    },
    delete: async (name) => store.delete(name),
    list: async () => [...store.keys()],
  };
}

type Harness = {
  handler: CoreHandler;
  approve: ReturnType<typeof vi.fn<PairApprover>>;
  /** A fetch for the client: the request goes to the handler with the Host header the bridge needs. */
  fetch: typeof fetch;
  /** A client of the local bridge that has no origin: the local token. */
  local: CoreClient;
  /** A client for a web origin that has paired and holds its token. */
  web: CoreClient;
  /** A client for the same origin with the given token. */
  webWith(token: string): CoreClient;
  pairing: CoreClient;
};

function harness(): Harness {
  const mock = new MockProvider({ id: "mock" });
  const lister: ModelProvider = Object.assign(new MockProvider({ id: "lister" }), {
    listModels: async () => ["m-1", "m-2"],
  });
  const boom = new MockProvider({
    id: "boom",
    script: [{ error: { code: "unavailable", message: "scripted failure", retryable: true } }],
    echo: false,
  });
  const approve = vi.fn<PairApprover>(async () => true);
  const bridge = localBridge({
    port: PORT,
    tokens: new ServeTokens(mapSecrets()),
    localToken: LOCAL_TOKEN,
    approve,
  });
  const handler = createCoreHandler({
    mode: "local",
    version: "0.0.0-test",
    middleware: [bridge.middleware],
    authenticate: bridge.authenticate,
    credentialsFor: () => new MemoryCredentialStore(),
    registryFor: () => {
      const registry = new ProviderRegistry();
      for (const provider of [mock, lister, boom]) registry.register(provider);
      return registry;
    },
    graph: { store: new MemoryGraphStore(), access: new AllowAll() },
  });

  const injected: typeof fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    // A browser cannot set Host, so the test sets it here and not through the client's `headers()`.
    headers.set("host", `127.0.0.1:${PORT}`);
    return handler.fetch(new Request(new URL(String(input), BASE), { ...init, headers }));
  };
  const origin = () => ({ origin: ORIGIN });
  const webWith = (token: string) =>
    createCoreClient({ baseUrl: BASE, fetch: injected, token, headers: origin });
  const pairing = createCoreClient({ baseUrl: BASE, fetch: injected, headers: origin });
  return {
    handler,
    approve,
    fetch: injected,
    local: createCoreClient({ baseUrl: BASE, fetch: injected, token: LOCAL_TOKEN }),
    web: webWith("replaced below"),
    webWith,
    pairing,
  };
}

/** A harness whose `web` client has paired. */
async function paired(): Promise<Harness> {
  const h = harness();
  const { token } = await h.pairing.pair({ code: CODE, name: "Test app" });
  return { ...h, web: h.webWith(token) };
}

const mainOf = (state: GraphState) => {
  const main = Object.values(state.branches).find((branch) => branch.name === "main");
  if (main === undefined) throw new Error("no main branch");
  return main;
};

const finishEvent = (messages: Message[]): TurnEvent => ({
  type: "turn-finish",
  reason: "stop",
  rounds: 1,
  usage: { inputTokens: 1, outputTokens: 2 },
  messages,
});

/** A fake fetch that answers every request with the given JSON. */
function jsonFetch(status: number, body: unknown): typeof fetch {
  return async () =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** A fake fetch that records each request and answers it with `{}` (not a valid answer to anything). */
function recordingFetch(): { fetch: typeof fetch; urls: string[]; inits: RequestInit[] } {
  const urls: string[] = [];
  const inits: RequestInit[] = [];
  const fake: typeof fetch = async (input, init) => {
    urls.push(String(input));
    inits.push(init ?? {});
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };
  return { fetch: fake, urls, inits };
}

const encoder = new TextEncoder();

describe("client against a real handler: meta and pairing", () => {
  it("answers health, pairs through an approver, lists providers and models, and unpairs with that origin's token", async () => {
    const h = harness();

    expect(await h.local.health()).toEqual({ ok: true, version: "0.0.0-test", mode: "local" });

    const pairedAs = await h.pairing.pair({ code: CODE, name: "Test app" });
    expect(pairedAs.origin).toBe(ORIGIN);
    expect(pairedAs.token.length).toBeGreaterThan(0);
    expect(h.approve).toHaveBeenCalledTimes(1);
    expect(h.approve.mock.calls[0]?.[0]).toMatchObject({ origin: ORIGIN, code: CODE, name: "Test app" });

    const web = h.webWith(pairedAs.token);
    expect(await web.health()).toEqual({ ok: true, version: "0.0.0-test", mode: "local" });
    const providers = await web.providers();
    expect(providers.providers.map((provider) => provider.id).sort()).toEqual(["boom", "lister", "mock"]);
    expect(await web.models("lister")).toEqual({ provider: "lister", models: ["m-1", "m-2"] });

    expect(await web.unpair()).toBeUndefined();
    // The token is forgotten: the origin is not paired any more.
    const after = await failure(web.providers());
    expect(after.code).toBe("auth");
  });
});

describe("client against a real handler: chat and turn", () => {
  it("chat answers the model's text with its attempts, and turn streams events up to turn-finish", async () => {
    const { web } = await paired();

    const answer = await web.chat({ route: [MOCK], messages: [{ role: "user", content: "hi" }] });
    expect(answer.ok).toBe(true);
    if (!answer.ok) throw new Error("expected ok");
    expect(answer.text).toBe("echo: hi");
    expect(answer.model).toEqual(MOCK);
    expect(answer.attempts).toHaveLength(1);
    expect(answer.attempts[0]?.ok).toBe(true);

    const events = await within(collect(web.turn({ route: [MOCK], messages: [{ role: "user", content: "hi" }] })));
    expect(events.some((event) => event.type === "route")).toBe(true);
    expect(events.some((event) => event.type === "round")).toBe(true);
    const text = events.flatMap((event) => (event.type === "text-delta" ? [event.text] : [])).join("");
    expect(text).toBe("echo: hi");
    expect(events.filter((event) => event.type === "turn-finish")).toHaveLength(1);
    const last = events.at(-1);
    expect(last).toMatchObject({ type: "turn-finish", reason: "stop" });
    if (last?.type !== "turn-finish") throw new Error("not a finish");
    expect(last.messages).toEqual([{ role: "assistant", content: "echo: hi" }]);
  });
});

describe("client against a real handler: graphs", () => {
  it("creates, lists and gets a graph, and reads its events with and without after", async () => {
    const { web } = await paired();

    expect((await web.graphs.list()).graphs).toEqual([]);
    const created = await web.graphs.create({ title: "Plan" });
    const gid = created.ids[0]!;
    expect(created.ids).toHaveLength(1);
    expect(created.state.graphId).toBe(gid);
    expect(created.state.title).toBe("Plan");
    const untitled = await web.graphs.create();
    expect(untitled.ids).toHaveLength(1);
    expect(untitled.state.title).toBeUndefined();
    expect((await web.graphs.list()).graphs).toEqual([gid, untitled.ids[0]]);
    expect(await web.graphs.get(gid)).toEqual(created.state);

    // seq 1 graph-created, 2 branch-created main, 3 message-added
    await web.graphs.addMessage(gid, { branchId: mainOf(created.state).id, message: USER });
    const all = await web.graphs.events(gid);
    expect(all.records.map((record) => record.seq)).toEqual([1, 2, 3]);
    expect((await web.graphs.events(gid, 2)).records.map((record) => record.seq)).toEqual([3]);
    expect((await web.graphs.events(gid, 0)).records.map((record) => record.seq)).toEqual([1, 2, 3]);
    expect((await web.graphs.events(gid, 3)).records).toEqual([]);
  });

  it("branch, addMessage, merge, crossReference and recordTurn answer their ids and the graph's new state", async () => {
    const { web } = await paired();
    const { state: created } = await web.graphs.create({ title: "Work" });
    const gid = created.graphId;
    const main = mainOf(created);

    const message = await web.graphs.addMessage(gid, { branchId: main.id, message: USER });
    const root = message.ids[0]!;
    expect(message.ids).toHaveLength(1);
    expect(message.state.nodes[root]).toMatchObject({ branchId: main.id, parentIds: [], message: USER });
    expect(message.state.branches[main.id]?.head).toBe(root);

    const side = await web.graphs.branch(gid, { name: "side", from: root });
    expect(side.ids).toHaveLength(1);
    expect(side.state.branches[side.ids[0]!]).toMatchObject({ name: "side", from: root, head: root });
    const other = await web.graphs.branch(gid, { name: "other", from: root });
    const sideNode = (await web.graphs.addMessage(gid, { branchId: side.ids[0]!, message: ANSWER })).ids[0]!;

    const summary = await web.graphs.merge(gid, {
      source: side.ids[0]!,
      target: main.id,
      strategy: "summary",
      message: { role: "assistant", content: "side in short" },
    });
    expect(summary.ids).toHaveLength(1);
    expect(summary.state.nodes[summary.ids[0]!]).toMatchObject({
      branchId: main.id,
      parentIds: [root, sideNode],
      merge: { strategy: "summary", sourceBranchId: side.ids[0] },
      message: { role: "assistant", content: "side in short" },
    });
    const append = await web.graphs.merge(gid, { source: side.ids[0]!, target: other.ids[0]!, strategy: "append" });
    expect(append.state.nodes[append.ids[0]!]?.merge).toEqual({ strategy: "append", sourceBranchId: side.ids[0] });

    const to = { graphId: "other-graph", nodeId: "other-node" };
    const ref = await web.graphs.crossReference(gid, { from: root, to, label: "see also" });
    expect(ref.ids).toHaveLength(1);
    expect(ref.state.refs).toEqual([{ id: ref.ids[0], from: root, to, label: "see also" }]);

    const recorded = await web.graphs.recordTurn(gid, {
      branchId: main.id,
      events: [{ type: "round", round: 1 }, finishEvent([ANSWER])],
    });
    expect(recorded.ids).toHaveLength(1);
    expect(recorded.state.nodes[recorded.ids[0]!]).toMatchObject({ branchId: main.id, message: ANSWER });
    expect(Object.values(recorded.state.turns)).toHaveLength(1);
    expect(recorded.state.branches[main.id]?.head).toBe(recorded.ids[0]);
    expect(recorded.state).toEqual(await web.graphs.get(gid));
  });

  it("fork copies the conversation into a new graph, and a branch turn streams and is recorded on the branch", async () => {
    const { web } = await paired();
    const { state: created } = await web.graphs.create();
    const gid = created.graphId;
    const main = mainOf(created);
    const first = (await web.graphs.addMessage(gid, { branchId: main.id, message: USER })).ids[0]!;

    const fork = await web.graphs.fork(gid, { nodeId: first, title: "Branch off" });
    const forkId = fork.ids[0]!;
    expect(forkId).not.toBe(gid);
    expect(fork.state).toMatchObject({ graphId: forkId, title: "Branch off", forkedFrom: { graphId: gid, nodeId: first } });
    expect(Object.values(fork.state.nodes)).toHaveLength(1);

    const events = await within(collect(web.graphs.turn(gid, { branchId: main.id, input: USER, route: [MOCK] })));
    const last = events.at(-1);
    expect(last).toMatchObject({ type: "turn-finish", reason: "stop" });
    expect(events.filter((event) => event.type === "turn-finish")).toHaveLength(1);

    const state = await web.graphs.get(gid);
    const turns = Object.values(state.turns);
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ branchId: main.id, reason: "stop" });
    const head = state.branches[main.id]?.head;
    expect(head).toBe(turns[0]?.nodeIds.at(-1));
    expect(state.nodes[head ?? ""]?.message).toEqual({ role: "assistant", content: "echo: hello" });
  });
});

describe("errors", () => {
  it("throws CoreError with the server's code: a wrong token is auth, an unknown graph is not_found", async () => {
    const h = await paired();
    const wrong = h.webWith("not-the-token");

    const unauthorized = await failure(wrong.providers());
    expect(unauthorized).toBeInstanceOf(CoreError);
    expect(unauthorized.code).toBe("auth");
    expect(unauthorized.retryable).toBe(false);

    const missing = await failure(h.web.graphs.get("no-such-graph"));
    expect(missing.code).toBe("not_found");
    expect(missing.message).toBe("graph not found");
    expect((await failure(h.web.graphs.branch("no-such-graph", { name: "x", from: null }))).code).toBe("not_found");
    expect((await failure(h.web.models("nope"))).code).toBe("not_found");
    expect((await failure(h.web.models("mock"))).code).toBe("bad_request");
    expect((await failure(wrong.unpair())).code).toBe("auth");
    // chat only returns an AskResult body; any other error body is thrown.
    expect((await failure(wrong.chat({ route: [MOCK], messages: [USER] }))).code).toBe("auth");
  });

  it("throws before streaming when a turn is refused, when iteration starts", async () => {
    const { web } = await paired();
    const { state } = await web.graphs.create();
    const refused = await failure(collect(web.graphs.turn(state.graphId, { branchId: "nope", input: USER, route: [MOCK] })));
    expect(refused.code).toBe("not_found");
    const unrouted = await failure(collect(web.turn({ messages: [USER] })));
    expect(unrouted.code).toBe("bad_request");
  });

  it("keeps code, message, provider, details and the retryable flag of the body, even a flag that differs from the code's default", async () => {
    const shape = (code: string, retryable: boolean) => ({
      ok: false,
      error: { code, message: "slow down", provider: "mock", retryable, details: { after: 3 } },
    });
    const limited = createCoreClient({ baseUrl: "https://core.example", fetch: jsonFetch(429, shape("rate_limit", true)) });
    const error = await failure(limited.health());
    expect(error).toMatchObject({ code: "rate_limit", message: "slow down", provider: "mock", retryable: true, details: { after: 3 } });

    const flipped = createCoreClient({ baseUrl: "https://core.example", fetch: jsonFetch(429, shape("rate_limit", false)) });
    expect((await failure(flipped.providers())).retryable).toBe(false);
    const odd = createCoreClient({ baseUrl: "https://core.example", fetch: jsonFetch(400, shape("bad_request", true)) });
    expect((await failure(odd.graphs.list())).retryable).toBe(true);
  });
});

describe("answers the client cannot use", () => {
  const BASE_URL = "https://core.example";

  it("throws unknown for a 2xx body that fails its schema and for a 2xx that is not JSON", async () => {
    const wrongShape = createCoreClient({ baseUrl: BASE_URL, fetch: jsonFetch(200, { ok: 1 }) });
    const shapeError = await failure(wrongShape.health());
    expect(shapeError.code).toBe("unknown");
    expect(shapeError.message).toBe("unexpected answer from core");

    const html: typeof fetch = async () => new Response("<html>hello</html>", { status: 200 });
    const notJson = createCoreClient({ baseUrl: BASE_URL, fetch: html });
    const parseError = await failure(notJson.providers());
    expect(parseError.code).toBe("unknown");
    expect(parseError.message).toBe("unexpected answer from core");

    expect((await failure(createCoreClient({ baseUrl: BASE_URL, fetch: jsonFetch(200, {}) }).graphs.create())).code).toBe("unknown");
    expect((await failure(createCoreClient({ baseUrl: BASE_URL, fetch: jsonFetch(200, { ok: true }) }).chat({ messages: [USER] }))).code).toBe("unknown");
  });

  it("throws unknown for an error status whose body is not an error body", async () => {
    const html: typeof fetch = async () => new Response("bad gateway", { status: 502 });
    expect((await failure(createCoreClient({ baseUrl: BASE_URL, fetch: html }).health())).code).toBe("unknown");
    expect((await failure(createCoreClient({ baseUrl: BASE_URL, fetch: jsonFetch(500, { oops: true }) }).unpair())).code).toBe("unknown");
    expect((await failure(createCoreClient({ baseUrl: BASE_URL, fetch: jsonFetch(500, { oops: true }) }).chat({ messages: [USER] }))).code).toBe("unknown");
  });

  it("throws unavailable naming the baseUrl when fetch rejects", async () => {
    const down: typeof fetch = async () => {
      throw new TypeError("fetch failed");
    };
    const error = await failure(createCoreClient({ baseUrl: BASE_URL, fetch: down }).health());
    expect(error.code).toBe("unavailable");
    expect(error.message).toBe(`core is not reachable at ${BASE_URL}`);
    expect(error.retryable).toBe(true);

    const streamed = await failure(collect(createCoreClient({ baseUrl: BASE_URL, fetch: down }).turn({ messages: [USER] })));
    expect(streamed.code).toBe("unavailable");
    expect(streamed.message).toContain(BASE_URL);
  });
});

describe("request headers", () => {
  it("evaluates headers() once per request, sync or async, and sends the token on every request", async () => {
    const seen: Headers[] = [];
    const fake: typeof fetch = async (_input, init) => {
      seen.push(new Headers(init?.headers));
      return new Response("{}", { status: 200 });
    };
    let calls = 0;
    const client = createCoreClient({
      baseUrl: "https://core.example",
      token: "tok-1",
      fetch: fake,
      headers: () => ({ "x-seq": String(++calls) }),
    });
    await settle(client.health());
    await settle(client.health());
    await settle(client.providers());
    await settle(client.models("mock"));
    await settle(client.graphs.list());
    expect(calls).toBe(5);
    expect(seen).toHaveLength(5);
    expect(seen.map((headers) => headers.get("x-seq"))).toEqual(["1", "2", "3", "4", "5"]);
    expect(seen.every((headers) => headers.get("authorization") === "Bearer tok-1")).toBe(true);

    let asyncCalls = 0;
    const lazy = createCoreClient({
      baseUrl: "https://core.example",
      fetch: fake,
      headers: async () => ({ "x-lazy": String(++asyncCalls) }),
    });
    await settle(lazy.health());
    await settle(lazy.health());
    expect(asyncCalls).toBe(2);
    expect(seen.slice(5).map((headers) => headers.get("x-lazy"))).toEqual(["1", "2"]);
    // Without a token there is no Authorization header.
    expect(seen.slice(5).every((headers) => !headers.has("authorization"))).toBe(true);
  });

  it("sends JSON bodies with content-type, none on a bodiless request, and passes credentials to fetch", async () => {
    const { fetch: fake, inits } = recordingFetch();
    const client = createCoreClient({ baseUrl: "https://core.example", fetch: fake, credentials: "include" });
    const call = { route: [MOCK], messages: [USER] };
    await settle(client.chat(call));
    await settle(client.health());
    await settle(collect(client.turn(call)));

    const [chat, health, turn] = inits;
    expect(chat?.method).toBe("POST");
    expect(JSON.parse(String(chat?.body))).toEqual(call);
    expect(new Headers(chat?.headers).get("content-type")).toBe("application/json");
    expect(health?.method).toBe("GET");
    expect(health?.body).toBeUndefined();
    expect(new Headers(health?.headers).has("content-type")).toBe(false);
    expect(turn?.method).toBe("POST");
    expect(JSON.parse(String(turn?.body))).toEqual(call);
    expect(inits.map((init) => init.credentials)).toEqual(["include", "include", "include"]);

    const plain = recordingFetch();
    await settle(createCoreClient({ baseUrl: "https://core.example", fetch: plain.fetch }).health());
    expect(plain.inits[0]?.credentials).toBeUndefined();
  });
});

describe("urls", () => {
  it("joins a relative baseUrl as a plain string and encodes ids and the provider", async () => {
    const { fetch: fake, urls } = recordingFetch();
    const client = createCoreClient({ baseUrl: "/api/core", fetch: fake });
    const id = "a/b c";
    const encoded = "a%2Fb%20c";

    await settle(client.health());
    await settle(client.pair({ code: CODE }));
    await settle(client.unpair());
    await settle(client.providers());
    await settle(client.models("a b"));
    await settle(client.chat({ messages: [USER] }));
    await settle(collect(client.turn({ messages: [USER] })));
    await settle(client.graphs.list());
    await settle(client.graphs.create());
    await settle(client.graphs.get(id));
    await settle(client.graphs.events(id));
    await settle(client.graphs.events(id, 0));
    await settle(client.graphs.events(id, 7));
    await settle(client.graphs.branch(id, { name: "x", from: null }));
    await settle(client.graphs.addMessage(id, { branchId: "b", message: USER }));
    await settle(client.graphs.recordTurn(id, { branchId: "b", events: [finishEvent([])] }));
    await settle(client.graphs.merge(id, { source: "s", target: "t", strategy: "append" }));
    await settle(client.graphs.crossReference(id, { from: "n", to: { graphId: "g", nodeId: "n" } }));
    await settle(client.graphs.fork(id, { nodeId: "n" }));
    await settle(collect(client.graphs.turn(id, { branchId: "b" })));

    expect(urls).toEqual([
      "/api/core/v1/health",
      "/api/core/v1/pair",
      "/api/core/v1/pair",
      "/api/core/v1/providers",
      "/api/core/v1/models?provider=a%20b",
      "/api/core/v1/chat",
      "/api/core/v1/turns",
      "/api/core/v1/graphs",
      "/api/core/v1/graphs",
      `/api/core/v1/graphs/${encoded}`,
      `/api/core/v1/graphs/${encoded}/events`,
      `/api/core/v1/graphs/${encoded}/events?after=0`,
      `/api/core/v1/graphs/${encoded}/events?after=7`,
      `/api/core/v1/graphs/${encoded}/branches`,
      `/api/core/v1/graphs/${encoded}/messages`,
      `/api/core/v1/graphs/${encoded}/turn-records`,
      `/api/core/v1/graphs/${encoded}/merges`,
      `/api/core/v1/graphs/${encoded}/cross-references`,
      `/api/core/v1/graphs/${encoded}/forks`,
      `/api/core/v1/graphs/${encoded}/turns`,
    ]);
  });

  it("joins an absolute baseUrl the same way", async () => {
    const { fetch: fake, urls } = recordingFetch();
    await settle(createCoreClient({ baseUrl: "http://127.0.0.1:8977", fetch: fake }).health());
    expect(urls).toEqual(["http://127.0.0.1:8977/v1/health"]);
  });
});

describe("parseTurnStream", () => {
  /** A body that delivers each chunk on its own. */
  function bodyOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    });
  }

  const eventsOf = (chunks: Uint8Array[]): Promise<TurnEvent[]> => collect(parseTurnStream(bodyOf(chunks)));

  /** The turn events of an SSE text, read without the client's parser: the reference. */
  function referenceOf(sse: string): TurnEvent[] {
    const events: TurnEvent[] = [];
    for (const frame of sse.split("\n\n")) {
      const lines = frame.split("\n");
      if (!lines.includes("event: turn")) continue;
      const data = lines.find((line) => line.startsWith("data: "));
      if (data === undefined) throw new Error("a turn frame without data");
      events.push(TurnEventSchema.parse(JSON.parse(data.slice(6))));
    }
    return events;
  }

  /** The SSE body of a real turn, as the handler writes it, for a user message with multi-byte text. */
  async function recordedTurn(): Promise<string> {
    const h = harness();
    const response = await h.fetch("/v1/turns", {
      method: "POST",
      headers: { authorization: `Bearer ${LOCAL_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ route: [MOCK], messages: [{ role: "user", content: "héllo — 漢字 🎉" }] }),
    });
    expect(response.status).toBe(200);
    return response.text();
  }

  /** Every way to cut `bytes` in two, and one byte at a time. Each must give `expected`. */
  async function expectEveryCut(bytes: Uint8Array, expected: TurnEvent[]): Promise<void> {
    expect(await eventsOf([bytes])).toEqual(expected);
    for (let k = 1; k < bytes.length; k++) {
      const events = await eventsOf([bytes.slice(0, k), bytes.slice(k)]);
      expect(events, `split at byte ${k} of ${bytes.length}`).toEqual(expected);
    }
    const single = Array.from(bytes, (byte) => Uint8Array.of(byte));
    expect(await eventsOf(single), "one byte per chunk").toEqual(expected);
  }

  it("yields the same events however the recorded stream is split, with LF or CRLF line endings", async () => {
    const sse = await recordedTurn();
    const reference = referenceOf(sse);
    // The reference has to contain what makes splitting hard.
    const deltas = reference.flatMap((event) => (event.type === "text-delta" ? [event.text] : []));
    expect(deltas.join("")).toBe("echo: héllo — 漢字 🎉");
    expect(deltas.some((text) => /[^\p{ASCII}]/u.test(text))).toBe(true);
    expect(reference.at(-1)?.type).toBe("turn-finish");
    expect(encoder.encode(sse).length).toBeGreaterThan(sse.length);

    await expectEveryCut(encoder.encode(sse), reference);
    const crlf = sse.replaceAll("\n", "\r\n");
    expect(crlf).toContain("\r\n\r\n");
    await expectEveryCut(encoder.encode(crlf), reference);
  });

  it("skips comments and events that are not turn events, and stops after turn-finish", async () => {
    const reference = referenceOf(await recordedTurn());
    const frame = (event: TurnEvent) => `event: turn\r\ndata: ${JSON.stringify(event)}\r\n\r\n`;
    const body = [
      ": keep-alive\r\n\r\n",
      frame(reference[0]!),
      "event: other\r\ndata: {\"x\":1}\r\n\r\n",
      ": another comment\r\n",
      ...reference.slice(1).map(frame),
      // After turn-finish: never yielded.
      frame({ type: "round", round: 9 }),
    ].join("");
    const bytes = encoder.encode(body);
    expect(bytes.length).toBeGreaterThan(body.length - 1);
    await expectEveryCut(bytes, reference);
  });

  it("ends at the end of the stream when there is no turn-finish", async () => {
    const frame = (event: TurnEvent) => `event: turn\ndata: ${JSON.stringify(event)}\n\n`;
    const events: TurnEvent[] = [{ type: "round", round: 1 }, { type: "text-delta", text: "partial" }];
    expect(await eventsOf([encoder.encode(events.map(frame).join(""))])).toEqual(events);
    expect(await eventsOf([])).toEqual([]);
  });

  it("throws unknown for a turn event that is not JSON or fails TurnEventSchema", async () => {
    for (const data of ["{not json", JSON.stringify({ type: "nope" }), JSON.stringify({ type: "round", round: 0 })]) {
      const body = encoder.encode(`event: turn\ndata: ${data}\n\n`);
      const error = await failure(eventsOf([body]));
      expect(error.code, data).toBe("unknown");
      expect(error.message).toBe("unexpected answer from core");
    }
  });
});

describe("leaving a turn early", () => {
  const first = `event: turn\r\ndata: ${JSON.stringify({ type: "round", round: 1 })}\r\n\r\n`;

  /** A fake fetch whose body emits one turn event and then stays open until cancelled or aborted. */
  function openStream() {
    const state = { cancelled: false };
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const fake: typeof fetch = async (_input, init) => {
      const body = new ReadableStream<Uint8Array>({
        start(started) {
          controller = started;
          started.enqueue(encoder.encode(first));
        },
        cancel() {
          state.cancelled = true;
        },
      });
      // What a real fetch does: aborting the request errors the body.
      init?.signal?.addEventListener(
        "abort",
        () => {
          try {
            controller?.error(init.signal?.reason);
          } catch {
            // already closed or cancelled
          }
        },
        { once: true },
      );
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    };
    const push = (text: string): void => {
      try {
        controller?.enqueue(encoder.encode(text));
      } catch {
        // the body is already errored: nothing more arrives
      }
    };
    return { state, fake, push };
  }

  it("cancels the body when the loop is left after one event", async () => {
    const { state, fake } = openStream();
    const client = createCoreClient({ baseUrl: "https://core.example", fetch: fake });
    const seen: TurnEvent[] = [];
    await within(
      (async () => {
        for await (const event of client.turn({ messages: [USER] })) {
          seen.push(event);
          break;
        }
      })(),
    );
    expect(seen).toEqual([{ type: "round", round: 1 }]);
    expect(state.cancelled).toBe(true);
  });

  it("cancels the body when a branch turn is left early too", async () => {
    const { state, fake } = openStream();
    const client = createCoreClient({ baseUrl: "https://core.example", fetch: fake });
    await within(
      (async () => {
        for await (const event of client.graphs.turn("g", { branchId: "b" })) {
          expect(event.type).toBe("round");
          break;
        }
      })(),
    );
    expect(state.cancelled).toBe(true);
  });

  it("ends the iteration with CoreError aborted, and no further events, when the signal is aborted", async () => {
    const { fake, push } = openStream();
    const client = createCoreClient({ baseUrl: "https://core.example", fetch: fake });
    const controller = new AbortController();
    const seen: TurnEvent[] = [];
    const run = (async () => {
      for await (const event of client.turn({ messages: [USER] }, { signal: controller.signal })) {
        seen.push(event);
        controller.abort();
        // An event the core sends after the abort must not reach the loop.
        push(`event: turn\ndata: ${JSON.stringify({ type: "round", round: 2 })}\n\n`);
      }
    })();
    const error = await failure(run);
    expect(error.code).toBe("aborted");
    expect(seen).toEqual([{ type: "round", round: 1 }]);
  });

  /** A fake fetch whose body emits `frames` and then errors, with no abort. */
  function breakingFetch(frames: string[], reason: unknown): typeof fetch {
    return async () => {
      const queue = [...frames];
      const body = new ReadableStream<Uint8Array>({
        // Erroring in `start` would drop the queued frames, so the error comes on a later pull.
        pull(controller) {
          const frame = queue.shift();
          if (frame === undefined) controller.error(reason);
          else controller.enqueue(encoder.encode(frame));
        },
      });
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    };
  }

  it("throws CoreError unavailable naming the baseUrl after the events seen, when the body errors partway", async () => {
    const baseUrl = "https://core.example";
    const client = createCoreClient({ baseUrl, fetch: breakingFetch([first], new TypeError("terminated")) });
    const runs = {
      turn: () => client.turn({ messages: [USER] }),
      "graphs.turn": () => client.graphs.turn("g", { branchId: "b" }),
    };
    for (const [name, start] of Object.entries(runs)) {
      const seen: TurnEvent[] = [];
      const error = await failure(
        (async () => {
          for await (const event of start()) seen.push(event);
        })(),
      );
      expect(seen, name).toEqual([{ type: "round", round: 1 }]);
      expect(error.code, name).toBe("unavailable");
      expect(error.message, name).toContain(baseUrl);
    }
  });

  it("passes bad data mid-stream through as unknown, not unavailable", async () => {
    const bad = `event: turn\ndata: ${JSON.stringify({ type: "nope" })}\n\n`;
    const client = createCoreClient({
      baseUrl: "https://core.example",
      fetch: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoder.encode(first + bad));
              controller.close();
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
    });
    const seen: TurnEvent[] = [];
    const error = await failure(
      (async () => {
        for await (const event of client.turn({ messages: [USER] })) seen.push(event);
      })(),
    );
    expect(seen).toEqual([{ type: "round", round: 1 }]);
    expect(error.code).toBe("unknown");
    expect(error.message).toBe("unexpected answer from core");
  });
});

describe("chat that fails", () => {
  it("returns an ok: false AskResult with its attempts instead of throwing", async () => {
    const { web } = await paired();
    const result = await within(web.chat({ route: [BOOM], messages: [USER] }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a failure");
    expect(result.error.code).toBe("unavailable");
    expect(result.attempts[0]?.error?.message).toContain("scripted failure");
    expect(result.attempts.length).toBeGreaterThanOrEqual(1);
    expect(result.attempts.every((attempt) => !attempt.ok)).toBe(true);
    expect(result.attempts[0]?.model).toEqual(BOOM);
  });
});

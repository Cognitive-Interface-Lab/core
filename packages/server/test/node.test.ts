import { connect } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  CoreError,
  TurnEventSchema,
  type ChatRequest,
  type ModelRef,
  type StreamEvent,
  type TurnCall,
  type TurnEvent,
} from "@core/contracts";
import { MockProvider, type ChatOptions } from "@core/models";
import { serveLocal } from "../src/node.js";
import { AUTH_HEADER, createTestHandler, createTestHandlerWith } from "./helpers.js";

type Served = Awaited<ReturnType<typeof serveLocal>>;

const MODEL: ModelRef = { provider: "mock", model: "scripted" };
const TURN: TurnCall = { route: [MODEL], messages: [{ role: "user", content: "hello" }] };
const WAIT_MS = 2000;

/** Servers started by a test; `afterEach` closes every one so no port or socket outlives its test. */
const servers: Served[] = [];
/** Release functions of held providers, called in `afterEach` so no turn stays suspended. */
const releases: (() => void)[] = [];

async function start(handler = createTestHandler(), port = 0): Promise<Served> {
  const served = await serveLocal({ handler, port });
  servers.push(served);
  return served;
}

afterEach(async () => {
  for (const release of releases.splice(0)) release();
  await Promise.all(servers.splice(0).map((served) => served.close()));
});

/** Rejects after `ms`, so a hang fails the test instead of timing it out silently. */
function within<T>(promise: Promise<T>, what: string, ms = WAIT_MS): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Streams one text delta at once, then holds until `release()`; only then does the scripted turn
 * finish. Records the signal of each model call.
 */
class HoldProvider extends MockProvider {
  readonly signals: (AbortSignal | undefined)[] = [];
  readonly release: () => void;
  readonly #gate: Promise<void>;

  constructor() {
    super({ id: "mock", script: [{ text: "second" }], echo: false });
    let open!: () => void;
    this.#gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    this.release = open;
    releases.push(open);
  }

  override stream(req: ChatRequest, opts?: ChatOptions): AsyncIterable<StreamEvent> {
    this.signals.push(opts?.signal);
    const inner = super.stream(req, opts);
    const gate = this.#gate;
    return (async function* () {
      yield { type: "text-delta", text: "first" } satisfies StreamEvent;
      await gate;
      yield* inner;
    })();
  }
}

/** Reads SSE `event: turn` frames off a response body, one parsed TurnEvent at a time. */
function eventReader(response: Response) {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const next = async (): Promise<TurnEvent | null> => {
    for (;;) {
      const split = buffer.indexOf("\n\n");
      if (split >= 0) {
        const raw = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        const data = raw
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .join("\n");
        if (data === "") continue;
        return TurnEventSchema.parse(JSON.parse(data));
      }
      const { done, value } = await reader.read();
      if (done) return null;
      buffer += decoder.decode(value, { stream: true });
    }
  };
  /** Reads events until `predicate` matches one; null when the stream ends first. */
  const until = async (predicate: (event: TurnEvent) => boolean): Promise<TurnEvent | null> => {
    for (let event = await next(); event !== null; event = await next()) {
      if (predicate(event)) return event;
    }
    return null;
  };
  return { next, until, reader };
}

const postTurn = (url: string, init: { signal?: AbortSignal } = {}): Promise<Response> =>
  fetch(`${url}/v1/turns`, {
    method: "POST",
    headers: { authorization: AUTH_HEADER, "content-type": "application/json" },
    body: JSON.stringify(TURN),
    ...init,
  });

const isDelta = (text: string) => (event: TurnEvent) => event.type === "text-delta" && event.text === text;

describe("serveLocal", () => {
  it("answers GET /v1/health with 200 through the socket", async () => {
    const { url } = await start();
    const response = await fetch(`${url}/v1/health`, { headers: { authorization: AUTH_HEADER } });
    expect(response.status).toBe(200);
  });

  it("listens on 127.0.0.1 at the real port, and a TCP connect there succeeds", async () => {
    const { url } = await start();
    const parsed = new URL(url);
    expect(parsed.hostname).toBe("127.0.0.1");
    expect(Number(parsed.port)).toBeGreaterThan(0);
    await within(
      new Promise<void>((resolve, reject) => {
        const socket = connect({ host: "127.0.0.1", port: Number(parsed.port) }, () => {
          socket.destroy();
          resolve();
        });
        socket.once("error", reject);
      }),
      "a TCP connect to 127.0.0.1",
    );
  });

  // On Linux all of 127.0.0.0/8 is loopback: a wildcard bind (0.0.0.0, ::) accepts a connect to
  // 127.0.0.2, a bind to 127.0.0.1 alone refuses it.
  it.runIf(process.platform === "linux")("refuses a connect on another loopback address", async () => {
    const { url } = await start();
    const port = Number(new URL(url).port);
    const outcome = await within(
      new Promise<string>((resolve) => {
        const socket = connect({ host: "127.0.0.2", port }, () => {
          socket.destroy();
          resolve("connected");
        });
        socket.once("error", (error: NodeJS.ErrnoException) => resolve(error.code ?? "error"));
      }),
      "a TCP connect to 127.0.0.2",
    );
    expect(outcome).toBe("ECONNREFUSED");
  });

  it("rejects with CoreError unavailable when the port is in use", async () => {
    const first = await start();
    const port = Number(new URL(first.url).port);
    const error: unknown = await serveLocal({ handler: createTestHandler(), port }).then(
      (served) => {
        servers.push(served);
        return null;
      },
      (caught: unknown) => caught,
    );
    expect(CoreError.is(error)).toBe(true);
    expect(error).toMatchObject({ code: "unavailable", message: `port ${port} is in use` });
    // The first server is untouched by the failed attempt.
    const response = await fetch(`${first.url}/v1/health`, { headers: { authorization: AUTH_HEADER } });
    expect(response.status).toBe(200);
  });

  it("delivers a turn's SSE incrementally: the first event arrives before the provider is released", async () => {
    const provider = new HoldProvider();
    const { url } = await start(createTestHandlerWith([provider]));
    const response = await within(postTurn(url), "the response headers");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const events = eventReader(response);

    const first = await within(events.until(isDelta("first")), "the first delta before release");
    expect(first).toMatchObject({ type: "text-delta", text: "first" });

    provider.release();
    const second = await within(events.until(isDelta("second")), "the second delta after release");
    expect(second).not.toBeNull();
    const finish = await within(events.until((event) => event.type === "turn-finish"), "turn-finish");
    expect(finish).toMatchObject({ type: "turn-finish", reason: "stop" });
  });

  it("aborts the provider's signal when the client aborts its fetch mid-turn", async () => {
    const provider = new HoldProvider();
    const { url } = await start(createTestHandlerWith([provider]));
    const controller = new AbortController();
    const response = await within(postTurn(url, { signal: controller.signal }), "the response headers");
    const events = eventReader(response);
    await within(events.until(isDelta("first")), "the first delta");

    const signal = provider.signals[0];
    expect(signal).toBeDefined();
    expect(signal?.aborted).toBe(false);
    const aborted = new Promise<void>((resolve) => {
      if (signal?.aborted) resolve();
      signal?.addEventListener("abort", () => resolve(), { once: true });
    });

    controller.abort();
    await within(aborted, "the provider signal to abort");
    expect(signal?.aborted).toBe(true);
  });

  it("close() ends an open stream, resolves, and frees the port", async () => {
    const provider = new HoldProvider();
    const served = await start(createTestHandlerWith([provider]));
    const port = Number(new URL(served.url).port);
    const response = await within(postTurn(served.url), "the response headers");
    const events = eventReader(response);
    await within(events.until(isDelta("first")), "the first delta");

    // The provider is still held, so the stream is open when close() is called.
    servers.splice(servers.indexOf(served), 1); // closed here; afterEach must not close it again
    await within(served.close(), "close() to resolve");

    // Either a clean end or an error counts: what matters is that the read does not hang.
    const settled = await within(
      events.next().then(
        (event) => ({ ended: event === null }),
        () => ({ ended: true }),
      ),
      "the client's read to settle",
    );
    expect(settled.ended).toBe(true);

    const again = await start(createTestHandler(), port);
    expect(new URL(again.url).port).toBe(String(port));
    const health = await fetch(`${again.url}/v1/health`, { headers: { authorization: AUTH_HEADER } });
    expect(health.status).toBe(200);
  });
});

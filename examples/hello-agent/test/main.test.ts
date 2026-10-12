import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ToolCall } from "@core/contracts";
import { MockProvider, ProviderRegistry, type MockTurn } from "@core/models";
import { ToolRegistry, createMcpServer, type McpServerSpec, type RegisteredTool } from "@core/tools";
import { run } from "../src/main.js";

// The stdio transport would spawn `npx`. Replace it with one that records its parameters and
// refuses to start, so CORE_MCP_FS can be checked without running anything.
const stdio = vi.hoisted(() => ({ params: [] as Record<string, unknown>[] }));
vi.mock("@modelcontextprotocol/sdk/client/stdio.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@modelcontextprotocol/sdk/client/stdio.js")>();
  class BlockedStdioTransport {
    constructor(params: Record<string, unknown>) {
      stdio.params.push(params);
    }
    async start(): Promise<void> {
      throw new Error("spawn blocked in tests");
    }
    async send(): Promise<void> {}
    async close(): Promise<void> {}
  }
  return { ...actual, StdioClientTransport: BlockedStdioTransport };
});

const closers: (() => Promise<void>)[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  stdio.params.length = 0;
  await Promise.allSettled(closers.splice(0).map((close) => close()));
});

function capture() {
  let text = "";
  return {
    write(chunk: string) {
      text += chunk;
    },
    get text() {
      return text;
    },
  };
}

/** Fails the test if anything reaches for the network. */
function forbidNetwork() {
  const stub = vi.fn(async () => {
    throw new Error("network call attempted");
  });
  vi.stubGlobal("fetch", stub);
  return stub;
}

const callTurn = (id: string, name: string, args: Record<string, unknown>): MockTurn => ({
  toolCalls: [{ id, name, arguments: args } satisfies ToolCall],
  finishReason: "tool-calls",
});

function scripted(script: MockTurn[]) {
  const mock = new MockProvider({ id: "mock", script, echo: false });
  return { mock, providers: new ProviderRegistry().register(mock) };
}

function plainTool(name: string, sideEffects: boolean, handler: (args: Record<string, unknown>) => unknown): RegisteredTool & { calls: Record<string, unknown>[] } {
  const calls: Record<string, unknown>[] = [];
  return {
    definition: { name, description: `the ${name} tool`, inputSchema: { type: "object" } },
    policy: { sideEffects },
    source: "local",
    handler: async (args) => {
      calls.push(args);
      return handler(args);
    },
    calls,
  };
}

/** A test MCP server on one end of an in-memory pair; the spec for the other end goes in `deps.mcp`. */
async function testServer(tools: RegisteredTool[], name = "fs") {
  const registry = new ToolRegistry();
  for (const tool of tools) registry.register(tool);
  // The server confirms everything: the gate under test is the example's own.
  const server = createMcpServer(registry, { name: "test-fs", version: "1.0.0", channel: "local", confirm: async () => true });
  const state = { closed: false };
  server.onclose = () => {
    state.closed = true;
  };
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  closers.push(() => server.close());
  const spec: McpServerSpec = { name, transport: clientSide };
  return { spec, state };
}

type Result = { code: number; out: string; err: string; mock: MockProvider };

async function runAgent(
  argv: string[],
  script: MockTurn[],
  options: { env?: Record<string, string | undefined>; mcp?: McpServerSpec[] } = {},
): Promise<Result> {
  const { mock, providers } = scripted(script);
  const out = capture();
  const err = capture();
  const code = await run(argv, { CORE_ROUTE: "mock:x", ...options.env }, out, err, {
    providers,
    ...(options.mcp !== undefined && { mcp: options.mcp }),
  });
  return { code, out: out.text, err: err.text, mock };
}

const lines = (text: string) => text.split("\n").filter((line) => line !== "");

describe("hello-agent: calculate", () => {
  it("calls calculate, shows the call and the result, and prints the model's answer", async () => {
    const fetchStub = forbidNetwork();
    const { code, out, err, mock } = await runAgent(
      ["what's", "23", "times", "17?"],
      [callTurn("call_1", "calculate", { expression: "23*17" }), { text: "23 times 17 is 391." }],
    );
    expect(code).toBe(0);
    expect(out).toBe("23 times 17 is 391.\n");
    expect(lines(err)).toEqual([
      '[tool calculate {"expression":"23*17"}]',
      '[result calculate {"expression":"23*17","result":391}]',
      expect.stringMatching(/^\[via mock:x · 2 round\(s\) · \d+ ms\]$/),
    ]);
    expect(fetchStub).not.toHaveBeenCalled();
    expect(mock.calls).toHaveLength(2);
  });

  it("sends the system message, the joined prompt and the calculate tool, then the tool result", async () => {
    const { mock } = await runAgent(
      ["what's", "23", "times", "17?"],
      [callTurn("call_1", "calculate", { expression: "23*17" }), { text: "391" }],
    );
    const first = mock.calls[0];
    expect(first?.messages).toEqual([
      {
        role: "system",
        content: "You are a concise assistant. Use the tools when they help. Answer in one or two sentences.",
      },
      { role: "user", content: "what's 23 times 17?" },
    ]);
    expect(first?.tools?.map((tool) => tool.name)).toEqual(["calculate"]);
    expect(mock.calls[1]?.messages.at(-1)).toEqual({
      role: "tool",
      toolCallId: "call_1",
      toolName: "calculate",
      content: '{"expression":"23*17","result":391}',
      isError: false,
    });
  });

  it("keeps the answer on stdout and the tool trace on stderr", async () => {
    const { out, err } = await runAgent(["go"], [callTurn("c", "calculate", { expression: "1+1" }), { text: "It is 2." }]);
    expect(out).not.toContain("[tool");
    expect(out).not.toContain("[via");
    expect(err).not.toContain("It is 2.");
  });

  it("works with the default mock route: no tools, echoes the prompt", async () => {
    const fetchStub = forbidNetwork();
    const out = capture();
    const err = capture();
    const code = await run(["hello", "there"], {}, out, err);
    expect(code).toBe(0);
    expect(out.text).toBe("echo: hello there\n");
    expect(err.text).toMatch(/^\[via mock:echo · 1 round\(s\) · \d+ ms\]\n$/);
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("cuts a long result to 200 characters on stderr", async () => {
    const server = await testServer([plainTool("echo_long", false, () => "x".repeat(500))]);
    const { code, err } = await runAgent(["go"], [callTurn("c", "fs__echo_long", {}), { text: "ok" }], { mcp: [server.spec] });
    expect(code).toBe(0);
    expect(err).toContain(`[result fs__echo_long ${"x".repeat(200)}]`);
    expect(err).not.toContain("x".repeat(201));
  });
});

describe("hello-agent: MCP tools", () => {
  it("imports the server's tools and reports how many", async () => {
    const server = await testServer([plainTool("list_directory", false, () => []), plainTool("write_file", true, () => "ok")]);
    const { err } = await runAgent(["go"], [{ text: "hi" }], { mcp: [server.spec] });
    expect(lines(err)[0]).toBe("[mcp fs: 2 tools]");
  });

  it("offers the MCP tools to the model next to calculate", async () => {
    const server = await testServer([plainTool("list_directory", false, () => []), plainTool("write_file", true, () => "ok")]);
    const { mock } = await runAgent(["go"], [{ text: "hi" }], { mcp: [server.spec] });
    expect(mock.calls[0]?.tools?.map((tool) => tool.name)).toEqual(["calculate", "fs__list_directory", "fs__write_file"]);
  });

  it("runs a read-only tool without --yes", async () => {
    const listing = plainTool("list_directory", false, (args) => ({ path: args["path"], entries: ["a.txt", "b.txt"] }));
    const server = await testServer([listing]);
    const { code, out, err } = await runAgent(
      ["list", "the", "files"],
      [callTurn("c1", "fs__list_directory", { path: "." }), { text: "There are two files." }],
      { mcp: [server.spec] },
    );
    expect(code).toBe(0);
    expect(out).toBe("There are two files.\n");
    expect(listing.calls).toEqual([{ path: "." }]);
    expect(err).toContain('[tool fs__list_directory {"path":"."}]');
    expect(err).toContain('[result fs__list_directory {"path":".","entries":["a.txt","b.txt"]}]');
    expect(err).not.toContain("[declined");
    expect(err).not.toContain("[error");
  });

  it("declines a side-effect tool without --yes: the handler does not run and the model is told", async () => {
    const writer = plainTool("write_file", true, () => "written");
    const server = await testServer([writer]);
    const { code, out, err, mock } = await runAgent(
      ["write", "a", "file"],
      [callTurn("c1", "fs__write_file", { path: "a.txt", content: "hi" }), { text: "I could not write it." }],
      { mcp: [server.spec] },
    );
    expect(code).toBe(0);
    expect(out).toBe("I could not write it.\n");
    expect(writer.calls).toEqual([]);
    const trace = lines(err);
    const declined = trace.indexOf("[declined fs__write_file: run with --yes to allow]");
    const failed = trace.findIndex((line) => line.startsWith("[error fs__write_file "));
    expect(declined).toBeGreaterThan(-1);
    expect(failed).toBeGreaterThan(declined);
    expect(trace[failed]).toContain("was declined");
    expect(mock.calls[1]?.messages.at(-1)).toMatchObject({ role: "tool", toolName: "fs__write_file", isError: true });
  });

  it("runs a side-effect tool with --yes", async () => {
    const writer = plainTool("write_file", true, () => "written");
    const server = await testServer([writer]);
    const { code, err } = await runAgent(
      ["--yes", "write", "a", "file"],
      [callTurn("c1", "fs__write_file", { path: "a.txt", content: "hi" }), { text: "Done." }],
      { mcp: [server.spec] },
    );
    expect(code).toBe(0);
    expect(writer.calls).toEqual([{ path: "a.txt", content: "hi" }]);
    expect(err).toContain("[result fs__write_file written]");
    expect(err).not.toContain("[declined");
    expect(err).not.toContain("[error");
  });

  it("takes --yes from anywhere in the arguments and keeps it out of the prompt", async () => {
    const writer = plainTool("write_file", true, () => "written");
    const server = await testServer([writer]);
    const { mock } = await runAgent(
      ["write", "it", "--yes"],
      [callTurn("c1", "fs__write_file", {}), { text: "Done." }],
      { mcp: [server.spec] },
    );
    expect(writer.calls).toHaveLength(1);
    expect(mock.calls[0]?.messages.at(-1)).toEqual({ role: "user", content: "write it" });
  });

  it("does not let the model call a tool the server never offered", async () => {
    const server = await testServer([plainTool("list_directory", false, () => [])]);
    const { code, err } = await runAgent(
      ["go"],
      [callTurn("c1", "fs__delete_everything", {}), { text: "Sorry." }],
      { mcp: [server.spec] },
    );
    expect(code).toBe(0);
    expect(err).toContain('[error fs__delete_everything unknown tool "fs__delete_everything"]');
  });

  it("closes every MCP connection when the turn ends", async () => {
    const server = await testServer([plainTool("list_directory", false, () => [])]);
    expect(server.state.closed).toBe(false);
    await runAgent(["go"], [{ text: "hi" }], { mcp: [server.spec] });
    await vi.waitFor(() => expect(server.state.closed).toBe(true));
  });

  it("closes the connections when the turn fails", async () => {
    const server = await testServer([plainTool("list_directory", false, () => [])]);
    const { code } = await runAgent(["go"], [{ error: { code: "unavailable", message: "down", retryable: true } }], {
      mcp: [server.spec],
    });
    expect(code).toBe(1);
    await vi.waitFor(() => expect(server.state.closed).toBe(true));
  });

  it("reports a server that cannot start, closes the ones already open, and calls no model", async () => {
    const first = await testServer([plainTool("list_directory", false, () => [])], "good");
    const broken: Transport = {
      start: async () => {
        throw new Error("boom");
      },
      send: async () => {},
      close: async () => {},
    };
    const { code, out, err, mock } = await runAgent(["go"], [{ text: "unused" }], {
      mcp: [first.spec, { name: "bad", transport: broken }],
    });
    expect(code).toBe(1);
    expect(out).toBe("");
    expect(err).toContain('error: unavailable: mcp server "bad" failed to start: boom');
    expect(mock.calls).toHaveLength(0);
    await vi.waitFor(() => expect(first.state.closed).toBe(true));
  });

  it("starts the reference filesystem server for CORE_MCP_FS, without running it in tests", async () => {
    const { code, err } = await runAgent(["go"], [{ text: "unused" }], { env: { CORE_MCP_FS: "/data/files" } });
    expect(code).toBe(1);
    expect(err).toContain('mcp server "fs" failed to start');
    expect(stdio.params).toHaveLength(1);
    expect(stdio.params[0]).toMatchObject({
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem@1", "/data/files"],
    });
  });

  it("starts no MCP server when CORE_MCP_FS is unset or empty", async () => {
    await runAgent(["go"], [{ text: "hi" }]);
    await runAgent(["go"], [{ text: "hi" }], { env: { CORE_MCP_FS: "" } });
    expect(stdio.params).toHaveLength(0);
  });

  it("prefers deps.mcp over CORE_MCP_FS", async () => {
    const server = await testServer([plainTool("list_directory", false, () => [])]);
    const { code } = await runAgent(["go"], [{ text: "hi" }], { env: { CORE_MCP_FS: "/data/files" }, mcp: [server.spec] });
    expect(code).toBe(0);
    expect(stdio.params).toHaveLength(0);
  });
});

describe("hello-agent: arguments and failures", () => {
  for (const [label, argv] of [
    ["no arguments", []],
    ["an empty argument", [""]],
    ["only --yes", ["--yes"]],
  ] as const) {
    it(`exits 2 with usage on stderr for ${label}`, async () => {
      const fetchStub = forbidNetwork();
      const { code, out, err, mock } = await runAgent([...argv], [{ text: "unused" }]);
      expect(code).toBe(2);
      expect(out).toBe("");
      expect(err).toContain("usage:");
      expect(err).toContain("--yes");
      expect(mock.calls).toHaveLength(0);
      expect(fetchStub).not.toHaveBeenCalled();
    });
  }

  it("exits 1 with an attempt line and an error line, and no [via line, when every step of the route fails", async () => {
    const { code, out, err } = await runAgent(["go"], [{ error: { code: "unavailable", message: "down", retryable: true } }]);
    expect(code).toBe(1);
    expect(out).toBe("");
    expect(err).not.toContain("[via");
    expect(lines(err)).toEqual(["attempt 1 mock:x: unavailable: down", "error: unavailable: all 1 route steps failed"]);
  });

  it("prints one attempt line per failed step, in order, before the error line", async () => {
    const { code, err } = await runAgent(
      ["go"],
      [
        { error: { code: "unavailable", message: "down", retryable: true } },
        { error: { code: "rate_limit", message: "slow down", retryable: true } },
      ],
      { env: { CORE_ROUTE: "mock:a,mock:b" } },
    );
    expect(code).toBe(1);
    expect(lines(err)).toEqual([
      "attempt 1 mock:a: unavailable: down",
      "attempt 2 mock:b: rate_limit: slow down",
      expect.stringMatching(/^error: rate_limit: all 2 route steps failed$/),
    ]);
  });

  it("exits 1 when the route names a provider nobody registered", async () => {
    const fetchStub = forbidNetwork();
    const { code, err, mock } = await runAgent(["go"], [{ text: "unused" }], { env: { CORE_ROUTE: "nope:x" } });
    expect(code).toBe(1);
    expect(err).not.toContain("[via");
    expect(lines(err)).toEqual([
      expect.stringMatching(/^attempt 1 nope:x: not_found: .+$/),
      "error: not_found: all 1 route steps failed",
    ]);
    expect(mock.calls).toHaveLength(0);
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("exits 1 for a route entry that is not provider:model", async () => {
    const { code, err } = await runAgent(["go"], [{ text: "unused" }], { env: { CORE_ROUTE: "nocolon" } });
    expect(code).toBe(1);
    expect(err).toMatch(/^error: bad_request: /);
  });

  it("falls back along the route", async () => {
    const { code, out, err } = await runAgent(
      ["go"],
      [{ error: { code: "unavailable", message: "down", retryable: true } }, { text: "second step" }],
      { env: { CORE_ROUTE: "mock:a,mock:b" } },
    );
    expect(code).toBe(0);
    expect(out).toBe("second step\n");
    expect(err).toMatch(/\[via mock:b · 1 round\(s\) · \d+ ms\]/);
  });

  it("reports exactly error: max-rounds when the model calls a tool in every one of the 8 rounds", async () => {
    const script = Array.from({ length: 8 }, (_, n) => callTurn(`c${n}`, "calculate", { expression: "1+1" }));
    const { code, out, err, mock } = await runAgent(["go"], script);
    expect(code).toBe(1);
    expect(out).toBe("");
    expect(mock.calls).toHaveLength(8);
    expect(err).not.toContain("[via");
    expect(err).not.toContain("attempt ");
    expect(lines(err).filter((line) => line.startsWith("error:"))).toEqual(["error: max-rounds"]);
    expect(lines(err).at(-1)).toBe("error: max-rounds");
  });
});

describe("hello-agent: CORE_TIMEOUT_MS", () => {
  for (const value of ["abc", "0", "-5", "1.5"]) {
    it(`exits 2 for ${JSON.stringify(value)} and calls no model`, async () => {
      const fetchStub = forbidNetwork();
      const { code, out, err, mock } = await runAgent(["go"], [{ text: "unused" }], { env: { CORE_TIMEOUT_MS: value } });
      expect(code).toBe(2);
      expect(out).toBe("");
      expect(err).toBe("error: bad_request: CORE_TIMEOUT_MS must be a positive integer\n");
      expect(mock.calls).toHaveLength(0);
      expect(fetchStub).not.toHaveBeenCalled();
    });
  }

  it("reaches the router: a step slower than the value times out and the route falls back", async () => {
    const { code, out, err } = await runAgent(["go"], [{ text: "too slow", delayMs: 2000 }, { text: "fast enough" }], {
      env: { CORE_ROUTE: "mock:slow,mock:fast", CORE_TIMEOUT_MS: "50" },
    });
    expect(code).toBe(0);
    expect(out).toBe("fast enough\n");
    expect(err).toMatch(/\[via mock:fast · 1 round\(s\) · \d+ ms\]/);
  });
});

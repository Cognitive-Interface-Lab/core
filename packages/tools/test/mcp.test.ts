import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { CoreError, type ToolCall, type ToolPolicy } from "@core/contracts";
import {
  ToolRegistry,
  calculateTool,
  connectMcpServer,
  createMcpServer,
  defineTool,
  type McpConnection,
  type McpToolInfo,
  type ToolContext,
} from "../src/index.js";

// The stdio transport would spawn a process. Replace it with one that records its parameters and
// refuses to start, so the stdio path can be checked without running anything.
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

const local: ToolContext = { channel: "local" };

type TestTool = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
  outputSchema?: Record<string, unknown>;
};
type CallResult = Record<string, unknown>;

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  stdio.params.length = 0;
  await Promise.allSettled(cleanups.splice(0).map((close) => close()));
});

/** A small MCP server on one end of an in-memory pair; the other end is returned as a transport. */
async function testServer(options: {
  tools: TestTool[];
  pageSize?: number;
  call?: (name: string, args: Record<string, unknown>) => CallResult;
  listFails?: boolean;
}) {
  const server = new Server({ name: "test-server", version: "1.0.0" }, { capabilities: { tools: {} } });
  const listRequests: (string | undefined)[] = [];
  const calls: { name: string; arguments: Record<string, unknown> | undefined }[] = [];
  server.setRequestHandler(ListToolsRequestSchema, (request) => {
    listRequests.push(request.params?.cursor);
    if (options.listFails) throw new Error("list exploded");
    const size = options.pageSize ?? options.tools.length;
    const start = Number(request.params?.cursor ?? 0);
    const page = options.tools.slice(start, start + size).map((tool) => ({
      inputSchema: { type: "object" as const },
      ...tool,
    }));
    return start + size < options.tools.length ? { tools: page, nextCursor: String(start + size) } : { tools: page };
  });
  server.setRequestHandler(CallToolRequestSchema, (request) => {
    calls.push({ name: request.params.name, arguments: request.params.arguments });
    const result = options.call?.(request.params.name, request.params.arguments ?? {});
    return (result ?? { content: [{ type: "text", text: `ran ${request.params.name}` }] }) as {
      content: { type: "text"; text: string }[];
    };
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  cleanups.push(() => server.close());
  return { transport: clientSide, calls, listRequests };
}

async function connect(
  options: Parameters<typeof testServer>[0],
  name = "files",
  opts?: { policy?: (tool: McpToolInfo) => ToolPolicy },
): Promise<{ connection: McpConnection; calls: Awaited<ReturnType<typeof testServer>>["calls"]; listRequests: (string | undefined)[] }> {
  const { transport, calls, listRequests } = await testServer(options);
  const connection = await connectMcpServer({ name, transport }, opts);
  cleanups.push(() => connection.close());
  return { connection, calls, listRequests };
}

function toolNamed(connection: McpConnection, name: string) {
  const found = connection.tools().find((tool) => tool.definition.name === name);
  if (found === undefined) throw new Error(`no tool ${name} in ${connection.tools().map((t) => t.definition.name).join(", ")}`);
  return found;
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the promise to reject");
}

describe("connectMcpServer: importing tools", () => {
  it("prefixes names with the server, replaces unsafe characters and keeps description and schema", async () => {
    const schema = { type: "object", properties: { path: { type: "string" } }, required: ["path"] };
    const { connection } = await connect({
      tools: [
        { name: "read_file", description: "Reads a file", inputSchema: schema },
        { name: "list.dir" },
        { name: "a b/c" },
        { name: "keep-dash_and_UPPER9" },
      ],
    });
    expect(connection.name).toBe("files");
    expect(connection.tools().map((tool) => tool.definition.name)).toEqual([
      "files__read_file",
      "files__list_dir",
      "files__a_b_c",
      "files__keep-dash_and_UPPER9",
    ]);
    const read = toolNamed(connection, "files__read_file");
    expect(read.definition.description).toBe("Reads a file");
    expect(read.definition.inputSchema).toEqual(schema);
    expect(read.source).toBe("mcp:files");
    expect(toolNamed(connection, "files__list_dir").definition.description).toBe("");
    expect(connection.skipped).toEqual([]);
  });

  it("registers cleanly: every imported definition passes the registry's validation", async () => {
    const { connection } = await connect({ tools: [{ name: "x.y" }, { name: "ünï" }] });
    const registry = new ToolRegistry();
    for (const tool of connection.tools()) registry.register(tool);
    expect(registry.list().map((definition) => definition.name)).toEqual(["files___n_", "files__x_y"]);
  });

  it("skips a tool whose registered name would pass 64 characters, and lists its MCP name", async () => {
    const fits = "x".repeat(57); // "files__" + 57 = 64
    const tooLong = "y".repeat(58); // 65
    const { connection } = await connect({ tools: [{ name: fits }, { name: tooLong }, { name: "short" }] });
    expect(connection.tools().map((tool) => tool.definition.name)).toEqual([`files__${fits}`, "files__short"]);
    expect(connection.skipped).toEqual([tooLong]);
  });

  it("skips a tool whose sanitised name clashes with an earlier one", async () => {
    const { connection } = await connect({ tools: [{ name: "write.file" }, { name: "write_file" }] });
    expect(connection.tools().map((tool) => tool.definition.name)).toEqual(["files__write_file"]);
    expect(connection.skipped).toEqual(["write_file"]);
  });

  it("follows nextCursor pages and lists once, at connect", async () => {
    const tools = ["a", "b", "c", "d", "e"].map((name) => ({ name }));
    const { connection, listRequests } = await connect({ tools, pageSize: 2 });
    expect(connection.tools().map((tool) => tool.definition.name)).toEqual(
      ["a", "b", "c", "d", "e"].map((name) => `files__${name}`),
    );
    expect(listRequests).toEqual([undefined, "2", "4"]);
    connection.tools();
    expect(listRequests).toHaveLength(3);
  });

  it("an empty server imports nothing", async () => {
    const { connection } = await connect({ tools: [] });
    expect(connection.tools()).toEqual([]);
    expect(connection.skipped).toEqual([]);
  });
});

describe("connectMcpServer: policy", () => {
  const tools: TestTool[] = [
    { name: "reads", annotations: { readOnlyHint: true } },
    { name: "writes", annotations: { readOnlyHint: false } },
    { name: "unhinted" },
    { name: "destroys", annotations: { destructiveHint: true } },
    { name: "both", annotations: { readOnlyHint: true, destructiveHint: false } },
  ];

  it("by default allows only the local channel and treats a tool as having side effects unless readOnlyHint is true", async () => {
    const { connection } = await connect({ tools });
    const policies = Object.fromEntries(connection.tools().map((tool) => [tool.definition.name, tool.policy]));
    expect(policies).toEqual({
      files__reads: { channels: ["local"], sideEffects: false },
      files__writes: { channels: ["local"], sideEffects: true },
      files__unhinted: { channels: ["local"], sideEffects: true },
      files__destroys: { channels: ["local"], sideEffects: true },
      files__both: { channels: ["local"], sideEffects: false },
    });
  });

  it("opts.policy replaces the default and sees the original name and the hints", async () => {
    const seen: McpToolInfo[] = [];
    const { connection } = await connect(
      { tools },
      "files",
      {
        policy: (info) => {
          seen.push(info);
          return { channels: ["local", "voice"], sideEffects: false };
        },
      },
    );
    expect(seen.map((info) => info.name)).toEqual(["reads", "writes", "unhinted", "destroys", "both"]);
    expect(seen[0]?.annotations).toEqual({ readOnlyHint: true });
    expect(seen[3]?.annotations).toEqual({ destructiveHint: true });
    expect(seen[4]?.annotations).toEqual({ readOnlyHint: true, destructiveHint: false });
    expect(seen[2]?.annotations).toBeUndefined();
    for (const tool of connection.tools()) {
      expect(tool.policy).toEqual({ channels: ["local", "voice"], sideEffects: false });
    }
  });

  it("through a registry, an imported tool is refused off the local channel and needs confirmation", async () => {
    const { connection } = await connect({ tools });
    const registry = new ToolRegistry();
    for (const tool of connection.tools()) registry.register(tool);
    const call = (name: string): ToolCall => ({ id: "c1", name, arguments: {} });
    expect((await registry.call(call("files__reads"), { channel: "voice" })).content).toBe(
      'tool "files__reads" is not allowed on channel "voice"',
    );
    expect((await registry.call(call("files__reads"), local)).isError).toBe(false);
    expect((await registry.call(call("files__writes"), local)).content).toBe('tool "files__writes" needs confirmation');
    expect(
      (await registry.call(call("files__writes"), { channel: "local", confirm: async () => true })).isError,
    ).toBe(false);
  });
});

describe("connectMcpServer: calling tools", () => {
  it("passes the arguments and the original, unsanitised tool name to the server", async () => {
    const { connection, calls } = await connect({ tools: [{ name: "list.dir" }] });
    await toolNamed(connection, "files__list_dir").handler({ path: "/tmp", depth: 2 }, local);
    expect(calls).toEqual([{ name: "list.dir", arguments: { path: "/tmp", depth: 2 } }]);
  });

  it("returns the text of a text result, and joins several text parts with a newline", async () => {
    const { connection } = await connect({
      tools: [{ name: "one" }, { name: "two" }],
      call: (name) => ({
        content:
          name === "one"
            ? [{ type: "text", text: "hello" }]
            : [
                { type: "text", text: "line 1" },
                { type: "text", text: "line 2" },
              ],
      }),
    });
    expect(await toolNamed(connection, "files__one").handler({}, local)).toBe("hello");
    expect(await toolNamed(connection, "files__two").handler({}, local)).toBe("line 1\nline 2");
  });

  it("returns structuredContent when the server sends it, instead of the text", async () => {
    const outputSchema = { type: "object", properties: { n: { type: "number" } }, required: ["n"] };
    const { connection } = await connect({
      tools: [{ name: "data", outputSchema }],
      call: () => ({ structuredContent: { n: 4 }, content: [{ type: "text", text: '{"n":4}' }] }),
    });
    expect(await toolNamed(connection, "files__data").handler({}, local)).toEqual({ n: 4 });
  });

  it("replaces every non-text part with a placeholder, in order", async () => {
    const { connection } = await connect({
      tools: [{ name: "media" }],
      call: () => ({
        content: [
          { type: "text", text: "before" },
          { type: "image", data: "AAAA", mimeType: "image/png" },
          { type: "audio", data: "AAAA", mimeType: "audio/wav" },
          { type: "resource", resource: { uri: "file:///a.txt", text: "secret body" } },
          { type: "text", text: "after" },
        ],
      }),
    });
    const result = await toolNamed(connection, "files__media").handler({}, local);
    expect(result).toBe(
      "before\n[image content omitted]\n[audio content omitted]\n[resource content omitted]\nafter",
    );
    expect(String(result)).not.toContain("secret body");
  });

  it("throws CoreError unknown with the text when the server reports isError", async () => {
    const { connection } = await connect({
      tools: [{ name: "fail" }],
      call: () => ({ isError: true, content: [{ type: "text", text: "no such file: /x" }] }),
    });
    const error = await rejectionOf(toolNamed(connection, "files__fail").handler({}, local));
    expect(CoreError.is(error)).toBe(true);
    expect((error as CoreError).code).toBe("unknown");
    expect((error as CoreError).message).toBe("no such file: /x");
  });

  it("through a registry, a server error becomes an error result the model can read", async () => {
    const { connection } = await connect({
      tools: [{ name: "fail", annotations: { readOnlyHint: true } }],
      call: () => ({ isError: true, content: [{ type: "text", text: "no such file: /x" }] }),
    });
    const registry = new ToolRegistry().register(toolNamed(connection, "files__fail"));
    expect(await registry.call({ id: "c9", name: "files__fail", arguments: {} }, local)).toEqual({
      toolCallId: "c9",
      toolName: "files__fail",
      content: "no such file: /x",
      isError: true,
    });
  });

  it("passes the context's signal on: an aborted signal cancels the request", async () => {
    const { connection, calls } = await connect({ tools: [{ name: "slow" }] });
    const error = await rejectionOf(
      toolNamed(connection, "files__slow").handler({}, { channel: "local", signal: AbortSignal.abort() }),
    );
    expect(error).toBeInstanceOf(Error);
    expect(calls).toEqual([]);
  });
});

describe("connectMcpServer: lifecycle and errors", () => {
  it("close() twice is safe", async () => {
    const { connection } = await connect({ tools: [{ name: "a" }] });
    await connection.close();
    await expect(connection.close()).resolves.toBeUndefined();
  });

  it("a tool cannot be called after close(), and says so as an error", async () => {
    const { connection } = await connect({ tools: [{ name: "a" }] });
    const tool = toolNamed(connection, "files__a");
    await connection.close();
    await expect(tool.handler({}, local)).rejects.toBeInstanceOf(Error);
  });

  it("rejects an invalid server name with bad_request before using the transport", async () => {
    const transport = { start: vi.fn(), send: vi.fn(), close: vi.fn() } as unknown as Transport;
    for (const name of ["", "Files", "a_b", "has space", "a".repeat(21), "dot.name"]) {
      const error = await rejectionOf(connectMcpServer({ name, transport }));
      expect(CoreError.is(error), JSON.stringify(name)).toBe(true);
      expect((error as CoreError).code).toBe("bad_request");
    }
    expect(transport.start).not.toHaveBeenCalled();
  });

  it("accepts the boundary names", async () => {
    for (const name of ["a", "a".repeat(20), "my-server-2"]) {
      const { connection } = await connect({ tools: [] }, name);
      expect(connection.name).toBe(name);
    }
  });

  it("a transport that cannot start gives unavailable with the reason", async () => {
    const transport: Transport = {
      start: async () => {
        throw new Error("boom");
      },
      send: async () => {},
      close: async () => {},
    };
    const error = await rejectionOf(connectMcpServer({ name: "broken", transport }));
    expect(CoreError.is(error)).toBe(true);
    expect((error as CoreError).code).toBe("unavailable");
    expect((error as CoreError).message).toBe('mcp server "broken" failed to start: boom');
  });

  it("a server whose tool list fails gives unavailable", async () => {
    const { transport } = await testServer({ tools: [{ name: "a" }], listFails: true });
    const error = await rejectionOf(connectMcpServer({ name: "badlist", transport }));
    expect((error as CoreError).code).toBe("unavailable");
    expect((error as CoreError).message).toMatch(/^mcp server "badlist" failed to start: .*list exploded/);
  });

  it("a command that cannot start is reported as unavailable, without leaking the environment", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-secret-do-not-leak");
    const error = await rejectionOf(connectMcpServer({ name: "stdio", command: "some-server" }));
    expect((error as CoreError).code).toBe("unavailable");
    expect((error as CoreError).message).toBe('mcp server "stdio" failed to start: spawn blocked in tests');
    expect((error as CoreError).message).not.toContain("sk-secret");
  });
});

describe("connectMcpServer: stdio parameters", () => {
  it("gives the server the minimal default environment plus spec.env, never process.env", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-secret-do-not-leak");
    vi.stubEnv("CORE_OPENAI_API_KEY", "sk-secret-do-not-leak-2");
    vi.stubEnv("PATH", "/usr/bin:/bin");
    await rejectionOf(
      connectMcpServer({
        name: "stdio",
        command: "npx",
        args: ["-y", "some-server", "/data"],
        env: { SERVER_TOKEN: "for-the-server", PATH: "/custom/bin" },
        cwd: "/work",
      }),
    );
    expect(stdio.params).toHaveLength(1);
    const params = stdio.params[0] as {
      command: string;
      args: string[];
      cwd: string;
      stderr: string;
      env: Record<string, string>;
    };
    expect(params.command).toBe("npx");
    expect(params.args).toEqual(["-y", "some-server", "/data"]);
    expect(params.cwd).toBe("/work");
    expect(params.stderr).toBe("ignore");
    expect(params.env["SERVER_TOKEN"]).toBe("for-the-server");
    expect(params.env["PATH"]).toBe("/custom/bin");
    expect(Object.keys(params.env)).not.toContain("OPENAI_API_KEY");
    expect(Object.keys(params.env)).not.toContain("CORE_OPENAI_API_KEY");
    expect(JSON.stringify(params.env)).not.toContain("sk-secret");
  });

  it("without spec.env the environment is only the default one", async () => {
    vi.stubEnv("SOME_OTHER_VARIABLE", "present-in-the-parent");
    await rejectionOf(connectMcpServer({ name: "stdio", command: "server" }));
    const env = (stdio.params[0] as { env: Record<string, string> }).env;
    expect(Object.keys(env)).not.toContain("SOME_OTHER_VARIABLE");
    expect(env).toEqual(getDefaultEnvironment());
  });
});

describe("createMcpServer", () => {
  function hostRegistry() {
    const saved: string[] = [];
    const registry = new ToolRegistry()
      .register(calculateTool)
      .register(
        defineTool({
          name: "save_note",
          description: "Saves a note",
          input: z.object({ text: z.string() }),
          policy: { sideEffects: true },
          handler: ({ text }) => {
            saved.push(text);
            return `saved ${text}`;
          },
        }),
      )
      .register(
        defineTool({
          name: "speak",
          description: "Speaks",
          input: z.object({}),
          policy: { channels: ["voice"], sideEffects: false },
          handler: () => "spoken",
        }),
      )
      .register(
        defineTool({
          name: "local_only",
          description: "Local only",
          input: z.object({}),
          policy: { channels: ["local"], sideEffects: false },
          handler: () => "local",
        }),
      );
    return { registry, saved };
  }

  async function hostClient(registry: ToolRegistry, opts: Partial<Parameters<typeof createMcpServer>[1]> = {}) {
    const server = createMcpServer(registry, { name: "core", version: "0.1.0", channel: "voice", ...opts });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: "test-client", version: "1.0.0" });
    await client.connect(clientSide);
    cleanups.push(() => client.close(), () => server.close());
    return { client, server, clientSide };
  }

  const textOf = (result: Awaited<ReturnType<Client["callTool"]>>) =>
    (result["content"] as { type: string; text: string }[]).map((part) => part.text).join("");

  it("identifies itself and offers tools", async () => {
    const { registry } = hostRegistry();
    const { client } = await hostClient(registry, { name: "core-host", version: "9.9.9" });
    expect(client.getServerVersion()).toMatchObject({ name: "core-host", version: "9.9.9" });
    expect(client.getServerCapabilities()).toHaveProperty("tools");
  });

  it("lists only the tools allowed on its channel, with readOnlyHint from the policy", async () => {
    const { registry } = hostRegistry();
    const { client } = await hostClient(registry);
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(["calculate", "save_note", "speak"]);
    const hints = Object.fromEntries(tools.map((tool) => [tool.name, tool.annotations?.readOnlyHint]));
    expect(hints).toEqual({ calculate: true, save_note: false, speak: true });
    const calculate = tools[0];
    expect(calculate?.description).toContain("arithmetic");
    expect(calculate?.inputSchema).toMatchObject({ type: "object", required: ["expression"] });
  });

  it("lists a different set on another channel", async () => {
    const { registry } = hostRegistry();
    const { client } = await hostClient(registry, { channel: "local" });
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(["calculate", "local_only", "save_note"]);
  });

  it("reads the registry live at each request", async () => {
    const { registry } = hostRegistry();
    const { client } = await hostClient(registry);
    registry.unregister("speak");
    registry.register(
      defineTool({
        name: "late",
        description: "Added later",
        input: z.object({}),
        policy: { sideEffects: false },
        handler: () => "late",
      }),
    );
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(["calculate", "late", "save_note"]);
  });

  it("sends an object schema even for a tool registered with an empty one", async () => {
    const { registry } = hostRegistry();
    registry.register({
      definition: { name: "bare", description: "No schema", inputSchema: {} },
      policy: { sideEffects: false },
      handler: async () => "bare",
      source: "local",
    });
    const { client } = await hostClient(registry);
    const bare = (await client.listTools()).tools.find((tool) => tool.name === "bare");
    expect(bare?.inputSchema.type).toBe("object");
  });

  it("calculate answers 391 for 23*17", async () => {
    const { registry } = hostRegistry();
    const { client } = await hostClient(registry);
    const result = await client.callTool({ name: "calculate", arguments: { expression: "23*17" } });
    expect(result["isError"]).toBe(false);
    expect(textOf(result)).toBe('{"expression":"23*17","result":391}');
    expect(textOf(result)).toContain("391");
  });

  it("a side-effect tool without confirm is listed but its call needs confirmation", async () => {
    const { registry, saved } = hostRegistry();
    const { client } = await hostClient(registry);
    expect((await client.listTools()).tools.map((tool) => tool.name)).toContain("save_note");
    const result = await client.callTool({ name: "save_note", arguments: { text: "milk" } });
    expect(result["isError"]).toBe(true);
    expect(textOf(result)).toBe('tool "save_note" needs confirmation');
    expect(saved).toEqual([]);
  });

  it("with a confirm that accepts, the side-effect tool runs, and confirm sees the call", async () => {
    const { registry, saved } = hostRegistry();
    const asked: ToolCall[] = [];
    const confirm = vi.fn(async (call: ToolCall) => {
      asked.push(call);
      return true;
    });
    const { client } = await hostClient(registry, { confirm });
    const result = await client.callTool({ name: "save_note", arguments: { text: "milk" } });
    expect(result["isError"]).toBe(false);
    expect(textOf(result)).toBe("saved milk");
    expect(saved).toEqual(["milk"]);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ name: "save_note", arguments: { text: "milk" } });
  });

  it("with a confirm that declines, the tool does not run", async () => {
    const { registry, saved } = hostRegistry();
    const { client } = await hostClient(registry, { confirm: async () => false });
    const result = await client.callTool({ name: "save_note", arguments: { text: "milk" } });
    expect(result["isError"]).toBe(true);
    expect(textOf(result)).toBe('tool "save_note" was declined');
    expect(saved).toEqual([]);
  });

  it("refuses a tool the channel may not call even when asked by name", async () => {
    const { registry } = hostRegistry();
    const { client } = await hostClient(registry);
    const result = await client.callTool({ name: "local_only", arguments: {} });
    expect(result["isError"]).toBe(true);
    expect(textOf(result)).toBe('tool "local_only" is not allowed on channel "voice"');
  });

  it("answers an unknown tool and invalid arguments as error results, not protocol errors", async () => {
    const { registry } = hostRegistry();
    const { client } = await hostClient(registry);
    const unknown = await client.callTool({ name: "nope", arguments: {} });
    expect(unknown["isError"]).toBe(true);
    expect(textOf(unknown)).toBe('unknown tool "nope"');
    const invalid = await client.callTool({ name: "calculate", arguments: {} });
    expect(invalid["isError"]).toBe(true);
    expect(textOf(invalid)).toMatch(/^invalid arguments for "calculate": expression: /);
  });

  it("treats missing arguments as an empty object", async () => {
    const { registry } = hostRegistry();
    const { client } = await hostClient(registry);
    const result = await client.callTool({ name: "speak" });
    expect(result["isError"]).toBe(false);
    expect(textOf(result)).toBe("spoken");
  });

  it("gives every call its own UUID", async () => {
    const { registry } = hostRegistry();
    const ids: string[] = [];
    const { client } = await hostClient(registry, {
      confirm: async (call) => {
        ids.push(call.id);
        return true;
      },
    });
    await client.callTool({ name: "save_note", arguments: { text: "a" } });
    await client.callTool({ name: "save_note", arguments: { text: "b" } });
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it("passes the request's abort signal to the handler", async () => {
    const { registry } = hostRegistry();
    let seen: AbortSignal | undefined;
    let started!: () => void;
    const running = new Promise<void>((resolve) => (started = resolve));
    registry.register(
      defineTool({
        name: "wait",
        description: "Waits for cancellation",
        input: z.object({}),
        policy: { sideEffects: false },
        handler: (_args, ctx) =>
          new Promise((_resolve, reject) => {
            seen = ctx.signal;
            started();
            ctx.signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
          }),
      }),
    );
    const { client } = await hostClient(registry);
    const controller = new AbortController();
    const pending = client.callTool({ name: "wait", arguments: {} }, undefined, { signal: controller.signal });
    await running;
    controller.abort();
    await rejectionOf(pending);
    await vi.waitFor(() => expect(seen?.aborted).toBe(true));
  });
});

describe("round trip: client → host → registry", () => {
  it("imports a host's calculate tool back through connectMcpServer and runs it", async () => {
    const hosted = new ToolRegistry().register(calculateTool);
    const server = createMcpServer(hosted, { name: "core", version: "0.1.0", channel: "local" });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    cleanups.push(() => server.close());

    const connection = await connectMcpServer({ name: "self", transport: clientSide });
    cleanups.push(() => connection.close());
    expect(connection.skipped).toEqual([]);
    const imported = connection.tools();
    expect(imported.map((tool) => tool.definition.name)).toEqual(["self__calculate"]);
    expect(imported[0]?.definition.inputSchema).toMatchObject({ type: "object", required: ["expression"] });
    expect(imported[0]?.policy).toEqual({ channels: ["local"], sideEffects: false });
    expect(imported[0]?.source).toBe("mcp:self");

    const mine = new ToolRegistry();
    for (const tool of imported) mine.register(tool);
    const result = await mine.call(
      { id: "c1", name: "self__calculate", arguments: { expression: "23*17" } },
      local,
    );
    expect(result).toEqual({
      toolCallId: "c1",
      toolName: "self__calculate",
      content: '{"expression":"23*17","result":391}',
      isError: false,
    });
  });

  it("carries a refusal from the host's gate back as an error result", async () => {
    const hosted = new ToolRegistry().register(calculateTool).register(
      defineTool({
        name: "write",
        description: "Writes",
        input: z.object({}),
        policy: { sideEffects: true },
        handler: () => "written",
      }),
    );
    const server = createMcpServer(hosted, { name: "core", version: "0.1.0", channel: "local" });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    cleanups.push(() => server.close());
    const connection = await connectMcpServer({ name: "self", transport: clientSide });
    cleanups.push(() => connection.close());
    const mine = new ToolRegistry();
    for (const tool of connection.tools()) mine.register(tool);

    expect(mine.get("self__write").policy.sideEffects).toBe(true);
    const result = await mine.call(
      { id: "c2", name: "self__write", arguments: {} },
      { channel: "local", confirm: async () => true },
    );
    expect(result).toMatchObject({ isError: true, content: 'tool "write" needs confirmation' });
  });
});

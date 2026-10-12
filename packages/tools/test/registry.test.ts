import { describe, expect, it, vi } from "vitest";
import { CoreError, type ToolCall, type ToolDefinition, type ToolPolicy } from "@core/contracts";
import { isAllowedOn, ToolRegistry, type RegisteredTool, type ToolContext, type ToolHandler } from "../src/index.js";

const local: ToolContext = { channel: "local" };

function tool(
  name: string,
  options: { policy?: ToolPolicy; handler?: ToolHandler; source?: string } = {},
): RegisteredTool {
  return {
    definition: { name, description: `the ${name} tool`, inputSchema: { type: "object" } },
    policy: options.policy ?? { sideEffects: false },
    handler: options.handler ?? (async () => "ok"),
    source: options.source ?? "local",
  };
}

function callOf(name: string, args: Record<string, unknown> = {}, id = "call_1"): ToolCall {
  return { id, name, arguments: args };
}

function thrownBy(run: () => unknown): CoreError {
  try {
    run();
  } catch (error) {
    expect(CoreError.is(error)).toBe(true);
    return error as CoreError;
  }
  throw new Error("expected the call to throw");
}

describe("ToolRegistry registration", () => {
  it("registers a tool and returns the registry so calls chain", () => {
    const registry = new ToolRegistry();
    expect(registry.register(tool("a")).register(tool("b"))).toBe(registry);
    expect(registry.has("a")).toBe(true);
    expect(registry.has("b")).toBe(true);
    expect(registry.has("c")).toBe(false);
  });

  it("rejects a duplicate name with bad_request and keeps the first tool", () => {
    const registry = new ToolRegistry().register(tool("a", { source: "local" }));
    const error = thrownBy(() => registry.register(tool("a", { source: "mcp:other" })));
    expect(error.code).toBe("bad_request");
    expect(error.message).toContain('"a"');
    expect(registry.get("a").source).toBe("local");
  });

  it("rejects an invalid definition with bad_request", () => {
    const registry = new ToolRegistry();
    for (const name of ["", "has space", "x".repeat(65), "dot.name"]) {
      expect(thrownBy(() => registry.register(tool(name))).code, JSON.stringify(name)).toBe("bad_request");
    }
    const noSchema = { ...tool("a"), definition: { name: "a", description: "d" } } as unknown as RegisteredTool;
    expect(thrownBy(() => registry.register(noSchema)).code).toBe("bad_request");
    expect(registry.list()).toEqual([]);
  });

  it("rejects an invalid policy with bad_request", () => {
    const registry = new ToolRegistry();
    for (const policy of [{ channels: [], sideEffects: false }, { channels: ["Local"], sideEffects: false }, {}]) {
      const error = thrownBy(() => registry.register(tool("a", { policy: policy as ToolPolicy })));
      expect(error.code, JSON.stringify(policy)).toBe("bad_request");
    }
    expect(registry.has("a")).toBe(false);
  });

  it("accepts every valid name character", () => {
    const registry = new ToolRegistry().register(tool("Valid_name-1")).register(tool("x".repeat(64)));
    expect(registry.has("Valid_name-1")).toBe(true);
  });
});

describe("ToolRegistry lookup", () => {
  it("get returns the registered tool", () => {
    const handler: ToolHandler = async () => 1;
    const registry = new ToolRegistry().register(tool("a", { handler, source: "mcp:files" }));
    const found = registry.get("a");
    expect(found.definition.name).toBe("a");
    expect(found.policy).toEqual({ sideEffects: false });
    expect(found.source).toBe("mcp:files");
    expect(found.handler).toBe(handler);
  });

  it("get of an unknown name throws not_found", () => {
    const error = thrownBy(() => new ToolRegistry().get("missing"));
    expect(error.code).toBe("not_found");
    expect(error.message).toContain("missing");
  });

  it("unregister reports whether it removed something, and the name can be reused", () => {
    const registry = new ToolRegistry().register(tool("a"));
    expect(registry.unregister("a")).toBe(true);
    expect(registry.unregister("a")).toBe(false);
    expect(registry.has("a")).toBe(false);
    expect(thrownBy(() => registry.get("a")).code).toBe("not_found");
    registry.register(tool("a"));
    expect(registry.has("a")).toBe(true);
  });
});

describe("ToolRegistry.list and listFor", () => {
  const names = (definitions: ToolDefinition[]) => definitions.map((definition) => definition.name);

  const registry = new ToolRegistry()
    .register(tool("zeta"))
    .register(tool("alpha", { policy: { channels: ["voice"], sideEffects: false } }))
    .register(tool("mid", { policy: { channels: ["local", "trilix"], sideEffects: true } }))
    .register(tool("beta", { policy: { channels: ["remote"], sideEffects: false } }));

  it("list returns every definition sorted by name", () => {
    expect(names(registry.list())).toEqual(["alpha", "beta", "mid", "zeta"]);
  });

  it("listFor keeps tools without channels and tools that list the channel, sorted", () => {
    expect(names(registry.listFor("local"))).toEqual(["mid", "zeta"]);
    expect(names(registry.listFor("voice"))).toEqual(["alpha", "zeta"]);
    expect(names(registry.listFor("remote"))).toEqual(["beta", "zeta"]);
    expect(names(registry.listFor("trilix"))).toEqual(["mid", "zeta"]);
  });

  it("listFor an unlisted channel returns only the tools open to every channel", () => {
    expect(names(registry.listFor("other"))).toEqual(["zeta"]);
  });

  it("is empty for an empty registry and follows unregister", () => {
    const empty = new ToolRegistry();
    expect(empty.list()).toEqual([]);
    expect(empty.listFor("local")).toEqual([]);
    empty.register(tool("a")).register(tool("b"));
    empty.unregister("a");
    expect(names(empty.list())).toEqual(["b"]);
  });
});

describe("isAllowedOn", () => {
  it("allows every channel when channels is omitted", () => {
    expect(isAllowedOn({ sideEffects: false }, "anything")).toBe(true);
  });

  it("allows only the listed channels", () => {
    const policy: ToolPolicy = { channels: ["local", "voice"], sideEffects: false };
    expect(isAllowedOn(policy, "local")).toBe(true);
    expect(isAllowedOn(policy, "voice")).toBe(true);
    expect(isAllowedOn(policy, "remote")).toBe(false);
  });
});

describe("ToolRegistry.call gate", () => {
  it("1. an unknown tool is an error result with the call's id and name", async () => {
    const result = await new ToolRegistry().call(callOf("nope", {}, "call_9"), local);
    expect(result).toEqual({ toolCallId: "call_9", toolName: "nope", content: 'unknown tool "nope"', isError: true });
  });

  it("2. a channel that is not allowed is refused and the handler does not run", async () => {
    const handler = vi.fn(async () => "ran");
    const registry = new ToolRegistry().register(
      tool("secret", { policy: { channels: ["voice"], sideEffects: false }, handler }),
    );
    const result = await registry.call(callOf("secret"), local);
    expect(result).toEqual({
      toolCallId: "call_1",
      toolName: "secret",
      content: 'tool "secret" is not allowed on channel "local"',
      isError: true,
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("3. an already aborted signal is refused and the handler does not run", async () => {
    const handler = vi.fn(async () => "ran");
    const registry = new ToolRegistry().register(tool("slow", { handler }));
    const result = await registry.call(callOf("slow"), { channel: "local", signal: AbortSignal.abort() });
    expect(result.isError).toBe(true);
    expect(result.content).toBe('tool "slow" was aborted');
    expect(handler).not.toHaveBeenCalled();
  });

  it("a signal that is not aborted lets the call through", async () => {
    const registry = new ToolRegistry().register(tool("a"));
    const result = await registry.call(callOf("a"), { channel: "local", signal: new AbortController().signal });
    expect(result).toEqual({ toolCallId: "call_1", toolName: "a", content: "ok", isError: false });
  });

  describe("4. side effects need confirmation", () => {
    const effect = (handler: ToolHandler) =>
      new ToolRegistry().register(tool("write", { policy: { sideEffects: true }, handler }));

    it("without a confirm function the call needs confirmation and does not run", async () => {
      const handler = vi.fn(async () => "wrote");
      const result = await effect(handler).call(callOf("write"), local);
      expect(result.isError).toBe(true);
      expect(result.content).toBe('tool "write" needs confirmation');
      expect(handler).not.toHaveBeenCalled();
    });

    it("a confirm that resolves false declines the call", async () => {
      const handler = vi.fn(async () => "wrote");
      const result = await effect(handler).call(callOf("write"), { channel: "local", confirm: async () => false });
      expect(result.isError).toBe(true);
      expect(result.content).toBe('tool "write" was declined');
      expect(handler).not.toHaveBeenCalled();
    });

    it("a confirm that rejects declines the call", async () => {
      const handler = vi.fn(async () => "wrote");
      const confirm = async () => {
        throw new Error("prompt crashed");
      };
      const result = await effect(handler).call(callOf("write"), { channel: "local", confirm });
      expect(result).toMatchObject({ isError: true, content: 'tool "write" was declined' });
      expect(handler).not.toHaveBeenCalled();
    });

    it("a confirm that throws synchronously declines the call", async () => {
      const handler = vi.fn(async () => "wrote");
      const confirm = (() => {
        throw new Error("prompt crashed");
      }) as unknown as ToolContext["confirm"];
      const result = await effect(handler).call(callOf("write"), { channel: "local", confirm });
      expect(result).toMatchObject({ isError: true, content: 'tool "write" was declined' });
      expect(handler).not.toHaveBeenCalled();
    });

    it("an accepted call runs, and confirm receives the call and the tool's definition", async () => {
      const handler = vi.fn(async () => "wrote");
      const confirm = vi.fn(async () => true);
      const call = callOf("write", { path: "a.txt" });
      const result = await effect(handler).call(call, { channel: "local", confirm });
      expect(result).toEqual({ toolCallId: "call_1", toolName: "write", content: "wrote", isError: false });
      expect(confirm).toHaveBeenCalledTimes(1);
      const [askedCall, askedTool] = confirm.mock.calls[0] as unknown as [ToolCall, ToolDefinition];
      expect(askedCall).toBe(call);
      expect(askedTool.name).toBe("write");
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it("a tool without side effects never asks for confirmation", async () => {
      const confirm = vi.fn(async () => false);
      const registry = new ToolRegistry().register(tool("read"));
      const result = await registry.call(callOf("read"), { channel: "local", confirm });
      expect(result.isError).toBe(false);
      expect(confirm).not.toHaveBeenCalled();
    });
  });

  describe("5. results are serialised", () => {
    const resultOf = async (value: unknown) => {
      const registry = new ToolRegistry().register(tool("t", { handler: async () => value }));
      return registry.call(callOf("t"), local);
    };

    it("a string is the content as is", async () => {
      expect(await resultOf("hello")).toEqual({ toolCallId: "call_1", toolName: "t", content: "hello", isError: false });
      expect((await resultOf("")).content).toBe("");
    });

    it("an object, array or number is JSON", async () => {
      expect((await resultOf({ a: 1, b: [true, null] })).content).toBe('{"a":1,"b":[true,null]}');
      expect((await resultOf([1, 2])).content).toBe("[1,2]");
      expect((await resultOf(391)).content).toBe("391");
      expect((await resultOf(false)).content).toBe("false");
    });

    it("undefined and null become the text null", async () => {
      expect(await resultOf(undefined)).toMatchObject({ content: "null", isError: false });
      expect(await resultOf(null)).toMatchObject({ content: "null", isError: false });
    });

    it("a circular value is an error result", async () => {
      const circular: Record<string, unknown> = {};
      circular["self"] = circular;
      expect(await resultOf(circular)).toEqual({
        toolCallId: "call_1",
        toolName: "t",
        content: 'tool "t" returned a value that is not JSON',
        isError: true,
      });
    });

    it("a BigInt, a function or a symbol is an error result, never undefined content", async () => {
      for (const value of [10n, () => 1, Symbol("s")]) {
        const result = await resultOf(value);
        expect(result.isError).toBe(true);
        expect(result.content).toBe('tool "t" returned a value that is not JSON');
      }
    });
  });

  describe("6. a throwing handler is an error result", () => {
    const failing = (handler: ToolHandler) => new ToolRegistry().register(tool("boom", { handler }));

    it("uses an Error's message", async () => {
      const result = await failing(async () => {
        throw new Error("disk is full");
      }).call(callOf("boom"), local);
      expect(result).toEqual({ toolCallId: "call_1", toolName: "boom", content: "disk is full", isError: true });
    });

    it("uses a CoreError's message", async () => {
      const result = await failing(async () => {
        throw new CoreError("bad_request", "invalid arguments");
      }).call(callOf("boom"), local);
      expect(result).toMatchObject({ content: "invalid arguments", isError: true });
    });

    it("says the tool failed when the thrown value is not an Error", async () => {
      for (const thrown of ["oops", 42, null, undefined, { message: "not an Error" }]) {
        const result = await failing(async () => {
          throw thrown;
        }).call(callOf("boom"), local);
        expect(result, String(thrown)).toMatchObject({ content: 'tool "boom" failed', isError: true });
      }
    });

    it("says the tool failed when an Error has no message", async () => {
      const result = await failing(async () => {
        throw new Error("");
      }).call(callOf("boom"), local);
      expect(result.content).toBe('tool "boom" failed');
    });

    it("cuts the message to 500 characters", async () => {
      const long = await failing(async () => {
        throw new Error("x".repeat(600));
      }).call(callOf("boom"), local);
      expect(long.isError).toBe(true);
      expect(long.content).toBe("x".repeat(500));
      const exact = await failing(async () => {
        throw new Error("y".repeat(500));
      }).call(callOf("boom"), local);
      expect(exact.content).toBe("y".repeat(500));
    });

    it("catches a handler that throws synchronously", async () => {
      const handler = (() => {
        throw new Error("sync");
      }) as unknown as ToolHandler;
      expect(await failing(handler).call(callOf("boom"), local)).toMatchObject({ content: "sync", isError: true });
    });
  });

  it("runs the handler with the call's arguments and the context", async () => {
    const handler = vi.fn(async () => "ok");
    const registry = new ToolRegistry().register(tool("echo", { handler }));
    const args = { text: "hi" };
    const ctx: ToolContext = { channel: "voice" };
    await registry.call(callOf("echo", args), ctx);
    expect(handler).toHaveBeenCalledWith(args, ctx);
  });

  it("takes toolCallId and toolName from the call on success too", async () => {
    const registry = new ToolRegistry().register(tool("echo"));
    expect(await registry.call(callOf("echo", {}, "call_77"), local)).toEqual({
      toolCallId: "call_77",
      toolName: "echo",
      content: "ok",
      isError: false,
    });
  });

  it("checks in order: unknown, then channel, then aborted, then confirmation", async () => {
    const registry = new ToolRegistry().register(
      tool("both", { policy: { channels: ["voice"], sideEffects: true } }),
    );
    const aborted = AbortSignal.abort();
    const confirm = vi.fn(async () => true);
    expect((await registry.call(callOf("nope"), { channel: "local", signal: aborted })).content).toBe(
      'unknown tool "nope"',
    );
    expect((await registry.call(callOf("both"), { channel: "local", signal: aborted, confirm })).content).toBe(
      'tool "both" is not allowed on channel "local"',
    );
    expect((await registry.call(callOf("both"), { channel: "voice", signal: aborted, confirm })).content).toBe(
      'tool "both" was aborted',
    );
    expect((await registry.call(callOf("both"), { channel: "voice" })).content).toBe(
      'tool "both" needs confirmation',
    );
    expect(confirm).not.toHaveBeenCalled();
  });

  it("never rejects, whatever fails", async () => {
    const registry = new ToolRegistry()
      .register(
        tool("rejects", {
          handler: () => Promise.reject(new Error("rejected")),
        }),
      )
      .register(tool("effect", { policy: { sideEffects: true } }));
    const results = await Promise.all([
      registry.call(callOf("rejects"), local),
      registry.call(callOf("missing"), local),
      registry.call(callOf("effect"), { channel: "local", confirm: () => Promise.reject(new Error("x")) }),
      registry.call(callOf("rejects"), { channel: "local", signal: AbortSignal.abort() }),
    ]);
    expect(results.every((result) => result.isError)).toBe(true);
  });
});

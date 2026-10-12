import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { CoreError } from "@core/contracts";
import { ToolRegistry, calculateTool, defineTool, evaluate, type ToolContext } from "../src/index.js";

const local: ToolContext = { channel: "local" };

function errorOf(run: () => unknown): CoreError {
  try {
    run();
  } catch (error) {
    expect(CoreError.is(error)).toBe(true);
    return error as CoreError;
  }
  throw new Error("expected the call to throw");
}

async function rejectionOf(promise: Promise<unknown>): Promise<CoreError> {
  try {
    await promise;
  } catch (error) {
    expect(CoreError.is(error)).toBe(true);
    return error as CoreError;
  }
  throw new Error("expected the promise to reject");
}

describe("defineTool", () => {
  const greet = defineTool({
    name: "greet",
    description: "Greets someone",
    input: z.object({ name: z.string(), times: z.number().int().optional() }),
    policy: { channels: ["local"], sideEffects: false },
    handler: ({ name, times }) => `hello ${name}${times === undefined ? "" : ` x${times}`}`,
  });

  it("describes the tool and keeps the policy as given", () => {
    expect(greet.definition.name).toBe("greet");
    expect(greet.definition.description).toBe("Greets someone");
    expect(greet.policy).toEqual({ channels: ["local"], sideEffects: false });
    expect(greet.source).toBe("local");
  });

  it("builds a JSON Schema without the $schema key and with the right required list", () => {
    const schema = greet.definition.inputSchema;
    expect(schema).not.toHaveProperty("$schema");
    expect(schema["type"]).toBe("object");
    expect(schema["required"]).toEqual(["name"]);
    expect(Object.keys(schema["properties"] as object).sort()).toEqual(["name", "times"]);
    expect(schema["properties"]).toMatchObject({ name: { type: "string" } });
  });

  it("registers like any other tool", async () => {
    const registry = new ToolRegistry().register(greet);
    expect(registry.listFor("local").map((definition) => definition.name)).toEqual(["greet"]);
    expect(registry.listFor("voice")).toEqual([]);
    const result = await registry.call({ id: "c1", name: "greet", arguments: { name: "Ada" } }, local);
    expect(result).toEqual({ toolCallId: "c1", toolName: "greet", content: "hello Ada", isError: false });
  });

  it("does not validate the definition itself: registering does", () => {
    const bad = defineTool({
      name: "not valid!",
      description: "",
      input: z.object({}),
      policy: { sideEffects: false },
      handler: () => null,
    });
    expect(() => new ToolRegistry().register(bad)).toThrowError(CoreError);
  });

  it("gives the handler parsed arguments: defaults applied, unknown keys dropped", async () => {
    const received: { n: number; label: string }[] = [];
    const handler = (args: { n: number; label: string }) => {
      received.push(args);
      return "ok";
    };
    const tool = defineTool({
      name: "parsed",
      description: "",
      input: z.object({ n: z.number().default(3), label: z.string().trim() }),
      policy: { sideEffects: false },
      handler,
    });
    await tool.handler({ label: "  padded  ", extra: true }, local);
    expect(received).toEqual([{ n: 3, label: "padded" }]);
  });

  it("passes the context to the handler and awaits an async handler", async () => {
    const ctx: ToolContext = { channel: "voice" };
    const tool = defineTool({
      name: "later",
      description: "",
      input: z.object({}),
      policy: { sideEffects: false },
      handler: async (args, received) => {
        await Promise.resolve();
        return { args, channel: received.channel };
      },
    });
    expect(await tool.handler({}, ctx)).toEqual({ args: {}, channel: "voice" });
  });

  it("throws bad_request with 'path: message' issues joined by '; ' for invalid arguments", async () => {
    const error = await rejectionOf(greet.handler({ name: 5, times: "many" }, local));
    expect(error.code).toBe("bad_request");
    expect(error.message).toMatch(/^invalid arguments for "greet": name: .+; times: .+$/);
  });

  it("names nested paths with dots and reports a missing field", async () => {
    const nested = defineTool({
      name: "nested",
      description: "",
      input: z.object({ outer: z.object({ inner: z.string() }) }),
      policy: { sideEffects: false },
      handler: () => null,
    });
    expect((await rejectionOf(nested.handler({ outer: {} }, local))).message).toMatch(
      /^invalid arguments for "nested": outer\.inner: .+$/,
    );
    expect((await rejectionOf(nested.handler({}, local))).message).toMatch(
      /^invalid arguments for "nested": outer: .+$/,
    );
  });

  it("does not run the handler when the arguments are invalid", async () => {
    const handler = vi.fn(() => "ran");
    const tool = defineTool({
      name: "strict",
      description: "",
      input: z.object({ n: z.number() }),
      policy: { sideEffects: false },
      handler,
    });
    await rejectionOf(tool.handler({ n: "x" }, local));
    expect(handler).not.toHaveBeenCalled();
  });

  it("turns invalid arguments into a readable error result through the registry", async () => {
    const registry = new ToolRegistry().register(greet);
    const result = await registry.call({ id: "c2", name: "greet", arguments: {} }, local);
    expect(result.isError).toBe(true);
    expect(result.toolCallId).toBe("c2");
    expect(result.content).toMatch(/^invalid arguments for "greet": name: /);
  });
});

describe("evaluate", () => {
  const cases: [string, number][] = [
    ["2+3*4", 14],
    ["(2+3)*4", 20],
    ["2^3^2", 512],
    ["-2^2", -4],
    ["(-2)^2", 4],
    ["2^-1", 0.5],
    ["2^3*2", 16],
    ["10-4-3", 3],
    ["100/10/2", 5],
    ["7%3", 1],
    ["-7%3", -1],
    ["10%4*2", 4],
    [".5*4", 2],
    ["0.5+.25", 0.75],
    ["12", 12],
    ["6×7", 42],
    ["8÷2", 4],
    ["2 × 3 ÷ 6", 1],
    ["--3", 3],
    ["+4", 4],
    ["-(1+2)", -3],
    ["  23 *  17  ", 391],
    ["2*(3+(4-1))^2", 72],
  ];
  for (const [expression, expected] of cases) {
    it(`${JSON.stringify(expression)} = ${expected}`, () => {
      expect(evaluate(expression)).toBe(expected);
    });
  }

  const malformed: [string, string][] = [
    ["", "empty expression: at position 0"],
    ["   ", "empty expression: at position 0"],
    ["abc", 'unexpected "abc": at position 0'],
    ["2+x", 'unexpected "x": at position 2'],
    ["sin(2)", 'unexpected "sin": at position 0'],
    ["2+", "unexpected end of input: at position 2"],
    ["*3", 'unexpected "*": at position 0'],
    ["2**3", 'unexpected "*": at position 2'],
    ["2 3", 'unexpected "3": at position 2'],
    ["(2+3", 'missing closing parenthesis ")": at position 4'],
    ["2+3)", 'unexpected ")": at position 3'],
    ["()", 'unexpected ")": at position 1'],
    ["5.", 'unexpected ".": at position 1'],
    ["1e3", 'unexpected "e3": at position 1'],
    ["2 $ 3", 'unexpected "$": at position 2'],
  ];
  for (const [expression, message] of malformed) {
    it(`rejects ${JSON.stringify(expression)} with bad_request: ${message}`, () => {
      const error = errorOf(() => evaluate(expression));
      expect(error.code).toBe("bad_request");
      expect(error.message).toBe(message);
    });
  }

  it("rejects a result that is not finite", () => {
    for (const expression of ["1/0", "-1/0", "0/0", "5%0", "9".repeat(400), "10^1000"]) {
      const error = errorOf(() => evaluate(expression));
      expect(error.code, expression.slice(0, 20)).toBe("bad_request");
      expect(error.message).toBe("result is not a finite number");
    }
  });

  it("never executes code: names and calls are plain syntax errors", () => {
    for (const expression of ["process.exit(1)", "constructor", "this", "globalThis", "(() => 1)()", "1;2", "`1`"]) {
      expect(errorOf(() => evaluate(expression)).code, expression).toBe("bad_request");
    }
  });

  it("refuses absurd nesting with bad_request instead of overflowing the stack", () => {
    for (const expression of ["(".repeat(5000) + "1" + ")".repeat(5000), "-".repeat(5000) + "1", "2^".repeat(5000) + "1"]) {
      const error = errorOf(() => evaluate(expression));
      expect(error.code).toBe("bad_request");
      expect(error.message).toMatch(/^expression is nested too deeply: at position \d+$/);
    }
  });

  it("accepts a long flat expression", () => {
    expect(evaluate(Array.from({ length: 1000 }, () => "1").join("+"))).toBe(1000);
  });
});

describe("calculateTool", () => {
  const registry = new ToolRegistry().register(calculateTool);
  const run = (expression: unknown) =>
    registry.call({ id: "c1", name: "calculate", arguments: { expression } }, local);

  it("is described for the model and open to every channel without side effects", () => {
    expect(calculateTool.definition.name).toBe("calculate");
    expect(calculateTool.definition.description).toBe(
      "Evaluate an arithmetic expression exactly. Supports + - * / % ^ and parentheses.",
    );
    expect(calculateTool.policy).toEqual({ sideEffects: false });
    expect(calculateTool.source).toBe("local");
    const schema = calculateTool.definition.inputSchema;
    expect(schema).not.toHaveProperty("$schema");
    expect(schema["required"]).toEqual(["expression"]);
    expect(schema["properties"]).toMatchObject({ expression: { type: "string", minLength: 1, maxLength: 200 } });
  });

  it("returns the expression and its result through a registry", async () => {
    expect(await run("23*17")).toEqual({
      toolCallId: "c1",
      toolName: "calculate",
      content: '{"expression":"23*17","result":391}',
      isError: false,
    });
  });

  it("is offered on every channel and runs without confirmation", async () => {
    expect(registry.listFor("voice").map((definition) => definition.name)).toEqual(["calculate"]);
    const result = await registry.call(
      { id: "c1", name: "calculate", arguments: { expression: "1+1" } },
      { channel: "voice" },
    );
    expect(result.content).toBe('{"expression":"1+1","result":2}');
  });

  it("reports a malformed expression as an error result the model can read", async () => {
    expect(await run("2+")).toMatchObject({ isError: true, content: "unexpected end of input: at position 2" });
  });

  it("reports division by zero as an error result", async () => {
    expect(await run("1/0")).toMatchObject({ isError: true, content: "result is not a finite number" });
  });

  it("rejects an empty, too long or non-string expression as invalid arguments", async () => {
    for (const expression of ["", "1+".repeat(101) + "1", 5, undefined]) {
      const result = await run(expression);
      expect(result.isError).toBe(true);
      expect(result.content).toMatch(/^invalid arguments for "calculate": expression: /);
    }
    expect((await run("1".repeat(200))).isError).toBe(false);
  });
});

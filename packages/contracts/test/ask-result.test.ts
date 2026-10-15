import { describe, expect, it } from "vitest";
import { AskResultSchema, RouteAttemptSchema, toJsonSchemas } from "../src/index.js";

const model = { provider: "mock", model: "echo" };
const error = { code: "unknown", message: "boom", retryable: false } as const;

describe("RouteAttemptSchema", () => {
  it("accepts a success entry", () => {
    expect(RouteAttemptSchema.safeParse({ model, ok: true, ms: 12 }).success).toBe(true);
  });

  it("accepts a failure entry carrying a CoreErrorShape", () => {
    const parsed = RouteAttemptSchema.safeParse({ model, ok: false, ms: 0, error });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.error).toEqual(error);
  });

  it("rejects a negative ms", () => {
    expect(RouteAttemptSchema.safeParse({ model, ok: true, ms: -1 }).success).toBe(false);
  });

  it("rejects a fractional ms", () => {
    expect(RouteAttemptSchema.safeParse({ model, ok: true, ms: 1.5 }).success).toBe(false);
  });

  it("rejects a missing model", () => {
    expect(RouteAttemptSchema.safeParse({ ok: true, ms: 12 }).success).toBe(false);
  });
});

describe("AskResultSchema", () => {
  const success = {
    ok: true,
    model,
    text: "hello",
    usage: { inputTokens: 3, outputTokens: 5 },
    attempts: [{ model, ok: true, ms: 4 }],
  };

  it("accepts a success without output", () => {
    const parsed = AskResultSchema.safeParse(success);
    expect(parsed.success).toBe(true);
    expect(parsed.data).not.toHaveProperty("output");
  });

  it("accepts a success with output of any shape", () => {
    for (const output of [{ answer: 42 }, [1, 2], "text", null]) {
      const parsed = AskResultSchema.safeParse({ ...success, output });
      expect(parsed.success).toBe(true);
      expect(parsed.data).toHaveProperty("output", output);
    }
  });

  it("accepts a success whose usage is empty", () => {
    expect(AskResultSchema.safeParse({ ...success, usage: {} }).success).toBe(true);
  });

  it("accepts a failure with an empty attempts list", () => {
    expect(AskResultSchema.safeParse({ ok: false, error, attempts: [] }).success).toBe(true);
  });

  it("accepts a failure whose attempts carry their own errors", () => {
    const attempts = [{ model, ok: false, ms: 7, error: { ...error, code: "timeout", retryable: true } }];
    expect(AskResultSchema.safeParse({ ok: false, error, attempts }).success).toBe(true);
  });

  it("rejects a success without model", () => {
    const { ok, text, usage, attempts } = success;
    expect(AskResultSchema.safeParse({ ok, text, usage, attempts }).success).toBe(false);
  });

  it("rejects a success without usage", () => {
    const { ok, model: answered, text, attempts } = success;
    expect(AskResultSchema.safeParse({ ok, model: answered, text, attempts }).success).toBe(false);
  });

  it("rejects a failure without error", () => {
    expect(AskResultSchema.safeParse({ ok: false, attempts: [] }).success).toBe(false);
  });

  it("rejects ok given as a string", () => {
    expect(AskResultSchema.safeParse({ ...success, ok: "true" }).success).toBe(false);
    expect(AskResultSchema.safeParse({ ok: "false", error, attempts: [] }).success).toBe(false);
  });

  it("drops details from a failure's error", () => {
    const parsed = AskResultSchema.parse({
      ok: false,
      error: { ...error, details: { attempts: [] } },
      attempts: [],
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).not.toHaveProperty("details");
  });
});

describe("toJsonSchemas", () => {
  it("includes RouteAttempt and AskResult and serialises", () => {
    const schemas = toJsonSchemas();
    expect(schemas).toHaveProperty("RouteAttempt");
    expect(schemas).toHaveProperty("AskResult");
    expect(() => JSON.stringify(schemas)).not.toThrow();
  });
});

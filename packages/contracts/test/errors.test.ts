import { describe, expect, it } from "vitest";
import {
  CoreError,
  CoreErrorShapeSchema,
  ErrorCodeSchema,
  isRetryableCode,
  type CoreErrorShape,
  type ErrorCode,
} from "../src/index.js";

const RETRYABLE: ErrorCode[] = ["rate_limit", "timeout", "unavailable"];

describe("isRetryableCode", () => {
  for (const code of ErrorCodeSchema.options) {
    it(`${code} → ${RETRYABLE.includes(code)}`, () => {
      expect(isRetryableCode(code)).toBe(RETRYABLE.includes(code));
    });
  }

  it("covers exactly the nine documented codes", () => {
    expect([...ErrorCodeSchema.options].sort()).toEqual(
      [
        "aborted",
        "auth",
        "bad_request",
        "content_filter",
        "not_found",
        "rate_limit",
        "timeout",
        "unavailable",
        "unknown",
      ].sort(),
    );
  });
});

describe("CoreError", () => {
  it("defaults name, retryable and optional fields", () => {
    const retryable = new CoreError("unavailable", "down");
    expect(retryable).toBeInstanceOf(Error);
    expect(retryable.name).toBe("CoreError");
    expect(retryable.message).toBe("down");
    expect(retryable.code).toBe("unavailable");
    expect(retryable.retryable).toBe(true);
    expect(retryable.provider).toBeUndefined();
    expect(retryable.details).toBeUndefined();

    expect(new CoreError("auth", "nope").retryable).toBe(false);
  });

  it("keeps provider, details and cause", () => {
    const cause = new Error("root");
    const error = new CoreError("rate_limit", "slow down", {
      provider: "openai",
      details: { retryAfterMs: 500 },
      cause,
    });
    expect(error.provider).toBe("openai");
    expect(error.details).toEqual({ retryAfterMs: 500 });
    expect(error.cause).toBe(cause);
  });

  it("serialises to a valid CoreErrorShape", () => {
    const error = new CoreError("timeout", "too slow", { provider: "groq", details: { ms: 30 } });
    const shape = error.toJSON();
    expect(shape).toEqual({
      code: "timeout",
      message: "too slow",
      provider: "groq",
      retryable: true,
      details: { ms: 30 },
    });
    expect(CoreErrorShapeSchema.safeParse(shape).success).toBe(true);
    expect(JSON.parse(JSON.stringify(error))).toEqual(shape);
  });

  it("omits provider and details from the shape when unset", () => {
    const shape = new CoreError("auth", "nope").toJSON();
    expect(shape).toEqual({ code: "auth", message: "nope", retryable: false });
    expect("provider" in shape).toBe(false);
    expect("details" in shape).toBe(false);
  });

  it("round-trips through fromShape", () => {
    const original = new CoreError("unavailable", "down", { provider: "ollama", details: { a: 1 } });
    const restored = CoreError.fromShape(original.toJSON());
    expect(restored).toBeInstanceOf(CoreError);
    expect(restored.toJSON()).toEqual(original.toJSON());
  });

  it("fromShape keeps the retryable flag of the shape", () => {
    const shape: CoreErrorShape = { code: "auth", message: "m", retryable: true };
    expect(CoreError.fromShape(shape).retryable).toBe(true);
    expect(CoreError.fromShape(shape).toJSON()).toEqual(shape);
  });

  it("CoreError.is recognises only CoreError instances", () => {
    expect(CoreError.is(new CoreError("unknown", "x"))).toBe(true);
    expect(CoreError.is(new Error("x"))).toBe(false);
    expect(CoreError.is({ code: "unknown", message: "x" })).toBe(false);
    expect(CoreError.is(null)).toBe(false);
    expect(CoreError.is("unknown")).toBe(false);
  });
});

describe("CoreErrorShapeSchema", () => {
  it("rejects an unknown code and a missing retryable flag", () => {
    expect(CoreErrorShapeSchema.safeParse({ code: "boom", message: "m", retryable: false }).success).toBe(false);
    expect(CoreErrorShapeSchema.safeParse({ code: "auth", message: "m" }).success).toBe(false);
  });
});

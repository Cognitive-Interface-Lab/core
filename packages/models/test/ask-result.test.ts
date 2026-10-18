import { describe, expect, it } from "vitest";
import { AskResultSchema, CoreError, type RouteAttempt } from "@core/contracts";
import { askResultFrom, type RoutedResponse } from "../src/index.js";

const ref = { provider: "openai", model: "gpt-test" };

const attempts: RouteAttempt[] = [
  { model: { provider: "groq", model: "m1" }, ok: false, ms: 12, error: { code: "unavailable", message: "down", retryable: true } },
  { model: ref, ok: true, ms: 34 },
];

const response: RoutedResponse = {
  model: ref,
  message: { role: "assistant", content: "hello there" },
  finishReason: "stop",
  usage: { inputTokens: 3, outputTokens: 5 },
  output: { answer: 42 },
  attempts,
};

function parses(result: unknown) {
  expect(AskResultSchema.safeParse(result).success).toBe(true);
}

describe("askResultFrom: an answer", () => {
  it("carries model, text, usage and attempts, and omits output without withOutput", () => {
    const result = askResultFrom({ response }, { withOutput: false });
    expect(result).toEqual({
      ok: true,
      model: ref,
      text: "hello there",
      usage: { inputTokens: 3, outputTokens: 5 },
      attempts,
    });
    expect("output" in result).toBe(false);
    parses(result);
  });

  it("includes the structured output with withOutput", () => {
    const result = askResultFrom({ response }, { withOutput: true });
    expect(result).toEqual({
      ok: true,
      model: ref,
      text: "hello there",
      output: { answer: 42 },
      usage: { inputTokens: 3, outputTokens: 5 },
      attempts,
    });
    parses(result);
  });
});

describe("askResultFrom: a CoreError", () => {
  it("reports the error shape and the attempts from details", () => {
    const error = new CoreError("unavailable", "all providers failed", { provider: "openai", details: { attempts } });
    const result = askResultFrom({ error }, { withOutput: true });
    expect(result).toEqual({
      ok: false,
      error: { code: "unavailable", message: "all providers failed", retryable: true, provider: "openai" },
      attempts,
    });
    parses(result);
  });

  it("does not copy details into the error", () => {
    const error = new CoreError("auth", "bad key", { details: { attempts, secret: "sk-leak" } });
    const result = askResultFrom({ error }, { withOutput: false });
    if (result.ok) throw new Error("expected a failure result");
    expect(result.error).toEqual({ code: "auth", message: "bad key", retryable: false });
    expect("details" in result.error).toBe(false);
    expect(JSON.stringify(result)).not.toContain("sk-leak");
  });

  it("omits provider when the error has none", () => {
    const result = askResultFrom({ error: new CoreError("bad_request", "nope") }, { withOutput: false });
    if (result.ok) throw new Error("expected a failure result");
    expect("provider" in result.error).toBe(false);
    expect(result.attempts).toEqual([]);
    parses(result);
  });

  it("uses no attempts when details.attempts is malformed", () => {
    const error = new CoreError("timeout", "slow", {
      details: { attempts: [{ model: ref, ok: "yes", ms: -1 }] },
    });
    const result = askResultFrom({ error }, { withOutput: false });
    expect(result).toEqual({
      ok: false,
      error: { code: "timeout", message: "slow", retryable: true },
      attempts: [],
    });
    parses(result);
  });

  it("uses no attempts when details.attempts is not an array", () => {
    const error = new CoreError("timeout", "slow", { details: { attempts: "many" } });
    expect(askResultFrom({ error }, { withOutput: false })).toMatchObject({ ok: false, attempts: [] });
  });
});

describe("askResultFrom: anything else", () => {
  it("maps a plain Error to unknown with its message", () => {
    const result = askResultFrom({ error: new Error("boom") }, { withOutput: false });
    expect(result).toEqual({
      ok: false,
      error: { code: "unknown", message: "boom", retryable: false },
      attempts: [],
    });
    parses(result);
  });

  it("maps a thrown string to unknown with a generic message", () => {
    const result = askResultFrom({ error: "just a string" }, { withOutput: false });
    expect(result).toEqual({
      ok: false,
      error: { code: "unknown", message: "unexpected failure", retryable: false },
      attempts: [],
    });
    parses(result);
  });
});

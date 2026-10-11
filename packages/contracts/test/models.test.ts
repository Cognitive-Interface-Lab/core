import { describe, expect, it } from "vitest";
import {
  ChatRequestSchema,
  CoreError,
  StreamEventSchema,
  formatModelRef,
  parseModelRef,
  toJsonSchemas,
} from "../src/index.js";

const model = { provider: "mock", model: "echo" };
const messages = [{ role: "user", content: "hi" }];

describe("parseModelRef / formatModelRef", () => {
  it("splits on the first colon only", () => {
    expect(parseModelRef("ollama:llama3.2:3b")).toEqual({ provider: "ollama", model: "llama3.2:3b" });
    expect(parseModelRef("openai:gpt-4.1-mini")).toEqual({ provider: "openai", model: "gpt-4.1-mini" });
  });

  it("throws bad_request without a colon", () => {
    try {
      parseModelRef("nocolon");
      expect.unreachable("parseModelRef should have thrown");
    } catch (error) {
      expect(CoreError.is(error)).toBe(true);
      expect((error as CoreError).code).toBe("bad_request");
    }
  });

  it("throws bad_request for an empty provider or model", () => {
    for (const ref of [":x", "x:", ":"]) {
      expect(() => parseModelRef(ref)).toThrowError(CoreError);
    }
  });

  it("formats provider:model and round-trips", () => {
    expect(formatModelRef({ provider: "ollama", model: "llama3.2:3b" })).toBe("ollama:llama3.2:3b");
    expect(parseModelRef(formatModelRef({ provider: "ollama", model: "llama3.2:3b" }))).toEqual({
      provider: "ollama",
      model: "llama3.2:3b",
    });
  });
});

describe("ChatRequestSchema", () => {
  it("accepts a minimal request", () => {
    expect(ChatRequestSchema.safeParse({ model, messages }).success).toBe(true);
  });

  it("rejects empty messages", () => {
    expect(ChatRequestSchema.safeParse({ model, messages: [] }).success).toBe(false);
  });

  it("bounds temperature to 0..2 and requires positive maxOutputTokens", () => {
    expect(ChatRequestSchema.safeParse({ model, messages, temperature: 2 }).success).toBe(true);
    expect(ChatRequestSchema.safeParse({ model, messages, temperature: 2.1 }).success).toBe(false);
    expect(ChatRequestSchema.safeParse({ model, messages, temperature: -0.1 }).success).toBe(false);
    expect(ChatRequestSchema.safeParse({ model, messages, maxOutputTokens: 0 }).success).toBe(false);
  });

  it("restricts toolChoice", () => {
    expect(ChatRequestSchema.safeParse({ model, messages, toolChoice: "required" }).success).toBe(true);
    expect(ChatRequestSchema.safeParse({ model, messages, toolChoice: "always" }).success).toBe(false);
  });
});

describe("StreamEventSchema", () => {
  it("accepts each documented event type", () => {
    const events = [
      { type: "route", model, attempt: 1 },
      { type: "text-delta", text: "hi" },
      { type: "tool-call", toolCall: { id: "c1", name: "t", arguments: {} } },
      { type: "finish", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 2 } },
      { type: "error", error: { code: "unavailable", message: "down", retryable: true } },
    ];
    for (const event of events) {
      expect(StreamEventSchema.safeParse(event).success, event.type).toBe(true);
    }
  });

  it("rejects an unknown type", () => {
    expect(StreamEventSchema.safeParse({ type: "nope" }).success).toBe(false);
  });

  it("rejects an unknown finish reason", () => {
    expect(StreamEventSchema.safeParse({ type: "finish", finishReason: "done", usage: {} }).success).toBe(false);
  });
});

describe("toJsonSchemas", () => {
  it("contains Message, ChatRequest and StreamEvent as JSON Schema objects", () => {
    const schemas = toJsonSchemas();
    for (const name of ["Message", "ChatRequest", "StreamEvent"]) {
      expect(schemas, name).toHaveProperty(name);
      expect(typeof schemas[name]).toBe("object");
    }
  });

  it("is serialisable", () => {
    expect(() => JSON.stringify(toJsonSchemas())).not.toThrow();
  });
});

import { describe, expect, it } from "vitest";
import { MessageSchema, ToolCallSchema, ToolDefinitionSchema } from "../src/index.js";

describe("MessageSchema", () => {
  it("parses a system message", () => {
    expect(MessageSchema.parse({ role: "system", content: "be brief" })).toEqual({
      role: "system",
      content: "be brief",
    });
  });

  it("parses a user message", () => {
    expect(MessageSchema.parse({ role: "user", content: "hi" })).toEqual({ role: "user", content: "hi" });
  });

  it("parses an assistant message with and without tool calls", () => {
    expect(MessageSchema.safeParse({ role: "assistant", content: "ok" }).success).toBe(true);
    const withCalls = {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "c1", name: "search", arguments: { q: "x" } }],
    };
    expect(MessageSchema.parse(withCalls)).toEqual(withCalls);
  });

  it("parses a tool message with and without isError", () => {
    const base = { role: "tool", toolCallId: "c1", toolName: "search", content: '{"hits":1}' };
    expect(MessageSchema.parse(base)).toEqual(base);
    expect(MessageSchema.parse({ ...base, isError: true })).toEqual({ ...base, isError: true });
  });

  it("rejects an unknown role", () => {
    expect(MessageSchema.safeParse({ role: "robot", content: "x" }).success).toBe(false);
  });

  it("rejects a variant with missing or mistyped fields", () => {
    expect(MessageSchema.safeParse({ role: "user" }).success).toBe(false);
    expect(MessageSchema.safeParse({ role: "tool", content: "{}" }).success).toBe(false);
    expect(MessageSchema.safeParse({ role: "user", content: 1 }).success).toBe(false);
  });
});

describe("ToolDefinitionSchema", () => {
  const def = (name: string) => ({ name, description: "d", inputSchema: { type: "object" } });

  it("accepts a 64-character name and rejects 65", () => {
    expect(ToolDefinitionSchema.safeParse(def("a".repeat(64))).success).toBe(true);
    expect(ToolDefinitionSchema.safeParse(def("a".repeat(65))).success).toBe(false);
  });

  it("rejects an empty name, a space and other characters", () => {
    expect(ToolDefinitionSchema.safeParse(def("")).success).toBe(false);
    expect(ToolDefinitionSchema.safeParse(def("has space")).success).toBe(false);
    expect(ToolDefinitionSchema.safeParse(def("dot.name")).success).toBe(false);
  });

  it("accepts letters, digits, underscore and hyphen", () => {
    expect(ToolDefinitionSchema.safeParse(def("Web_search-2")).success).toBe(true);
  });
});

describe("ToolCallSchema", () => {
  it("accepts a parsed arguments object", () => {
    expect(ToolCallSchema.safeParse({ id: "c1", name: "t", arguments: { a: 1 } }).success).toBe(true);
  });

  it("rejects arguments given as a string", () => {
    expect(ToolCallSchema.safeParse({ id: "c1", name: "t", arguments: '{"a":1}' }).success).toBe(false);
  });

  it("rejects an empty id or name", () => {
    expect(ToolCallSchema.safeParse({ id: "", name: "t", arguments: {} }).success).toBe(false);
    expect(ToolCallSchema.safeParse({ id: "c1", name: "", arguments: {} }).success).toBe(false);
  });
});

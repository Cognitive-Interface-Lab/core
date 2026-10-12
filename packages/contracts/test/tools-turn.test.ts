import { describe, expect, it } from "vitest";
import {
  ChannelSchema,
  StreamEventSchema,
  ToolPolicySchema,
  ToolResultSchema,
  TurnBudgetSchema,
  TurnEventSchema,
  toJsonSchemas,
} from "../src/index.js";

const toolResult = { toolCallId: "call_1", toolName: "calculate", content: "391", isError: false };

describe("ChannelSchema", () => {
  it("accepts lowercase names with digits and dashes", () => {
    for (const channel of ["local", "voice-2", "a", "trilix", "a".repeat(32)]) {
      expect(ChannelSchema.safeParse(channel).success, channel).toBe(true);
    }
  });

  it("rejects capitals, an empty string, a leading digit and more than 32 characters", () => {
    for (const channel of ["Local", "", "1abc", "a".repeat(33), "-a", "has space", "under_score"]) {
      expect(ChannelSchema.safeParse(channel).success, JSON.stringify(channel)).toBe(false);
    }
  });
});

describe("ToolPolicySchema", () => {
  it("parses with channels", () => {
    const policy = { channels: ["local", "voice"], sideEffects: true };
    expect(ToolPolicySchema.parse(policy)).toEqual(policy);
  });

  it("parses without channels, meaning every channel", () => {
    expect(ToolPolicySchema.parse({ sideEffects: false })).toEqual({ sideEffects: false });
  });

  it("rejects an empty channel list", () => {
    expect(ToolPolicySchema.safeParse({ channels: [], sideEffects: false }).success).toBe(false);
  });

  it("rejects an invalid channel name and a missing sideEffects", () => {
    expect(ToolPolicySchema.safeParse({ channels: ["Local"], sideEffects: false }).success).toBe(false);
    expect(ToolPolicySchema.safeParse({ channels: ["local"] }).success).toBe(false);
  });
});

describe("ToolResultSchema", () => {
  it("parses a success and an error result", () => {
    expect(ToolResultSchema.parse(toolResult)).toEqual(toolResult);
    const failure = { ...toolResult, content: "unknown tool", isError: true };
    expect(ToolResultSchema.parse(failure)).toEqual(failure);
  });

  it("requires isError", () => {
    const withoutFlag = { toolCallId: "call_1", toolName: "calculate", content: "391" };
    expect(ToolResultSchema.safeParse(withoutFlag).success).toBe(false);
  });

  it("requires a non-empty toolCallId and toolName, and string content", () => {
    expect(ToolResultSchema.safeParse({ ...toolResult, toolCallId: "" }).success).toBe(false);
    expect(ToolResultSchema.safeParse({ ...toolResult, toolName: "" }).success).toBe(false);
    expect(ToolResultSchema.safeParse({ ...toolResult, content: 391 }).success).toBe(false);
  });

  it("allows empty content", () => {
    expect(ToolResultSchema.safeParse({ ...toolResult, content: "" }).success).toBe(true);
  });
});

describe("TurnBudgetSchema", () => {
  it("parses an empty budget and a full one", () => {
    expect(TurnBudgetSchema.parse({})).toEqual({});
    const full = { maxRounds: 8, maxOutputTokens: 2000, maxWallMs: 60_000 };
    expect(TurnBudgetSchema.parse(full)).toEqual(full);
  });

  it("rejects zero, negative numbers and non-integers in every field", () => {
    for (const field of ["maxRounds", "maxOutputTokens", "maxWallMs"]) {
      for (const value of [0, -1, 1.5]) {
        expect(TurnBudgetSchema.safeParse({ [field]: value }).success, `${field}=${value}`).toBe(false);
      }
    }
  });
});

describe("TurnEventSchema", () => {
  const streamEvents = [
    { type: "route", model: { provider: "mock", model: "echo" }, attempt: 1 },
    { type: "text-delta", text: "hi" },
    { type: "tool-call", toolCall: { id: "call_1", name: "calculate", arguments: { expression: "23*17" } } },
    { type: "finish", finishReason: "tool-calls", usage: { inputTokens: 3, outputTokens: 5 } },
    { type: "error", error: { code: "timeout", message: "timed out", retryable: true } },
  ];
  const turnEvents = [
    { type: "round", round: 1 },
    { type: "tool-result", result: toolResult },
    {
      type: "turn-finish",
      reason: "stop",
      rounds: 2,
      usage: { outputTokens: 12 },
      messages: [
        { role: "assistant", content: "", toolCalls: [{ id: "call_1", name: "calculate", arguments: {} }] },
        { role: "tool", toolCallId: "call_1", toolName: "calculate", content: "391" },
        { role: "assistant", content: "391" },
      ],
    },
  ];

  it("parses every stream event unchanged", () => {
    for (const event of streamEvents) {
      expect(TurnEventSchema.parse(event), event.type).toEqual(event);
      expect(StreamEventSchema.safeParse(event).success, event.type).toBe(true);
    }
  });

  it("parses round, tool-result and turn-finish", () => {
    for (const event of turnEvents) {
      expect(TurnEventSchema.parse(event), event.type).toEqual(event);
    }
  });

  it("covers every variant: the five stream events plus the three turn events", () => {
    const types = TurnEventSchema.options.map((option) => option.shape.type.value).sort();
    expect(types).toEqual(
      ["error", "finish", "round", "route", "text-delta", "tool-call", "tool-result", "turn-finish"].sort(),
    );
  });

  it("parses every turn finish reason, and a turn that ran zero rounds", () => {
    for (const reason of ["stop", "max-rounds", "budget", "error", "aborted"]) {
      const event = { type: "turn-finish", reason, rounds: 0, usage: {}, messages: [] };
      expect(TurnEventSchema.safeParse(event).success, reason).toBe(true);
    }
  });

  it("rejects an unknown or missing type", () => {
    expect(TurnEventSchema.safeParse({ type: "nope" }).success).toBe(false);
    expect(TurnEventSchema.safeParse({ type: "turn-start" }).success).toBe(false);
    expect(TurnEventSchema.safeParse({}).success).toBe(false);
  });

  it("rejects malformed turn events", () => {
    expect(TurnEventSchema.safeParse({ type: "round", round: 0 }).success).toBe(false);
    expect(TurnEventSchema.safeParse({ type: "round", round: 1.5 }).success).toBe(false);
    expect(TurnEventSchema.safeParse({ type: "tool-result", result: { ...toolResult, isError: undefined } }).success).toBe(
      false,
    );
    expect(
      TurnEventSchema.safeParse({ type: "turn-finish", reason: "done", rounds: 1, usage: {}, messages: [] }).success,
    ).toBe(false);
    expect(
      TurnEventSchema.safeParse({ type: "turn-finish", reason: "stop", rounds: -1, usage: {}, messages: [] }).success,
    ).toBe(false);
    expect(TurnEventSchema.safeParse({ type: "turn-finish", reason: "stop", rounds: 1, usage: {} }).success).toBe(false);
    expect(
      TurnEventSchema.safeParse({
        type: "turn-finish",
        reason: "stop",
        rounds: 1,
        usage: {},
        messages: [{ role: "robot", content: "x" }],
      }).success,
    ).toBe(false);
  });
});

describe("toJsonSchemas", () => {
  it("contains the tool policy, tool result and turn schemas", () => {
    const schemas = toJsonSchemas();
    for (const name of ["Channel", "ToolPolicy", "ToolResult", "TurnBudget", "TurnFinishReason", "TurnEvent"]) {
      expect(schemas, name).toHaveProperty(name);
    }
    expect(() => JSON.stringify(schemas)).not.toThrow();
  });
});

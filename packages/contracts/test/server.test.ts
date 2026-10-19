import { describe, expect, it } from "vitest";
import {
  ApiErrorBodySchema,
  BranchCreateSchema,
  BranchTurnCallSchema,
  ChatCallSchema,
  CrossReferenceCallSchema,
  ForkCallSchema,
  GraphCreateSchema,
  GraphEventsSchema,
  GraphListSchema,
  GraphWriteResultSchema,
  HealthResponseSchema,
  MergeCallSchema,
  MessageAddSchema,
  ModelsResponseSchema,
  PairRequestSchema,
  PairResponseSchema,
  PrincipalSchema,
  ProviderStatusSchema,
  ProvidersResponseSchema,
  TurnCallSchema,
  TurnRecordSchema,
  toJsonSchemas,
} from "../src/index.js";

const message = { role: "user", content: "hi" } as const;
const model = { provider: "mock", model: "echo" };
const nodeRef = { graphId: "g1", nodeId: "n1" };
const tool = { name: "lookup", description: "look it up", inputSchema: { type: "object" } };
const error = { code: "unknown", message: "boom", retryable: false } as const;
const at = "2026-01-01T00:00:00.000Z";

const state = {
  graphId: "g1",
  createdAt: at,
  lastSeq: 1,
  branches: {},
  nodes: {},
  turns: {},
  refs: [],
};
const record = { graphId: "g1", seq: 1, at, event: { type: "graph-created" } };
const turnFinish = {
  type: "turn-finish",
  reason: "stop",
  rounds: 1,
  usage: {},
  messages: [],
} as const;

const ok = (schema: { safeParse(value: unknown): { success: boolean } }, value: unknown) =>
  schema.safeParse(value).success;

describe("PrincipalSchema", () => {
  it("accepts an id and a channel", () => {
    expect(ok(PrincipalSchema, { id: "u1", channel: "trilix" })).toBe(true);
  });

  it("rejects an empty id", () => {
    expect(ok(PrincipalSchema, { id: "", channel: "trilix" })).toBe(false);
  });

  it("rejects a malformed channel", () => {
    expect(ok(PrincipalSchema, { id: "u1", channel: "Not A Channel" })).toBe(false);
  });
});

describe("HealthResponseSchema", () => {
  it("accepts both modes", () => {
    for (const mode of ["local", "hosted"]) {
      expect(ok(HealthResponseSchema, { ok: true, version: "0.1.0", mode })).toBe(true);
    }
  });

  it("rejects ok: false", () => {
    expect(ok(HealthResponseSchema, { ok: false, version: "0.1.0", mode: "local" })).toBe(false);
  });

  it("rejects an unknown mode", () => {
    expect(ok(HealthResponseSchema, { ok: true, version: "0.1.0", mode: "cloud" })).toBe(false);
  });
});

describe("providers and models responses", () => {
  it("accepts a provider status and a providers response", () => {
    const status = { id: "ollama", ready: true, requiresKey: false };
    expect(ok(ProviderStatusSchema, status)).toBe(true);
    expect(ok(ProvidersResponseSchema, { providers: [status] })).toBe(true);
    expect(ok(ProvidersResponseSchema, { providers: [] })).toBe(true);
  });

  it("rejects a provider status missing requiresKey", () => {
    expect(ok(ProviderStatusSchema, { id: "ollama", ready: true })).toBe(false);
  });

  it("accepts a models response", () => {
    expect(ok(ModelsResponseSchema, { provider: "ollama", models: ["llama3.2:3b"] })).toBe(true);
    expect(ok(ModelsResponseSchema, { provider: "ollama", models: [] })).toBe(true);
  });
});

describe("ChatCallSchema", () => {
  it("accepts a minimal call", () => {
    expect(ok(ChatCallSchema, { messages: [message] })).toBe(true);
  });

  it("accepts a call with every optional field", () => {
    expect(
      ok(ChatCallSchema, {
        route: [model],
        messages: [message],
        outputSchema: { type: "object" },
        maxOutputTokens: 100,
        temperature: 2,
        timeoutMs: 5000,
      }),
    ).toBe(true);
  });

  it("rejects empty messages", () => {
    expect(ok(ChatCallSchema, { messages: [] })).toBe(false);
  });

  it("rejects an empty route", () => {
    expect(ok(ChatCallSchema, { route: [], messages: [message] })).toBe(false);
  });

  it("rejects maxOutputTokens: 0", () => {
    expect(ok(ChatCallSchema, { messages: [message], maxOutputTokens: 0 })).toBe(false);
  });

  it("rejects temperature: 2.5", () => {
    expect(ok(ChatCallSchema, { messages: [message], temperature: 2.5 })).toBe(false);
  });

  it("rejects a non-positive timeoutMs", () => {
    expect(ok(ChatCallSchema, { messages: [message], timeoutMs: 0 })).toBe(false);
  });
});

describe("TurnCallSchema", () => {
  it("accepts a minimal call", () => {
    expect(ok(TurnCallSchema, { messages: [message] })).toBe(true);
  });

  it("accepts a call with every optional field", () => {
    expect(
      ok(TurnCallSchema, {
        route: [model],
        messages: [message],
        clientTools: [tool],
        budget: { maxRounds: 3, maxOutputTokens: 100, maxWallMs: 1000 },
        maxOutputTokens: 100,
        temperature: 0,
        timeoutMs: 5000,
      }),
    ).toBe(true);
  });

  it("rejects empty messages", () => {
    expect(ok(TurnCallSchema, { messages: [] })).toBe(false);
  });

  it("rejects an empty route", () => {
    expect(ok(TurnCallSchema, { route: [], messages: [message] })).toBe(false);
  });

  it("rejects maxOutputTokens: 0", () => {
    expect(ok(TurnCallSchema, { messages: [message], maxOutputTokens: 0 })).toBe(false);
  });

  it("rejects temperature: 2.5", () => {
    expect(ok(TurnCallSchema, { messages: [message], temperature: 2.5 })).toBe(false);
  });

  it("rejects a malformed client tool", () => {
    expect(ok(TurnCallSchema, { messages: [message], clientTools: [{ name: "bad name!" }] })).toBe(false);
  });
});

describe("BranchTurnCallSchema", () => {
  it("accepts a minimal call", () => {
    expect(ok(BranchTurnCallSchema, { branchId: "b1" })).toBe(true);
  });

  it("accepts a call with every optional field", () => {
    expect(
      ok(BranchTurnCallSchema, {
        branchId: "b1",
        input: message,
        route: [model],
        clientTools: [tool],
        budget: { maxRounds: 2 },
        maxOutputTokens: 10,
        temperature: 1,
        timeoutMs: 1000,
      }),
    ).toBe(true);
  });

  it("rejects a missing branchId", () => {
    expect(ok(BranchTurnCallSchema, { input: message })).toBe(false);
  });

  it("does not require messages", () => {
    expect(ok(BranchTurnCallSchema, { branchId: "b1", route: [model] })).toBe(true);
  });
});

describe("graph write call schemas", () => {
  it("GraphCreate accepts an empty body and a title", () => {
    expect(ok(GraphCreateSchema, {})).toBe(true);
    expect(ok(GraphCreateSchema, { title: "notes" })).toBe(true);
  });

  it("BranchCreate accepts a minimal value and one with every optional field", () => {
    expect(ok(BranchCreateSchema, { name: "main", from: null })).toBe(true);
    expect(ok(BranchCreateSchema, { name: "alt", from: "n1", replayOf: "b1" })).toBe(true);
  });

  it("BranchCreate rejects an empty name and a missing from", () => {
    expect(ok(BranchCreateSchema, { name: "", from: null })).toBe(false);
    expect(ok(BranchCreateSchema, { name: "main" })).toBe(false);
  });

  it("MessageAdd accepts a minimal value and one with every optional field", () => {
    expect(ok(MessageAddSchema, { branchId: "b1", message })).toBe(true);
    expect(ok(MessageAddSchema, { branchId: "b1", message, origin: nodeRef })).toBe(true);
  });

  it("MessageAdd rejects a missing message", () => {
    expect(ok(MessageAddSchema, { branchId: "b1" })).toBe(false);
  });

  it("TurnRecord accepts a turn with events", () => {
    expect(ok(TurnRecordSchema, { branchId: "b1", events: [turnFinish] })).toBe(true);
  });

  it("TurnRecord rejects empty events", () => {
    expect(ok(TurnRecordSchema, { branchId: "b1", events: [] })).toBe(false);
  });

  it("TurnRecord rejects an event of an unknown type", () => {
    expect(ok(TurnRecordSchema, { branchId: "b1", events: [{ type: "bogus" }] })).toBe(false);
  });

  it("CrossReferenceCall accepts a minimal value and one with every optional field", () => {
    expect(ok(CrossReferenceCallSchema, { from: "n1", to: nodeRef })).toBe(true);
    expect(ok(CrossReferenceCallSchema, { from: "n1", to: nodeRef, label: "see also" })).toBe(true);
  });

  it("CrossReferenceCall rejects a bare string target", () => {
    expect(ok(CrossReferenceCallSchema, { from: "n1", to: "n2" })).toBe(false);
  });

  it("ForkCall accepts a minimal value and one with every optional field", () => {
    expect(ok(ForkCallSchema, { nodeId: "n1" })).toBe(true);
    expect(ok(ForkCallSchema, { nodeId: "n1", title: "fork" })).toBe(true);
  });

  it("ForkCall rejects a missing nodeId", () => {
    expect(ok(ForkCallSchema, { title: "fork" })).toBe(false);
  });
});

describe("MergeCallSchema", () => {
  it("accepts an append merge without a message", () => {
    expect(ok(MergeCallSchema, { source: "b2", target: "b1", strategy: "append" })).toBe(true);
  });

  it("accepts a summary merge with a message", () => {
    expect(ok(MergeCallSchema, { source: "b2", target: "b1", strategy: "summary", message })).toBe(true);
  });

  it("rejects a summary merge without a message", () => {
    expect(ok(MergeCallSchema, { source: "b2", target: "b1", strategy: "summary" })).toBe(false);
  });

  it("rejects an unknown strategy", () => {
    expect(ok(MergeCallSchema, { source: "b2", target: "b1", strategy: "rebase" })).toBe(false);
  });

  it("rejects a missing source or target", () => {
    expect(ok(MergeCallSchema, { target: "b1", strategy: "append" })).toBe(false);
    expect(ok(MergeCallSchema, { source: "b2", strategy: "append" })).toBe(false);
  });
});

describe("graph result schemas", () => {
  it("GraphWriteResult accepts ids and a state", () => {
    expect(ok(GraphWriteResultSchema, { ids: ["n1"], state })).toBe(true);
    expect(ok(GraphWriteResultSchema, { ids: [], state })).toBe(true);
  });

  it("GraphWriteResult rejects a malformed state", () => {
    expect(ok(GraphWriteResultSchema, { ids: [], state: { graphId: "g1" } })).toBe(false);
  });

  it("GraphList accepts graph ids", () => {
    expect(ok(GraphListSchema, { graphs: ["g1", "g2"] })).toBe(true);
    expect(ok(GraphListSchema, { graphs: [] })).toBe(true);
  });

  it("GraphEvents accepts records", () => {
    expect(ok(GraphEventsSchema, { records: [record] })).toBe(true);
    expect(ok(GraphEventsSchema, { records: [] })).toBe(true);
  });

  it("GraphEvents rejects a record with seq 0", () => {
    expect(ok(GraphEventsSchema, { records: [{ ...record, seq: 0 }] })).toBe(false);
  });
});

describe("PairRequestSchema", () => {
  it("accepts a code alone", () => {
    expect(ok(PairRequestSchema, { code: "ABC234" })).toBe(true);
  });

  it("accepts a code with a name", () => {
    expect(ok(PairRequestSchema, { code: "ABC234", name: "phone" })).toBe(true);
  });

  it("rejects a lowercase code", () => {
    expect(ok(PairRequestSchema, { code: "abc234" })).toBe(false);
  });

  it("rejects codes containing 0, 1, I or O", () => {
    for (const code of ["ABC230", "ABC231", "ABCI23", "ABCO23"]) {
      expect(ok(PairRequestSchema, { code }), code).toBe(false);
    }
  });

  it("rejects 5- and 7-character codes", () => {
    expect(ok(PairRequestSchema, { code: "ABC23" })).toBe(false);
    expect(ok(PairRequestSchema, { code: "ABC2345" })).toBe(false);
  });

  it("accepts a name of exactly 64 characters and rejects 65", () => {
    expect(ok(PairRequestSchema, { code: "ABC234", name: "a".repeat(64) })).toBe(true);
    expect(ok(PairRequestSchema, { code: "ABC234", name: "a".repeat(65) })).toBe(false);
  });

  it("rejects an empty name", () => {
    expect(ok(PairRequestSchema, { code: "ABC234", name: "" })).toBe(false);
  });
});

describe("PairResponseSchema", () => {
  it("accepts an origin and a token", () => {
    expect(ok(PairResponseSchema, { origin: "http://localhost:3000", token: "t0ken" })).toBe(true);
  });

  it("rejects a missing token", () => {
    expect(ok(PairResponseSchema, { origin: "http://localhost:3000" })).toBe(false);
  });
});

describe("ApiErrorBodySchema", () => {
  it("accepts ok: false with a CoreErrorShape", () => {
    expect(ok(ApiErrorBodySchema, { ok: false, error })).toBe(true);
    expect(ok(ApiErrorBodySchema, { ok: false, error: { ...error, provider: "mock", details: { a: 1 } } })).toBe(
      true,
    );
  });

  it("rejects ok: true", () => {
    expect(ok(ApiErrorBodySchema, { ok: true, error })).toBe(false);
  });

  it("rejects a malformed error", () => {
    expect(ok(ApiErrorBodySchema, { ok: false, error: { message: "boom" } })).toBe(false);
  });
});

describe("toJsonSchemas", () => {
  it("contains the server schema names and the graph shapes they carry", () => {
    const names = Object.keys(toJsonSchemas());
    for (const name of [
      "Principal",
      "HealthResponse",
      "ProviderStatus",
      "ProvidersResponse",
      "ModelsResponse",
      "ChatCall",
      "TurnCall",
      "BranchTurnCall",
      "GraphCreate",
      "BranchCreate",
      "MessageAdd",
      "TurnRecord",
      "MergeCall",
      "CrossReferenceCall",
      "ForkCall",
      "GraphWriteResult",
      "GraphList",
      "GraphEvents",
      "PairRequest",
      "PairResponse",
      "ApiErrorBody",
      "GraphState",
      "GraphEventRecord",
    ]) {
      expect(names, name).toContain(name);
    }
  });
});

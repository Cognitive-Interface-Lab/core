import { z } from "zod";
import { CoreErrorShapeSchema } from "./errors.js";
import { GraphEventRecordSchema, NodeRefSchema } from "./graph-events.js";
import { GraphStateSchema } from "./graph-state.js";
import { MessageSchema } from "./messages.js";
import { ModelRefSchema } from "./models.js";
import { ChannelSchema, ToolDefinitionSchema } from "./tools.js";
import { TurnBudgetSchema, TurnEventSchema } from "./turn.js";

/** Who a request runs as. The host app decides the principal; the server only carries it. */
export const PrincipalSchema = z.object({
  id: z.string().min(1),
  channel: ChannelSchema,
});
export type Principal = z.infer<typeof PrincipalSchema>;

export const HealthResponseSchema = z.object({
  ok: z.literal(true),
  version: z.string(),
  mode: z.enum(["local", "hosted"]),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

export const ProviderStatusSchema = z.object({
  id: z.string(),
  ready: z.boolean(),
  requiresKey: z.boolean(),
});
export type ProviderStatus = z.infer<typeof ProviderStatusSchema>;

export const ProvidersResponseSchema = z.object({
  providers: z.array(ProviderStatusSchema),
});
export type ProvidersResponse = z.infer<typeof ProvidersResponseSchema>;

export const ModelsResponseSchema = z.object({
  provider: z.string(),
  models: z.array(z.string()),
});
export type ModelsResponse = z.infer<typeof ModelsResponseSchema>;

/** A model call. `route` lists the models to try, in order. */
export const ChatCallSchema = z.object({
  route: z.array(ModelRefSchema).min(1).optional(),
  messages: z.array(MessageSchema).min(1),
  outputSchema: z.record(z.string(), z.unknown()).optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  temperature: z.number().min(0).max(2).optional(),
  timeoutMs: z.number().int().positive().optional(),
});
export type ChatCall = z.infer<typeof ChatCallSchema>;

/** A turn: model calls and tool calls until the model stops or the budget runs out. */
export const TurnCallSchema = z.object({
  route: z.array(ModelRefSchema).min(1).optional(),
  messages: z.array(MessageSchema).min(1),
  clientTools: z.array(ToolDefinitionSchema).optional(),
  budget: TurnBudgetSchema.optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  temperature: z.number().min(0).max(2).optional(),
  timeoutMs: z.number().int().positive().optional(),
});
export type TurnCall = z.infer<typeof TurnCallSchema>;

/** A turn on a branch of a graph: the branch holds the history, so only the new input is sent. */
export const BranchTurnCallSchema = TurnCallSchema.omit({ messages: true }).extend({
  branchId: z.string(),
  input: MessageSchema.optional(),
});
export type BranchTurnCall = z.infer<typeof BranchTurnCallSchema>;

export const GraphCreateSchema = z.object({
  title: z.string().optional(),
});
export type GraphCreate = z.infer<typeof GraphCreateSchema>;

/** `from` is the node the branch starts at, or null for a branch with nothing before it. */
export const BranchCreateSchema = z.object({
  name: z.string().min(1),
  from: z.string().nullable(),
  replayOf: z.string().optional(),
});
export type BranchCreate = z.infer<typeof BranchCreateSchema>;

export const MessageAddSchema = z.object({
  branchId: z.string(),
  message: MessageSchema,
  origin: NodeRefSchema.optional(),
});
export type MessageAdd = z.infer<typeof MessageAddSchema>;

export const TurnRecordSchema = z.object({
  branchId: z.string(),
  events: z.array(TurnEventSchema).min(1),
});
export type TurnRecord = z.infer<typeof TurnRecordSchema>;

/** `source` and `target` are branch ids. `summary` takes the one message that stands for the source. */
export const MergeCallSchema = z.discriminatedUnion("strategy", [
  z.object({
    source: z.string(),
    target: z.string(),
    strategy: z.literal("append"),
  }),
  z.object({
    source: z.string(),
    target: z.string(),
    strategy: z.literal("summary"),
    message: MessageSchema,
  }),
]);
export type MergeCall = z.infer<typeof MergeCallSchema>;

export const CrossReferenceCallSchema = z.object({
  from: z.string(),
  to: NodeRefSchema,
  label: z.string().optional(),
});
export type CrossReferenceCall = z.infer<typeof CrossReferenceCallSchema>;

export const ForkCallSchema = z.object({
  nodeId: z.string(),
  title: z.string().optional(),
});
export type ForkCall = z.infer<typeof ForkCallSchema>;

export const GraphWriteResultSchema = z.object({
  ids: z.array(z.string()),
  state: GraphStateSchema,
});
export type GraphWriteResult = z.infer<typeof GraphWriteResultSchema>;

export const GraphListSchema = z.object({
  graphs: z.array(z.string()),
});
export type GraphList = z.infer<typeof GraphListSchema>;

export const GraphEventsSchema = z.object({
  records: z.array(GraphEventRecordSchema),
});
export type GraphEvents = z.infer<typeof GraphEventsSchema>;

/** A pairing code: six characters with no 0, 1, I or O, so it reads aloud without confusion. */
export const PairRequestSchema = z.object({
  code: z.string().regex(/^[A-HJ-NP-Z2-9]{6}$/),
  name: z.string().min(1).max(64).optional(),
});
export type PairRequest = z.infer<typeof PairRequestSchema>;

export const PairResponseSchema = z.object({
  origin: z.string(),
  token: z.string(),
});
export type PairResponse = z.infer<typeof PairResponseSchema>;

export const ApiErrorBodySchema = z.object({
  ok: z.literal(false),
  error: CoreErrorShapeSchema,
});
export type ApiErrorBody = z.infer<typeof ApiErrorBodySchema>;

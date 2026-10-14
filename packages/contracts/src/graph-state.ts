import { z } from "zod";
import { MergeStrategySchema, NodeRefSchema } from "./graph-events.js";
import { MessageSchema } from "./messages.js";
import { ModelRefSchema, UsageSchema } from "./models.js";
import { TurnFinishReasonSchema } from "./turn.js";

/** One message in a graph; the projection of the event log builds these. */
export const GraphNodeSchema = z.object({
  id: z.string().min(1),
  /** The branch it was added on. */
  branchId: z.string().min(1),
  /** 0 for a root, 1 normally, 2 for a merge (target head, then source head). */
  parentIds: z.array(z.string().min(1)),
  /** Absent only on an `append` merge node. */
  message: MessageSchema.optional(),
  /** The turn that added it, if any. */
  turnId: z.string().min(1).optional(),
  merge: z.object({ strategy: MergeStrategySchema, sourceBranchId: z.string().min(1) }).optional(),
  /** The node it was copied from, in a fork or a replay. */
  origin: NodeRefSchema.optional(),
});
export type GraphNode = z.infer<typeof GraphNodeSchema>;

/** A named line of conversation: starts at `from` (or nothing) and ends at `head`. */
export const BranchSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  from: z.string().min(1).nullable(),
  head: z.string().min(1).nullable(),
  /** The branch this one replays. */
  replayOf: z.string().min(1).optional(),
});
export type Branch = z.infer<typeof BranchSchema>;

/** What a recorded turn did, without its events. */
export const TurnSummarySchema = z.object({
  id: z.string().min(1),
  branchId: z.string().min(1),
  nodeIds: z.array(z.string().min(1)),
  reason: TurnFinishReasonSchema,
  /** The model of the turn's last `route` event; absent when it had none. */
  model: ModelRefSchema.optional(),
  usage: UsageSchema,
});
export type TurnSummary = z.infer<typeof TurnSummarySchema>;

/** A labelled link from a node of this graph to any node in any graph. */
export const CrossRefSchema = z.object({
  id: z.string().min(1),
  from: z.string().min(1),
  to: NodeRefSchema,
  label: z.string().optional(),
});
export type CrossRef = z.infer<typeof CrossRefSchema>;

/** A graph as the projection of its event log. Records are keyed by id. */
export const GraphStateSchema = z.object({
  graphId: z.string().min(1),
  title: z.string().optional(),
  forkedFrom: NodeRefSchema.optional(),
  createdAt: z.iso.datetime(),
  lastSeq: z.number().int().nonnegative(),
  branches: z.record(z.string(), BranchSchema),
  nodes: z.record(z.string(), GraphNodeSchema),
  turns: z.record(z.string(), TurnSummarySchema),
  refs: z.array(CrossRefSchema),
});
export type GraphState = z.infer<typeof GraphStateSchema>;

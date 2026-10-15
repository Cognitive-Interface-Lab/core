import { z } from "zod";
import { MessageSchema } from "./messages.js";
import { TurnEventSchema } from "./turn.js";

/** A node in a graph, possibly another one. */
export const NodeRefSchema = z.object({
  graphId: z.string().min(1),
  nodeId: z.string().min(1),
});
export type NodeRef = z.infer<typeof NodeRefSchema>;

/**
 * How a merge joins two branches: `append` continues the target with what the source added,
 * `summary` adds one caller-supplied message that stands for the source.
 */
export const MergeStrategySchema = z.enum(["append", "summary"]);
export type MergeStrategy = z.infer<typeof MergeStrategySchema>;

/**
 * One fact in a graph's event log. Graph state is a projection of these; cross-field rules are
 * enforced by the projection, not by the schema.
 */
export const GraphEventSchema = z.discriminatedUnion("type", [
  /** The graph exists. Always seq 1; `forkedFrom` names the node a fork copied up to. */
  z.object({
    type: z.literal("graph-created"),
    title: z.string().optional(),
    forkedFrom: NodeRefSchema.optional(),
  }),
  /** A named line of conversation starts at node `from` (or at nothing); `replayOf` names the branch it replays. */
  z.object({
    type: z.literal("branch-created"),
    branchId: z.string().min(1),
    name: z.string().min(1),
    from: z.string().min(1).nullable(),
    replayOf: z.string().min(1).optional(),
  }),
  /** One message is added at the head of a branch; `origin` names the node it was copied from. */
  z.object({
    type: z.literal("message-added"),
    nodeId: z.string().min(1),
    branchId: z.string().min(1),
    message: MessageSchema,
    origin: NodeRefSchema.optional(),
  }),
  /** A whole turn ran on a branch: its events exactly as emitted, and one node id per message it added. */
  z.object({
    type: z.literal("turn-recorded"),
    turnId: z.string().min(1),
    branchId: z.string().min(1),
    nodeIds: z.array(z.string().min(1)),
    events: z.array(TurnEventSchema),
  }),
  /** The source branch is merged into the target branch by a node with two parents. */
  z.object({
    type: z.literal("branches-merged"),
    nodeId: z.string().min(1),
    sourceBranchId: z.string().min(1),
    targetBranchId: z.string().min(1),
    strategy: MergeStrategySchema,
    message: MessageSchema.optional(),
  }),
  /** A labelled link from a node of this graph to any node in any graph. */
  z.object({
    type: z.literal("cross-referenced"),
    refId: z.string().min(1),
    from: z.string().min(1),
    to: NodeRefSchema,
    label: z.string().optional(),
  }),
]);
export type GraphEvent = z.infer<typeof GraphEventSchema>;

/** One stored entry of a graph's log; `seq` is gapless from 1 per graph. */
export const GraphEventRecordSchema = z.object({
  graphId: z.string().min(1),
  seq: z.number().int().positive(),
  at: z.iso.datetime(),
  event: GraphEventSchema,
});
export type GraphEventRecord = z.infer<typeof GraphEventRecordSchema>;

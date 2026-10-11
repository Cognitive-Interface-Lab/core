import { z } from "zod";
import { CoreErrorShapeSchema } from "./errors.js";
import { FinishReasonSchema, ModelRefSchema, UsageSchema } from "./models.js";
import { ToolCallSchema } from "./tools.js";

/**
 * Events of a streamed answer. `route` is emitted only by the router, before each attempt
 * (1-based). `error` is always the last event when present.
 */
export const StreamEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("route"), model: ModelRefSchema, attempt: z.number().int().positive() }),
  z.object({ type: z.literal("text-delta"), text: z.string() }),
  z.object({ type: z.literal("tool-call"), toolCall: ToolCallSchema }),
  z.object({ type: z.literal("finish"), finishReason: FinishReasonSchema, usage: UsageSchema }),
  z.object({ type: z.literal("error"), error: CoreErrorShapeSchema }),
]);
export type StreamEvent = z.infer<typeof StreamEventSchema>;

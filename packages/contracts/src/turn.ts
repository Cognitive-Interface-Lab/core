import { z } from "zod";
import { MessageSchema } from "./messages.js";
import { UsageSchema } from "./models.js";
import { StreamEventSchema } from "./stream.js";
import { ToolResultSchema } from "./tools.js";

/** Limits on one turn. Every field is optional; the runtime fills in its defaults (8 rounds). */
export const TurnBudgetSchema = z.object({
  maxRounds: z.number().int().positive().optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  maxWallMs: z.number().int().positive().optional(),
});
export type TurnBudget = z.infer<typeof TurnBudgetSchema>;

export const TurnFinishReasonSchema = z.enum(["stop", "max-rounds", "budget", "error", "aborted", "client-tools"]);
export type TurnFinishReason = z.infer<typeof TurnFinishReasonSchema>;

/**
 * Events of a whole turn: the model's stream events, plus one `round` event before each model
 * call, one `tool-result` per tool call, and a final `turn-finish`. The event log persists
 * exactly these.
 */
export const TurnEventSchema = z.discriminatedUnion("type", [
  ...StreamEventSchema.options,
  z.object({ type: z.literal("round"), round: z.number().int().positive() }),
  z.object({ type: z.literal("tool-result"), result: ToolResultSchema }),
  z.object({
    type: z.literal("turn-finish"),
    reason: TurnFinishReasonSchema,
    rounds: z.number().int().nonnegative(),
    usage: UsageSchema,
    /** The assistant and tool messages this turn added, in order. */
    messages: z.array(MessageSchema),
  }),
]);
export type TurnEvent = z.infer<typeof TurnEventSchema>;

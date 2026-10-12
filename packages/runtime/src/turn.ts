import {
  CoreError,
  type Channel,
  type Message,
  type ToolCall,
  type TurnBudget,
  type TurnEvent,
  type TurnFinishReason,
  type Usage,
} from "@core/contracts";
import type { ModelRouter, RouteStep } from "@core/models";
import type { ConfirmFn, ToolRegistry } from "@core/tools";

const DEFAULT_MAX_ROUNDS = 8;

export type RunTurnOptions = {
  router: ModelRouter;
  route: RouteStep[];
  tools: ToolRegistry;
  channel: Channel;
  /** The conversation so far, ending with the message to answer. */
  messages: Message[];
  budget?: TurnBudget;
  signal?: AbortSignal;
  confirm?: ConfirmFn;
  temperature?: number;
};

/**
 * Runs one turn: model, then the tool calls it asked for, then the model again with the results,
 * until it answers without calling a tool or a limit ends the turn. Tools run one at a time, in
 * the order the model gave them. Never throws: every failure is an `error` event, and
 * `turn-finish` is always the last event, emitted exactly once, with the messages this turn added.
 */
export async function* runTurn(opts: RunTurnOptions): AsyncGenerator<TurnEvent, void, undefined> {
  const maxRounds = opts.budget?.maxRounds ?? DEFAULT_MAX_ROUNDS;
  const added: Message[] = [];
  const usage: Usage = {};
  let rounds = 0;

  const finish = (reason: TurnFinishReason): TurnEvent => ({
    type: "turn-finish",
    reason,
    rounds,
    usage: { ...usage },
    messages: added,
  });

  try {
    for (let round = 1; round <= maxRounds; round++) {
      if (opts.signal?.aborted) {
        yield finish("aborted");
        return;
      }
      rounds = round;
      yield { type: "round", round };

      const definitions = opts.tools.listFor(opts.channel);
      const request = {
        messages: [...opts.messages, ...added],
        ...(definitions.length > 0 && { tools: definitions }),
        ...(opts.temperature !== undefined && { temperature: opts.temperature }),
      };

      let text = "";
      const toolCalls: ToolCall[] = [];
      let finished = false;
      for await (const event of opts.router.stream(request, opts.route, { signal: opts.signal })) {
        if (event.type === "error") {
          yield event;
          yield finish(event.error.code === "aborted" ? "aborted" : "error");
          return;
        }
        yield event;
        if (event.type === "text-delta") {
          text += event.text;
        } else if (event.type === "tool-call") {
          toolCalls.push(event.toolCall);
        } else if (event.type === "finish") {
          finished = true;
          addTokens(usage, event.usage);
        }
      }
      if (!finished) {
        yield { type: "error", error: new CoreError("unknown", "the model stream ended without a finish event").toJSON() };
        yield finish("error");
        return;
      }

      added.push({ role: "assistant", content: text, ...(toolCalls.length > 0 && { toolCalls }) });
      if (toolCalls.length === 0) {
        yield finish("stop");
        return;
      }

      for (const call of toolCalls) {
        // After an abort the registry answers each remaining call with an error result, so every
        // tool call in the history still has its result.
        const result = await opts.tools.call(call, {
          channel: opts.channel,
          ...(opts.signal !== undefined && { signal: opts.signal }),
          ...(opts.confirm !== undefined && { confirm: opts.confirm }),
        });
        yield { type: "tool-result", result };
        added.push({
          role: "tool",
          toolCallId: result.toolCallId,
          toolName: result.toolName,
          content: result.content,
          isError: result.isError,
        });
      }

      if (opts.signal?.aborted) {
        yield finish("aborted");
        return;
      }
      if (round === maxRounds) {
        yield finish("max-rounds");
        return;
      }
    }
    yield finish("max-rounds");
  } catch (error) {
    const failure = CoreError.is(error)
      ? error
      : new CoreError("unknown", error instanceof Error && error.message !== "" ? error.message : "the turn failed");
    yield { type: "error", error: failure.toJSON() };
    yield finish("error");
  }
}

/** Adds the token counts that are defined; a count nobody reported stays undefined. */
function addTokens(total: Usage, step: Usage): void {
  if (step.inputTokens !== undefined) total.inputTokens = (total.inputTokens ?? 0) + step.inputTokens;
  if (step.outputTokens !== undefined) total.outputTokens = (total.outputTokens ?? 0) + step.outputTokens;
}

import {
  CoreError,
  type ChatRequest,
  type ChatResponse,
  type CoreErrorShape,
  type FinishReason,
  type ModelCapabilities,
  type StreamEvent,
  type ToolCall,
  type Usage,
} from "@core/contracts";
import type { ChatOptions, ModelProvider } from "../provider.js";
import { parseStructuredOutput } from "../structured.js";

export type MockTurn = {
  text?: string;
  toolCalls?: ToolCall[];
  finishReason?: FinishReason;
  error?: CoreErrorShape;
  delayMs?: number;
  chunkSize?: number;
};

const DEFAULT_CHUNK_SIZE = 8;

type TakenTurn = { turn: MockTurn } | { error: CoreError };

/**
 * Deterministic provider for tests and the example's default route. Replies come from a script
 * of turns; without one (or once it is used up, when `echo` is on) it answers
 * `echo: <last user message>`.
 */
export class MockProvider implements ModelProvider {
  readonly id: string;
  /** Every request received, in order. */
  readonly calls: ChatRequest[] = [];

  readonly #script: MockTurn[] | undefined;
  readonly #echo: boolean;
  #next = 0;

  constructor(opts?: { id?: string; script?: MockTurn[]; echo?: boolean }) {
    this.id = opts?.id ?? "mock";
    this.#script = opts?.script;
    this.#echo = opts?.echo ?? opts?.script === undefined;
  }

  // The mock answers the same for every model; the parameter only mirrors `ModelProvider`.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  capabilities(_model?: string): ModelCapabilities {
    return { streaming: true, tools: true, vision: false, structuredOutput: true };
  }

  async chat(req: ChatRequest, opts?: ChatOptions): Promise<ChatResponse> {
    const taken = this.#take(req);
    if ("error" in taken) throw taken.error;
    const { turn } = taken;
    await this.#pause(turn.delayMs, opts?.signal);
    if (turn.error) throw CoreError.fromShape(turn.error);
    const text = turn.text ?? "";
    const message: ChatResponse["message"] = { role: "assistant", content: text };
    if (turn.toolCalls !== undefined) message.toolCalls = turn.toolCalls;
    const response: ChatResponse = {
      model: req.model,
      message,
      finishReason: this.#finishReason(turn),
      usage: this.#usage(req, text),
    };
    if (req.outputSchema !== undefined) {
      response.output = parseStructuredOutput(req.outputSchema, text);
    }
    return response;
  }

  stream(req: ChatRequest, opts?: ChatOptions): AsyncIterable<StreamEvent> {
    if (req.outputSchema !== undefined) {
      return this.#rejectOutputSchema();
    }
    // Record and consume eagerly so that call order, not iteration order, decides the turn.
    const taken = this.#take(req);
    return this.#events(req, taken, opts);
  }

  async *#rejectOutputSchema(): AsyncGenerator<StreamEvent> {
    const error = new CoreError("bad_request", "outputSchema is not supported when streaming");
    yield { type: "error", error: error.toJSON() };
  }

  async *#events(req: ChatRequest, taken: TakenTurn, opts?: ChatOptions): AsyncGenerator<StreamEvent> {
    try {
      if ("error" in taken) throw taken.error;
      const { turn } = taken;
      await this.#pause(turn.delayMs, opts?.signal);
      if (turn.error) throw CoreError.fromShape(turn.error);

      const text = turn.text ?? "";
      const size = Math.max(1, Math.floor(turn.chunkSize ?? DEFAULT_CHUNK_SIZE));
      const characters = Array.from(text);
      for (let i = 0; i < characters.length; i += size) {
        if (opts?.signal?.aborted) throw this.#aborted();
        yield { type: "text-delta", text: characters.slice(i, i + size).join("") };
      }
      for (const toolCall of turn.toolCalls ?? []) {
        yield { type: "tool-call", toolCall };
      }
      yield { type: "finish", finishReason: this.#finishReason(turn), usage: this.#usage(req, text) };
    } catch (error) {
      const coreError = CoreError.is(error)
        ? error
        : new CoreError("unknown", `${this.id}: unexpected failure`, { provider: this.id, cause: error });
      yield { type: "error", error: coreError.toJSON() };
    }
  }

  #take(req: ChatRequest): TakenTurn {
    this.calls.push(req);
    const scripted = this.#script?.[this.#next];
    if (scripted !== undefined) {
      this.#next += 1;
      return { turn: scripted };
    }
    if (!this.#echo) {
      return { error: new CoreError("unavailable", "mock script exhausted", { provider: this.id }) };
    }
    const lastUser = [...req.messages].reverse().find((message) => message.role === "user");
    return { turn: { text: `echo: ${lastUser?.content ?? ""}` } };
  }

  #finishReason(turn: MockTurn): FinishReason {
    return turn.finishReason ?? (turn.toolCalls && turn.toolCalls.length > 0 ? "tool-calls" : "stop");
  }

  #usage(req: ChatRequest, text: string): Usage {
    const inputTokens = req.messages.reduce((total, message) => total + message.content.length, 0);
    return { inputTokens, outputTokens: text.length };
  }

  #aborted(): CoreError {
    return new CoreError("aborted", `${this.id}: request aborted`, { provider: this.id });
  }

  /** Waits `ms`, rejecting with `aborted` as soon as `signal` fires (also when already aborted). */
  #pause(ms: number | undefined, signal: AbortSignal | undefined): Promise<void> {
    if (signal?.aborted) return Promise.reject(this.#aborted());
    if (!ms || ms <= 0) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timer);
        reject(this.#aborted());
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}

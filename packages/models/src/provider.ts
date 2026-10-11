import type {
  ChatRequest,
  ChatResponse,
  ModelCapabilities,
  StreamEvent,
} from "@core/contracts";

export interface ChatOptions {
  signal?: AbortSignal;
}

export interface ModelProvider {
  /** Registry key, e.g. "mock", "openai", "ollama". */
  readonly id: string;
  capabilities(model: string): ModelCapabilities;
  /** Throws `CoreError` only. */
  chat(req: ChatRequest, opts?: ChatOptions): Promise<ChatResponse>;
  /**
   * Never throws: a failure is a final `{ type: "error" }` event.
   * Providers never emit `route` events; only the router does.
   */
  stream(req: ChatRequest, opts?: ChatOptions): AsyncIterable<StreamEvent>;
}

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  CoreError,
  type ChatRequest,
  type ChatResponse,
  type ErrorCode,
  type FinishReason,
  type ModelCapabilities,
  type StreamEvent,
  type ToolCall,
  type Usage,
} from "@core/contracts";
import {
  APICallError,
  NoObjectGeneratedError,
  Output,
  RetryError,
  generateText,
  jsonSchema,
  streamText,
  tool,
  type JSONSchema7,
  type LanguageModelUsage,
  type ModelMessage,
  type ToolSet,
} from "ai";
import { parseStructuredOutput } from "../structured.js";
import type { CredentialStore, Credentials } from "../credentials.js";
import type { ChatOptions, ModelProvider } from "../provider.js";
import type { Preset } from "./presets.js";

const DEFAULT_CAPABILITIES: ModelCapabilities = { streaming: true, tools: true, vision: false, structuredOutput: true };
const MAX_MESSAGE_LENGTH = 300;
const MIN_SECRET_LENGTH = 4;
const ACCOUNT_PLACEHOLDER = "{accountId}";
const CLOUDFLARE_BASE_SUFFIX = "/ai/v1";
const CLOUDFLARE_SEARCH_SUFFIX = "/ai/models/search";
const CLOUDFLARE_PAGE_SIZE = 100;
const CLOUDFLARE_MAX_PAGES = 10;
const MAX_BODY_SNIPPET = 200;

const UNAVAILABLE_CAUSE_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "UND_ERR_SOCKET",
]);
const TIMEOUT_CAUSE_CODES = new Set(["ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT"]);

type Resolved = {
  model: ReturnType<ReturnType<typeof createOpenAICompatible>["chatModel"]>;
  secrets: string[];
};

/**
 * One adapter for every server that speaks the OpenAI chat-completions format (OpenAI, Ollama,
 * OpenRouter, Groq, Cloudflare Workers AI, ...), built on the Vercel AI SDK. The router owns
 * retries, so the SDK's own retrying is off. Tools are offered to the model but never executed
 * here: tool calls come back to the caller.
 */
export class OpenAICompatibleProvider implements ModelProvider {
  readonly id: string;

  readonly #credentials: CredentialStore;
  readonly #preset: Preset | undefined;
  readonly #capabilities: Partial<ModelCapabilities> | ((model: string) => Partial<ModelCapabilities>);
  readonly #fetch: typeof fetch | undefined;

  constructor(opts: {
    id: string;
    credentials: CredentialStore;
    preset?: Preset;
    /** Overrides of the defaults: one object for every model, or a function answering per model. */
    capabilities?: Partial<ModelCapabilities> | ((model: string) => Partial<ModelCapabilities>);
    fetch?: typeof fetch;
  }) {
    this.id = opts.id;
    this.#credentials = opts.credentials;
    this.#preset = opts.preset;
    this.#capabilities = opts.capabilities ?? {};
    this.#fetch = opts.fetch;
  }

  capabilities(model: string): ModelCapabilities {
    const overrides = typeof this.#capabilities === "function" ? this.#capabilities(model) : this.#capabilities;
    return { ...DEFAULT_CAPABILITIES, ...overrides };
  }

  async chat(req: ChatRequest, opts?: ChatOptions): Promise<ChatResponse> {
    let secrets: string[] = [];
    try {
      const resolved = await this.#resolve(req.model.model, req.outputSchema !== undefined);
      secrets = resolved.secrets;
      const result = await generateText({
        model: resolved.model,
        ...this.#callOptions(req, opts),
        ...(req.outputSchema ? { output: Output.object({ schema: jsonSchema(req.outputSchema as JSONSchema7) }) } : {}),
      });
      const toolCalls = result.toolCalls.map(
        (call): ToolCall => ({ id: call.toolCallId, name: call.toolName, arguments: asObject(call.input) }),
      );
      const message: ChatResponse["message"] = { role: "assistant", content: result.text };
      if (toolCalls.length > 0) message.toolCalls = toolCalls;
      return {
        model: req.model,
        message,
        finishReason: result.finishReason satisfies FinishReason,
        usage: toUsage(result.usage),
        ...(req.outputSchema !== undefined ? { output: parseStructuredOutput(req.outputSchema, result.text) } : {}),
      };
    } catch (error) {
      const recovered = this.#recoverStructured(req, error);
      if (recovered) return recovered;
      throw this.#toCoreError(error, opts?.signal, secrets);
    }
  }

  /**
   * The SDK parses structured output with a strict `JSON.parse` and throws when that fails, so a
   * fenced reply or invalid JSON never reaches the shared helper. Hand the reply text to it here,
   * so every provider accepts and rejects the same text with the same message.
   */
  #recoverStructured(req: ChatRequest, error: unknown): ChatResponse | undefined {
    if (req.outputSchema === undefined || !NoObjectGeneratedError.isInstance(error)) return undefined;
    if (error.text === undefined) return undefined;
    const output = parseStructuredOutput(req.outputSchema, error.text);
    return {
      model: req.model,
      message: { role: "assistant", content: error.text },
      finishReason: (error.finishReason ?? "stop") satisfies FinishReason,
      usage: error.usage ? toUsage(error.usage) : {},
      output,
    };
  }

  async *stream(req: ChatRequest, opts?: ChatOptions): AsyncGenerator<StreamEvent> {
    if (req.outputSchema !== undefined) {
      yield { type: "error", error: new CoreError("bad_request", "outputSchema is not supported when streaming").toJSON() };
      return;
    }
    let secrets: string[] = [];
    try {
      const resolved = await this.#resolve(req.model.model);
      secrets = resolved.secrets;
      const result = streamText({
        model: resolved.model,
        ...this.#callOptions(req, opts),
        streamRetries: 0,
        // Errors surface as stream parts and become the final error event; keep the SDK from logging them.
        onError: () => {},
      });
      let finished = false;
      for await (const part of result.stream) {
        switch (part.type) {
          case "text-delta":
            if (part.text.length > 0) yield { type: "text-delta", text: part.text };
            break;
          case "tool-call":
            yield {
              type: "tool-call",
              toolCall: { id: part.toolCallId, name: part.toolName, arguments: asObject(part.input) },
            };
            break;
          case "finish":
            finished = true;
            yield { type: "finish", finishReason: part.finishReason, usage: toUsage(part.totalUsage) };
            break;
          case "error":
            throw part.error;
          case "abort":
            throw abortError();
          default:
            break;
        }
        if (finished) break;
      }
      if (!finished) {
        if (opts?.signal?.aborted) throw abortError();
        throw new CoreError("unknown", `${this.id}: stream ended without a finish event`, { provider: this.id });
      }
    } catch (error) {
      yield { type: "error", error: this.#toCoreError(error, opts?.signal, secrets).toJSON() };
    }
  }

  async #resolve(modelId: string, structuredOutput = false): Promise<Resolved> {
    const credentials = await this.#credentials.get(this.id);
    const { baseURL, apiKey, secrets } = this.#connection(credentials);
    const provider = createOpenAICompatible({
      name: this.id,
      baseURL,
      includeUsage: true,
      ...(apiKey ? { apiKey } : {}),
      ...(credentials?.headers ? { headers: credentials.headers } : {}),
      ...(this.#fetch ? { fetch: this.#fetch } : {}),
      // Without this the SDK sends only `json_object`, and the endpoint never sees the JSON Schema.
      ...(structuredOutput ? { supportsStructuredOutputs: true } : {}),
    });
    return { model: provider.chatModel(modelId), secrets };
  }

  /**
   * Where to send requests and with which key. An explicit `credentials.baseURL` wins; otherwise
   * `{accountId}` in the preset URL is filled from `credentials.accountId`.
   */
  #connection(credentials: Credentials | undefined): {
    baseURL: string;
    apiKey: string | undefined;
    secrets: string[];
  } {
    let baseURL = credentials?.baseURL ?? this.#preset?.baseURL;
    if (!baseURL) {
      throw new CoreError("bad_request", `${this.id}: no base URL configured`, { provider: this.id });
    }
    if (credentials?.baseURL === undefined && baseURL.includes(ACCOUNT_PLACEHOLDER)) {
      if (!credentials?.accountId) {
        throw new CoreError("auth", `${this.id}: no account ID configured`, { provider: this.id });
      }
      baseURL = baseURL.split(ACCOUNT_PLACEHOLDER).join(encodeURIComponent(credentials.accountId));
    }
    const apiKey = credentials?.apiKey;
    if (this.#preset?.requiresKey && !apiKey) {
      throw new CoreError("auth", `${this.id}: no API key configured`, { provider: this.id });
    }
    const secrets = [apiKey, ...Object.values(credentials?.headers ?? {})].filter(
      (value): value is string => typeof value === "string" && value.length >= MIN_SECRET_LENGTH,
    );
    return { baseURL, apiKey, secrets };
  }

  async listModels(opts?: ChatOptions): Promise<string[]> {
    let secrets: string[] = [];
    try {
      const credentials = await this.#credentials.get(this.id);
      const connection = this.#connection(credentials);
      secrets = connection.secrets;
      const headers: Record<string, string> = { ...credentials?.headers };
      if (connection.apiKey) headers.Authorization = `Bearer ${connection.apiKey}`;
      const get = (url: string) => this.#getJson(url, headers, opts?.signal);

      const ids: unknown[] = [];
      if (this.#preset?.models === "cloudflare") {
        if (!connection.baseURL.endsWith(CLOUDFLARE_BASE_SUFFIX)) {
          throw new CoreError("bad_request", `${this.id}: cannot list models for this base URL`, {
            provider: this.id,
          });
        }
        const search = `${connection.baseURL.slice(0, -CLOUDFLARE_BASE_SUFFIX.length)}${CLOUDFLARE_SEARCH_SUFFIX}`;
        for (let page = 1; page <= CLOUDFLARE_MAX_PAGES; page++) {
          const body = await get(`${search}?task=Text%20Generation&per_page=${CLOUDFLARE_PAGE_SIZE}&page=${page}`);
          const items = listField(this.id, body, "result");
          for (const item of items) ids.push(field(item, "name"));
          if (items.length < CLOUDFLARE_PAGE_SIZE) break;
        }
      } else {
        const body = await get(`${connection.baseURL.replace(/\/+$/, "")}/models`);
        for (const item of listField(this.id, body, "data")) ids.push(field(item, "id"));
      }
      if (!ids.every((id): id is string => typeof id === "string" && id.length > 0)) {
        throw malformedModels(this.id);
      }
      return [...new Set(ids)].sort();
    } catch (error) {
      throw this.#toListError(error, opts?.signal, secrets);
    }
  }

  async #getJson(url: string, headers: Record<string, string>, signal: AbortSignal | undefined): Promise<unknown> {
    const response = await (this.#fetch ?? fetch)(url, {
      method: "GET",
      headers,
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      const snippet = text.replace(/\s+/g, " ").trim().slice(0, MAX_BODY_SNIPPET);
      throw new CoreError(
        codeForStatus(response.status),
        `${this.id}: HTTP ${response.status}${snippet ? `: ${snippet}` : ""}`,
        { provider: this.id, details: { status: response.status } },
      );
    }
    try {
      return await response.json();
    } catch {
      throw malformedModels(this.id);
    }
  }

  /** Like `#toCoreError`, for failures of a plain `fetch` rather than the AI SDK. */
  #toListError(error: unknown, signal: AbortSignal | undefined, secrets: string[]): CoreError {
    const fail = (code: ErrorCode, summary: string, details?: Record<string, unknown>) =>
      new CoreError(code, truncate(redact(`${this.id}: ${summary}`, secrets)), {
        provider: this.id,
        ...(details ? { details } : {}),
      });
    if (CoreError.is(error)) {
      return new CoreError(error.code, truncate(redact(error.message, secrets)), {
        provider: this.id,
        ...(error.details ? { details: error.details } : {}),
      });
    }
    const cancelled = cancellationCode(error, signal);
    if (cancelled) return fail(cancelled, cancelled === "timeout" ? "request timed out" : "request aborted");
    const causeCode = findCauseCode(error);
    const message = error instanceof Error ? error.message : "unexpected failure";
    if (causeCode && TIMEOUT_CAUSE_CODES.has(causeCode)) return fail("timeout", `connection timed out: ${message}`);
    if (causeCode && UNAVAILABLE_CAUSE_CODES.has(causeCode)) return fail("unavailable", `cannot connect: ${message}`);
    return fail("unknown", message);
  }

  #callOptions(req: ChatRequest, opts: ChatOptions | undefined) {
    const tools = toToolSet(req);
    return {
      messages: toModelMessages(req),
      allowSystemInMessages: true,
      maxRetries: 0,
      ...(opts?.signal ? { abortSignal: opts.signal } : {}),
      ...(tools ? { tools, ...(req.toolChoice ? { toolChoice: req.toolChoice } : {}) } : {}),
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      ...(req.maxOutputTokens !== undefined ? { maxOutputTokens: req.maxOutputTokens } : {}),
    };
  }

  /** Maps any failure to a `CoreError` whose message never contains a credential. */
  #toCoreError(error: unknown, signal: AbortSignal | undefined, secrets: string[]): CoreError {
    const unwrapped = RetryError.isInstance(error) ? error.lastError : error;
    if (CoreError.is(unwrapped)) return unwrapped;

    const fail = (code: ErrorCode, summary: string, details?: Record<string, unknown>) =>
      new CoreError(code, truncate(redact(`${this.id}: ${summary}`, secrets)), {
        provider: this.id,
        ...(details ? { details } : {}),
      });

    const cancelled = cancellationCode(unwrapped, signal);
    if (cancelled) return fail(cancelled, cancelled === "timeout" ? "request timed out" : "request aborted");

    if (APICallError.isInstance(unwrapped)) {
      const status = unwrapped.statusCode;
      if (status === undefined) {
        const causeCode = findCauseCode(unwrapped);
        if (causeCode && TIMEOUT_CAUSE_CODES.has(causeCode)) {
          return fail("timeout", `connection timed out: ${unwrapped.message}`);
        }
        if ((causeCode && UNAVAILABLE_CAUSE_CODES.has(causeCode)) || unwrapped.isRetryable) {
          return fail("unavailable", `cannot connect: ${unwrapped.message}`);
        }
        return fail("unknown", unwrapped.message);
      }
      return fail(codeForStatus(status), `HTTP ${status}: ${unwrapped.message}`, { status });
    }

    const message = unwrapped instanceof Error ? unwrapped.message : "unexpected failure";
    return fail("unknown", message);
  }
}

function codeForStatus(status: number): ErrorCode {
  if (status === 401 || status === 403) return "auth";
  if (status === 404) return "not_found";
  if (status === 400 || status === 422) return "bad_request";
  if (status === 408) return "timeout";
  if (status === 429) return "rate_limit";
  if (status >= 500) return "unavailable";
  return "unknown";
}

function malformedModels(providerId: string): CoreError {
  return new CoreError("unknown", `${providerId}: unexpected response to the model listing`, {
    provider: providerId,
  });
}

function listField(providerId: string, body: unknown, key: string): unknown[] {
  const value = typeof body === "object" && body !== null ? (body as Record<string, unknown>)[key] : undefined;
  if (!Array.isArray(value)) throw malformedModels(providerId);
  return value;
}

function field(item: unknown, key: string): unknown {
  return typeof item === "object" && item !== null ? (item as Record<string, unknown>)[key] : undefined;
}

function abortError(): Error {
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}

/** `aborted` or `timeout` when the failure is a cancellation, else undefined. */
function cancellationCode(error: unknown, signal: AbortSignal | undefined): ErrorCode | undefined {
  const names = [errorName(error), errorName(signal?.aborted ? signal.reason : undefined)];
  if (names.includes("TimeoutError")) return "timeout";
  if (names.includes("AbortError") || signal?.aborted) return "aborted";
  return undefined;
}

function errorName(value: unknown): string | undefined {
  return typeof value === "object" && value !== null && "name" in value
    ? String((value as { name: unknown }).name)
    : undefined;
}

function findCauseCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && typeof current === "object" && current !== null; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

function redact(text: string, secrets: string[]): string {
  return secrets.reduce((result, secret) => result.split(secret).join("[redacted]"), text);
}

function truncate(text: string): string {
  return text.length > MAX_MESSAGE_LENGTH ? `${text.slice(0, MAX_MESSAGE_LENGTH)}…` : text;
}

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function toUsage(usage: LanguageModelUsage): Usage {
  const result: Usage = {};
  if (usage.inputTokens !== undefined) result.inputTokens = usage.inputTokens;
  if (usage.outputTokens !== undefined) result.outputTokens = usage.outputTokens;
  return result;
}

function toToolSet(req: ChatRequest): ToolSet | undefined {
  if (!req.tools || req.tools.length === 0) return undefined;
  const tools: ToolSet = {};
  for (const definition of req.tools) {
    // No `execute`: the model's tool calls are returned to the caller, never run here.
    tools[definition.name] = tool({
      description: definition.description,
      inputSchema: jsonSchema(definition.inputSchema as JSONSchema7),
    });
  }
  return tools;
}

function toModelMessages(req: ChatRequest): ModelMessage[] {
  return req.messages.map((message): ModelMessage => {
    switch (message.role) {
      case "system":
        return { role: "system", content: message.content };
      case "user":
        return { role: "user", content: message.content };
      case "assistant":
        if (!message.toolCalls || message.toolCalls.length === 0) {
          return { role: "assistant", content: message.content };
        }
        return {
          role: "assistant",
          content: [
            ...(message.content.length > 0 ? [{ type: "text" as const, text: message.content }] : []),
            ...message.toolCalls.map((call) => ({
              type: "tool-call" as const,
              toolCallId: call.id,
              toolName: call.name,
              input: call.arguments,
            })),
          ],
        };
      case "tool":
        return {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: message.toolCallId,
              toolName: message.toolName,
              output: message.isError
                ? { type: "error-text", value: message.content }
                : { type: "text", value: message.content },
            },
          ],
        };
    }
  });
}

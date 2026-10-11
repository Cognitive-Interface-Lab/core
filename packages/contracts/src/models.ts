import { z } from "zod";
import { CoreError } from "./errors.js";
import { AssistantMessageSchema, MessageSchema } from "./messages.js";
import { ToolDefinitionSchema } from "./tools.js";

export const ModelRefSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
});
export type ModelRef = z.infer<typeof ModelRefSchema>;

/** Splits on the first ":" only, so "ollama:llama3.2:3b" is provider "ollama", model "llama3.2:3b". */
export function parseModelRef(ref: string): ModelRef {
  const index = ref.indexOf(":");
  if (index < 0) {
    throw new CoreError("bad_request", `invalid model ref "${ref}": expected "provider:model"`);
  }
  const parsed = ModelRefSchema.safeParse({
    provider: ref.slice(0, index),
    model: ref.slice(index + 1),
  });
  if (!parsed.success) {
    throw new CoreError("bad_request", `invalid model ref "${ref}": provider and model must be non-empty`);
  }
  return parsed.data;
}

export function formatModelRef(ref: ModelRef): string {
  return `${ref.provider}:${ref.model}`;
}

export const ModelCapabilitiesSchema = z.object({
  streaming: z.boolean(),
  tools: z.boolean(),
  vision: z.boolean(),
  contextWindow: z.number().int().positive().optional(),
});
export type ModelCapabilities = z.infer<typeof ModelCapabilitiesSchema>;

export const FinishReasonSchema = z.enum([
  "stop",
  "length",
  "tool-calls",
  "content-filter",
  "error",
  "other",
]);
export type FinishReason = z.infer<typeof FinishReasonSchema>;

export const UsageSchema = z.object({
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
});
export type Usage = z.infer<typeof UsageSchema>;

export const ChatRequestSchema = z.object({
  model: ModelRefSchema,
  messages: z.array(MessageSchema).min(1),
  tools: z.array(ToolDefinitionSchema).optional(),
  toolChoice: z.enum(["auto", "none", "required"]).optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxOutputTokens: z.number().int().positive().optional(),
});
export type ChatRequest = z.infer<typeof ChatRequestSchema>;

export const ChatResponseSchema = z.object({
  model: ModelRefSchema,
  message: AssistantMessageSchema,
  finishReason: FinishReasonSchema,
  usage: UsageSchema,
});
export type ChatResponse = z.infer<typeof ChatResponseSchema>;

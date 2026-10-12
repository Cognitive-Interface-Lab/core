import { z } from "zod";

export const ToolDefinitionSchema = z.object({
  name: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  description: z.string(),
  inputSchema: z.record(z.string(), z.unknown()),
});
export type ToolDefinition = z.infer<typeof ToolDefinitionSchema>;

export const ToolCallSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  arguments: z.record(z.string(), z.unknown()),
});
export type ToolCall = z.infer<typeof ToolCallSchema>;

/** Where a request comes from: "local", "trilix", "voice", "remote", ... Tool policy is decided per channel. */
export const ChannelSchema = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/);
export type Channel = z.infer<typeof ChannelSchema>;

export const ToolPolicySchema = z.object({
  /** Channels allowed to call the tool. Omitted means every channel. */
  channels: z.array(ChannelSchema).min(1).optional(),
  /** True means the tool needs confirmation before each call. */
  sideEffects: z.boolean(),
});
export type ToolPolicy = z.infer<typeof ToolPolicySchema>;

/** The outcome of one tool call, one-to-one with a tool message. */
export const ToolResultSchema = z.object({
  toolCallId: z.string().min(1),
  toolName: z.string().min(1),
  /** JSON-serialised result, or the error text when `isError`. */
  content: z.string(),
  isError: z.boolean(),
});
export type ToolResult = z.infer<typeof ToolResultSchema>;

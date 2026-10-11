import { z } from "zod";
import { ToolCallSchema } from "./tools.js";

export const SystemMessageSchema = z.object({
  role: z.literal("system"),
  content: z.string(),
});
export type SystemMessage = z.infer<typeof SystemMessageSchema>;

export const UserMessageSchema = z.object({
  role: z.literal("user"),
  content: z.string(),
});
export type UserMessage = z.infer<typeof UserMessageSchema>;

export const AssistantMessageSchema = z.object({
  role: z.literal("assistant"),
  content: z.string(),
  toolCalls: z.array(ToolCallSchema).optional(),
});
export type AssistantMessage = z.infer<typeof AssistantMessageSchema>;

export const ToolMessageSchema = z.object({
  role: z.literal("tool"),
  toolCallId: z.string(),
  toolName: z.string(),
  /** JSON-serialised result. */
  content: z.string(),
  isError: z.boolean().optional(),
});
export type ToolMessage = z.infer<typeof ToolMessageSchema>;

export const MessageSchema = z.discriminatedUnion("role", [
  SystemMessageSchema,
  UserMessageSchema,
  AssistantMessageSchema,
  ToolMessageSchema,
]);
export type Message = z.infer<typeof MessageSchema>;

import { z } from "zod";
import { ToolCallSchema } from "./tools.js";

export const SystemMessageSchema = z.object({
  role: z.literal("system"),
  content: z.string(),
});
export type SystemMessage = z.infer<typeof SystemMessageSchema>;

export const TextPartSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
});
export type TextPart = z.infer<typeof TextPartSchema>;

/** `data:image/<subtype>;base64,<data>`: the only data URL an image may use. */
const IMAGE_DATA_URL = /^data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/]+={0,2}$/;

/** An `http:` or `https:` URL, or an image data URL. Nothing else may name an image. */
function isAllowedImageUrl(value: string): boolean {
  if (IMAGE_DATA_URL.test(value)) return true;
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

export const ImagePartSchema = z.object({
  type: z.literal("image"),
  url: z.string().refine(isAllowedImageUrl, {
    message: "the image URL is not allowed: use an http(s) URL or data:image/<type>;base64,<data>",
  }),
});
export type ImagePart = z.infer<typeof ImagePartSchema>;

export const UserContentPartSchema = z.discriminatedUnion("type", [TextPartSchema, ImagePartSchema]);
export type UserContentPart = z.infer<typeof UserContentPartSchema>;

export const UserMessageSchema = z.object({
  role: z.literal("user"),
  /** Plain text, or a non-empty list of text and image parts. */
  content: z.union([z.string(), z.array(UserContentPartSchema).min(1)]),
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

/** A user message's text: a string as is, or a list's text parts joined by a newline, images left out. */
export function messageText(content: UserMessage["content"]): string {
  if (typeof content === "string") return content;
  return content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
}

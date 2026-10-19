import { describe, expect, it } from "vitest";
import {
  ImagePartSchema,
  MessageSchema,
  TextPartSchema,
  TurnCallSchema,
  UserContentPartSchema,
  UserMessageSchema,
  messageText,
} from "../src/index.js";

const text = (value: string) => ({ type: "text" as const, text: value });
const image = (url: string) => ({ type: "image" as const, url });

const png = "data:image/png;base64,iVBORw0KGgo=";

describe("content parts", () => {
  it("parses a text part and an image part", () => {
    expect(TextPartSchema.parse(text("hi"))).toEqual(text("hi"));
    expect(ImagePartSchema.parse(image("https://example.com/a.png"))).toEqual(image("https://example.com/a.png"));
  });

  it("tells the two parts apart by type", () => {
    expect(UserContentPartSchema.parse(text("hi"))).toEqual(text("hi"));
    expect(UserContentPartSchema.parse(image(png))).toEqual(image(png));
    expect(UserContentPartSchema.safeParse({ type: "audio", url: png }).success).toBe(false);
    expect(UserContentPartSchema.safeParse({ type: "text", url: png }).success).toBe(false);
    expect(UserContentPartSchema.safeParse({ type: "image", text: "hi" }).success).toBe(false);
  });
});

describe("UserMessageSchema content", () => {
  it("still parses a string content", () => {
    const message = { role: "user", content: "hi" };
    expect(UserMessageSchema.parse(message)).toEqual(message);
    expect(MessageSchema.parse(message)).toEqual(message);
  });

  it("parses one text part and one image part, unchanged", () => {
    const message = { role: "user", content: [text("what is this?"), image(png)] };
    const parsed = UserMessageSchema.safeParse(message);
    expect(parsed.success).toBe(true);
    expect(parsed.data?.content).toEqual(message.content);
    expect(MessageSchema.parse(message)).toEqual(message);
  });

  it("parses a message with a single image part only", () => {
    const message = { role: "user", content: [image("https://example.com/a.png")] };
    const parsed = UserMessageSchema.safeParse(message);
    expect(parsed.success).toBe(true);
    expect(parsed.data?.content).toEqual(message.content);
  });

  it("rejects an empty parts array", () => {
    expect(UserMessageSchema.safeParse({ role: "user", content: [] }).success).toBe(false);
    expect(MessageSchema.safeParse({ role: "user", content: [] }).success).toBe(false);
  });

  it("rejects an array holding something that is not a part", () => {
    expect(UserMessageSchema.safeParse({ role: "user", content: ["hi"] }).success).toBe(false);
    expect(UserMessageSchema.safeParse({ role: "user", content: [{ type: "audio", url: png }] }).success).toBe(false);
  });

  it("rejects a message holding a part whose image url is not allowed", () => {
    expect(UserMessageSchema.safeParse({ role: "user", content: [text("x"), image("javascript:alert(1)")] }).success).toBe(
      false,
    );
  });
});

describe("image url", () => {
  it.each([
    "https://example.com/a.png",
    "http://example.com/a.png",
    "data:image/png;base64,iVBORw0KGgo=",
    "data:image/svg+xml;base64,PHN2Zz4=",
  ])("accepts %s", (url) => {
    const parsed = ImagePartSchema.safeParse(image(url));
    expect(parsed.success).toBe(true);
    expect(parsed.data).toEqual(image(url));
    expect(UserMessageSchema.safeParse({ role: "user", content: [image(url)] }).success).toBe(true);
  });

  it.each([
    "data:text/plain;base64,aGk=",
    "data:image/png,raw",
    "data:image/png;base64,***",
    "javascript:alert(1)",
    "ftp://example.com/a.png",
    "/a.png",
  ])("rejects %s", (url) => {
    expect(ImagePartSchema.safeParse(image(url)).success).toBe(false);
    expect(UserContentPartSchema.safeParse(image(url)).success).toBe(false);
    expect(UserMessageSchema.safeParse({ role: "user", content: [image(url)] }).success).toBe(false);
  });

  it("says the url is not allowed", () => {
    for (const url of ["javascript:alert(1)", "data:text/plain;base64,aGk=", "/a.png"]) {
      const parsed = ImagePartSchema.safeParse(image(url));
      expect(parsed.success, url).toBe(false);
      expect(
        parsed.error?.issues.some((issue) => /not allowed/i.test(issue.message)),
        url,
      ).toBe(true);
    }
  });

  it("says the url is not allowed when the image sits in a user message", () => {
    const parsed = UserMessageSchema.safeParse({ role: "user", content: [image("ftp://example.com/a.png")] });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.some((issue) => /not allowed/i.test(issue.message))).toBe(true);
  });
});

describe("other roles keep string content", () => {
  const parts = [text("x")];
  const messages = {
    system: { role: "system" },
    assistant: { role: "assistant" },
    tool: { role: "tool", toolCallId: "c1", toolName: "search" },
  };

  it.each(Object.keys(messages) as (keyof typeof messages)[])("rejects array content on a %s message", (role) => {
    const base = messages[role];
    // the same message with string content is valid, so the array is the only reason for the failure
    expect(MessageSchema.safeParse({ ...base, content: "x" }).success).toBe(true);
    expect(MessageSchema.safeParse({ ...base, content: parts }).success).toBe(false);
  });
});

describe("messageText", () => {
  it("returns a string content as is", () => {
    expect(messageText("hello")).toBe("hello");
    expect(messageText("")).toBe("");
    expect(messageText("a\nb  ")).toBe("a\nb  ");
  });

  it("joins the text parts with a newline", () => {
    expect(messageText([text("a"), text("b")])).toBe("a\nb");
    expect(messageText([text("a")])).toBe("a");
  });

  it("leaves the images out", () => {
    expect(messageText([text("a"), image(png), text("b")])).toBe("a\nb");
    expect(messageText([image(png), text("a")])).toBe("a");
    expect(messageText([text("a"), image(png)])).toBe("a");
  });

  it("returns an empty string for an image-only array", () => {
    expect(messageText([image(png)])).toBe("");
    expect(messageText([image(png), image("https://example.com/a.png")])).toBe("");
  });
});

describe("TurnCallSchema", () => {
  it("accepts a call whose user message carries a text part and an image part", () => {
    const messages = [{ role: "user", content: [text("what is this?"), image(png)] }];
    const parsed = TurnCallSchema.safeParse({ messages });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.messages).toEqual(messages);
  });

  it("rejects a call whose user message carries an image that is not allowed", () => {
    const messages = [{ role: "user", content: [text("x"), image("javascript:alert(1)")] }];
    expect(TurnCallSchema.safeParse({ messages }).success).toBe(false);
  });
});

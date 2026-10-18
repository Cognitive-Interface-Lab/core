import { CoreError, TurnEventSchema, type TurnEvent } from "@core/contracts";

/**
 * Reads the server-sent events of one turn and yields its `turn` events in order. The stream ends
 * after `turn-finish` or when the body ends. Leaving the loop early cancels the body.
 */
export async function* parseTurnStream(body: ReadableStream<Uint8Array>): AsyncIterable<TurnEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let eventName = "";
  let dataLines: string[] = [];
  let finished = false;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) {
        finished = true;
        pending += decoder.decode();
      } else {
        pending += decoder.decode(chunk.value, { stream: true });
      }
      const { lines, rest } = splitLines(pending, chunk.done);
      pending = rest;
      for (const line of lines) {
        if (line === "") {
          const event = dispatch(eventName, dataLines);
          eventName = "";
          dataLines = [];
          if (event !== undefined) {
            yield event;
            if (event.type === "turn-finish") return;
          }
        } else if (!line.startsWith(":")) {
          const colon = line.indexOf(":");
          const field = colon === -1 ? line : line.slice(0, colon);
          const value = colon === -1 ? "" : stripSpace(line.slice(colon + 1));
          if (field === "event") eventName = value;
          else if (field === "data") dataLines.push(value);
        }
      }
      if (chunk.done) return;
    }
  } finally {
    // A failed body has already errored: its error is the one to report, not the cancel's.
    if (!finished) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/**
 * Splits `text` at every line end (`\n`, `\r\n` or `\r`) and returns the rest after the last one.
 * A `\r` at the very end may be the first half of a CRLF, so it waits for the next chunk unless `eof`.
 */
function splitLines(text: string, eof: boolean): { lines: string[]; rest: string } {
  const lines: string[] = [];
  let start = 0;
  let i = 0;
  while (i < text.length) {
    const char = text[i];
    if (char === "\r" && i === text.length - 1 && !eof) break;
    if (char === "\r" || char === "\n") {
      lines.push(text.slice(start, i));
      if (char === "\r" && text[i + 1] === "\n") i++;
      start = i + 1;
    }
    i++;
  }
  return { lines, rest: text.slice(start) };
}

/** A field value without the single space that may follow its colon. */
function stripSpace(value: string): string {
  return value.startsWith(" ") ? value.slice(1) : value;
}

/** The turn event a dispatched SSE event carries, or undefined for any event that is not `turn`. */
function dispatch(name: string, dataLines: string[]): TurnEvent | undefined {
  if (name !== "turn" || dataLines.length === 0) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(dataLines.join("\n"));
  } catch {
    throw new CoreError("unknown", "unexpected answer from core");
  }
  const parsed = TurnEventSchema.safeParse(json);
  if (!parsed.success) throw new CoreError("unknown", "unexpected answer from core");
  return parsed.data;
}

import { TurnCallSchema, type TurnEvent } from "@core/contracts";
import { runTurn } from "@core/runtime";
import { ToolRegistry } from "@core/tools";
import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import type { CoreEnv, RouteModule } from "../handler.js";

/** A comment line this often, so proxies and clients see the stream is alive while the model works. */
const KEEP_ALIVE_MS = 15_000;

export const turns: RouteModule = {
  specs: [
    {
      method: "POST",
      path: "/v1/turns",
      summary: "A whole turn, streamed as server-sent events",
      body: "TurnCall",
      answer: "TurnEvent stream",
    },
  ],

  register(app, deps) {
    app.post("/v1/turns", async (c) => {
      // Read and resolve before the stream starts, so a bad request still answers as JSON.
      const call = await deps.body(c, TurnCallSchema);
      const { router, route } = await deps.model(c, call);

      const events = runTurn({
        router,
        route,
        tools: new ToolRegistry(),
        channel: deps.principal(c).channel,
        messages: call.messages,
        ...(call.clientTools !== undefined && { clientTools: call.clientTools }),
        ...(call.budget !== undefined && { budget: call.budget }),
        ...(call.maxOutputTokens !== undefined && { maxOutputTokens: call.maxOutputTokens }),
        ...(call.temperature !== undefined && { temperature: call.temperature }),
        signal: c.req.raw.signal,
      });
      return turnStream(c, events);
    });
  },
};

/**
 * Writes each event as an SSE `turn` event, then closes. A keep-alive comment goes out every
 * KEEP_ALIVE_MS while waiting. A client that has gone stops the loop; the caller's signal is what
 * ends the turn itself. Hono's writes swallow a closed socket, so nothing throws out of them.
 */
export function turnStream(c: Context<CoreEnv>, events: AsyncIterable<TurnEvent>): Response {
  return streamSSE(c, async (stream) => {
    const keepAlive = setInterval(() => {
      void stream.write(": keep-alive\n\n");
    }, KEEP_ALIVE_MS);
    stream.onAbort(() => clearInterval(keepAlive));
    try {
      for await (const event of events) {
        if (stream.aborted) break;
        await stream.writeSSE({ event: "turn", data: JSON.stringify(event) });
      }
    } catch {
      // runTurn never throws, and the server logs nothing: the stream simply ends.
    } finally {
      clearInterval(keepAlive);
    }
  });
}

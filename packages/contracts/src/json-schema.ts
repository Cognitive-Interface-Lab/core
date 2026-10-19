import { z } from "zod";
import * as errors from "./errors.js";
import * as graphEvents from "./graph-events.js";
import * as graphState from "./graph-state.js";
import * as messages from "./messages.js";
import * as models from "./models.js";
import * as server from "./server.js";
import * as stream from "./stream.js";
import * as tools from "./tools.js";
import * as turn from "./turn.js";

const SCHEMA_MODULES: Record<string, unknown>[] = [
  errors,
  tools,
  messages,
  models,
  stream,
  turn,
  graphEvents,
  graphState,
  server,
];

/** JSON Schema for every exported `XxxSchema`, keyed by type name (`Message`, `ChatRequest`, ...). */
export function toJsonSchemas(): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const mod of SCHEMA_MODULES) {
    for (const [name, value] of Object.entries(mod)) {
      if (name.endsWith("Schema") && value instanceof z.ZodType) {
        result[name.slice(0, -"Schema".length)] = z.toJSONSchema(value);
      }
    }
  }
  return result;
}

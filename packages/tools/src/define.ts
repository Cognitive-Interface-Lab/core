import { CoreError, type ToolPolicy } from "@core/contracts";
import { z } from "zod";
import type { RegisteredTool, ToolContext } from "./registry.js";

/**
 * Declares a local tool in one place: the zod `input` gives the JSON Schema the model sees and
 * the validated, typed arguments the handler receives. Invalid arguments throw `bad_request`,
 * which `ToolRegistry.call` turns into a result the model can read. The definition and policy
 * are validated when the tool is registered.
 */
export function defineTool<S extends z.ZodObject>(spec: {
  name: string;
  description: string;
  input: S;
  /** Required: the author decides which channels may call the tool and whether it has side effects. */
  policy: ToolPolicy;
  handler: (args: z.infer<S>, ctx: ToolContext) => unknown | Promise<unknown>;
}): RegisteredTool {
  const inputSchema: Record<string, unknown> = { ...z.toJSONSchema(spec.input) };
  delete inputSchema["$schema"];
  return {
    definition: { name: spec.name, description: spec.description, inputSchema },
    policy: spec.policy,
    source: "local",
    handler: async (args, ctx) => {
      const parsed = spec.input.safeParse(args);
      if (!parsed.success) {
        const issues = parsed.error.issues
          .map((issue) => `${issue.path.map(String).join(".") || "(root)"}: ${issue.message}`)
          .join("; ");
        throw new CoreError("bad_request", `invalid arguments for "${spec.name}": ${issues}`);
      }
      return spec.handler(parsed.data, ctx);
    },
  };
}

import { CoreError } from "@core/contracts";
import { z } from "zod";

/**
 * Converts a Zod schema to a JSON Schema record suitable for model output validation.
 * Removes the `$schema` key that `z.toJSONSchema` includes.
 */
export function outputSchemaFrom(schema: z.ZodType): Record<string, unknown> {
  const result: Record<string, unknown> = { ...z.toJSONSchema(schema, { io: "output" }) };
  delete result["$schema"];
  return result;
}

/**
 * Parses and validates structured output from a model against a JSON Schema.
 * Strips optional markdown code fence (```json ... ``` or ``` ... ```) before parsing.
 * Throws `CoreError` with code "unknown" on invalid JSON or schema mismatch.
 */
export function parseStructuredOutput(outputSchema: Record<string, unknown>, text: string): unknown {
  let json = text.trim();

  // Strip optional markdown code fence
  const jsonFenceMatch = json.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (jsonFenceMatch) {
    json = jsonFenceMatch[1]!;
  }

  // Parse JSON
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new CoreError("unknown", "structured output is not valid JSON");
  }

  // Validate with zod
  const schema = z.fromJSONSchema(outputSchema);
  const result = schema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.map(String).join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new CoreError("unknown", `structured output does not match outputSchema: ${issues}`);
  }

  return result.data;
}

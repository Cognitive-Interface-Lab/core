import { CoreError, type FinishReason } from "@core/contracts";
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

const CUT_OFF_MESSAGE = 'structured output was cut off at the output-token limit (finish reason "length")';

/**
 * Parses and validates structured output from a model against a JSON Schema.
 * Strips optional markdown code fence (```json ... ``` or ``` ... ```) before parsing.
 * Throws `CoreError` with code "unknown" on invalid JSON or schema mismatch.
 *
 * When the text fails to parse or to match and the provider finished with `"length"`, the reply was
 * cut off at the output-token limit: the error then says so and carries `details.finishReason`, for
 * both failure kinds. Text that parses and matches is returned whatever the finish reason, and any
 * other (or no) finish reason keeps the invalid-JSON and mismatch messages.
 */
export function parseStructuredOutput(
  outputSchema: Record<string, unknown>,
  text: string,
  finishReason?: FinishReason,
): unknown {
  const fail = (message: string): CoreError =>
    finishReason === "length"
      ? new CoreError("unknown", CUT_OFF_MESSAGE, { details: { finishReason } })
      : new CoreError("unknown", message);

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
    throw fail("structured output is not valid JSON");
  }

  // Validate with zod
  const schema = z.fromJSONSchema(outputSchema);
  const result = schema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.map(String).join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw fail(`structured output does not match outputSchema: ${issues}`);
  }

  return result.data;
}

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { CoreError } from "@core/contracts";
import { outputSchemaFrom, parseStructuredOutput } from "../src/index.js";

const PersonSchema = z.object({
  name: z.string(),
  age: z.number().int().optional(),
  tags: z.array(z.string()),
  kind: z.enum(["a", "b"]),
  nested: z.object({ ok: z.boolean() }),
});

const valid = { name: "Ada", age: 36, tags: ["x", "y"], kind: "a" as const, nested: { ok: true } };
const outputSchema = outputSchemaFrom(PersonSchema);

function caught(run: () => unknown): CoreError {
  try {
    run();
  } catch (error) {
    expect(CoreError.is(error)).toBe(true);
    return error as CoreError;
  }
  throw new Error("expected the call to throw");
}

describe("outputSchemaFrom", () => {
  it("returns an object JSON Schema with properties and required keys, without $schema", () => {
    expect(outputSchema.type).toBe("object");
    expect(Object.keys(outputSchema.properties as Record<string, unknown>).sort()).toEqual(
      ["age", "kind", "name", "nested", "tags"],
    );
    const required = outputSchema.required as string[];
    expect([...required].sort()).toEqual(["kind", "name", "nested", "tags"]);
    expect(required).not.toContain("age");
    expect("$schema" in outputSchema).toBe(false);
  });
});

describe("parseStructuredOutput", () => {
  it("returns the parsed value for valid JSON text", () => {
    expect(parseStructuredOutput(outputSchema, JSON.stringify(valid))).toEqual(valid);
  });

  it("accepts a ```json fenced block", () => {
    const text = "```json\n" + JSON.stringify(valid, null, 2) + "\n```";
    expect(parseStructuredOutput(outputSchema, text)).toEqual(valid);
  });

  it("accepts a bare ``` fenced block", () => {
    const text = "```\n" + JSON.stringify(valid) + "\n```";
    expect(parseStructuredOutput(outputSchema, text)).toEqual(valid);
  });

  it("parses when optional fields are omitted", () => {
    const withoutAge: Record<string, unknown> = { ...valid };
    delete withoutAge.age;
    expect(parseStructuredOutput(outputSchema, JSON.stringify(withoutAge))).toEqual(withoutAge);
  });

  it("round-trips a value through outputSchemaFrom", () => {
    const schema = outputSchemaFrom(PersonSchema);
    expect(parseStructuredOutput(schema, JSON.stringify(valid))).toEqual(valid);
  });

  it("throws CoreError unknown for non-JSON text without leaking the text", () => {
    const error = caught(() => parseStructuredOutput(outputSchema, "this is SECRET-RAW-TEXT, not json"));
    expect(error.code).toBe("unknown");
    expect(error.message).toBe("structured output is not valid JSON");
    expect(error.message).not.toContain("SECRET-RAW-TEXT");
  });

  describe("schema mismatch", () => {
    const prefix = "structured output does not match outputSchema:";
    const marker = "SECRET-MARKER-VALUE";

    const missingTags: Record<string, unknown> = { ...valid, name: marker };
    delete missingTags.tags;

    const cases: Array<[string, unknown]> = [
      ["wrong type for a field", { ...valid, name: { leak: marker } }],
      ["missing required field", missingTags],
      ["value outside the enum", { ...valid, kind: marker }],
    ];

    it.each(cases)("rejects %s", (_label, value) => {
      const error = caught(() => parseStructuredOutput(outputSchema, JSON.stringify(value)));
      expect(error.code).toBe("unknown");
      expect(error.message.startsWith(prefix)).toBe(true);
      expect(error.message).not.toContain(marker);
    });
  });
});

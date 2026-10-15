import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseMaxOutputTokens, parseTimeout, readSchemaFile, readSystemFile } from "../src/ask-input.js";
import { UsageError } from "../src/run.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "core-ask-input-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function file(name: string, content: string): string {
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

/** The usage error a call throws, so its message can be checked. */
async function usageError(call: () => unknown): Promise<UsageError> {
  try {
    await call();
  } catch (error) {
    expect(error).toBeInstanceOf(UsageError);
    return error as UsageError;
  }
  throw new Error("expected a usage error");
}

describe("readSystemFile", () => {
  it("returns the file as is, whitespace included", async () => {
    const content = "  You are terse.\n\nAnswer in one line.\n";
    expect(await readSystemFile(file("system.txt", content))).toBe(content);
  });

  it("reads UTF-8", async () => {
    expect(await readSystemFile(file("system.txt", "Antwort: grüße 你好 🚀"))).toBe("Antwort: grüße 你好 🚀");
  });

  it("is a usage error naming the option and the path when the file is missing", async () => {
    const path = join(dir, "absent.txt");
    const error = await usageError(() => readSystemFile(path));
    expect(error.message).toContain("--system-file");
    expect(error.message).toContain(path);
  });

  it("is a usage error when the path is a directory", async () => {
    const path = join(dir, "folder");
    mkdirSync(path);
    const error = await usageError(() => readSystemFile(path));
    expect(error.message).toContain("--system-file");
    expect(error.message).toContain(path);
  });

  it.each([
    ["an empty file", ""],
    ["only spaces", "   "],
    ["only line breaks and tabs", "\n\t\r\n"],
  ])("is a usage error for %s", async (_name, content) => {
    const path = file("system.txt", content);
    const error = await usageError(() => readSystemFile(path));
    expect(error.message).toContain("--system-file");
    expect(error.message).toContain(path);
  });
});

describe("readSchemaFile", () => {
  it("returns the JSON object", async () => {
    const schema = { type: "object", properties: { answer: { type: "number" } }, required: ["answer"] };
    expect(await readSchemaFile(file("schema.json", JSON.stringify(schema)))).toEqual(schema);
  });

  it("accepts an empty object", async () => {
    expect(await readSchemaFile(file("schema.json", "{}"))).toEqual({});
  });

  it("accepts pretty-printed JSON with surrounding whitespace", async () => {
    expect(await readSchemaFile(file("schema.json", '\n  {\n    "type": "string"\n  }\n'))).toEqual({ type: "string" });
  });

  it("is a usage error naming the option and the path when the file is missing", async () => {
    const path = join(dir, "absent.json");
    const error = await usageError(() => readSchemaFile(path));
    expect(error.message).toContain("--schema");
    expect(error.message).toContain(path);
  });

  it("is a usage error when the path is a directory", async () => {
    const path = join(dir, "folder");
    mkdirSync(path);
    const error = await usageError(() => readSchemaFile(path));
    expect(error.message).toContain("--schema");
    expect(error.message).toContain(path);
  });

  it.each([
    ["text", "not json at all"],
    ["truncated JSON", '{"type": "object", '],
    ["an empty file", ""],
    ["JSON with a trailing comma", '{"type": "object",}'],
  ])("is a usage error for %s", async (_name, content) => {
    const path = file("schema.json", content);
    const error = await usageError(() => readSchemaFile(path));
    expect(error.message).toContain("--schema");
    expect(error.message).toContain(path);
  });

  it.each([
    ["an array", "[1, 2]"],
    ["null", "null"],
    ["a string", '"object"'],
    ["a number", "42"],
    ["a boolean", "true"],
  ])("is a usage error for JSON that is %s, not an object", async (_name, content) => {
    const path = file("schema.json", content);
    const error = await usageError(() => readSchemaFile(path));
    expect(error.message).toContain("--schema");
    expect(error.message).toContain(path);
  });
});

describe("error messages never contain the file's contents", () => {
  // Short and at the start of each file: a parser quotes only the first characters of what it rejects.
  const SECRET = "SECRET";

  it.each([
    ["a schema that is not JSON", () => readSchemaFile(file("a.json", `{ ${SECRET}`))],
    ["a schema that is a JSON string", () => readSchemaFile(file("b.json", JSON.stringify(SECRET)))],
    ["a schema that is a JSON array", () => readSchemaFile(file("c.json", JSON.stringify([SECRET])))],
    ["a schema whose parse error would quote the input", () => readSchemaFile(file("d.json", `${SECRET} {"a": 1}`))],
  ])("%s", async (_name, call) => {
    const error = await usageError(call);
    expect(error.message).not.toContain(SECRET);
  });
});

describe("parseTimeout", () => {
  it.each([
    ["1", 1],
    ["250", 250],
    ["30000", 30_000],
    ["007", 7],
    [String(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER],
  ])("accepts %s", (value, expected) => {
    expect(parseTimeout(value)).toBe(expected);
  });

  it.each([
    ["an empty string", ""],
    ["zero", "0"],
    ["only zeros", "000"],
    ["a negative number", "-1"],
    ["a fraction", "1.5"],
    ["an exponent", "1e3"],
    ["a unit", "10ms"],
    ["a leading plus", "+5"],
    ["surrounding spaces", " 5 "],
    ["hexadecimal", "0x10"],
    ["a word", "abc"],
    ["Infinity", "Infinity"],
    ["an integer too large to be exact", "9007199254740993"],
  ])("is a usage error for %s", (_name, value) => {
    expect(() => parseTimeout(value)).toThrow(UsageError);
    try {
      parseTimeout(value);
    } catch (error) {
      expect((error as Error).message).toContain("--timeout");
    }
  });
});

describe("parseMaxOutputTokens", () => {
  it.each([
    ["1", 1],
    ["8192", 8192],
  ])("accepts %s", (value, expected) => {
    expect(parseMaxOutputTokens(value)).toBe(expected);
  });

  it.each([
    ["zero", "0"],
    ["a negative number", "-1"],
    ["a word", "abc"],
    ["a fraction", "1.5"],
    ["an exponent", "1e3"],
    ["an empty string", ""],
    ["a value above Number.MAX_SAFE_INTEGER", String(Number.MAX_SAFE_INTEGER + 2)],
  ])("is a usage error naming the option for %s", (_name, value) => {
    expect(() => parseMaxOutputTokens(value)).toThrow(UsageError);
    try {
      parseMaxOutputTokens(value);
    } catch (error) {
      expect((error as Error).message).toContain("--max-output-tokens");
    }
  });
});

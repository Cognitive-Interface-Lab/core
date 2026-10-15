import { readFile } from "node:fs/promises";
import { UsageError } from "./run.js";

/**
 * The values of `core ask`'s file and number options, read and checked. Every failure is a usage
 * error that names the option and the path; it never repeats what the file contains, because a
 * system prompt or a schema may hold text the caller does not want in an error message.
 */

/** The `--system-file` text, as is. A missing, unreadable or whitespace-only file is a usage error. */
export async function readSystemFile(path: string): Promise<string> {
  const text = await readText("--system-file", path);
  if (text.trim() === "") throw new UsageError(`--system-file ${path}: the file is empty`);
  return text;
}

/** The `--schema` file as a JSON Schema object. A missing file, invalid JSON or a non-object is a usage error. */
export async function readSchemaFile(path: string): Promise<Record<string, unknown>> {
  const text = await readText("--schema", path);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    // The parser's message quotes part of the input, so it is not passed on.
    throw new UsageError(`--schema ${path}: the file is not valid JSON`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new UsageError(`--schema ${path}: the file must contain a JSON object`);
  }
  return value as Record<string, unknown>;
}

/** The `--timeout` value in milliseconds: a positive safe integer written in decimal digits only. */
export function parseTimeout(value: string): number {
  const ms = /^[0-9]+$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(ms) || ms <= 0) {
    throw new UsageError(`--timeout must be a positive whole number of milliseconds, got "${value}"`);
  }
  return ms;
}

async function readText(option: string, path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    throw new UsageError(`${option} ${path}: ${readFailure(error)}`);
  }
}

function readFailure(error: unknown): string {
  const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : undefined;
  if (code === "ENOENT") return "no such file";
  if (code === "EISDIR") return "is a directory, not a file";
  return code === undefined ? "the file cannot be read" : `the file cannot be read (${code})`;
}

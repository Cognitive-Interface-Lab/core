import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CoreError, parseModelRef, type ModelRef } from "@core/contracts";
import { z } from "zod";

/** Choices that are not secret. CLI-local, so it stays out of `@core/contracts`. */
export const ConfigSchema = z
  .object({
    route: z.array(z.string().min(1)).min(1).optional(),
    timeoutMs: z.number().int().positive().optional(),
    cloudflare: z.object({ oauthClientId: z.string().min(1).optional() }).strict().optional(),
  })
  .strict();
export type Config = z.infer<typeof ConfigSchema>;

const NO_MODEL_MESSAGE =
  'no model chosen: pass --model, set CORE_ROUTE, or run "core config set route <provider:model,...>"';

export function configPath(dir: string): string {
  return join(dir, "config.json");
}

/** A missing file is `{}`. */
export async function loadConfig(dir: string): Promise<Config> {
  const path = configPath(dir);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return {};
    throw new CoreError("unavailable", `${path}: cannot be read${describeCode(error)}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new CoreError("bad_request", `${path}: not valid JSON`);
  }
  const parsed = ConfigSchema.safeParse(json);
  if (!parsed.success) throw new CoreError("bad_request", `${path}: ${firstIssue(parsed.error)}`);
  return parsed.data;
}

/** Writes pretty JSON atomically (a temporary file, then a rename) into a `0700` directory. */
export async function saveConfig(dir: string, config: Config): Promise<void> {
  const path = configPath(dir);
  const parsed = ConfigSchema.safeParse(config);
  if (!parsed.success) throw new CoreError("bad_request", `${path}: ${firstIssue(parsed.error)}`);
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(temporary, `${JSON.stringify(parsed.data, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw new CoreError("unavailable", `${path}: cannot be written${describeCode(error)}`);
  }
}

/** The models to try, in order: the `--model` flag, else `CORE_ROUTE`, else the saved route. */
export function resolveRoute(
  flag: string | undefined,
  env: Record<string, string | undefined>,
  config: Config,
): ModelRef[] {
  const entries = flag
    ? splitRoute(flag)
    : env["CORE_ROUTE"]
      ? splitRoute(env["CORE_ROUTE"])
      : (config.route ?? []);
  if (entries.length === 0) throw new CoreError("bad_request", NO_MODEL_MESSAGE);
  return entries.map((entry) => parseModelRef(entry));
}

export function splitRoute(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "invalid configuration";
  const where = issue.path.join(".");
  return where ? `${where}: ${issue.message}` : issue.message;
}

function errorCode(error: unknown): string | undefined {
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" ? code : undefined;
}

function describeCode(error: unknown): string {
  const code = errorCode(error);
  return code ? ` (${code})` : "";
}

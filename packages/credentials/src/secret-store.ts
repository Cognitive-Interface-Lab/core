import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { CoreError } from "@core/contracts";

/** Where saved secrets live. Values are opaque strings; the layers above decide what they mean. */
export interface SecretStore {
  readonly kind: "keychain" | "file" | "memory";
  /** For people: "OS keychain", the file path, or "memory". Never a secret. */
  readonly location: string;
  get(name: string): Promise<string | undefined>;
  set(name: string, value: string): Promise<void>;
  /** False when the name was absent. */
  delete(name: string): Promise<boolean>;
  /** Sorted names. */
  list(): Promise<string[]>;
}

const NAME_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;

export function assertSecretName(name: string): void {
  if (!NAME_PATTERN.test(name)) {
    throw new CoreError("bad_request", `invalid secret name "${name}": expected ${NAME_PATTERN.source}`);
  }
}

/**
 * Both stores keep their values out of reach of `JSON.stringify`, `String(store)` and
 * `console.log(store)`: they serialise to `{}`.
 */
export class MemorySecretStore implements SecretStore {
  readonly kind = "memory";
  readonly location = "memory";
  readonly #entries = new Map<string, string>();

  constructor(initial?: Record<string, string>) {
    for (const [name, value] of Object.entries(initial ?? {})) {
      assertSecretName(name);
      this.#entries.set(name, value);
    }
  }

  async get(name: string): Promise<string | undefined> {
    assertSecretName(name);
    return this.#entries.get(name);
  }

  async set(name: string, value: string): Promise<void> {
    assertSecretName(name);
    this.#entries.set(name, value);
  }

  async delete(name: string): Promise<boolean> {
    assertSecretName(name);
    return this.#entries.delete(name);
  }

  async list(): Promise<string[]> {
    return [...this.#entries.keys()].sort();
  }

  toJSON(): Record<string, never> {
    return {};
  }
}

/**
 * Secrets in one JSON file: `{ "version": 1, "secrets": { "<name>": "<value>" } }`. The directory
 * is `0700`, the file is `0600` and replaced atomically (write a temporary file, then rename), and
 * on POSIX a file that group or others can access is refused rather than used.
 */
export class FileSecretStore implements SecretStore {
  readonly kind = "file";
  readonly location: string;
  /** Serialises this instance's operations, so concurrent `set` calls cannot lose each other. */
  #queue: Promise<unknown> = Promise.resolve();

  constructor(path: string) {
    this.location = path;
  }

  async get(name: string): Promise<string | undefined> {
    assertSecretName(name);
    return this.#run(async () => (await this.#read()).get(name));
  }

  async set(name: string, value: string): Promise<void> {
    assertSecretName(name);
    return this.#run(async () => {
      const secrets = await this.#read();
      secrets.set(name, value);
      await this.#write(secrets);
    });
  }

  async delete(name: string): Promise<boolean> {
    assertSecretName(name);
    return this.#run(async () => {
      const secrets = await this.#read();
      if (!secrets.delete(name)) return false;
      await this.#write(secrets);
      return true;
    });
  }

  list(): Promise<string[]> {
    return this.#run(async () => [...(await this.#read()).keys()].sort());
  }

  toJSON(): Record<string, never> {
    return {};
  }

  #run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(task, task);
    this.#queue = result.catch(() => undefined);
    return result;
  }

  async #read(): Promise<Map<string, string>> {
    const path = this.location;
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      if (errorCode(error) === "ENOENT") return new Map();
      throw new CoreError("unavailable", `cannot read ${path}${describeCode(error)}`);
    }
    await this.#checkPermissions();
    return parseSecrets(text, path);
  }

  async #checkPermissions(): Promise<void> {
    if (process.platform === "win32") return;
    const { mode } = await stat(this.location);
    if ((mode & 0o077) !== 0) {
      throw new CoreError("auth", `${this.location} is readable by other users; run: chmod 600 ${this.location}`);
    }
  }

  async #write(secrets: Map<string, string>): Promise<void> {
    const path = this.location;
    const body = `${JSON.stringify({ version: 1, secrets: Object.fromEntries(secrets) }, null, 2)}\n`;
    const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writeFile(temporary, body, { mode: 0o600, flag: "wx" });
      await rename(temporary, path);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw new CoreError("unavailable", `cannot write ${path}${describeCode(error)}`);
    }
  }
}

function parseSecrets(text: string, path: string): Map<string, string> {
  const invalid = () => new CoreError("bad_request", `${path} is not a valid credentials file`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw invalid();
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw invalid();
  const { version, secrets } = parsed as { version?: unknown; secrets?: unknown };
  if (version !== 1 || typeof secrets !== "object" || secrets === null || Array.isArray(secrets)) throw invalid();
  const result = new Map<string, string>();
  for (const [name, value] of Object.entries(secrets)) {
    if (!NAME_PATTERN.test(name) || typeof value !== "string") throw invalid();
    result.set(name, value);
  }
  return result;
}

function errorCode(error: unknown): string | undefined {
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" ? code : undefined;
}

function describeCode(error: unknown): string {
  const code = errorCode(error);
  return code ? ` (${code})` : "";
}

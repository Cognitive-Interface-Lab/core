/** The shape of @core/credentials' SecretStore (do not import that package). */
export type TokenSecrets = {
  get(name: string): Promise<string | undefined>;
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<boolean>;
  list(): Promise<string[]>;
};

/** Secret names are `serve-token-` and 32 hex characters, so they pass SecretStore's name rule. */
const NAME_PREFIX = "serve-token-";
const TOKEN_BYTES = 32;
const encoder = new TextEncoder();

/** What is stored per origin: the origin as given, and the hex SHA-256 of its token. Never the token. */
type StoredToken = { origin: string; hash: string };

async function sha256(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text)));
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function nameFor(origin: string): Promise<string> {
  return NAME_PREFIX + toHex(await sha256(origin)).slice(0, 32);
}

/** Returns undefined for a missing, unparseable or malformed value rather than throwing. */
function parseStored(value: string | undefined): StoredToken | undefined {
  if (value === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const { origin, hash } = parsed as Record<string, unknown>;
    return typeof origin === "string" && typeof hash === "string" ? { origin, hash } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Bearer tokens for `core serve`, one per origin. Only each token's SHA-256 is stored, so a leaked
 * store does not reveal a token. `verify` reads the store on every call, so a token removed
 * elsewhere stops working at once.
 */
export class ServeTokens {
  readonly #secrets: TokenSecrets;

  constructor(secrets: TokenSecrets) {
    this.#secrets = secrets;
  }

  /** 32 random bytes, base64url without padding. Replaces the origin's earlier token, if any. */
  async issue(origin: string): Promise<string> {
    const bytes = crypto.getRandomValues(new Uint8Array(TOKEN_BYTES));
    const token = btoa(String.fromCharCode(...bytes))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const stored: StoredToken = { origin, hash: toHex(await sha256(token)) };
    await this.#secrets.set(await nameFor(origin), JSON.stringify(stored));
    return token;
  }

  /** False for an unknown origin or a wrong token. */
  async verify(origin: string, token: string): Promise<boolean> {
    const stored = parseStored(await this.#secrets.get(await nameFor(origin)));
    if (!stored || stored.origin !== origin) return false;
    return timingSafeEqual(toHex(await sha256(token)), stored.hash);
  }

  /** True when the origin had a token. */
  async forget(origin: string): Promise<boolean> {
    return this.#secrets.delete(await nameFor(origin));
  }

  /** Origins that have a token, sorted. */
  async origins(): Promise<string[]> {
    const names = (await this.#secrets.list()).filter((name) => name.startsWith(NAME_PREFIX));
    const origins: string[] = [];
    for (const name of names) {
      const stored = parseStored(await this.#secrets.get(name));
      if (stored) origins.push(stored.origin);
    }
    return origins.sort();
  }
}

/** Constant-time equality: both strings are hashed first, so neither length nor content leaks through timing. */
export async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([sha256(a), sha256(b)]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

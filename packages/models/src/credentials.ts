export type Credentials = {
  apiKey?: string;
  baseURL?: string;
  /** Account that owns the key, for providers whose address contains it (Cloudflare Workers AI). */
  accountId?: string;
  headers?: Record<string, string>;
};

export interface CredentialStore {
  get(providerId: string): Promise<Credentials | undefined>;
}

function copyCredentials(credentials: Credentials): Credentials {
  const copy: Credentials = {};
  if (credentials.apiKey !== undefined) copy.apiKey = credentials.apiKey;
  if (credentials.baseURL !== undefined) copy.baseURL = credentials.baseURL;
  if (credentials.accountId !== undefined) copy.accountId = credentials.accountId;
  if (credentials.headers !== undefined) copy.headers = { ...credentials.headers };
  return copy;
}

/**
 * Both stores keep their secrets in `#private` fields and serialise to `{}`, so a key cannot
 * leak through `JSON.stringify`, `String(store)` or `console.log(store)`.
 */
export class MemoryCredentialStore implements CredentialStore {
  readonly #entries = new Map<string, Credentials>();

  constructor(initial?: Record<string, Credentials>) {
    for (const [providerId, credentials] of Object.entries(initial ?? {})) {
      this.set(providerId, credentials);
    }
  }

  set(providerId: string, credentials: Credentials): void {
    this.#entries.set(providerId, copyCredentials(credentials));
  }

  async get(providerId: string): Promise<Credentials | undefined> {
    const credentials = this.#entries.get(providerId);
    return credentials === undefined ? undefined : copyCredentials(credentials);
  }

  toJSON(): Record<string, never> {
    return {};
  }
}

/** Reads `<prefix><ID>_API_KEY`, `_BASE_URL` and `_ACCOUNT_ID`; an empty value counts as unset. */
export class EnvCredentialStore implements CredentialStore {
  readonly #env: Record<string, string | undefined>;
  readonly #prefix: string;

  constructor(env?: Record<string, string | undefined>, prefix = "CORE_") {
    this.#env = env ?? (typeof process === "undefined" ? {} : process.env);
    this.#prefix = prefix;
  }

  async get(providerId: string): Promise<Credentials | undefined> {
    const id = providerId.toUpperCase().replace(/[^A-Z0-9]/g, "_");
    const apiKey = this.#env[`${this.#prefix}${id}_API_KEY`] || undefined;
    const baseURL = this.#env[`${this.#prefix}${id}_BASE_URL`] || undefined;
    const accountId = this.#env[`${this.#prefix}${id}_ACCOUNT_ID`] || undefined;
    if (apiKey === undefined && baseURL === undefined && accountId === undefined) return undefined;
    const credentials: Credentials = {};
    if (apiKey !== undefined) credentials.apiKey = apiKey;
    if (baseURL !== undefined) credentials.baseURL = baseURL;
    if (accountId !== undefined) credentials.accountId = accountId;
    return credentials;
  }

  toJSON(): Record<string, never> {
    return {};
  }
}

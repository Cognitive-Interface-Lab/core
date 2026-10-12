import {
  CoreError,
  StoredCredentialSchema,
  type CredentialSummary,
  type StoredCredential,
} from "@core/contracts";
import type { CredentialStore, Credentials } from "@core/models";
import type { SecretStore } from "./secret-store.js";

export type OAuthCredential = Extract<StoredCredential, { kind: "oauth" }>;
export type Refresher = (current: OAuthCredential, signal?: AbortSignal) => Promise<StoredCredential>;

const DEFAULT_REFRESH_SKEW_MS = 60_000;

/**
 * Saved sign-ins as provider credentials. Each record lives in the `SecretStore` under the provider
 * id, validated whenever it is read back. A short-lived browser sign-in is renewed shortly before
 * it expires, through the refresher registered for its provider.
 */
export class PersistentCredentialStore implements CredentialStore {
  readonly #secrets: SecretStore;
  readonly #refreshers: Record<string, Refresher>;
  readonly #clock: () => number;
  readonly #skewMs: number;
  readonly #renewals = new Map<string, Promise<StoredCredential>>();

  constructor(opts: {
    secrets: SecretStore;
    refreshers?: Record<string, Refresher>;
    clock?: () => number;
    /** Renew when the token expires within this many milliseconds. Default 60 000. */
    refreshSkewMs?: number;
  }) {
    this.#secrets = opts.secrets;
    this.#refreshers = { ...opts.refreshers };
    this.#clock = opts.clock ?? Date.now;
    this.#skewMs = opts.refreshSkewMs ?? DEFAULT_REFRESH_SKEW_MS;
  }

  /** Where the records live, for people. */
  get location(): string {
    return this.#secrets.location;
  }

  async get(providerId: string): Promise<Credentials | undefined> {
    let stored = await this.read(providerId);
    if (stored === undefined) return undefined;
    if (this.#isDue(stored)) stored = await this.#renew(providerId);
    return toCredentials(stored);
  }

  async read(providerId: string): Promise<StoredCredential | undefined> {
    const text = await this.#secrets.get(providerId);
    if (text === undefined) return undefined;
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw unreadable(providerId);
    }
    const parsed = StoredCredentialSchema.safeParse(json);
    if (!parsed.success) throw unreadable(providerId);
    return parsed.data;
  }

  async save(providerId: string, credential: StoredCredential): Promise<void> {
    const parsed = StoredCredentialSchema.safeParse(credential);
    if (!parsed.success) {
      throw new CoreError("bad_request", `${providerId}: the sign-in to save is not valid`);
    }
    await this.#secrets.set(providerId, JSON.stringify(parsed.data));
  }

  remove(providerId: string): Promise<boolean> {
    return this.#secrets.delete(providerId);
  }

  /** What may be shown to a user, sorted by provider id. Never a key or a token. */
  async list(): Promise<CredentialSummary[]> {
    const summaries: CredentialSummary[] = [];
    for (const providerId of await this.#secrets.list()) {
      const stored = await this.read(providerId);
      if (stored === undefined) continue;
      const summary: CredentialSummary = { providerId, kind: stored.kind };
      if (stored.accountId !== undefined) summary.accountId = stored.accountId;
      if (stored.kind === "oauth") summary.expiresAt = stored.expiresAt;
      summaries.push(summary);
    }
    return summaries.sort((a, b) => (a.providerId < b.providerId ? -1 : a.providerId > b.providerId ? 1 : 0));
  }

  toJSON(): Record<string, never> {
    return {};
  }

  #isDue(stored: StoredCredential): boolean {
    return stored.kind === "oauth" && stored.expiresAt - this.#clock() <= this.#skewMs;
  }

  /** Concurrent callers for one provider share a single renewal. */
  #renew(providerId: string): Promise<StoredCredential> {
    let pending = this.#renewals.get(providerId);
    if (pending === undefined) {
      pending = this.#renewOnce(providerId).finally(() => this.#renewals.delete(providerId));
      this.#renewals.set(providerId, pending);
    }
    return pending;
  }

  async #renewOnce(providerId: string): Promise<StoredCredential> {
    // Read again: a renewal that finished while this caller was waiting has already replaced the record.
    const current = await this.read(providerId);
    if (current === undefined) throw expired(providerId);
    if (current.kind !== "oauth" || !this.#isDue(current)) return current;

    const refresher = this.#refreshers[providerId];
    if (refresher === undefined) throw expired(providerId);
    let renewed: StoredCredential;
    try {
      renewed = await refresher(current);
    } catch (error) {
      // A network blip must not look like a sign-out. The underlying message is dropped: it might hold a token.
      if (CoreError.is(error) && (error.code === "unavailable" || error.code === "timeout")) {
        throw new CoreError(error.code, `${providerId}: the sign-in expired and could not be renewed right now; try again`, {
          provider: providerId,
        });
      }
      throw expired(providerId);
    }
    const parsed = StoredCredentialSchema.safeParse(renewed);
    if (!parsed.success) throw expired(providerId);
    await this.save(providerId, parsed.data);
    return parsed.data;
  }
}

/** Asks each store in turn; the first one that returns credentials wins (so put the environment first). */
export class ChainCredentialStore implements CredentialStore {
  readonly #stores: CredentialStore[];

  constructor(stores: CredentialStore[]) {
    this.#stores = [...stores];
  }

  async get(providerId: string): Promise<Credentials | undefined> {
    for (const store of this.#stores) {
      const credentials = await store.get(providerId);
      if (credentials !== undefined) return credentials;
    }
    return undefined;
  }

  toJSON(): Record<string, never> {
    return {};
  }
}

function toCredentials(stored: StoredCredential): Credentials {
  if (stored.kind === "oauth") {
    const credentials: Credentials = { apiKey: stored.accessToken };
    if (stored.accountId !== undefined) credentials.accountId = stored.accountId;
    return credentials;
  }
  const credentials: Credentials = { apiKey: stored.apiKey };
  if (stored.accountId !== undefined) credentials.accountId = stored.accountId;
  if (stored.baseURL !== undefined) credentials.baseURL = stored.baseURL;
  return credentials;
}

function unreadable(providerId: string): CoreError {
  return new CoreError("bad_request", `${providerId}: the saved sign-in is unreadable; sign in again`, {
    provider: providerId,
  });
}

function expired(providerId: string): CoreError {
  return new CoreError("auth", `${providerId}: the sign-in expired and could not be renewed; sign in again`, {
    provider: providerId,
  });
}

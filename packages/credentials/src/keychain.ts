import { join } from "node:path";
import { CoreError } from "@core/contracts";
import { FileSecretStore, assertSecretName, type SecretStore } from "./secret-store.js";

const DEFAULT_SERVICE = "core";
const PROBE_ACCOUNT = "__probe__";
const NAME_FILTER = /^[a-z][a-z0-9-]{0,63}$/;

export type KeyringEntry = {
  getPassword(): Promise<string | null>;
  setPassword(value: string): Promise<void>;
  deletePassword(): Promise<boolean>;
};

/** The seam tests replace; tests never touch the real keychain. */
export type KeyringBackend = {
  /** May throw when no keychain is available. */
  entry(service: string, account: string): KeyringEntry;
  /** Account names stored under the service. */
  find(service: string): Promise<string[]>;
};

/**
 * The OS keychain through `@napi-rs/keyring`. On Linux the entry is pinned to the Secret Service:
 * left to itself the library silently falls back to the kernel keyring, which is lost on reboot.
 * Pinned, the constructor throws when no Secret Service is running, and the caller falls back to a file.
 */
export async function nativeKeyringBackend(): Promise<KeyringBackend> {
  let keyring: typeof import("@napi-rs/keyring");
  try {
    keyring = await import("@napi-rs/keyring");
  } catch {
    throw new CoreError("unavailable", "OS keychain is not available on this platform");
  }
  return {
    entry: (service, account) => {
      const entry = new keyring.AsyncEntry(service, account, { linux: { store: "secret-service" } });
      return {
        getPassword: () => entry.getPassword(),
        setPassword: (value) => entry.setPassword(value),
        deletePassword: () => entry.deletePassword(),
      };
    },
    find: async (service) => (await keyring.findCredentialsAsync(service)).map((credential) => credential.account),
  };
}

/** One keychain entry per name (service `core`, account = name). */
export class KeychainSecretStore implements SecretStore {
  readonly kind = "keychain";
  readonly location = "OS keychain";
  readonly #service: string;
  #backend: Promise<KeyringBackend> | undefined;

  constructor(opts?: { service?: string; backend?: KeyringBackend }) {
    this.#service = opts?.service ?? DEFAULT_SERVICE;
    if (opts?.backend) this.#backend = Promise.resolve(opts.backend);
  }

  /** True when the keychain answers. Only reads; never writes. */
  static async probe(backend?: KeyringBackend): Promise<boolean> {
    try {
      const resolved = backend ?? (await nativeKeyringBackend());
      await resolved.entry(DEFAULT_SERVICE, PROBE_ACCOUNT).getPassword();
      return true;
    } catch {
      return false;
    }
  }

  async get(name: string): Promise<string | undefined> {
    assertSecretName(name);
    return this.#use(async (backend) => (await backend.entry(this.#service, name).getPassword()) ?? undefined);
  }

  async set(name: string, value: string): Promise<void> {
    assertSecretName(name);
    await this.#use((backend) => backend.entry(this.#service, name).setPassword(value));
  }

  async delete(name: string): Promise<boolean> {
    assertSecretName(name);
    return this.#use((backend) => backend.entry(this.#service, name).deletePassword());
  }

  async list(): Promise<string[]> {
    return this.#use(async (backend) =>
      [...new Set(await backend.find(this.#service))].filter((name) => NAME_FILTER.test(name)).sort(),
    );
  }

  toJSON(): Record<string, never> {
    return {};
  }

  async #use<T>(action: (backend: KeyringBackend) => Promise<T>): Promise<T> {
    try {
      this.#backend ??= nativeKeyringBackend();
      return await action(await this.#backend);
    } catch (error) {
      if (CoreError.is(error)) throw error;
      const message = error instanceof Error ? error.message : "unexpected failure";
      throw new CoreError("unavailable", `OS keychain: ${message}`);
    }
  }
}

/**
 * Picks where secrets live. `auto` (the default) prefers the OS keychain and otherwise saves to
 * `<configDir>/credentials.json`, saying so through `warn`; `keychain` and `file` force one store.
 */
export async function openSecretStore(opts: {
  configDir: string;
  mode?: "auto" | "keychain" | "file";
  backend?: KeyringBackend;
  warn?: (message: string) => void;
}): Promise<SecretStore> {
  const mode = opts.mode ?? "auto";
  const filePath = join(opts.configDir, "credentials.json");
  if (mode === "file") return new FileSecretStore(filePath);

  const available = await KeychainSecretStore.probe(opts.backend);
  if (available) return new KeychainSecretStore(opts.backend ? { backend: opts.backend } : undefined);
  if (mode === "keychain") {
    throw new CoreError("unavailable", "OS keychain is not available on this machine");
  }
  opts.warn?.(`No OS keychain found; saving credentials to ${filePath} (readable only by you)`);
  return new FileSecretStore(filePath);
}

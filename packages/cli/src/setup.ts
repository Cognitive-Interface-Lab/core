import {
  ChainCredentialStore,
  PersistentCredentialStore,
  cloudflareRefresher,
} from "@core/credentials";
import {
  EnvCredentialStore,
  MockProvider,
  ModelRouter,
  OpenAICompatibleProvider,
  PRESETS,
  ProviderRegistry,
  type CredentialStore,
} from "@core/models";
import type { Config } from "./config.js";
import type { Io } from "./run.js";

export type Gateway = {
  registry: ProviderRegistry;
  router: ModelRouter;
  /** Saved sign-ins. */
  store: PersistentCredentialStore;
  /** Environment variables first, then the saved sign-ins. */
  credentials: CredentialStore;
  /** Every preset provider id, sorted. */
  providers: string[];
};

const ENV_PREFIX = "CORE_";

/** Everything a command needs: all presets registered, credentials resolved, Cloudflare renewal wired in. */
export async function openGateway(io: Io, config: Config): Promise<Gateway> {
  const store = new PersistentCredentialStore({
    secrets: await io.openSecrets(),
    refreshers: { cloudflare: cloudflareRefresher({ fetch: io.fetch }) },
  });
  const credentials = new ChainCredentialStore([new EnvCredentialStore(io.env), store]);

  const registry = new ProviderRegistry();
  registry.register(new MockProvider({ id: "mock" }));
  const providers = Object.keys(PRESETS).sort();
  for (const id of providers) registry.register(makeProvider(id, credentials, io));

  const router = new ModelRouter(
    registry,
    config.timeoutMs === undefined ? undefined : { defaultTimeoutMs: config.timeoutMs },
  );
  return { registry, router, store, credentials, providers };
}

export function makeProvider(id: string, credentials: CredentialStore, io: Io): OpenAICompatibleProvider {
  const preset = PRESETS[id];
  return new OpenAICompatibleProvider({
    id,
    credentials,
    ...(preset ? { preset } : {}),
    fetch: io.fetch,
  });
}

/**
 * The name of the first set variable among `CORE_<ID>_API_KEY`, `_BASE_URL` and `_ACCOUNT_ID`, or
 * `undefined`. Lets a command say where a credential comes from without ever printing its value.
 */
export function envSource(env: Record<string, string | undefined>, providerId: string): string | undefined {
  const id = providerId.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  for (const suffix of ["API_KEY", "BASE_URL", "ACCOUNT_ID"]) {
    const name = `${ENV_PREFIX}${id}_${suffix}`;
    if (env[name]) return name;
  }
  return undefined;
}

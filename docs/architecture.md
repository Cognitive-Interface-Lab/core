# Architecture

## Why a backbone

Trilix (Next.js app) and Orbit (local daily brief and voice assistant) need the same things: talking to any model provider, calling tools, recording what happened, and exposing it all safely to several front ends. Building each of these once, as a framework, lets every product be a thin client.

An assessment of the Trilix codebase on 2026-10-11 found good foundations (TypeScript strict with zero errors, CI, a server-only graph store with no React imports, eleven providers) but nothing reusable as a backbone yet:
- The provider layer is one `switch` with no common interface, keys live in browser `localStorage`, and model logic imports `@xyflow/react`.
- Branch, fork and merge are not engine operations. Provenance is a single JSON column, and there is no event log or replay.
- There is no package boundary or public API, and the tests are nine ad-hoc scripts.

## Modules

    contracts  ←  models, tools, graph  ←  credentials, runtime  ←  server  ←  clients, examples, apps (cli)

- **contracts:** zod schemas for messages, tools, tool calls, models, stream events, errors, and later graph events. The single source of every shape, exported as types and JSON Schema (which feeds the generated Python client).
- **models:** the `ModelProvider` interface (`capabilities`, `chat`, `stream`), `ProviderRegistry`, `CredentialStore` (memory and environment here; persistent stores live in `credentials`), `listModels` on providers, and `ModelRouter` (ordered fallback, per-attempt timeout, attempt log). Adapters are built on the Vercel AI SDK. One OpenAI-compatible adapter covers OpenAI, Ollama, OpenRouter, Groq and Cloudflare Workers AI.
- **tools (M2):** tool registry, MCP client (use any MCP server), MCP host (offer our tools), and policy (which channel may call which tool; confirmation for side effects).
- **runtime (M2):** one turn or flow: messages → model → tool calls → events, with streaming, cancellation and budgets.
- **graph (M3):** typed nodes and edges; branch, fork, merge and cross-reference as operations over an append-only event log, which gives provenance and replay. Storage behind an interface: Postgres via Drizzle for Trilix, SQLite for local apps.
- **credentials (M2b):** where sign-ins are kept and how they are obtained. `SecretStore` (OS keychain, a `0600` fallback file, memory), `PersistentCredentialStore` (saved records to provider credentials, with OAuth renewal), `ChainCredentialStore` (environment first), and the terminal sign-in flows (PKCE plus a local callback receiver; OpenRouter and Cloudflare).
- **cli (M2b):** the `core` command: `login`, `logout`, `status`, `models`, `config`, `ask`, `chat`. An app on top of `credentials` and `runtime`.
- **server (M4):** HTTP API with OpenAPI, an MCP endpoint and auth. Runs standalone (Orbit's local service) or mounted inside Next.js (Trilix).
- **clients (M4):** generated TypeScript and Python clients. Orbit's voice layer stays in Python and talks to the backbone through these.

## Decision log

- **Framework first** (owner, 2026-10-11). Build the backbone before porting Trilix (M5) and building Orbit on it (M6). Risk noted and accepted: a long stretch without product progress. Mitigation: every milestone ends with a runnable example.
- **TypeScript core; other languages via HTTP, MCP and generated clients** (owner, 2026-10-11). One implementation to maintain, shared with Trilix.
- **Standards over custom protocols** (lead, 2026-10-11). The AI SDK for provider wire formats, MCP for tools, OpenTelemetry for tracing, Drizzle for storage. The backbone owns only what makes Trilix different: the process graph, event log, provenance and replay. Rationale: a single maintainer cannot keep many hand-written adapters current.
- **TypeScript 5.9 for M1** (lead, 2026-10-11). TypeScript 7 (the native compiler) is out, but lint tooling support is unproven. Migration is a separate issue. *Superseded 2026-10-12, see below.*
- **The graph engine and event log come in M3, minimal but real** (lead, 2026-10-11). An event log is far harder to retrofit than to start with. M1 and M2 contracts leave room for graph events.
- **Cloud developer sessions push their own branches** (lead, 2026-10-11). A cloud container is discarded, so unpushed work is lost. This repo's developer reference allows pushing issue branches (never `main`, never force).
- **Workspace export condition is `@core/source`** (lead, 2026-10-11, core#12). A bare `source` condition collides with third-party packages that publish one (`eventsource-parser`), which made TypeScript type-check their raw sources. Vitest also needs it under `ssr.resolve.conditions` (core#14).
- **MCP through the official SDK's low-level `Server` and `Client`** (lead, 2026-10-11, M2). The low-level server takes our JSON Schemas as they are, with no second schema library. Tests connect client and host with the SDK's in-memory transport, so they never spawn processes or touch the network.
- **MCP tools are untrusted by default** (lead, 2026-10-11, M2). Imported MCP tools are allowed only on the `local` channel, and count as having side effects (so they need confirmation) unless the server marks them `readOnlyHint: true`. Stdio servers receive only the SDK's minimal default environment (HOME, LOGNAME, PATH, SHELL, TERM, USER, as `getDefaultEnvironment()` in SDK 1.32 returns it), never our API keys. TERM is accepted: it is not a secret (lead, 2026-10-12, core#38).
- **Tool arguments are validated by their owner** (lead, 2026-10-11, M2). Local tools are declared with zod through `defineTool`, which validates arguments. MCP servers validate their own. The registry has no JSON Schema validator in M2.
- **A turn runs tools one at a time** (lead, 2026-10-11, M2). A turn is rounds of model → tool calls → results until the model stops calling tools, or a budget (rounds, output tokens, wall time) ends it. The default limit is 8 rounds. Parallel tool calls wait until they are needed.
- **TypeScript 7 checks, TypeScript 6 serves the tools** (lead, 2026-10-12, core#23). The TypeScript 7 compiler (installed as the `typescript-7` alias) type-checks every package, about 4x faster than 5.9. TypeScript 7 ships no stable JavaScript API, and typescript-eslint supports TypeScript only up to 6.0, so the `typescript` package stays on 6.0 for typescript-eslint and tsdown. Both install a `tsc` binary, so `typecheck` scripts call TypeScript 7 by path, never a bare `tsc`. tsup is replaced by tsdown because tsup's type build fails on TypeScript 6 and later; the build output keeps the same file names and exports. TypeScript 6 stopped loading `@types/*` by default, so the base tsconfig lists `"types": ["node"]`. When typescript-eslint supports TypeScript 7, `typescript` moves to 7 and the alias goes.
- **A local CLI before the process graph** (owner, 2026-10-12, core#69). The owner wants to use core from the terminal now, signed in to the providers Trilix already uses. M2b ships `@core/credentials` and `@core/cli` before M3; it touches no M3 file.
- **Secrets live in the OS keychain, through `@napi-rs/keyring`, pinned to the Secret Service on Linux** (lead, 2026-10-12, core#69). The package ships prebuilt binaries (no native build), and `keytar` is archived. Spike: unpinned, it silently falls back to the Linux kernel keyring, which is lost on reboot; pinned, the constructor throws when no Secret Service runs. We then fall back to our own file, `credentials.json` in the config directory, mode `0600`, written atomically and refused when other users can read it. `CORE_CREDENTIAL_STORE` forces either store.
- **Environment variables win over saved sign-ins** (lead, 2026-10-12, core#69). CI and scripts keep working unchanged, and `core status` names the variable that is in effect.
- **Terminal sign-in reuses Trilix's flows** (lead, 2026-10-12, core#69). OpenRouter: PKCE with a localhost callback on any free port, issuing a key owned by the user's account. Cloudflare: authorization code with PKCE on Trilix's public OAuth client, with the fixed redirect `http://localhost:8976/oauth/callback` registered once by the owner; tokens are renewed before they expire. An API token plus account ID works without any OAuth setup. A new key is verified by listing models before it is saved.
- **Saved sign-ins are a contract** (lead, 2026-10-12, core#69). `StoredCredential` and `CredentialSummary` live in `@core/contracts` because the credentials package writes them and the CLI reads them; every record read back is validated.

# Architecture

## Why a backbone

Trilix (Next.js app) and Orbit (local daily brief and voice assistant) need the same things: talking to any model provider, calling tools, recording what happened, and exposing it all safely to several front ends. Building each of these once, as a framework, lets every product be a thin client.

An assessment of the Trilix codebase on 2026-10-11 found good foundations (TypeScript strict with zero errors, CI, a server-only graph store with no React imports, eleven providers) but nothing reusable as a backbone yet:
- The provider layer is one `switch` with no common interface, keys live in browser `localStorage`, and model logic imports `@xyflow/react`.
- Branch, fork and merge are not engine operations. Provenance is a single JSON column, and there is no event log or replay.
- There is no package boundary or public API, and the tests are nine ad-hoc scripts.

## Modules

    contracts  ←  models, tools, graph  ←  runtime  ←  server  ←  clients, examples, apps

- **contracts:** zod schemas for messages, tools, tool calls, models, stream events, errors, and later graph events. The single source of every shape, exported as types and JSON Schema (which feeds the generated Python client).
- **models:** the `ModelProvider` interface (`capabilities`, `chat`, `stream`), `ProviderRegistry`, `CredentialStore` (memory, environment, later browser and encrypted file), and `ModelRouter` (ordered fallback, per-attempt timeout, attempt log). Adapters are built on the Vercel AI SDK. One OpenAI-compatible adapter covers OpenAI, Ollama, OpenRouter, Groq and Cloudflare Workers AI.
- **tools (M2):** tool registry, MCP client (use any MCP server), MCP host (offer our tools), and policy (which channel may call which tool; confirmation for side effects).
- **runtime (M2):** one turn or flow: messages → model → tool calls → events, with streaming, cancellation and budgets.
- **graph (M3):** typed nodes and edges; branch, fork, merge and cross-reference as operations over an append-only event log, which gives provenance and replay. Storage behind an interface: Postgres via Drizzle for Trilix, SQLite for local apps.
- **server (M4):** HTTP API with OpenAPI, an MCP endpoint and auth. Runs standalone (Orbit's local service) or mounted inside Next.js (Trilix).
- **clients (M4):** generated TypeScript and Python clients. Orbit's voice layer stays in Python and talks to the backbone through these.

## Decision log

- **Framework first** (owner, 2026-10-11). Build the backbone before porting Trilix (M5) and building Orbit on it (M6). Risk noted and accepted: a long stretch without product progress. Mitigation: every milestone ends with a runnable example.
- **TypeScript core; other languages via HTTP, MCP and generated clients** (owner, 2026-10-11). One implementation to maintain, shared with Trilix.
- **Standards over custom protocols** (lead, 2026-10-11). The AI SDK for provider wire formats, MCP for tools, OpenTelemetry for tracing, Drizzle for storage. The backbone owns only what makes Trilix different: the process graph, event log, provenance and replay. Rationale: a single maintainer cannot keep many hand-written adapters current.
- **TypeScript 5.9 for M1** (lead, 2026-10-11). TypeScript 7 (the native compiler) is out, but lint tooling support is unproven. Migration is a separate issue.
- **The graph engine and event log come in M3, minimal but real** (lead, 2026-10-11). An event log is far harder to retrofit than to start with. M1 and M2 contracts leave room for graph events.
- **Cloud developer sessions push their own branches** (lead, 2026-10-11). A cloud container is discarded, so unpushed work is lost. This repo's developer reference allows pushing issue branches (never `main`, never force).

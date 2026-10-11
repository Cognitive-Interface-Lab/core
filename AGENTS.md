# AGENTS.md

`core` (working name) is the TypeScript backbone behind Trilix and the products built on it, such as Orbit. It is a framework: a model gateway, tools and MCP, a process graph with an event log, a runtime and a server. Trilix's web UI and Orbit become thin clients of it. Design and decisions: `docs/architecture.md`.

## Commands

    corepack enable            # or: npm i -g pnpm@12 when corepack is unavailable
    pnpm install
    pnpm gate                  # the compact verification gate: typecheck, lint, tests (failures only)
    pnpm build

Run `pnpm gate` before every hand-over. Never paste raw compiler or test output into issues or context; the gate prints only failures.

## Engineering rules

- **One definition per shape.** Every cross-package shape is a zod schema in `@core/contracts`; TypeScript types are `z.infer` of it. Never redeclare a contract type elsewhere. Schemas are named `XxxSchema`, inferred types `Xxx`.
- **Dependencies point one way:** `contracts` ← `models`, `tools`, `graph` ← `runtime` ← `server` ← clients, examples and apps. A package never imports from a package to its right.
- **No browser globals** (`window`, `localStorage`, `document`) in any package. Platform specifics enter through interfaces (for example `CredentialStore`).
- **Tests never touch the network or a real model.** Use `MockProvider` and injected `fetch`. Cloud sessions have no Ollama and no API keys.
- **Secrets never appear** in error messages, logs, events or snapshots.
- ESM only, Node >= 22, TypeScript 5.9 strict. Workspace packages export `./src/index.ts` under the `@core/source` condition for development and `./dist` for consumers.
- Prefer existing standards over new protocols: the Vercel AI SDK for provider wire formats, MCP for tools, OpenTelemetry for tracing.

## Working on issues

Issues live in this repo and on org project **Core**. Implementation follows the `developer` skill in `.claude/skills/developer/` together with this repo's reference `.claude/skills/developer/references/core.md`, which sets the comment tags, branch names, the push rule for cloud sessions, and project Status ids. Read both before claiming an issue.

Docs (`README.md`, `AGENTS.md`, `docs/`) and the project board belong to the tech lead. Developers report instead of editing them.

# core

Working name for the TypeScript backbone behind [Trilix](https://github.com/Cognitive-Interface-Lab/trilix) and the products built on it, such as [Orbit](https://github.com/Cognitive-Interface-Lab/orbit). The permanent name is still open.

Trilix's web UI, Orbit (CLI, voice, phone) and future experiments are thin clients. The backbone owns the parts they share:

| Package | Job |
|---|---|
| `@core/contracts` | The one definition of every shape (zod), exported as TypeScript types and JSON Schema |
| `@core/models` | Model gateway: one provider interface, registry, credential stores, fallback router |
| `@core/tools` | Tool registry, MCP client and host, per-channel policy (M2) |
| `@core/runtime` | Runs a turn: messages → model → tool calls → events (M2) |
| `@core/graph` | Process graph: branch, fork, merge, cross-reference on an append-only event log (M3) |
| `@core/server` | HTTP API with OpenAPI, MCP endpoint, auth; standalone or mounted in Next.js (M4) |

## Roadmap

Every milestone ends with something runnable.

| Milestone | Runnable result |
|---|---|
| M1 Foundation and model gateway | `hello-gateway` example streams an answer through the router (mock in CI, Ollama or any OpenAI-compatible API locally) |
| M2 Tools, MCP and runtime | An example agent calls a local tool and an MCP server |
| M3 Process graph and event log | A branched conversation is stored and replayed from its events |
| M4 Server, auth and clients | The same over HTTP, from the generated TypeScript and Python clients |
| M5 Trilix on core | Trilix's web app runs its chats through the backbone |
| M6 Orbit on core | Orbit's brief, voice and phone run on the backbone |

See `docs/architecture.md` for the design and the decision log, and `AGENTS.md` for how to work in this repo.

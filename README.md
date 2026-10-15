# core

Working name for the TypeScript backbone behind [Trilix](https://github.com/Cognitive-Interface-Lab/trilix) and the products built on it, such as [Orbit](https://github.com/Cognitive-Interface-Lab/orbit). The permanent name is still open.

Trilix's web UI, Orbit (CLI, voice, phone) and future experiments are thin clients. The backbone owns the parts they share:

| Package | Job |
|---|---|
| `@core/contracts` | The one definition of every shape (zod), exported as TypeScript types and JSON Schema |
| `@core/models` | Model gateway: one provider interface, registry, credential stores, fallback router |
| `@core/tools` | Tool registry, MCP client and host, per-channel policy (M2) |
| `@core/runtime` | Runs a turn: messages → model → tool calls → events (M2) |
| `@core/credentials` | Saved provider sign-ins: OS keychain or a private file, browser sign-in, token renewal (M2b) |
| `@core/cli` | The `core` command: sign in to providers, then ask or chat from any terminal (M2b) |
| `@core/graph` | Process graph: branch, fork, merge, cross-reference on an append-only event log (M3) |
| `@core/server` | HTTP API with OpenAPI, MCP endpoint, auth; standalone or mounted in Next.js (M4) |

## Use it from the terminal

You need Node 22 or newer and pnpm (`corepack enable` gives you the version this repo pins). Run these in a checkout of this repository, not in another project:

    git clone https://github.com/Cognitive-Interface-Lab/core.git
    cd core
    pnpm install
    pnpm build

Put the `core` command on your PATH once. The link points into this checkout, so keep the folder where it is:

    mkdir -p ~/.local/bin
    ln -sf "$PWD/packages/cli/dist/main.js" ~/.local/bin/core

If `core` is still not found, add `~/.local/bin` to your PATH (most Linux shells already have it). Then, from any folder:

    core status                                        # which providers you are signed in to
    core models ollama                                 # model names, as provider:model lines
    core config set route ollama:<model>               # several, comma-separated, are tried in order
    core ask "hello"
    core chat

Sign in to a provider with `core login openrouter` (browser), `core login cloudflare` (API token and account ID) or `core login openai` / `core login groq` (API key). Ollama needs no sign-in. Sign-ins go to the OS keychain when one is available. `core help <command>` shows each command's options.

To update later, pull and rebuild in the same folder. The link keeps working:

    git pull && pnpm install && pnpm build

If `git pull` refuses because `pnpm-lock.yaml` changed locally, run `git checkout -- pnpm-lock.yaml` first. A standalone pnpm install adds its own entries to the lockfile; they are not yours to commit.

### Tab completion (bash)

Let Tab complete commands, options, provider names, config keys and model names. Install once (needs the `bash-completion` package, which most Linux systems have):

    mkdir -p ~/.local/share/bash-completion/completions
    core completion bash > ~/.local/share/bash-completion/completions/core

Open a new terminal, then try `core lo<Tab>` or `core config set route <Tab>`. Model names come from the providers you are signed in to; a slow provider is skipped after a short wait, so Tab never hangs. Run the install line again after updating core.

## Roadmap

Every milestone ends with something runnable.

| Milestone | Runnable result |
|---|---|
| M1 Foundation and model gateway | `hello-gateway` example streams an answer through the router (mock in CI, Ollama or any OpenAI-compatible API locally) |
| M2 Tools, MCP and runtime | An example agent calls a local tool and an MCP server |
| M2b Local CLI and credentials | `core ask` and `core chat` answer from any terminal, with saved sign-ins for OpenRouter, Cloudflare and Ollama |
| M2c Tab completion | Tab completes `core` commands, options, providers and model names in bash |
| M3 Process graph and event log | A branched conversation is stored and replayed from its events |
| M4 Server, auth and clients | The same over HTTP, from the generated TypeScript and Python clients |
| M5 Trilix on core | Trilix's web app runs its chats through the backbone |
| M6 Orbit on core | Orbit's brief, voice and phone run on the backbone |

See `docs/architecture.md` for the design and the decision log, and `AGENTS.md` for how to work in this repo.

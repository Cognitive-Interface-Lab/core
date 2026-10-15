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

Sign in to a provider:

    core login openrouter      # opens the browser; approve there and you are signed in
    core login cloudflare      # the same, by link (--key pastes an API token and account ID instead)
    core login openai          # also groq and vercel: opens the page that creates an API key, then asks you to paste it
    core login anthropic       # Claude API: opens the Claude Console key page, then asks you to paste the key
    core login anthropic-aws   # Claude Platform on AWS: asks for the AWS region, the workspace ID and an AWS-Console API key

Ollama needs no sign-in. If the browser should not open by itself, add `--no-open` and core prints the link for you to open on this machine. Sign-ins go to the OS keychain when one is available. `core help <command>` shows each command's options.

Claude comes two ways. `anthropic` is the Claude API with a key from platform.claude.com. `anthropic-aws` is Claude Platform on AWS: it needs the AWS region, the Claude workspace ID and an API key created in the AWS Console (Claude Console keys don't work there). Route to a model by its plain ID, for example `core config set route anthropic:claude-opus-5-5`; `core models anthropic` lists them. For scripts, `CORE_ANTHROPIC_API_KEY`, or `CORE_ANTHROPIC_AWS_API_KEY`, `CORE_ANTHROPIC_AWS_REGION` and `CORE_ANTHROPIC_AWS_WORKSPACE_ID`, replace a saved sign-in: when any one of a provider's variables is set, core reads that provider from the environment only.

Vercel AI Gateway reaches many providers' models with one key. Sign in with `core login vercel`, then route to a model by its gateway name, for example `core config set route vercel:openai/gpt-4o-mini`.

To update later, pull and rebuild in the same folder. The link keeps working:

    git pull && pnpm install && pnpm build

If `git pull` refuses because `pnpm-lock.yaml` changed locally, run `git checkout -- pnpm-lock.yaml` first. A standalone pnpm install adds its own entries to the lockfile; they are not yours to commit.

### Calling core ask from a program

`core ask` has four options for scripts and other programs:

    core ask --system-file prompt.txt "…"              # the file's text goes first, as the instructions
    core ask --schema shape.json "…"                   # prints the answer as one line of JSON matching the JSON Schema in shape.json
    core ask --json "…"                                # prints one JSON result instead of the answer text
    core ask --timeout 60000 "…"                       # milliseconds per model, for this call only

With `--json`, stdout is one line once the options are understood (a misspelled option prints only the usage on stderr). On success it is `{"ok":true,"model":{"provider":…,"model":…},"text":…,"usage":…,"attempts":[…]}`, plus `output` (the matched object) when `--schema` is given. On failure it is `{"ok":false,"error":{"code":…,"message":…,"retryable":…},"attempts":[…]}`. `attempts` lists every model tried, in route order. The exit codes are the same with or without `--json`: 0 answered, 1 the models failed (a reply that is not valid JSON or does not match the schema counts, code `unknown`), 2 a usage error such as a missing or invalid schema file (reported before any model is called), 130 Ctrl+C. `--schema` and `--json` wait for the whole answer instead of streaming it. Nothing changes without these options.

### Tab completion (bash)

Let Tab complete commands, options, provider names, config keys and Ollama model names. Install once (needs the `bash-completion` package, which most Linux systems have):

    mkdir -p ~/.local/share/bash-completion/completions
    core completion bash > ~/.local/share/bash-completion/completions/core

Open a new terminal, then try `core lo<Tab>` or `core config set route <Tab>`. Model names come from your local Ollama only: completion never contacts remote providers or opens the keychain, and if Ollama doesn't answer within 1.5 s it offers no model names, so Tab never hangs. Run the install line again after updating core.

## Roadmap

Every milestone ends with something runnable.

| Milestone | Runnable result |
|---|---|
| M1 Foundation and model gateway | `hello-gateway` example streams an answer through the router (mock in CI, Ollama or any OpenAI-compatible API locally) |
| M2 Tools, MCP and runtime | An example agent calls a local tool and an MCP server |
| M2b Local CLI and credentials | `core ask` and `core chat` answer from any terminal, with saved sign-ins for OpenRouter, Cloudflare and Ollama |
| M2c Tab completion | Tab completes `core` commands, options, providers and Ollama model names in bash |
| M2d Browser sign-in and Vercel | `core login cloudflare` signs in by link, key-based logins open the page that creates the key, and Vercel AI Gateway is a provider |
| M2e Anthropic provider | `core login anthropic` (Claude API) and `core login anthropic-aws` (Claude Platform on AWS, with region and workspace ID) sign in, and `anthropic:` models answer |
| M2f core ask for programs | `core ask --schema`, `--system-file`, `--json` and `--timeout` let a program get a checked JSON answer and a machine-readable result |
| M3 Process graph and event log | A branched conversation is stored and replayed from its events |
| M4 Server, auth and clients | The same over HTTP, from the generated TypeScript and Python clients |
| M5 Trilix on core | Trilix's web app runs its chats through the backbone |
| M6 Orbit on core | Orbit's brief, voice and phone run on the backbone |

See `docs/architecture.md` for the design and the decision log, and `AGENTS.md` for how to work in this repo.

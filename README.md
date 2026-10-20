# core

An open TypeScript backbone for products that use AI. It gives you one interface to many model providers, with fallback when one fails, plus tools and MCP, a conversation graph you can branch, merge and replay, and an HTTP API you can run on your own machine or mount in your app. It is the backbone behind [Trilix](https://trilix.theenigmax.com) and Orbit. "core" is a working name; the permanent one is still open.

## Three ways to use it

**On your machine.** Build it once, sign in to a provider (`core login openrouter`, or use a local Ollama with no sign-in), then `core ask "hello"` or `core chat` from any terminal. Scripts can call `core ask --json`. Start at [Use it from the terminal](#use-it-from-the-terminal).

**In your app.** Use the packages in your own server or Node code: `@core/models` sends a request to a provider and falls back to the next one when it fails, `@core/runtime` runs a turn with tool calls, and `@core/graph` keeps conversations you can branch and replay. The [examples](examples/) show each one and need no keys. Or mount core's whole HTTP API in your server with `createCoreHandler` and call it from your front end with `@core/client`; your app decides who is asking and whose keys pay ([The HTTP API](#the-http-api)). Until core is on npm, another project installs it from packs ([Packs for other projects](#packs-for-other-projects)).

**Your website, your visitor's machine.** Your visitor runs `core serve` on their computer. Your site shows a six-character code and calls `pair`, and the visitor allows it in their terminal after checking the code. From then on your site calls core on their machine with its own token: models answer with the visitor's own sign-ins, their keys never leave their computer, and you pay nothing for their model use. Chrome, Edge and other Chromium browsers support this; Safari doesn't. Start at [Let websites and programs use core](#let-websites-and-programs-use-core).

Found a bug, or missing a provider? Issues and pull requests are welcome.

## Packages

| Package | Job |
|---|---|
| `@core/contracts` | The one definition of every shape (zod), exported as TypeScript types and JSON Schema |
| `@core/models` | Model gateway: one provider interface, registry, credential stores, fallback router |
| `@core/tools` | Tool registry, MCP client and host, per-channel policy (M2) |
| `@core/runtime` | Runs a turn: messages → model → tool calls → events (M2) |
| `@core/credentials` | Saved provider sign-ins: OS keychain or a private file, browser sign-in, token renewal (M2b) |
| `@core/cli` | The `core` command: sign in to providers, then ask or chat from any terminal (M2b) |
| `@core/graph` | Process graph: branch, fork, merge, cross-reference on an append-only event log (M3) |
| `@core/server` | HTTP API with OpenAPI, and the local bridge behind `core serve`; mounted in another app's server too (M4) |
| `@core/client` | TypeScript client for the HTTP API, for browsers and Node; checks every answer (M4) |

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

    core login openrouter         # opens the browser; approve there and you are signed in
    core login cloudflare         # the same, by link (--key pastes an API token and account ID instead)
    core login openai             # also groq and vercel: opens the page that creates an API key, then asks you to paste it
    core login anthropic          # Claude API: opens the Claude Console key page, then asks you to paste the key
    core login anthropic-aws      # Claude Platform on AWS: asks for the AWS region, the workspace ID and an AWS-Console API key
    core login google             # Google Gemini: opens the AI Studio key page, then asks you to paste the key
    core login azure              # Azure OpenAI: asks for the resource endpoint, then the key; route to a deployment as azure:<deployment>
    core login openai-compatible  # any OpenAI-compatible server (LM Studio, vLLM, a proxy): asks for its base URL, then a key (any placeholder if it ignores keys)

Ollama needs no sign-in. If the browser should not open by itself, add `--no-open` and core prints the link for you to open on this machine. Sign-ins go to the OS keychain when one is available. `core help <command>` shows each command's options.

Claude comes two ways. `anthropic` is the Claude API with a key from platform.claude.com. `anthropic-aws` is Claude Platform on AWS: it needs the AWS region, the Claude workspace ID and an API key created in the AWS Console (Claude Console keys don't work there). Route to a model by its plain ID, for example `core config set route anthropic:claude-opus-5-5`; `core models anthropic` lists them. For scripts, `CORE_ANTHROPIC_API_KEY`, or `CORE_ANTHROPIC_AWS_API_KEY`, `CORE_ANTHROPIC_AWS_REGION` and `CORE_ANTHROPIC_AWS_WORKSPACE_ID`, replace a saved sign-in: when any one of a provider's variables is set, core reads that provider from the environment only.

Vercel AI Gateway reaches many providers' models with one key. Sign in with `core login vercel`, then route to a model by its gateway name, for example `core config set route vercel:openai/gpt-4o-mini`.

To update later, pull and rebuild in the same folder. The link keeps working:

    git pull && pnpm install && pnpm build

If `git pull` refuses because `pnpm-lock.yaml` changed locally, run `git checkout -- pnpm-lock.yaml` first. A standalone pnpm install adds its own entries to the lockfile; they are not yours to commit.

### Calling core ask from a program

`core ask` has five options for scripts and other programs:

    core ask --system-file prompt.txt "…"              # the file's text goes first, as the instructions
    core ask --schema shape.json "…"                   # prints the answer as one line of JSON matching the JSON Schema in shape.json
    core ask --json "…"                                # prints one JSON result instead of the answer text
    core ask --timeout 60000 "…"                       # milliseconds per model, for this call only
    core ask --max-output-tokens 8192 "…"              # the most tokens each model may write in its reply

With `--json`, stdout is one line once the options are understood (a misspelled option prints only the usage on stderr). On success it is `{"ok":true,"model":{"provider":…,"model":…},"text":…,"usage":…,"attempts":[…]}`, plus `output` (the matched object) when `--schema` is given. On failure it is `{"ok":false,"error":{"code":…,"message":…,"retryable":…},"attempts":[…]}`. `attempts` lists every model tried, in route order. The exit codes are the same with or without `--json`: 0 answered, 1 the models failed (a reply that is not valid JSON or does not match the schema counts, code `unknown`), 2 a usage error such as a missing or invalid schema file (reported before any model is called), 130 Ctrl+C. `--schema` and `--json` wait for the whole answer instead of streaming it. Without `--max-output-tokens` no limit is sent and the provider's own default applies. Cloudflare's can be as low as 256 tokens, which a reasoning model such as `gpt-oss-120b` may spend before it writes anything. A `--schema` reply that stopped at the limit and does not match fails as cut off at the output-token limit (in `--json`, the attempt's `error.details.finishReason` is `"length"`), and stderr suggests raising the option. A cut-off answer without a schema is still printed, with a note on stderr. Nothing changes without these options.

### Tab completion (bash)

Let Tab complete commands, options, provider names, config keys and Ollama model names. Install once (needs the `bash-completion` package, which most Linux systems have):

    mkdir -p ~/.local/share/bash-completion/completions
    core completion bash > ~/.local/share/bash-completion/completions/core

Open a new terminal, then try `core lo<Tab>` or `core config set route <Tab>`. Model names come from your local Ollama only: completion never contacts remote providers or opens the keychain, and if Ollama doesn't answer within 1.5 s it offers no model names, so Tab never hangs. Run the install line again after updating core.

## Let websites and programs use core

`core serve` answers core's HTTP API on this machine, for websites you pair and for programs running here. It uses your saved sign-ins and the route you set with `core config set route`:

    core serve                     # http://127.0.0.1:8977
    core serve --port 9000

On start it prints the address, the sites already paired and where programs find their token. Ctrl+C stops it. It listens on 127.0.0.1 only, and it answers only requests addressed to `127.0.0.1:<port>` or `localhost:<port>`, so a site cannot reach it by pointing its own domain name at this machine.

### Pairing a website

A website that wants to use your core shows you a six-character code and asks to pair. The terminal running `core serve` asks:

    https://app.example.com asks to use core on this machine as "Example". Check that it shows the code K7PX2M. Allow? [y/N]

Answer `y` only if the site shows the same code. Any other answer denies it, and that site must wait 60 s before it asks again. One site can ask at a time, and an unanswered request ends after 120 s. Without a terminal, every request is refused. Only https sites, and http pages on `localhost` or `127.0.0.1`, may ask.

A paired site gets its own token, and core stores only its hash. Browsers can read core's answers only on paired sites; any other site may only ask to pair. To forget a site:

    core unpair https://app.example.com

This works at once, even while `core serve` runs. A site can also unpair itself.

Chrome, Edge and other Chromium browsers ask you once whether the site may reach this machine. Safari blocks https pages from calling `http://127.0.0.1` (WebKit bug 279249), so on Safari a site can't use your local core.

### Calling core serve from a program

A program on this machine sends the token from `serve-token` in core's config folder (`~/.config/core`, or `$CORE_CONFIG_DIR`). `core serve` creates the file on first start, readable only by you, and refuses to start if other users can read it:

    TOKEN=$(cat ~/.config/core/serve-token)
    curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8977/v1/providers
    curl -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
      -d '{"messages":[{"role":"user","content":"hello"}]}' http://127.0.0.1:8977/v1/chat

A request without an `Origin` header counts as a program. One that sends `Origin` is treated as a website and must be paired.

### The HTTP API

`core serve` and an app that mounts core in its own server (Trilix, in a Next.js route) answer the same API. `GET /v1/openapi.json` describes it (OpenAPI 3.1). It and `GET /v1/health` need no token, though `core serve` still turns away unpaired websites.

| Route | Answer |
|---|---|
| `GET /v1/health`, `GET /v1/providers`, `GET /v1/models?provider=<id>` | The version and mode; each provider and whether it is ready to use; a provider's models |
| `POST /v1/chat` | The same result as `core ask --json`, also when the models fail |
| `POST /v1/turns` | A turn as a `text/event-stream` of events: text deltas, tool calls, rounds, then `turn-finish` |
| `GET /v1/graphs`, `POST /v1/graphs`, `GET /v1/graphs/:id`, `GET /v1/graphs/:id/events?after=<seq>` | List, create and read process graphs and their events |
| `POST /v1/graphs/:id/<action>`, where `<action>` is `branches`, `messages`, `turns`, `turn-records`, `merges`, `cross-references` or `forks` | Change a graph; `turns` streams a turn and records it on a branch |
| `POST /v1/pair`, `DELETE /v1/pair` | Pair and unpair a website (`core serve` only) |

POST bodies are JSON, at most 4 MiB. A failure answers `{"ok":false,"error":{"code":…,"message":…,"retryable":…}}` with a status for its code: `bad_request` 400, `auth` 401, `not_found` 404, `conflict` 409, `content_filter` 422, `rate_limit` 429, `aborted` 499, `unknown` 500, `unavailable` 503, `timeout` 504. `core serve` adds 403 for an unpaired website and 421 for a request addressed to another host.

To mount the API in your own server, `createCoreHandler` from `@core/server` returns a `fetch(request)` handler. You decide who is asking and whose sign-ins a request uses:

```ts
import { createCoreHandler } from "@core/server";

const core = createCoreHandler({
  mode: "hosted",
  version: "1.0.0",
  basePath: "/api/core",
  authenticate: async (request) => principalFromSession(request), // { id, channel: "web" }, or null for a 401
  credentialsFor: (principal, request) => credentialsFor(request), // a CredentialStore from @core/models
  // graph: { store, access },  // serves the graph routes; without it they answer 404
});

// app/api/core/[...path]/route.ts in Next.js
export const GET = (request: Request) => core.fetch(request);
export const POST = GET;
export const DELETE = GET;
```

### The TypeScript client

`@core/client` calls the API from a browser or Node. It depends only on `@core/contracts`, and it checks every answer and every streamed event against its schema:

```ts
import { createCoreClient } from "@core/client";

const core = createCoreClient({ baseUrl: "http://127.0.0.1:8977", token });

const answer = await core.chat({ messages: [{ role: "user", content: "hello" }] });
if (answer.ok) console.log(answer.text);

for await (const event of core.turn({ messages: [{ role: "user", content: "hello" }] })) {
  if (event.type === "text-delta") process.stdout.write(event.text);
}
```

A website gets its token by pairing: it makes up the code (six characters from A–Z and 2–9, without I or O), shows it, and calls `core.pair({ code, name: "Example" })`, which answers `{ origin, token }` once you allow it. `core.unpair()` forgets it again. `core.graphs` has a method per graph route. Pass `{ signal }` to `chat`, `turn` and `graphs.turn` to cancel. Every failure is a `CoreError` from `@core/contracts`: `unavailable` when core can't be reached or stops answering partway through a stream, `aborted` when the signal fires, `unknown` for an answer that doesn't match its schema, and the server's own code otherwise. `headers` (a function, called on every request) and `credentials` serve an app that mounts core behind its own sign-in.

### Packs for other projects

Nothing is published to npm while core's name is still open. Instead, `pnpm pack:consumers` builds and packs the eight packages another project imports (`contracts`, `models`, `tools`, `graph`, `graph-postgres`, `runtime`, `server`, `client`) into `packs/`, with `packs/manifest.json` listing each one's name, version, file and SHA-256. `pnpm pack:consumers --check` also installs the tarballs into an empty project and imports every package.

The other project copies the tarballs into its repository and installs them with `file:` dependencies, plus npm `overrides` so the packages find each other there too:

    "dependencies": { "@core/client": "file:vendor/core/core-client-0.1.0.tgz" },
    "overrides": { "@core/contracts": "file:vendor/core/core-contracts-0.1.0.tgz" }

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
| M2g core ask output-token limit | `core ask --max-output-tokens` gives a model room to finish, and an answer cut off at the limit is reported as such |
| M3 Process graph and event log | A branched conversation is stored and replayed from its events |
| M4 Server, local bridge and TypeScript client | `core serve` answers websites you paired and programs on this machine over HTTP, and the same handler mounts inside a Next.js app |
| M5 Trilix on core | Trilix's web app runs its chats through the backbone |
| M6 Orbit on core | Orbit's brief, voice and phone run on the backbone |

See `docs/architecture.md` for the design and the decision log, and `AGENTS.md` for how to work in this repo.

## License

MIT, see [LICENSE](LICENSE).

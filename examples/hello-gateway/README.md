# hello-gateway

Streams one answer through the `@core/models` gateway: a `ModelRouter` that tries an ordered list
of models and falls back to the next one when a provider fails. It uses the mock provider by
default, so it runs anywhere with no keys and no network. Any OpenAI-compatible server works when
you point `CORE_ROUTE` at it.

Run it from the repository root, after `pnpm install`:

    pnpm --filter @core/example-hello-gateway start hi

The answer goes to stdout and a one-line summary to stderr:

    echo: hi
    [via mock:echo · 3 ms · 1 attempt(s)]

The exit code is 0 on success, 1 when every model in the route failed (an `error: <code>: <message>`
line is printed), and 2 when no prompt was given.

## Choosing models: `CORE_ROUTE`

`CORE_ROUTE` is a comma-separated list of `provider:model` refs, tried in order. The default is
`mock:echo`. The ref is split at the first `:` only, so `ollama:llama3.2:3b` means provider
`ollama`, model `llama3.2:3b`.

Providers that have a built-in preset are `openai`, `ollama`, `openrouter` and `groq`, plus `mock`.
A provider id the example does not know is skipped: the router moves on to the next entry.

### Local Ollama

Start Ollama (it listens on `http://127.0.0.1:11434`), pull a model, then:

    CORE_ROUTE=ollama:llama3.2:3b pnpm --filter @core/example-hello-gateway start "Say hello in five words"

No key is needed. Use `CORE_OLLAMA_BASE_URL` if Ollama runs somewhere else.

### OpenAI

    CORE_OPENAI_API_KEY=sk-... CORE_ROUTE=openai:gpt-4.1-mini pnpm --filter @core/example-hello-gateway start "Say hello"

The key is read from the environment and never printed.

### Fallback

Try a hosted model first, then local Ollama, then the mock:

    CORE_ROUTE="openai:gpt-4.1-mini,ollama:llama3.2:3b,mock:echo" pnpm --filter @core/example-hello-gateway start hi

With no `CORE_OPENAI_API_KEY` set, the first step fails before any network call and the answer
comes from the next one, for example `[via mock:echo · 2 ms · 2 attempt(s)]`.

## Credentials

Credentials come from environment variables named after the provider id, uppercased, with every
non-alphanumeric character replaced by `_`:

| Variable | Meaning |
| --- | --- |
| `CORE_<ID>_API_KEY` | API key for the provider, for example `CORE_OPENAI_API_KEY` |
| `CORE_<ID>_BASE_URL` | Overrides the preset's base URL, for example `CORE_GROQ_BASE_URL` |

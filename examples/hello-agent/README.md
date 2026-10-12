# hello-agent

One agent turn on the `@core/runtime` backbone: a model that can call tools. It always has the
built-in `calculate` tool, and it can use the tools of any MCP server you point it at. The model
runs through the same `ModelRouter` as [`hello-gateway`](../hello-gateway/README.md), so
`CORE_ROUTE`, `CORE_TIMEOUT_MS` and the provider credentials work the same way.

Run it from the repository root, after `pnpm install`:

    pnpm --filter @core/example-hello-agent start "what's 23 times 17?"

The answer goes to stdout. Everything else goes to stderr: each tool call as `[tool <name> <arguments>]`,
each result as `[result <name> <content>]` (or `[error <name> …]` when the tool failed; content is cut
at 200 characters), and, when the model finishes on its own, a last line `[via <provider:model> · <n> round(s) · <ms> ms]`.

The exit code is 0 when the model finishes on its own, 1 when the turn or its setup fails, and 2 when
no prompt was given or `CORE_TIMEOUT_MS` is invalid. A failed route prints one
`attempt <n> <provider:model>: <code>: <message>` line per failed step and then `error: <code>: <message>`;
any other failure prints `error: <reason>`, for example `error: max-rounds`.

## With the mock (no model, no network)

The default route is `mock:echo`, which never calls a tool: it just repeats your prompt.

    pnpm --filter @core/example-hello-agent start hello

## With Ollama

Use a model that supports tool calling, for example `llama3.2:3b`. Start Ollama and pull it, then:

    CORE_ROUTE=ollama:llama3.2:3b pnpm --filter @core/example-hello-agent start "what's 23 times 17?"

You should see the model call `calculate` and then answer with 391:

    [tool calculate {"expression":"23*17"}]
    [result calculate {"expression":"23*17","result":391}]
    391
    [via ollama:llama3.2:3b · 2 round(s) · … ms]

If the first token takes longer than 30 s (a cold model), raise `CORE_TIMEOUT_MS`, for example
`CORE_TIMEOUT_MS=120000`. See the "Cold starts" note in the `hello-gateway` README.

## With an MCP server: `CORE_MCP_FS`

Set `CORE_MCP_FS` to a directory and the example starts the reference filesystem MCP server on it
(`npx -y @modelcontextprotocol/server-filesystem@1 <dir>`, which needs Node and network access to
download the package the first time) and offers its tools to the model:

    CORE_MCP_FS=$PWD CORE_ROUTE=ollama:llama3.2:3b pnpm --filter @core/example-hello-agent start "list the files in the current directory"

`[mcp fs: <n> tools]` on stderr says how many tools were imported. Their names are prefixed with
the server (`fs__list_directory`, …). The server gets only a minimal environment (`HOME`, `PATH`
and a few more), never your API keys.

## Side effects need `--yes`

Tools imported from an MCP server are untrusted: they are offered only on the `local` channel, and
they count as having side effects unless the server marks them read-only. A tool with side effects
runs only if you allow it. Without `--yes` the call is declined, the model is told so, and stderr shows:

    [declined fs__write_file: run with --yes to allow]

With `--yes` the same call goes through:

    CORE_MCP_FS=$PWD CORE_ROUTE=ollama:llama3.2:3b pnpm --filter @core/example-hello-agent start --yes "write hello to hello.txt"

Read-only tools (`readOnlyHint`), and `calculate`, never need it.

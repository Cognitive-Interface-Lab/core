# branching-chat

A conversation that branches, merges and replays, kept in one file and rebuilt from that file
alone. It runs on `@core/graph` (the process graph and its event log), `@core/graph-sqlite` (the log
in a SQLite file), and `@core/runtime` (`runBranchTurn` records each turn, `replayBranch` re-runs a
branch on another model). The model runs through the same `ModelRouter` as
[`hello-agent`](../hello-agent/README.md), so `CORE_ROUTE`, `CORE_TIMEOUT_MS` and the provider
credentials work the same way. There are no tools.

Run it from the repository root, after `pnpm install`:

    pnpm --filter @core/example-branching-chat start --db demo.db

It plays one script and prints each user message and each answer as it completes, as
`[<branch>] user: …` and `[<branch>] assistant: …`:

1. `main`: a system message, then "What is an event log? Answer in two sentences."
2. Branch `short` from that answer: "Now say it in five words."
3. Branch `analogy` from the same answer: "Explain it with a kitchen analogy."
4. `short` is merged into `main` (an `append` merge).
5. `analogy` is replayed from the start on `CORE_REPLAY_ROUTE` (default: the main route), as a new
   branch `analogy replay`. The first answer is asked again, then the kitchen question.
6. The tree, and a last line `graph <id>: <n> events in <file | memory>`.

Without `--db` the graph lives in memory and is gone at exit.

## The tree

One line per branch, in creation order: its name, where it starts (`root`, or the first 8 characters
of a node id), how many messages its conversation has, `replay of <name> via <provider:model>` for a
replay (the model of its last turn), `merged into <name>` for a branch that was merged, and the first
60 characters of its last message:

    main · from root · 5 messages · "echo: Now say it in five words."
    short · from 8340c989 · 5 messages · merged into main · "echo: Now say it in five words."
    analogy · from 8340c989 · 5 messages · "echo: Explain it with a kitchen analogy."
    analogy replay · from root · 5 messages · replay of analogy via mock:echo · "echo: Explain it with a kitchen analogy."
    graph 894b3f45-eaa0-4ec1-88cc-e5fdabd04a92: 18 events in demo.db

## Rebuild it from the file

The id on the last line is all you need. `show` opens the file, rebuilds the graph from its event log,
and prints the tree and then each branch's conversation under a `## <branch>` line:

    pnpm --filter @core/example-branching-chat start show 894b3f45-eaa0-4ec1-88cc-e5fdabd04a92 --db demo.db

A file without that graph prints `error: not_found: …`; a path that does not exist prints
`error: not_found: no database at <file>` and creates nothing.

## With the mock (no model, no network)

The default route is `mock:echo`, which repeats the last user message. Everything above works with
it, which is what the output shown here is.

## With Ollama

Use one model for the conversation and a second for the replay, so the tree shows both:

    CORE_ROUTE=ollama:llama3.2:3b CORE_REPLAY_ROUTE=ollama:qwen2.5:3b \
      pnpm --filter @core/example-branching-chat start --db demo.db

`analogy replay` is then shown as `replay of analogy via ollama:qwen2.5:3b`, next to the original
`analogy` answered by the first model. If the first token takes longer than 30 s (a cold model), raise
`CORE_TIMEOUT_MS`, for example `CORE_TIMEOUT_MS=120000`.

## Exit codes

0 when every step succeeds. 1 when a turn does not finish on its own: stderr names the step
(`step main failed`), then prints one `attempt <n> <provider:model>: <code>: <message>` line per failed
route step and `error: <code>: <message>` (or `error: <reason>`, for example `error: max-rounds`), and the
script stops there. Also 1 when the store or graph fails (`error: <code>: <message>`). 2 for a bad
argument or an invalid `CORE_TIMEOUT_MS`, with the usage on stderr.

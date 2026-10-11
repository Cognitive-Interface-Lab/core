# Cognitive-Interface-Lab/core: developer reference

Read this together with `SKILL.md` before claiming work in this repo. Where they differ, this file wins for this repo.

## Project and Status

- Org project **Core** (number 2, id `PVT_kwDODpMGEM4BmkaT`). Each issue belongs to this one project.
- Status field `PVTSSF_lADODpMGEM4BmkaTzhlM4qg`. Options: Backlog `f2a20650`, Blocked `27820db4`, Ready `537c1785`, In progress `a7a84306`, In review `a1885932`, Done `238161e6`.
- You move a child **Ready → In progress** at pickup and **In progress → In review** at handover. You never set Done, Ready or Blocked, and never close issues.
- **If the session cannot change project Status** (cloud sessions may lack project access), post the comment anyway, add the line `Status: wanted <option>, could not set: <exact error>`, and continue. The lead syncs the board.

## Comment tags

You and the lead post from the same GitHub account. The first line of every comment carries a tag:
- Yours: `**[dev] pickup**`, `**[dev] progress**`, `**[dev] question**`, `**[dev] blocked**`, `**[dev] report**`.
- The lead's: `**[lead] approved**`, `**[lead] changes**`, `**[lead] answer**`. An untagged comment is the owner's.

Report on each child's own issue. Put only one-line progress and the final report on the parent.

## Order and dependencies

Children are delivered strictly in **sub-issue order**, which is the dependency order. There are no blocked-by links between siblings. A child whose predecessor is committed into the parent branch counts as satisfied, even before the lead reviews it. Do not wait for the lead between children.

## Branches, worktrees and commits

- The parent integration branch is `m<milestone>/<parent#>` (for example `m1/1`). The lead creates and pushes it from `main` before assigning.
- Work in a parent integration worktree on that branch. Each child gets its own worktree and branch `m<milestone>/<child#>`, cut from the current parent tip.
- One commit per child on the child branch, message `<child title>` plus `Refs #<child>` and `Refs #<parent>` (no closing keywords), plus the attribution trailer your harness requires. Then fast-forward the parent branch to it and run `pnpm gate` there.
- **Cloud push rule (this repo only):** a cloud container is discarded, so push after each integrated child: `git push origin m1/<child#> m1/<parent#>`. Fast-forward pushes only. Never force-push, never push `main`, never open or merge PRs. If the environment forces a branch prefix (for example `claude/`), keep it, use it consistently, and name the actual branches in your comments.
- Fixing an integrated child after `[lead] changes`: fast-forward the child branch to the parent tip, commit the fix there, fast-forward the parent again. Never rewrite pushed history.

## Gate

`pnpm gate` (from the first foundation slice onward). Before that slice exists, run the slice's own Verify commands. Never paste raw output: the gate prints failures only.

## Subagents

If `probe-worker`, `code-worker` or `test-author` (in `.claude/agents/`) are available, follow the delegation rules in `SKILL.md`. If the session cannot spawn them, implement the slice yourself, and still write tests as a separate step from the slice's contract.

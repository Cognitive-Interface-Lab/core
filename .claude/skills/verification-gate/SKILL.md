---
name: verification-gate
description: How to check that a change is sound without pouring raw compiler, build, or test output into the context window — find or build a compact gate in any repo, filter output to error lines only, and verify claims on disk. Use before reporting work complete, or when a build or test run would print hundreds of lines.
---

# The verification gate

Raw toolchain output is the largest avoidable context cost in most sessions. A full
type-check of a mid-size project prints thousands of lines; a failing test suite prints
stack traces for every case. Almost none of it changes what you do next.

**Never read raw compiler, build, or test output into context.**

---

## 1. Look for an existing gate first

Projects that have solved this already expose it. Check, in order:

- `package.json` scripts / `Makefile` targets / `justfile` / `Taskfile.yml` for names like
  `verify`, `check`, `gate`, `ci`, `lint:ci`, `typecheck`.
- A `scripts/` directory with a wrapper script.
- `CLAUDE.md` or `CONTRIBUTING.md` — a project that cares will say so.

If a gate exists, use it and nothing else. A project-authored gate usually encodes checks a
type checker cannot see — architectural policy, layering, duplicated definitions — and
those are exactly the failures that compile cleanly.

## 2. Otherwise, filter at the source

Build the compact form yourself. The goal is: **error lines only, capped, exit code
preserved.**

```bash
# type check — count first, then look
<typecheck cmd> 2>&1 | grep -E 'error|Error' | head -n 25

# tests — failures only
<test cmd> 2>&1 | grep -E '✕|FAIL|✗|failed|Error:' | head -n 40

# anything else — the tail is where the verdict is
<cmd> 2>&1 | tail -n 40

# just the number, when you only need pass/fail
<cmd> 2>&1 | grep -c 'error'
```

Read the count first. If it is zero, you are done — do not read the output. If it is large,
read the first few and fix the root cause; errors cascade, and lines 5–200 are usually
consequences of line 1.

Write the full output to a file if you may need it (`> /tmp/gate.log 2>&1`), then grep the
file. The file costs nothing until you read it.

## 3. Scope the run

Most gates take a path. `<typecheck cmd> -- src/orders` or `<test cmd> path/to/file`
answers the question you actually have, in a fraction of the time and output.

Run the **broad** suite once, at the end, from the session that owns the change — never
from inside a worker, where it is slow, noisy, and the classic way a brief stalls.

## 4. The gate is not the whole verification

A green gate says the code is well-formed. It does not say the change is done.

- **Grep for the symbols** a report claims were added. Confirm the path and the shape.
- **Read the diff.** "Added validation" and a validator nothing calls are the same sentence
  and different outcomes.
- **Find the production caller.** New code with green tests and no caller is dead code.
- **Check what the harness can prove.** In-memory or faked backends often cannot
  demonstrate transactional rollback, real concurrency, or unique-constraint races. A green
  test there is not evidence of those properties — say so rather than implying coverage.
- **A regression test that has never failed proves nothing.** Establish it goes red against
  the pre-fix behaviour.

## 5. Report honestly

If the gate fails, say so, with the filtered output — not a summary of it. If you skipped a
check, say which. If a red result was already red before your change, prove it by running
the same gate at the base and say so explicitly; inherited failures get misattributed
otherwise, and that costs someone an afternoon.

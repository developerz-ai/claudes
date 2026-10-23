---
description: Prove a change in developerz-ai/claudes before committing or opening a pull request — the repo's own install, run and check commands. Use before every commit.
applies: [typescript, javascript, bun]
---

# Verify a change in developerz-ai/claudes

> House skill — established by dz-runner setup mode from this repo’s own
> detected commands. Correct it in place; setup never overwrites a skill that exists.

## The one gate

`bin/check` is the gate. CI runs it and the pre-commit hook runs it, so a change that
passes it locally passes everywhere.

| Step | Command | What it is |
|------|---------|------------|
| install | `bin/setup` | `bun install --frozen-lockfile`, skipped when `node_modules` already holds every pin `bun.lock` declares |
| run | `bin/dev` | true — on developerz.ai runs, start it with code_bash_background when you need a running stack |
| prove | `bin/check` | bin/check |
| stop | `bin/stop` | true — on developerz.ai runs, the platform runs this when your session ends — do not stop the stack yourself |

## Rules

- Run every command from the repo root — the scripts `cd` there themselves.
- `bin/check` red is not a pull request. Fix the cause, never silence the gate.
- `bin/setup` printing "already satisfied" is a real answer, not a skipped step: it
  compared every `bun.lock` devDependency pin against what is installed. Only a
  refused `bun install --frozen-lockfile` needs you — it prints `bun --version`,
  the pin `.bun-version` requires, the `lockfileVersion` and the bun version CI
  installs. A bun older than the
  committed lockfile format is the usual cause; never edit `bun.lock` to get past it.

## Exit codes `bin/check` must use

A coding box runs this gate before it commits, and it has to tell a FAILING change
from a gate it could not run — otherwise correct work is thrown away as if it were
red. Exit 1 cannot carry that difference, so one code is reserved:

| Exit | Means | What the platform does |
|------|-------|------------------------|
| 0 | the change passes | commit it |
| 75 | a resource the gate NEEDS is unreachable (a database, a service, a credential) — it refused to grade | refuse the commit, and blame the environment, never the change |
| any other non-zero | the gate ran and the change is red | refuse the commit, and blame the change |

- Guard preconditions FIRST and `exit 75` when one is unmet. `exit 1` there tells the
  platform your change is broken when it is your environment that is.
- Changed a dependency? Re-run `bin/setup` before `bin/check`, or you are proving a stale tree.
- Add the test that fails first, then the fix — a green run that never went red proves nothing.

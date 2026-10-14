# AI-first scorecard

> Written by the developerz.ai maintainer agent — established by dz-runner setup mode. Each onboarding run rewrites this file whole; the latest run wins, and the same card is stored on the platform.

- Run: `run_b33c520043944ab5bb6fcf4724521682`
- Computed: 2026-10-14T21:29:17.152Z
- Proof: **proved with gaps** — `bin/check` ran green at head; the head commands that did not are named below.
- Score: 12 of 15 items ok

## `policy` — ok

- .dz/maintainer/maintainer.yml established
- .dz/maintainer/reviewer.md established

## `brain` — ok

- CLAUDE.md established

## `roster` — ok

- .claude/agents/cli-flags.md established
- .claude/agents/router-client.md established
- .claude/agents/config-store.md established

## `skills` — ok

- .claude/skills/verify-change/SKILL.md established
- .claude/skills/release-cut/SKILL.md established

## `scripts` — unprovable

- bin/setup established
- bin/dev established
- bin/check already present, left alone
- bin/stop established
- down: ./bin/stop (bin)
- ./bin/setup at head: red, exit 1 (0.1s)

## `wiring` — ok

- .mcp.json established

## `commands` — ok

- .claude/commands/planx.md established
- .claude/commands/feature.md established

## `access` — ok

- asked for 0 credentials
- ./bin/check exited 0 at head (2.4s) without one

## `layout` — gap

- migration to the house layout filed as tasks
- apps/claudes: 8 move(s) planned as one task

## `smoke_test` — ok

- src/dispatch.test.ts in the repository
- run by ./bin/check exited 0 at head (2.4s)

## `env_example` — gap

- nothing recorded

## `agents_md` — ok

- AGENTS.md established

## `per_workspace_brains` — ok

- single-package repository: 0 workspaces
- CLAUDE.md established

## `docs_readme` — ok

- docs/README.md established

## `gate_proved` — ok

- ./bin/check exited 0 at head (2.4s)

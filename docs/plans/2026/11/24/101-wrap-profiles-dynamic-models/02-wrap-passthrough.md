# 02 — wrap passthrough

Depends on: 01. Fixes B1, B2, B3, B21, B23.

## Files

- `src/launch/subcommands.ts` (new) — one pure table and `classify(args)`.
- `src/launch/argv.ts:64` — the `--settings` position comes from the class.
- `src/launch/run.ts:77` — choose the path by class, before config and pre-flight.
- `src/launch/run.ts:30,235` — not-found hint; self-reference refusal.
- `README.md` "Daily use", "Refusals and exit codes"; `src/help.ts:29`; `CLAUDE.md` Structure row.

## Design

`classify` looks at the first argument only, because that is what Claude Code does:

| Class     | First argument or flag                                                                                                                    | Behaviour                                                                                                     |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| manage    | `attach logs stop kill rm respawn daemon mcp plugin plugins update upgrade install auth auto-mode import purge setup-token gateway`, `-h` | exec `claude <args>` unchanged: no `--settings`, no config needed, no pre-flight, env through `buildChildEnv` |
| dispatch  | `agents`, `remote-control`                                                                                                                | full launch, with `--settings <file>` inserted **after** the word                                             |
| offRouter | `ultrareview`; flags `--cloud`, `--environment`, `--desktop`, anywhere before `--`                                                        | refuse, exit 64, naming the flag and never its value                                                          |
| session   | everything else                                                                                                                           | today's launch                                                                                                |

- The router-key refusal runs for every class, before anything is spawned.
- `--settings` and `--key` are refused only for session and dispatch; a managed subcommand's own
  `--settings` is not claudes' business.
- `resolveExecutable` candidates whose realpath is `deps.scriptPath` are refused with their own message
  ("the `claude` on PATH is claudes itself"). A shell-script shim cannot be seen this way; leave it.
- `claude not found on PATH` gains a second line: claudes wraps Claude Code and does not include it;
  install Claude Code first. The exact message is bound by the README table.

## Steps

1. `classify` with table-driven tests.
2. Wire argv and run. Keep `execClaude` the only spawn.
3. Verify live against a stub, for every word in the table: `claudes <word> --help` prints the same first
   line as `claude <word> --help`, and no `POST /v1/messages` reaches the stub.
   Do this in a scratch `HOME`; do not run `purge`, `install`, `update` or `rm` beyond `--help`.
4. `remote-control`: 2.1.331 refuses `--settings` before the word and accepts it after (2.1.321+). Confirm.
5. Check whether 2.1.331 has a `--managed-settings` flag. It would outrank the generated file; if it
   exists, refuse it like `--settings`.

## Tests

- `src/launch/subcommands.test.ts` — every row; a prompt that merely contains a word ("stop the server"
  as one argument) stays a session; `--` ends flag scanning.
- `src/launch/run.test.ts` — manage: no config, dead router, still spawns the exact argv, writes no file.
- `src/launch/run.e2e.test.ts` — a fake `claude` records argv for one word of each class.
- README refusal rows for the off-router and self-reference refusals.

## Done when

B1 and B2 no longer reproduce live, and the recorded table of step 3 is in the PR.

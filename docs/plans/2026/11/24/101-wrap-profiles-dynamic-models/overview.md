# 101 — wrap correctly, profiles, dynamic models

## Goal

Fix the bugs a live audit found in the wrapper. Add named profiles so one install can use several
routers. Make `/model`, the tiers and the context windows come from the router's own `/v1/models` at
every launch instead of from a snapshot taken at login.

## Context

`claudes` ships no agent binary. It finds the user's own `claude` (`src/launch/run.ts:235`), writes a
settings file (`src/launch/settings.ts:198`) and spawns it with `--settings` first
(`src/launch/argv.ts:64`). Every defect below is in that wrapping, or in what doctor says about it.

Audited 2026-11-24: 1207 tests pass, both `tsc` configs are clean. "live" means reproduced with real
Claude Code 2.1.331, a scratch `HOME`, a throwaway key and a local stub router. "read" means found by
reading source or docs and not executed.

| Id  | Sev | Defect                                                                                                                                                                                                                                 | Evidence                                                                                            | Slice |
| --- | --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ----- |
| B1  | P0  | `claudes logs abc`, `stop abc`, `attach abc`, `respawn abc` run as a **prompt**: Claude Code matches these on its first argument and claudes puts `--settings` there. Costs quota, does the wrong thing, exits 0.                      | live: each sent one `POST /v1/messages`; plain `claude logs abc` says "No session matching"         | 02    |
| B2  | P1  | `mcp list`, `plugin list`, `update --help`, `auth status`, `-h` are refused with exit 69 while the router is down, though none of them needs it.                                                                                       | live                                                                                                | 02    |
| B3  | P1  | `--cloud`, `--environment`, `--desktop` and `ultrareview` run somewhere other than the router. README says it "never falls back silently".                                                                                             | partly live: `--cloud` and `--desktop` reached Claude Code's own handling; no session was created   | 02    |
| B4  | P1  | Re-login drops `subagentModel`, `maxContextTokens` and the tier overrides (`src/commands/login.ts:140`).                                                                                                                               | live                                                                                                | 03    |
| B5  | P1  | Every doctor remedy says "re-run `claudes login`" (`src/doctor/checks/router.ts:9`), but bare `claudes login` is a usage error, exit 64 (`src/commands/login-args.ts:87`).                                                             | live                                                                                                | 03    |
| B6  | P1  | One global config: logging in to a second router makes `claudes key` refuse for every running session at its next credential fetch.                                                                                                    | live: `key` refuses, exit 64; a session keeps working only until its cached credential is refetched | 03    |
| B7  | P1  | Pre-flight never checks the key. A revoked key launches and then retries for over 60 s with no output.                                                                                                                                 | live: killed at 60 s after 8 requests                                                               | 04    |
| B8  | P2  | `/healthz` answering 404 is reported as "router unreachable".                                                                                                                                                                          | live                                                                                                | 04    |
| B9  | P1  | The session model is not guarded: a `model` in the user's settings, a planted `ANTHROPIC_MODEL`, or `--model fable` sends an id the router may not serve. Fable is not a tier here at all (`src/tiers.ts:10`).                         | live: all three sent `claude-fable-5-2`                                                             | 04    |
| B10 | P1  | `maxContextTokens` (`src/launch/settings.ts:198`) has no effect for ids Claude Code recognises, login cannot set it, and nothing reads the router's window. If the router serves 200k and Claude Code assumes 1M, a session overflows. | live: `/context` stayed at 1m with the variable at 150000                                           | 04    |
| B11 | P1  | `/model` shows Claude Code's built-in lineup, with Fable offered whether or not it is served, and none of the key's other models.                                                                                                      | live                                                                                                | 04    |
| B12 | P2  | Login fills unserved tiers from `DEFAULT_TIERS` and says nothing; a key that lists no Claude model logs in clean.                                                                                                                      | read: `src/tiers.ts:68`                                                                             | 04    |
| B13 | P2  | `settings.<pid>.json` collides across pid namespaces sharing a config dir, and the dead-pid sweep takes the file away from `--bg` and `/restart` descendants.                                                                          | read: `src/launch/settings-file.ts:31,49`; README lists the sweep as a caveat                       | 05    |
| B14 | P1  | Doctor's wiring probe leaves the plaintext key copy on disk when the terminal closes: `PROBE_SIGNALS` has no `SIGHUP` (`src/doctor/checks/wiring.ts:41`).                                                                              | live: 1 copy left after SIGHUP, 0 after SIGTERM                                                     | 06    |
| B15 | P1  | `CLAUDE_CONFIG_DIR` is ignored: conflicts prints PASS for plants in it, and the probe is not isolated. It reads that directory, **writes** to it, and blames the pinned tiers.                                                         | live                                                                                                | 06    |
| B16 | P2  | effective-model says sessions start on sonnet; they start on opus. It also reports an `advisorModel` for a feature claudes disables.                                                                                                   | live: default session sent `claude-opus-5-5`                                                        | 06    |
| B17 | P2  | When the key helper fails, Claude Code sends an empty `Bearer`, and the stub counts it as a foreign credential (`src/doctor/stub-server.ts:171`). The verdict sends the user hunting for a credential that is not there.               | live                                                                                                | 06    |
| B18 | P2  | Doctor does not name an environment the launcher refuses: unknown `CLAUDE_CODE_USE_*`, host-managed auth. The user gets an unrelated wiring FAIL.                                                                                      | live                                                                                                | 06    |
| B19 | P2  | Doctor reads `managed-settings.json` but not `managed-settings.d/*.json`, which merges into it.                                                                                                                                        | read: Claude Code docs; `src/doctor/checks/conflicts.ts:27`                                         | 06    |
| B20 | P2  | `bin/check` fails on any machine whose global gitignore hides `.claude/settings.local.json`: biome formats that untracked file.                                                                                                        | live                                                                                                | 01    |
| B21 | P3  | A `claude` on PATH that is itself claudes ends in "--settings is not supported". It does not loop, but the message misleads.                                                                                                           | live                                                                                                | 02    |
| B22 | P3  | No usable `HOME` is reported as "no claudes config: run login", which cannot help.                                                                                                                                                     | live                                                                                                | 03    |
| B23 | P3  | "claude not found on PATH" does not say that claudes needs a separate Claude Code install.                                                                                                                                             | live                                                                                                | 02    |

Checked and **not** bugs; do not re-investigate:

- `ANTHROPIC_UNIX_SOCKET`, `CLAUDE_CODE_API_BASE_URL` and `XDG_CONFIG_HOME` planted in settings `env` did not move a `-p` session or its key.
- A failing key helper with a saved claude.ai login did not send that login to the router.
- Deleting the settings file mid-session did not reroute a `-p` session.
- Ctrl-Z through the wrapper suspends and returns the shell, the same as plain `claude`.

Not tested: `claude rm` through the wrapper (treat it like `stop`), a live `--bg` respawn after a
sweep, macOS, and a real router.

### Facts the design rests on

- **`modelPicker`** (Claude Code 2.1.243+) is honoured from `--settings`.
  `{replaceBuiltInOptions, options: [{model, label?, description?, behavesAs?}]}` replaced the lineup
  live, non-Claude ids included. The "Default (recommended)" row stays; only managed settings can
  remove it.
- **Gateway discovery is not enough.** `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY` keeps only ids
  matching `claude|anthropic`, strips sizes, and added no row in our runs. Do not build on it.
- **Windows.** Claude Code's `/v1/models` size readers are compiled off in 2.1.331. What works live:
  `CLAUDE_CODE_MAX_CONTEXT_TOKENS` for unrecognised ids (since 2.1.325 also unrecognised `claude-*`
  ids), and `CLAUDE_CODE_AUTO_COMPACT_WINDOW` as a cap for recognised ones (200000 gave `/context` 200k).
  Both are session-wide, not per model.
- **Router shape.** multi-ai-router answers `/v1/models` by credential header. Bearer, which claudes
  sends, gets `context_length` / `max_completion_tokens`. `x-api-key` gets `max_input_tokens` /
  `max_tokens`, nullable. Alias rows carry `resolved_model`. Sizes are absent or null when unknown.
- **`/model` writes the user's settings.** A pick is saved as `model` in `~/.claude/settings.json`, and a
  later plain `claude` then uses it (live with `glm-4.7`). A `model` pinned in `--settings` hides the
  pick from the next claudes session.

## Slices, in execution order

1. [`01-gate.md`](01-gate.md) — the gate is green on a developer machine and hermetic.
2. [`02-wrap-passthrough.md`](02-wrap-passthrough.md) — subcommands reach `claude` intact; off-router modes are refused.
3. [`03-profiles.md`](03-profiles.md) — several routers, one config file each.
4. [`04-dynamic-models.md`](04-dynamic-models.md) — catalog at launch: `/model`, tiers, windows, key check.
5. [`05-settings-file-lifetime.md`](05-settings-file-lifetime.md) — content-named settings files.
6. [`06-doctor.md`](06-doctor.md) — doctor tells the truth.

02 to 05 all edit `src/launch/run.ts`, so they land one after another. B14, B15, B17, B18 and B19 in
06 depend on nothing and may land first; B14 leaves a key on disk, so prefer that. Every slice updates
its own README rows, help text, `CLAUDE.md` Structure rows and the guards that bind them
(`src/readme.test.ts`, `src/readme-refusals.test.ts`, `src/help.test.ts`,
`src/claude-structure.test.ts`).

## Decisions

- **Profiles are explicit, with no failover.** A dead router stays exit 69. Moving a session to another
  router moves who is billed and who sees the code; that contradicts "never falls back silently".
- **No repo-level profile file.** A cloned repository must not choose where a key goes.
- **One file per profile**, not one file with many. Two logins cannot lose each other's write, the
  0600/0700/atomic store is reused as is, and today's `config.json` is already the `default` profile.
- **`modelPicker` over discovery**, for the reasons above.
- **`/model` persistence is documented, not fought.** claudes still writes nothing under `~/.claude`.

## Done when

- All B rows have a regression test, or a recorded live run where only the real binary can show it.
- `heavy bin/check` exits 0 on Linux and in CI.
- A live run shows two profiles running at once against two stub routers, each stub seeing only its own
  key, and `/model` listing what each stub serves, with no login in between.

## Risks

- Claude Code's first-argument subcommands are not a documented contract. 02 keeps the list in one table
  with a live check and fails visibly for a name it does not know.
- `CLAUDE_CODE_AUTO_COMPACT_WINDOW` below 100k was not tested; the `--autocompact` flag documents a 100k floor.
- The meaning of an empty `ANTHROPIC_MODEL`, `CLAUDE_CODE_MAX_CONTEXT_TOKENS` and
  `CLAUDE_CODE_AUTO_COMPACT_WINDOW` in settings `env` is unverified. 04 verifies each before relying on it.
- A router can list hundreds of ids; 04 orders them and caps the body at the client's existing 1 MiB.

<h1 align="center">claudes</h1>

<p align="center"><strong>Claude Code against your team's own router.</strong> <em>Per-person key, no silent fallback.</em></p>

<div align="center">

[![CI](https://github.com/developerz-ai/claudes/actions/workflows/ci.yml/badge.svg)](https://github.com/developerz-ai/claudes/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@developerz.ai/claudes.svg)](https://www.npmjs.com/package/@developerz.ai/claudes)
[![AI-maintained](https://img.shields.io/badge/maintained%20by-developerz.ai-8a2be2.svg)](#ai-maintained)
[![Node](https://img.shields.io/badge/node-%E2%89%A5%2022-339933.svg?logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/typescript-strict-3178C6.svg?logo=typescript&logoColor=white)](tsconfig.json)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

</div>

`claudes` is a thin launcher that runs Claude Code (`claude`) against your
team's self-hosted, Anthropic-compatible router. It requires
[multi-ai-router](https://github.com/developerz-ai/multi-ai-router) and your own
per-person `mar_live_` key; it cannot talk to the Anthropic API directly.
It never falls back silently: if the wiring is wrong, it fails loudly instead
of quietly sending traffic somewhere else.

## Install

The package is published on npm as
[`@developerz.ai/claudes`](https://www.npmjs.com/package/@developerz.ai/claudes).
To install from a checkout instead, see [Build from source](#build-from-source).

```sh
npm i -g @developerz.ai/claudes
claudes login --url <your router URL>
```

Never `npm i -g claudes`. The unscoped name `claudes` is an unrelated
third-party package; this tool is published only as `@developerz.ai/claudes`.

`claudes login` reads the router key from a `Router key: ` prompt with echo
off, or from the first line of stdin when piped:

```sh
printf '%s\n' "$ROUTER_KEY" | claudes login --url <your router URL>
```

The key is never accepted as a command-line argument. The URL must be a bare
`https://` origin (`http://` is allowed only for `127.0.0.1`, `localhost` or
`[::1]`). Login then checks the router's health, proves the key lists models,
picks the newest model id the router advertises for each of the opus, sonnet
and haiku tiers (built-in defaults fill any gap), and saves the result to
`~/.config/claudes/config.json` (or `$XDG_CONFIG_HOME/claudes/config.json`),
a 0600 file in a 0700 directory. Override the tier pins with `--opus`,
`--sonnet` or `--haiku`.

`claudes login --help` prints the login usage and exits 0; the flags it names
are `--profile`, `--url`, `--opus`, `--sonnet` and `--haiku`.

## Build from source

Prerequisites: Node 22+, npm (bundled with Node), git, and Bun matching
`.bun-version` in the checkout (currently 1.4.4). Use a writable npm global
prefix and put its executable directory on your `PATH`.

```sh
git clone https://github.com/developerz-ai/claudes.git
cd claudes
bin/setup
bin/check
npm i -g .
claudes --version
```

`bin/setup` installs the pinned dependencies; `bin/check` checks the project
and builds the executable before the local global install. The final command
exits 0 and prints the version in `package.json` (currently 0.2.0).
Then run `claudes login --url <your router URL>` as described above; Claude
Code (`claude`) must also be installed and on `PATH` to launch sessions.

## Daily use

Use `claudes` to start a Claude Code session through the router.

```sh
claudes                  # interactive session
claudes -p "..."         # non-interactive print mode
claudes --model opus     # or sonnet / haiku
claudes --version        # or -v
claudes --help           # what claudes itself accepts
```

`--model` takes the tier names `opus|sonnet|haiku`; the longer spellings
`claude-opus`, `claude-sonnet` and `claude-haiku` (with or without a `[1m]`
suffix) are normalised to them.

`claudes` itself owns seven first arguments: `login`, `doctor`, `key`,
`profile`, `--version` (`-v`), `--help` and `--profile <name>`.

Management commands such as `logs`, `attach`, `mcp`, `plugin`, `auth` and `-h`
run directly in Claude Code and work even when the router is down.
`agents` and `remote-control` receive the router settings after the command
word. `ultrareview`, `--cloud`, `--environment` and `--desktop` are refused
because they can run outside the router.

`claudes --help` prints a help text on stdout and exits 0. It names the flags
`claudes` owns itself — `--version`, `-v`, `--help` and `--profile` — and the Claude
Code flags `--model`, `-p` and `-h`.

`claudes key` is the internal helper Claude Code calls to fetch the router
key. It accepts exactly `--profile <name>` or no arguments. The legacy
argument-free helper always uses `default`. At a terminal it refuses with
exit 64.

### Router profiles

Create a named profile with `claudes login --profile work --url <router>`.
Re-login with `claudes login --profile work` to reuse its stored URL and
replace its key. Existing pins and context overrides survive. Use
`--opus auto`, `--sonnet auto` or `--haiku auto` to clear a pin.

A leading `claudes --profile work` selects that router for one session.
It applies only to a session: in front of `login`, `doctor`, `key`,
`profile`, `--version` or `--help` it is refused with exit 64 instead of
sending the word to Claude Code as a prompt. Move the flag after `login`,
`doctor` or `key` (`claudes doctor --profile work`), switch the active
profile with `claudes profile use work`, and drop it for `--help` and
`--version`, which select no profile.
Without the flag, selection is `CLAUDES_PROFILE`, the profile picked with
`claudes profile use work`, and then `default`. An unknown profile fails
with exit 78. Existing installations use `config.json` for `default`.
Named profiles use separate `config.<name>.json` files.

`claudes profile list` shows names and router origins and marks the active
profile. `claudes profile remove work` refuses the active profile. A
session whose profile is removed fails its next credential lookup. Profile
changes share a lock. If a forcibly terminated command leaves an empty
`.profile-lock` directory inside the private config directory, remove the
lock directory after confirming no profile changes are running.

## Models

Each routed launch checks the key and fetches its current model catalog.
`/model` shows the models served for that key, with the router's reported
context and output sizes when available. Claude Code retains its own
Default row. The tier aliases are `opus`, `sonnet`, `haiku`, and `fable`
when the router serves Fable. A missing tier uses another served model.
A rejected credential stops the launch. If model listing otherwise fails,
the launcher uses the stored tier snapshot and reports that fallback.

Existing config files treat their stored tiers as pins while the router
still serves them. Re-login to follow the latest catalog. Login writes
explicit pins only when supplied or already saved, and `auto` clears a pin.
An unserved saved model falls back to the opus tier for this session. An
explicit unlisted `--model` is passed through with a note. Claude Code saves
model choices in its own settings when you ask it to persist the choice.

Context windows use the router's reported size for the launch model.
A configured `maxContextTokens` overrides that size, and shell overrides
take precedence. These controls apply for the whole session. After
`/model`, Claude Code can apply a smaller built-in limit, but it cannot
pick up a new router limit until the next launch. For recognized models,
Claude Code 2.1.331 clamps the auto-compact window to at least 100K and
caps it at the model's own window. For example, a 64K router limit for a
recognized model cannot be enforced by these settings.

## What it does and doesn't do

- It never writes `~/.claude`. Everything `claudes` writes lives under
  `~/.config/claudes` (`$XDG_CONFIG_HOME/claudes`): the config, small
  settings files addressed by profile and content (see "Network, proxies and certificates"), and
  the throwaway directory `claudes doctor`'s wiring probe works in (see
  "`claudes doctor`"). Claude Code itself does write there, as it does under
  plain `claude`: its `/model` command saves the chosen model to
  `~/.claude/settings.json`.
- The router key stays out of the session environment. Claude Code fetches it
  on demand through the `apiKeyHelper` setting, which runs `claudes key`; the
  generated settings pin `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_API_KEY` to
  `""`, and the child environment is stripped of `ANTHROPIC_*`,
  `CLAUDE_CODE_OAUTH_*`, `AWS_BEARER_TOKEN_BEDROCK` and Claude Code's
  provider switches (`CLAUDE_CODE_USE_BEDROCK` and friends).
- It never falls back silently. Before launching, `claudes` checks that the
  router answers; if it does not, the session does not start (exit 69). An
  environment that would reroute the session away from the router is refused
  up front (exit 64). The full list is under "Refusals and exit codes".

Known limitation: the terminal refusal on `claudes key` stops you pasting the
key into your own scrollback by accident, but an agent running as the same
user can still run `claudes key | cat`. The guard is against accidents, not
against a hostile agent.

## Expected start-up warning

If you're also logged in to claude.ai, Claude Code says "auth may not work as
expected". The router key wins: the session runs against your team's router
regardless. `claudes doctor` reports a saved claude.ai login as INFO for
exactly this reason.

## Known gaps through Claude subscriptions

Audited against router **v2.57.0** by source and test inspection, not a live test;
the cited upstream tests were inspected, not executed for this audit. This is
the verified version, not necessarily the first release containing each fix,
and does not establish your router's deployed version or configuration.

Subscription requests have two transports: fast mode sends HTTP directly;
SDK mode/fallback runs a router-side Claude SDK subprocess. The audited router
defaults to fast mode, with SDK fallback; see the inspected
[mode configuration](https://github.com/developerz-ai/multi-ai-router/blob/v2.57.0/apps/api/src/config/env-reader.ts)
and [fast invoker](https://github.com/developerz-ai/multi-ai-router/blob/v2.57.0/apps/api/src/providers/claude-fast/invoker.ts).
SDK-specific limitations below do not describe every subscription request.
Claudes' two Disabled rows are launcher policy and remain enforced regardless
of router improvements. The historical “Router issue” column now records
version-pinned evidence and the confirmation method, not active issue tracking.

The launcher-level picker and the remaining context-window limits are
documented under [Models](#models).

| What                    | Status in a claudes session                                                                                                                                                                                                                                                                                                            | Router issue                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WebSearch               | Disabled (`permissions.deny` in the generated settings): launcher policy remains in force in either transport. The router's SDK mode/fallback rejects non-custom server tools; this is not a blanket claim about fast mode.                                                                                                            | Source inspection: [`rejectServerTools`](https://github.com/developerz-ai/multi-ai-router/blob/v2.57.0/apps/api/src/providers/claude-sdk/request.ts).                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Advisor tool            | Disabled (`CLAUDE_CODE_DISABLE_ADVISOR_TOOL=1` in the generated settings): launcher policy remains in force in either transport. SDK mode/fallback rejects non-custom server tools; fast-mode support would not remove this launcher restriction.                                                                                      | Source inspection: [`rejectServerTools`](https://github.com/developerz-ai/multi-ai-router/blob/v2.57.0/apps/api/src/providers/claude-sdk/request.ts).                                                                                                                                                                                                                                                                                                                                                                                                                      |
| PDFs / document blocks  | Fixed by v2.57.0: the old blanket content-loss claim no longer holds. SDK translation preserves base64 PDFs, text and URL documents, including nested tool results. File-ID and content sources remain unsupported on SDK transport.                                                                                                   | Source inspection: [`documentSourceSchema`, `readDocument`, `toolResultAttachments`](https://github.com/developerz-ai/multi-ai-router/blob/v2.57.0/apps/api/src/providers/claude-sdk/prompt.ts).                                                                                                                                                                                                                                                                                                                                                                           |
| `count_tokens`          | Subscription-only pools now return a labelled estimate rather than the old refusal. It is not an exact token count; API-key pools retain exact counting. The historical `/context` refusal anecdote is not evidence for this version.                                                                                                  | Test inspection: [subscription estimate and exact API-key-pool cases in `count-tokens.test.ts`](https://github.com/developerz-ai/multi-ai-router/blob/v2.57.0/apps/api/test/integration/count-tokens.test.ts).                                                                                                                                                                                                                                                                                                                                                             |
| `anthropic-beta` header | Fixed by v2.57.0: fast mode forwards requested betas via client headers. SDK mode/fallback has no equivalent client-header forwarding in its request/options translation; do not assume parity between transports.                                                                                                                     | Source inspection: [`input.clientHeaders` in the fast invoker](https://github.com/developerz-ai/multi-ai-router/blob/v2.57.0/apps/api/src/providers/claude-fast/invoker.ts), [`fastHeaders` beta merge](https://github.com/developerz-ai/multi-ai-router/blob/v2.57.0/apps/api/src/providers/claude-fast/profile.ts), SDK [request](https://github.com/developerz-ai/multi-ai-router/blob/v2.57.0/apps/api/src/providers/claude-sdk/request.ts) and [options](https://github.com/developerz-ai/multi-ai-router/blob/v2.57.0/apps/api/src/providers/claude-sdk/options.ts). |
| Request duration        | Configurable, transport-specific bounds, not a universal ten-minute cap including queue time. `UPSTREAM_TIMEOUT_MS` defaults to 600000 ms; streaming defaults are 300000 ms first-byte, 55000 ms idle and 3600000 ms total. HTTP and SDK attempts apply deadlines differently; these source defaults do not establish deployed limits. | Source inspection: [`UPSTREAM_TIMEOUT_MS`](https://github.com/developerz-ai/multi-ai-router/blob/v2.57.0/apps/api/src/config/routing-env.ts), [streaming defaults](https://github.com/developerz-ai/multi-ai-router/blob/v2.57.0/apps/api/src/config/upstream-stream.ts), [HTTP attempt deadlines](https://github.com/developerz-ai/multi-ai-router/blob/v2.57.0/apps/api/src/services/dataplane/attempt.ts) and [SDK attempt deadlines](https://github.com/developerz-ai/multi-ai-router/blob/v2.57.0/apps/api/src/services/dataplane/sdk-attempt.ts).                    |
| Working directory       | Fixed by v2.57.0: SDK `isolatedOptions` uses a neutral `workspaceDir(dirname(configDir))`, not the account credential directory. Residual SDK-only context: this is still a router-side workspace, not your client's cwd. Fast transport does not spawn an inference subprocess.                                                       | Source inspection: [`isolatedOptions`](https://github.com/developerz-ai/multi-ai-router/blob/v2.57.0/apps/api/src/providers/claude-sdk/options.ts) and [direct HTTP fast invoker](https://github.com/developerz-ai/multi-ai-router/blob/v2.57.0/apps/api/src/providers/claude-fast/invoker.ts).                                                                                                                                                                                                                                                                            |
| Tool-call relay         | Informational, SDK mode/fallback only: deny/capture relay can make tool calls look declined before client-side results arrive; tools still run on your machine. Fast mode sends HTTP directly and does not use this SDK relay. This is an implementation caveat, not a new live reproduction.                                          | Source inspection: [SDK tool registration](https://github.com/developerz-ai/multi-ai-router/blob/v2.57.0/apps/api/src/providers/claude-sdk/tools/register.ts), [SDK relay options](https://github.com/developerz-ai/multi-ai-router/blob/v2.57.0/apps/api/src/providers/claude-sdk/options.ts) and [fast invoker](https://github.com/developerz-ai/multi-ai-router/blob/v2.57.0/apps/api/src/providers/claude-fast/invoker.ts).                                                                                                                                            |

## Router is down

`claudes` does not start the session. It exits 69 and prints:

```
router unreachable: run `claudes doctor`, or use plain `claude` with your own login (usage won't be attributed)
```

followed, when relevant, by one of the proxy, TLS or timeout notes under
"Network, proxies and certificates". You can keep working with plain `claude`
and your own login; that usage isn't attributed to your router key.

A router that answers the pre-launch check but reports no usable version is a
different refusal with the same exit code (69) and no notes: the router is
reachable, but the configured URL does not point at a router `claudes` can
use.

## Refusals and exit codes

`claudes` refuses loudly rather than guess. Messages are quoted exactly.

| Exit | When                                                                                                                      | Message                                                                                                                                                                                                                                                                                     |
| ---- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 64   | Managed settings were passed on argv (`--managed-settings` or `--managed-settings-in-initialize`)                         | `claudes: <name> is not supported — managed settings could override the router settings`                                                                                                                                                                                                    |
| 64   | A command or flag that runs outside the router                                                                            | `claudes: <name> is not supported — it runs outside the router`                                                                                                                                                                                                                             |
| 127  | `claude` on `PATH` resolves to claudes                                                                                    | `claudes: the claude on PATH is claudes itself`                                                                                                                                                                                                                                             |
| 64   | You passed `--settings`                                                                                                   | `claudes: --settings is not supported — claudes writes its own settings file to point claude at the router`                                                                                                                                                                                 |
| 64   | You passed `--key`                                                                                                        | `claudes: --key is not supported — the router key comes from the config written by \`claudes login\``                                                                                                                                                                                       |
| 64   | An argument looks like a router key (in any position, including after the `--` terminator)                                | `claudes: refusing an argument that looks like a router key — a key on the command line leaks into shell history and process listings`                                                                                                                                                      |
| 64   | `CLAUDE_CODE_HOST_AUTH_ENV_VAR` is set to any non-empty value, `0` and `false` included                                   | `claudes: refusing: <name> is set, so this session would not go to the router`                                                                                                                                                                                                              |
| 64   | An unknown `CLAUDE_CODE_USE_*` toggle or `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST` is set truthy                             | `claudes: refusing: <name> is set, so this session would not go to the router`                                                                                                                                                                                                              |
| 64   | `BUN_CONFIG_VERBOSE_FETCH` is set truthy                                                                                  | `claudes: refusing: BUN_CONFIG_VERBOSE_FETCH is set, so the router key would be printed`                                                                                                                                                                                                    |
| 64   | `claudes key` ran at a terminal                                                                                           | `claudes key is for apiKeyHelper only`                                                                                                                                                                                                                                                      |
| 64   | `claudes key` got a first argument other than `--profile`                                                                 | `claudes key: unknown argument #1\nusage: claudes key [--profile <name>]`                                                                                                                                                                                                                   |
| 69   | The router did not answer the pre-launch check                                                                            | (message above)                                                                                                                                                                                                                                                                             |
| 69   | The router answered the pre-launch check without a usable version                                                         | `router answered the pre-launch check with an invalid version: the configured router URL does not point at a router claudes can use — run \`claudes doctor\``                                                                                                                               |
| 69   | The router returned a health HTTP error                                                                                   | `router health check returned HTTP <name>: run \`claudes doctor\``                                                                                                                                                                                                                          |
| 77   | The router rejected the key during launch                                                                                 | `the router rejected the key: run \`claudes login --profile <name>\``                                                                                                                                                                                                                       |
| 78   | No config, or a config `claudes` refuses to trust                                                                         | `no claudes config: run \`claudes login --url <router>\``                                                                                                                                                                                                                                   |
| 127  | `claude` is not on `PATH`                                                                                                 | `claude not found on PATH\nclaudes wraps Claude Code. Install Claude Code separately and make it available on PATH.`                                                                                                                                                                        |
| 1    | `claudes doctor` had at least one FAIL                                                                                    | (the FAIL lines themselves)                                                                                                                                                                                                                                                                 |
| 64   | `claudes doctor` got an unsupported argument; `--help` is only accepted on its own, where it prints the usage and exits 0 | `claudes doctor: unknown argument #1\nusage: claudes doctor [--live] [--profile <name>]`                                                                                                                                                                                                    |
| 64   | `claudes login` ran without `--url` and the profile has no saved URL                                                      | `usage: claudes login [--profile <name>] [--url <router-url>] [--opus <model-id>] [--sonnet <model-id>] [--haiku <model-id>]\n\nThe router key is read from the "Router key: " prompt, or from the first line of\nstdin when it is piped; it is never accepted as a command-line argument.` |

The seven known provider switches (`CLAUDE_CODE_USE_BEDROCK` and friends) are
not a launch refusal: they are stripped from the child environment and pinned off
in the generated settings. Unknown `CLAUDE_CODE_USE_*` names are refused,
because `claudes` cannot know that they do not reroute the session; three
known-benign tool toggles are allowlisted.

The two env refusals above gate on different things, and both name the
variable in the message. `CLAUDE_CODE_HOST_AUTH_ENV_VAR` carries the _name_
of the env var holding the host's credential, so any non-empty value counts
— `0` and `false` included, because the variable is read as a name, not as a
flag. `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST` and the unknown
`CLAUDE_CODE_USE_*` toggles are flags, so only a truthy value counts: unset,
empty, `0` and `false` are all left alone.

## `claudes doctor`

```sh
claudes doctor [--live] [--profile <name>]
```

`claudes doctor --help` prints that usage and exits 0; the only flag it names
are `--live` and `--profile <name>`.

Runs every check in order, printing each verdict as it arrives — the wiring
probe alone can take a minute — and exits 1 when any check FAILed, 0
otherwise. The router key is never printed: it appears only as its
`mar_live_…` prefix, and every output line is scrubbed.

Statuses: PASS means checked and good. WARN means the session probably works
but you should fix it. FAIL means broken, and doctor exits 1. INFO is
informational, nothing to fix. FAIL and WARN lines are followed by an
indented `fix:` line.

| Check                | What it does                                                                                                                                                                                                                                                  | When it doesn't pass                                                                                                                                                                                               |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| runtime              | Not native Windows; Node 22 or newer runs `claudes`; `claude` is on `PATH` and reports a version at or above the tested minimum (2.1.325)                                                                                                                     | FAIL: on Windows use WSL; otherwise install or update Node or Claude Code as the fix line says                                                                                                                     |
| config               | The config exists, is 0600 in a 0700 directory, is owned by you and parses; shows the key as `mar_live_…` and the three pinned tiers                                                                                                                          | FAIL: the fix line carries the loader's own remedy — usually re-run `claudes login`                                                                                                                                |
| router               | The router answers `/healthz` with a version, your key lists `/v1/models`, and every pinned tier is served                                                                                                                                                    | FAIL: check the router is running and reachable; if it rejected the key (HTTP 401/403), re-run `claudes login`. WARN (a pinned tier is not served): re-run `claudes login`                                         |
| conflicts            | Shell credentials, user settings under `CLAUDE_CONFIG_DIR` (a relative one resolved against the working directory, as Claude Code does) or `~/.claude`, project settings, and system-managed settings and drop-ins.                                           | WARN for local settings conflicts. FAIL for managed settings conflicts or unreadable managed settings.                                                                                                             |
| launch environment   | Checks the provider and host-auth environment switches that the launcher refuses.                                                                                                                                                                             | FAIL names the variable. The wiring probe is skipped.                                                                                                                                                              |
| wiring               | The zero-quota probe runs Claude Code with a scratch config and a local stub. It checks that the only credential is the profile key and that the request uses the resolved launch model.                                                                      | FAIL for a missing or competing credential or a model mismatch. Skipped when the launcher refuses the environment.                                                                                                 |
| live (`--live` only) | Exactly one `POST /v1/messages` with `max_tokens 1` on the Haiku tier, through the real router with the real key; reports only the HTTP status and the router's request id, never the body — a request id carrying key material is withheld and never printed | FAIL: check the router is running and reachable; on a non-200, take the request id to the router's logs when one was shown — a request id carrying key material is withheld, so there is no id to take to the logs |
| effective-model      | The launch model selected from the profile and saved settings, any configured subagent model, and the configured context window and its source.                                                                                                               | WARN when the live catalog omits the configured subagent model.                                                                                                                                                    |

Without `--live`, doctor costs no router quota: it only asks the router for
its health and model list, and the wiring probe talks to the local stub.

The wiring probe is the one check that needs the real key on disk: the
generated settings point Claude Code at the local recording stub, and the
stub sees the key only when `claudes key` serves it. So the probe writes a
throwaway copy of the config — the real key, 0600, inside 0700 directories
— and points the child's `HOME` and `XDG_CONFIG_HOME` at it. The probe clears
`CLAUDE_CONFIG_DIR` so Claude Code uses the scratch home. The key never enters the child's environment: the probe proves the same helper path a real
session uses.

That copy lives inside the config directory
(`~/.config/claudes/probe.<pid>`), not in the OS temp directory: the
documented uninstall reaches it, and the next doctor run sweeps a probe
directory whose pid is dead. The probe deletes the copy when its child
exits — on the PASS path and on the FAIL path — and a run interrupted with
Ctrl-C, `SIGTERM` or `SIGHUP` deletes it before the process dies. Cleanup deletes the
copy first, before the signal traps come off and before the stub's socket is
closed, so an interrupt during teardown finds nothing to strand.

A symlinked path is refused: the config directory, the probe's own
directory, or a directory inside it. The copy would live in the link's
target, where neither the uninstall nor the sweep reaches it. And when the
copy cannot be deleted at all, the probe keeps its signal traps armed — so
an interrupt during teardown still takes it — and fails with the copy's path
instead of claiming a clean run.

Doctor still judges probe directory liveness in its own PID namespace.
Sharing the config directory across containers can make a live doctor probe
look stale to another container.

## Network, proxies and certificates

The launcher pins the network-related variables in the generated settings
file to your shell's own values — or to an empty string when your shell has
none: `HTTP_PROXY`/`http_proxy`, `HTTPS_PROXY`/`https_proxy`,
`ALL_PROXY`/`all_proxy`, `NO_PROXY`/`no_proxy`, `NODE_TLS_REJECT_UNAUTHORIZED`,
`NODE_EXTRA_CA_CERTS`, `NODE_USE_ENV_PROXY`, `NODE_OPTIONS`,
`CLAUDE_CODE_CERT_STORE` and `BUN_CONFIG_VERBOSE_FETCH`. A proxy pair is
pinned as a pair: set one spelling and both get it, set both and each keeps
its own value; the two `NO_PROXY` spellings get one merged list.
`SSL_CERT_FILE` and `SSL_CERT_DIR` are carried over only when your
shell sets them (for those, empty is not the same as unset).

Consequence: a proxy or CA configured only in `~/.claude/settings.json` — and
not exported in your shell — does not apply to claudes sessions; the pins
override settings-file values. Export it in your shell instead.

When the router is on loopback, its hostname plus `127.0.0.1,localhost,::1`
are prepended to the merged `NO_PROXY`, so no proxy ever sees the plaintext
loopback hop.

Generated settings use the name `settings.<profile>.<digest>.json` inside
the private config directory. A keyed SHA-256 digest covers the contents,
so launches with the same settings and key reuse the file. A changed model,
proxy, or profile key gets a new file. A settings file can contain credentials embedded in a proxy URL.
Files are 0600 inside the 0700 directory.

Completed settings files, including older PID-named files, survive later
launches so `/restart`, tmux and detached sessions can still read them.
The launcher removes only temporary write siblings older than 24 hours —
of settings files, config files and the active-profile marker, which a crash
mid-write can strand (a config temporary holds the key).
`claudes profile remove` removes only settings named for that profile.
Older PID-named files can also contain proxy credentials. Removing the
config directory during uninstall removes every form.

Before launching, `claudes` checks the router's `/healthz`. The check is
bounded by `CLAUDES_PREFLIGHT_TIMEOUT_MS` (integer milliseconds, 1 to
2147483647, default 1500; any other value is ignored) and is retried exactly
once, only after a timeout. It runs on Node's own fetch, which ignores
`HTTP(S)_PROXY` unless you opt in. When a hint applies, `claudes` prints it
under the unreachable message, exactly as follows:

```
note: claudes' router check does not use HTTP(S)_PROXY; set NODE_USE_ENV_PROXY=1 if your network needs a proxy
note: the router's TLS certificate was not trusted; if its CA is in your system store set NODE_USE_SYSTEM_CA=1 (NODE_USE_SYSTEM_CA needs Node 22.19 or 24.6 or newer), or point NODE_EXTRA_CA_CERTS at it
note: the router's TLS certificate has expired
note: the router's TLS certificate is not valid yet; check this machine's clock
note: the router's TLS certificate does not match its host name
note: the router check timed out; set CLAUDES_PREFLIGHT_TIMEOUT_MS (milliseconds) to wait longer
```

The hints name variables to set in your shell; `claudes` does not strip them,
so they reach the session too.

## Environment variables

`claudes` reads the variables below from your shell's environment, and from
nothing else. It never reads a `.env` file: `.env.example` in this repository
is a reference list of the same names, not a config file claudes loads. The
router key is never an environment variable — `claudes login` reads it from
the prompt or from the first line of stdin and stores it in the config file,
and it is never taken from the environment or from the command line.

| Variable                                 | Purpose                                                                                                                                                                                                                                              | Default or refusal                                                                                                                                                                                                                                                                   |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `XDG_CONFIG_HOME`                        | The base directory the config lives under: `$XDG_CONFIG_HOME/claudes/config.json`.                                                                                                                                                                   | Defaults to `$HOME/.config`. A relative value is ignored, and with no absolute `HOME` either the commands that need the config directory refuse with exit 78; `claudes doctor` reports the config as a FAIL and exits 1, and `--version` exits 0.                                    |
| `HOME`                                   | The fallback base for the config directory: `$HOME/.config/claudes`.                                                                                                                                                                                 | No default: a relative `HOME` is ignored, and without an absolute `XDG_CONFIG_HOME` or `HOME` the commands that need the config directory refuse with exit 78; `claudes doctor` reports the config as a FAIL and exits 1, and `--version` exits 0.                                   |
| `PATH`                                   | Where `claudes` looks for the `claude` executable it launches.                                                                                                                                                                                       | No default: without `claude` on `PATH` the session does not start (exit 127).                                                                                                                                                                                                        |
| `CLAUDE_CONFIG_DIR`                      | Claude Code settings directory, used to read the saved model and by the `claudes doctor` conflicts check. A relative value is resolved against the working directory, as Claude Code does.                                                           | Defaults to `$HOME/.claude`.                                                                                                                                                                                                                                                         |
| `CLAUDE_CODE_AUTO_COMPACT_WINDOW`        | Overrides the launch model's auto-compact window.                                                                                                                                                                                                    | Defaults to the router's known context window.                                                                                                                                                                                                                                       |
| `CLAUDE_CODE_MAX_CONTEXT_TOKENS`         | Overrides Claude Code's context limit for custom models.                                                                                                                                                                                             | Defaults to the resolved context window.                                                                                                                                                                                                                                             |
| `CLAUDES_GENERATED_WINDOWS`              | Internal marker naming windows supplied by an outer launch.                                                                                                                                                                                          | Set by the launcher for nested sessions.                                                                                                                                                                                                                                             |
| `CLAUDES_PROFILE`                        | Selects a router profile for login, doctor and routed launches.                                                                                                                                                                                      | Unset uses the active profile. An explicitly empty value is invalid.                                                                                                                                                                                                                 |
| `CLAUDES_PREFLIGHT_TIMEOUT_MS`           | How long the router's pre-launch check waits, in milliseconds.                                                                                                                                                                                       | 1500. Any value that is not an integer from 1 to 2147483647 is ignored.                                                                                                                                                                                                              |
| `BUN_CONFIG_VERBOSE_FETCH`               | Bun's verbose request logging, which prints every request header; the generated settings pin it to `""`.                                                                                                                                             | Unset. A truthy value in your shell refuses the session (exit 64): the router key would be printed.                                                                                                                                                                                  |
| `ANTHROPIC_BASE_URL`                     | The endpoint the session talks to; the generated settings pin it to the configured router.                                                                                                                                                           | Unset. A value that is not the configured router's origin makes `claudes key` refuse (exit 64): the key would be served to another endpoint.                                                                                                                                         |
| `HTTP_PROXY`, `http_proxy`               | The proxy for HTTP requests; pinned to your shell's own value in the generated settings.                                                                                                                                                             | Unset, then pinned to an empty string. The pair is pinned as a pair: set one spelling and both get it, set both and each keeps its own value.                                                                                                                                        |
| `HTTPS_PROXY`, `https_proxy`             | The proxy for HTTPS requests; pinned to your shell's own value in the generated settings.                                                                                                                                                            | Unset, then pinned to an empty string. The pair is pinned as a pair: set one spelling and both get it, set both and each keeps its own value.                                                                                                                                        |
| `ALL_PROXY`, `all_proxy`                 | The catch-all proxy; pinned to your shell's own value in the generated settings.                                                                                                                                                                     | Unset, then pinned to an empty string. The pair is pinned as a pair: set one spelling and both get it, set both and each keeps its own value.                                                                                                                                        |
| `NO_PROXY`, `no_proxy`                   | The hosts that bypass the proxy; the two spellings get one merged list, with the router's own host and the loopback hosts prepended when the router runs on this machine.                                                                            | Unset, then pinned to an empty string.                                                                                                                                                                                                                                               |
| `NODE_TLS_REJECT_UNAUTHORIZED`           | Whether Node accepts a certificate it cannot verify; pinned to your shell's own value.                                                                                                                                                               | Unset, then pinned to an empty string.                                                                                                                                                                                                                                               |
| `NODE_EXTRA_CA_CERTS`                    | The CA bundle Node trusts; pinned to your shell's own value.                                                                                                                                                                                         | Unset, then pinned to an empty string.                                                                                                                                                                                                                                               |
| `NODE_USE_ENV_PROXY`                     | Whether Node's own fetch goes through the proxy variables; pinned to your shell's own value.                                                                                                                                                         | Unset, then pinned to an empty string. The router check ignores `HTTP_PROXY` and `HTTPS_PROXY` unless this is set.                                                                                                                                                                   |
| `NODE_OPTIONS`                           | Node's own options; pinned to your shell's own value and merged into the key helper's environment.                                                                                                                                                   | Unset, then pinned to an empty string.                                                                                                                                                                                                                                               |
| `CLAUDE_CODE_CERT_STORE`                 | The certificate store Claude Code trusts; pinned to your shell's own value.                                                                                                                                                                          | Unset, then pinned to an empty string.                                                                                                                                                                                                                                               |
| `SSL_CERT_FILE`                          | The CA file the OpenSSL clients in the session use; carried over only when your shell sets it.                                                                                                                                                       | Unset, then left out of the generated settings: never pinned to an empty string, because an empty CA store breaks every HTTPS request those clients make.                                                                                                                            |
| `SSL_CERT_DIR`                           | The CA directory the OpenSSL clients in the session use; carried over only when your shell sets it.                                                                                                                                                  | Unset, then left out of the generated settings: never pinned to an empty string, because an empty CA store breaks every HTTPS request those clients make.                                                                                                                            |
| `CLAUDE_CODE_USE_BEDROCK`                | A switch that points Claude Code at another provider; stripped from the session environment and pinned to `""` in the generated settings.                                                                                                            | Off, so the session goes to the router. `claudes key` refuses (exit 64) when the switch is truthy in its own environment.                                                                                                                                                            |
| `CLAUDE_CODE_USE_VERTEX`                 | A switch that points Claude Code at another provider; stripped from the session environment and pinned to `""` in the generated settings.                                                                                                            | Off, so the session goes to the router. `claudes key` refuses (exit 64) when the switch is truthy in its own environment.                                                                                                                                                            |
| `CLAUDE_CODE_USE_FOUNDRY`                | A switch that points Claude Code at another provider; stripped from the session environment and pinned to `""` in the generated settings.                                                                                                            | Off, so the session goes to the router. `claudes key` refuses (exit 64) when the switch is truthy in its own environment.                                                                                                                                                            |
| `CLAUDE_CODE_USE_MANTLE`                 | A switch that points Claude Code at another provider; stripped from the session environment and pinned to `""` in the generated settings.                                                                                                            | Off, so the session goes to the router. `claudes key` refuses (exit 64) when the switch is truthy in its own environment.                                                                                                                                                            |
| `CLAUDE_CODE_USE_ANTHROPIC_AWS`          | A switch that points Claude Code at another provider; stripped from the session environment and pinned to `""` in the generated settings.                                                                                                            | Off, so the session goes to the router. `claudes key` refuses (exit 64) when the switch is truthy in its own environment.                                                                                                                                                            |
| `CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD` | A switch that points Claude Code at another provider; stripped from the session environment and pinned to `""` in the generated settings.                                                                                                            | Off, so the session goes to the router. `claudes key` refuses (exit 64) when the switch is truthy in its own environment.                                                                                                                                                            |
| `CLAUDE_CODE_USE_GATEWAY`                | A switch that points Claude Code at another provider; stripped from the session environment and pinned to `""` in the generated settings.                                                                                                            | Off, so the session goes to the router. `claudes key` refuses (exit 64) when the switch is truthy in its own environment.                                                                                                                                                            |
| `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST`   | A host process that manages Claude Code's provider and auth environment; Claude Code then ignores the generated settings file outright.                                                                                                              | Unset. A truthy value refuses the session (exit 64): the session would silently skip the router.                                                                                                                                                                                     |
| `CLAUDE_CODE_HOST_AUTH_ENV_VAR`          | The name of the env var holding the host's own credential.                                                                                                                                                                                           | Unset. Any non-empty value refuses the session (exit 64), `0` and `false` included: the variable is read as a name, not as a flag.                                                                                                                                                   |
| `CLAUDE_CODE_USE_POWERSHELL_TOOL`        | A known-benign `CLAUDE_CODE_USE_` toggle: it picks a local tool implementation, not another provider.                                                                                                                                                | Passed through to the session unchanged; never refused.                                                                                                                                                                                                                              |
| `CLAUDE_CODE_USE_NATIVE_FILE_SEARCH`     | A known-benign `CLAUDE_CODE_USE_` toggle: it picks a local tool implementation, not another provider.                                                                                                                                                | Passed through to the session unchanged; never refused.                                                                                                                                                                                                                              |
| `CLAUDE_CODE_USE_COWORK_PLUGINS`         | A known-benign `CLAUDE_CODE_USE_` toggle: it picks a local tool implementation, not another provider.                                                                                                                                                | Passed through to the session unchanged; never refused.                                                                                                                                                                                                                              |
| `CLAUDE_CODE_USE_*`                      | Every other variable under this prefix — a name that is neither one of the seven provider switches above nor one of the three known-benign toggles. `claudes` cannot know what such a name does, so it cannot rule out that it reroutes the session. | Refused (exit 64) when truthy: the launcher refuses it before the session starts, and `claudes key` refuses it too. A known provider switch is not refused at launch — it is stripped from the session and pinned off instead — though `claudes key` refuses a truthy one (exit 64). |
| `ANTHROPIC_*`                            | Anthropic's own credentials and endpoint settings; the session's copy is stripped, so a leftover personal key cannot win over the router.                                                                                                            | Stripped from the session environment. The generated settings set the names Claude Code needs: the credential names to `""`, the base URL to the configured router.                                                                                                                  |
| `CLAUDE_CODE_OAUTH_*`                    | A claude.ai OAuth credential; stripped from the session environment so it cannot authenticate the session anywhere but the router.                                                                                                                   | Stripped from the session environment.                                                                                                                                                                                                                                               |
| `AWS_BEARER_TOKEN_BEDROCK`               | The Bedrock bearer credential, the one credential outside the namespaces above; stripped from the session environment.                                                                                                                               | Stripped from the session environment.                                                                                                                                                                                                                                               |

## Uninstall

```sh
npm rm -g @developerz.ai/claudes && rm -rf ~/.config/claudes
```

(With `XDG_CONFIG_HOME` set, remove `$XDG_CONFIG_HOME/claudes` instead.)
Nothing else is left behind: `claudes` never writes `~/.claude`, and the
per-launch settings files and `claudes doctor`'s throwaway probe directory
live inside the config directory.

## The uninstall drill

The uninstall is the one step that only a real run can prove, so it has a
drill of its own: take the baseline, install, log in, run one session,
uninstall, and check that nothing of yours was touched. Run it on a dev box
against your own router and paste the result on
[developerz-ai/claudes#5](https://github.com/developerz-ai/claudes/issues/5).

```sh
# 1. baseline: Claude Code's own settings file, before anything of yours runs
sha256sum ~/.claude/settings.json     # Linux; on macOS: shasum -a 256 ~/.claude/settings.json

# 2. install
npm i -g @developerz.ai/claudes

# 3. login
claudes login --url <your router URL>

# 4. session
claudes -p "hello"

# 5. uninstall
npm rm -g @developerz.ai/claudes && rm -rf ~/.config/claudes

# 6. checksum: the same file again — it must be the one from step 1
#    (unless Claude Code has never run on this machine: see the note below)
sha256sum ~/.claude/settings.json     # Linux; on macOS: shasum -a 256 ~/.claude/settings.json

# 7. plain claude: plain claude still starts
claude --version
```

What the drill proves:

- `claudes` never writes `~/.claude/settings.json` — not at the install, not
  at the login, not during the session, not after the uninstall — so the
  checksum from step 6 is the one from step 1. The baseline is taken before
  the install, so a change by any of those four steps shows up.
- One difference is Claude Code's own, not `claudes`': on a machine where
  Claude Code has never run a session, its first session rewrites the model
  alias in that file (`"model": "opus"` → `"model": "opus[1m]"`). Plain
  `claude` does the same with no `claudes` involved, and never again after
  that. Run the drill twice — the second run's checksums must match — or run
  one plain `claude` session before step 1.
- The uninstall removed everything `claudes` wrote: the config, the per-launch
  settings file and `claudes doctor`'s throwaway probe directory all live
  under `~/.config/claudes` (or `$XDG_CONFIG_HOME/claudes`).
- Plain `claude` still starts afterwards: no leftover settings file and no
  leftover environment break your own sessions.
- The session went to your router: `claudes doctor` proves the wiring, and the
  session's own traffic is the router's.

### What to paste on the issue

The issue asks for the drill's results, and the checksums are what make the
claim checkable. Paste these seven lines on it, one per step, with your own
values in them:

```text
1. baseline: ~/.claude/settings.json -> absent
2. install: claudes --version -> exit 0, <claudes' version>
3. login: exit 0, logged in to <your router URL>
4. session: exit 0; the router saw the session carry the router key
5. uninstall: claudes is gone from PATH, the config directory is gone
6. checksum: before -> absent | after -> absent (MATCH)
7. plain claude: exit 0, <claude's version>
```

A recorded run of the whole lifecycle — the real Claude Code, the packed
tarball, the local stack, both passes and the matching checksums — is in the
repository's [`CLAUDE.md`](CLAUDE.md).

### The same drill against a local router stack

The drill above needs the team's router, which a newcomer may not have. It
is not needed to run the whole drill: a local stack answers the endpoints
`claudes` itself talks to. The package can come from npm or from the tarball
this repository builds.

Save this as `router.mjs`:

```js
// A local stand-in for the team's router: just enough of it for the drill —
// the health probe, the model list and one assistant turn. It expects the
// drill's own key in the ROUTER_KEY environment variable and compares every
// credential a request carries against it: the verdict goes to the log, the
// value never does, and a request without the right key is refused.
import { createServer } from "node:http";

const MODELS = ["claude-opus-4-1", "claude-sonnet-4-5", "claude-haiku-4-5"];

const EXPECTED = process.env.ROUTER_KEY ?? "";
if (EXPECTED === "") {
  console.log("router: set ROUTER_KEY to the drill's key before starting the stack");
  process.exit(1);
}

// The credential one request carried: the x-api-key value, a Bearer body, or
// "" for none — the shapes the router key legitimately travels in.
function credentialOf(req) {
  const apiKey = req.headers["x-api-key"];
  if (typeof apiKey === "string" && apiKey !== "") {
    return apiKey;
  }
  const auth = req.headers.authorization;
  if (typeof auth === "string" && auth !== "") {
    return auth.startsWith("Bearer ") ? auth.slice(7) : auth;
  }
  return "";
}

const server = createServer((req, res) => {
  const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
  const sent = credentialOf(req);
  // none / match / mismatch: the comparison is the drill's evidence that the
  // configured key travelled, and no key material reaches the log.
  const state = sent === "" ? "none" : sent === EXPECTED ? "match" : "mismatch";
  console.log(`${req.method} ${path} credential=${state}`);
  if (path === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ version: "1.4.2" }));
    return;
  }
  const refuse = () => {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { type: "authentication_error" } }));
  };
  if (path === "/v1/models") {
    if (state !== "match") {
      refuse();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: MODELS.map((id) => ({ id })) }));
    return;
  }
  if (path === "/v1/messages") {
    if (state !== "match") {
      refuse();
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    const events = [
      [
        "message_start",
        {
          type: "message_start",
          message: {
            id: "msg_1",
            type: "message",
            role: "assistant",
            model: MODELS[1],
            content: [],
            stop_reason: null,
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        },
      ],
      [
        "content_block_start",
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        },
      ],
      [
        "content_block_delta",
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "pong" },
        },
      ],
      ["content_block_stop", { type: "content_block_stop", index: 0 }],
      [
        "message_delta",
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { output_tokens: 1 },
        },
      ],
      ["message_stop", { type: "message_stop" }],
    ];
    for (const [event, data] of events) {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    }
    res.end();
    return;
  }
  res.writeHead(404);
  res.end("{}");
});

server.listen(0, "127.0.0.1", () => {
  console.log(`router: http://127.0.0.1:${server.address().port}`);
});
```

Start it with the drill's key in its environment, so it can compare — the key
is the same throwaway one you paste at the login prompt below:

```sh
ROUTER_KEY='<a throwaway key in the router's shape: mar_live_ plus 32 characters>' node router.mjs
```

It prints the URL it listens on and one line per request — the method, the
path, and the credential verdict: `none` when the request carried no
credential, `match` when the credential is the drill key, `mismatch` when it
is anything else. A `/v1/models` or `/v1/messages` request that does not
carry the drill key is refused with a 401, so the drill cannot record a
successful session on the wrong key: a session line reading
`credential=match` is what proves the router key travelled. The credential
itself is never printed.

Then run the same seven steps, with two changes: install the tarball this
repository builds instead of the published package, and log in against the
stack's own URL:

```sh
# 2. install the tarball this repository builds, so the drill tests this
#    checkout (the file name carries package.json's version)
bun run build
npm pack
npm i -g ./developerz.ai-claudes-0.2.0.tgz

# 3. login against the local stack; at the prompt paste the SAME throwaway
#    key the stack was started with — the router's shape, `mar_live_` followed
#    by 32 characters. The stack compares it and refuses any other key.
claudes login --url http://127.0.0.1:<the port the stack printed>
```

Steps 1, 4, 5, 6 and 7 are the ones above, unchanged. One detail: on a
machine where Claude Code has never run, `~/.claude/settings.json` may not
exist yet — take the baseline as "absent", and after the drill the file must
either still be absent or hold only Claude Code's own first-session change
(the note above).

This is the walkthrough to run when the published package and the team's router
are out of reach. It ends in the same seven steps, and the seven lines are
what goes on the issue; for step 4, the stack's
`POST /v1/messages credential=match` line is the evidence that the configured
router key travelled.

The same drill runs as an automated check in this repository's test suite,
against a local router stub and a fake `claude` instead of your router and
your Claude Code: it proves the mechanics — the config lands, the key travels
through `claudes key`, the checksum of Claude Code's own settings file is
taken before the install and compared after the login, the session and the
uninstall, the session's own output carries no fragment of the key, and the
uninstall removes what it claims to. What it cannot prove is your machine:
the real Claude Code binary is not in the checkout — the recipe above runs
the same drill with the real binary, against a local stack.

## Platforms

Linux, macOS and WSL. Node 22 or newer, plus Claude Code at or above the
version `claudes doctor` tests against (2.1.325 today). Native Windows is not
supported: there `claudes doctor` FAILs with the instruction to run inside
WSL.

## AI-maintained

`claudes` is maintained by the [developerz.ai](https://developerz.ai) maintainer
agent, under the policy committed in
[`.dz/maintainer/maintainer.yml`](.dz/maintainer/maintainer.yml):

| What                                    | What happens                                                                                                                                                                              |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| an issue                                | triaged; the reporter is asked for a reproduction when one is missing; a qualified issue goes straight to the developerz.ai coding fleet                                                  |
| a pull request                          | reviewed by CodeRabbit and the developerz.ai reviewer, which comments but never approves; merged automatically only when CI is green, the review verdict passes and branch rules allow it |
| a pull request over 500 changed lines   | waits for a human                                                                                                                                                                         |
| a hostile thread, or a direct mention   | goes to a human                                                                                                                                                                           |
| a branch with no new commit for 60 days | tagged `archive/<branch>/<date>` at its last commit, then deleted                                                                                                                         |
| a daily survey                          | files only what is already broken: red CI, failing tests, a security advisory, a broken build or link                                                                                     |

The agent does not cut releases here: a release is a GitHub release of a
`v<version>` tag, published to npm by [`release.yml`](.github/workflows/release.yml).
The reviewer's repo-specific rules live in
[`.dz/maintainer/reviewer.md`](.dz/maintainer/reviewer.md).

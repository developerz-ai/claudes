# claudes

`claudes` is a thin launcher that runs Claude Code (`claude`) against your
team's self-hosted, Anthropic-compatible router using your own per-person key.
It never falls back silently: if the wiring is wrong, it fails loudly instead
of quietly sending traffic somewhere else.

## Install

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

## Daily use

Type `claudes` wherever you would type `claude`; every argument passes
through:

```sh
claudes                  # interactive session
claudes -p "..."         # non-interactive print mode
claudes --model opus     # or sonnet / haiku
claudes --version        # or -v
```

`--model` takes the tier names `opus|sonnet|haiku`; the longer spellings
`claude-opus`, `claude-sonnet` and `claude-haiku` (with or without a `[1m]`
suffix) are normalised to them.

`claudes` itself owns only four first arguments: `login`, `doctor`, `key` and
`--version` (`-v`). Everything else goes to `claude`. `claudes key` is the
internal helper Claude Code calls to fetch the router key; at a terminal it
refuses (exit 64).

## What it does and doesn't do

- It never writes `~/.claude`. Everything `claudes` writes lives under
  `~/.config/claudes` (`$XDG_CONFIG_HOME/claudes`): the config, one small
  settings file per launch (see "Network, proxies and certificates"), and
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

Confirmed by the spike
([developerz-ai/multi-ai-router#211](https://github.com/developerz-ai/multi-ai-router/issues/211))
and its final verdict
([developerz-ai/multi-ai-router#213](https://github.com/developerz-ai/multi-ai-router/issues/213)),
linked here as the source. The table may shrink as the router catches up.

| What | Status in a claudes session | Router issue |
| --- | --- | --- |
| WebSearch | Disabled (`permissions.deny` in the generated settings): the subscription path cannot serve server tools | [#210](https://github.com/developerz-ai/multi-ai-router/issues/210) |
| Advisor tool | Disabled (`CLAUDE_CODE_DISABLE_ADVISOR_TOOL=1` in the generated settings): it rides every main turn and the subscription path rejects it | [#210](https://github.com/developerz-ai/multi-ai-router/issues/210) |
| PDFs / document blocks | Confirmed live: the model sees only a "PDF file read" line, never the content | [#298](https://github.com/developerz-ai/multi-ai-router/issues/298) |
| `count_tokens` | Refused on a subscription-only pool. Interactive `/context` does call it: one `/context` made 50 calls, all refused, and `/context` then shows a wrong message-token figure. `claude -p` runs did not call it | [#299](https://github.com/developerz-ai/multi-ai-router/issues/299) |
| `anthropic-beta` header | Not forwarded on the subscription path | [#213](https://github.com/developerz-ai/multi-ai-router/issues/213) |
| Request duration | A single request is capped at 10 minutes, queue time included | [#213](https://github.com/developerz-ai/multi-ai-router/issues/213) |
| Working directory | The router-side working directory is visible to the model, so it may try to read paths that do not exist on your machine | [#296](https://github.com/developerz-ai/multi-ai-router/issues/296) |
| Tool-call relay | Informational: the model may mention that its tool calls "look declined" before the results arrive. That is how the router relays tool calls; the tools still run on your machine | None |

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

| Exit | When | Message |
| --- | --- | --- |
| 64 | You passed `--settings` | `claudes: --settings is not supported — claudes writes its own settings file to point claude at the router` |
| 64 | You passed `--key` | `claudes: --key is not supported — the router key comes from the config written by \`claudes login\`` |
| 64 | An argument looks like a router key (in any position, including after the `--` terminator) | `claudes: refusing an argument that looks like a router key — a key on the command line leaks into shell history and process listings` |
| 64 | `CLAUDE_CODE_HOST_AUTH_ENV_VAR` is set to any non-empty value, `0` and `false` included | `claudes: refusing: <name> is set, so this session would not go to the router` |
| 64 | An unknown `CLAUDE_CODE_USE_*` toggle or `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST` is set truthy | `claudes: refusing: <name> is set, so this session would not go to the router` |
| 64 | `BUN_CONFIG_VERBOSE_FETCH` is set truthy | `claudes: refusing: BUN_CONFIG_VERBOSE_FETCH is set, so the router key would be printed` |
| 64 | `claudes key` ran at a terminal | `claudes key is for apiKeyHelper only` |
| 69 | The router did not answer the pre-launch check | (message above) |
| 69 | The router answered the pre-launch check without a usable version | `router answered the pre-launch check with an invalid version: the configured router URL does not point at a router claudes can use — run \`claudes doctor\`` |
| 78 | No config, or a config `claudes` refuses to trust | `no claudes config: run \`claudes login --url <router>\`` |
| 127 | `claude` is not on `PATH` | `claude not found on PATH` |
| 1 | `claudes doctor` had at least one FAIL | (the FAIL lines themselves) |
| 64 | `claudes doctor` got an argument other than `--live` | `claudes doctor: unknown argument #1\nusage: claudes doctor [--live]` |
| 64 | `claudes login` ran without `--url` | `usage: claudes login --url <router-url> [--opus <model-id>] [--sonnet <model-id>] [--haiku <model-id>]\n\nThe router key is read from the "Router key: " prompt, or from the first line of\nstdin when it is piped; it is never accepted as a command-line argument.` |

The seven known provider switches (`CLAUDE_CODE_USE_BEDROCK` and friends) are
not a launch refusal: they are stripped from the child environment and pinned off
in the generated settings. Unknown `CLAUDE_CODE_USE_*` names are refused,
because `claudes` cannot know that they do not reroute the session; three
known-benign tool toggles are allowlisted.

The two env refusals above gate on different things, and both name the
variable in the message. `CLAUDE_CODE_HOST_AUTH_ENV_VAR` carries the *name*
of the env var holding the host's credential, so any non-empty value counts
— `0` and `false` included, because the variable is read as a name, not as a
flag. `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST` and the unknown
`CLAUDE_CODE_USE_*` toggles are flags, so only a truthy value counts: unset,
empty, `0` and `false` are all left alone.

## `claudes doctor`

```sh
claudes doctor [--live]
```

Runs every check in order, printing each verdict as it arrives — the wiring
probe alone can take a minute — and exits 1 when any check FAILed, 0
otherwise. The router key is never printed: it appears only as its
`mar_live_…` prefix, and every output line is scrubbed.

Statuses: PASS means checked and good. WARN means the session probably works
but you should fix it. FAIL means broken, and doctor exits 1. INFO is
informational, nothing to fix. FAIL and WARN lines are followed by an
indented `fix:` line.

| Check | What it does | When it doesn't pass |
| --- | --- | --- |
| runtime | Not native Windows; Node 22 or newer runs `claudes`; `claude` is on `PATH` and reports a version at or above the tested minimum (2.1.299) | FAIL: on Windows use WSL; otherwise install or update Node or Claude Code as the fix line says |
| config | The config exists, is 0600 in a 0700 directory, is owned by you and parses; shows the key as `mar_live_…` and the three pinned tiers | FAIL: the fix line carries the loader's own remedy — usually re-run `claudes login` |
| router | The router answers `/healthz` with a version, your key lists `/v1/models`, and every pinned tier is served | FAIL: check the router is running and reachable; if it rejected the key (HTTP 401/403), re-run `claudes login`. WARN (a pinned tier is not served): re-run `claudes login` |
| conflicts | Looks for credentials that compete with the generated settings: the shell env (INFO — stripped for claudes, affects plain claude); `apiKeyHelper`, `forceLoginMethod` or credential env keys in the user, project or local settings (WARN); managed settings, which outrank the generated file (FAIL); a saved claude.ai login (INFO — expect the start-up warning) | WARN: remove those keys from the settings file(s). FAIL: remove them from the managed-settings file named in the line — it overrides everything |
| wiring | The zero-quota proof: spawns the real `claude` exactly the way the launcher does, but pointed at a local recording stub instead of the router. PASSes only when the stub saw a request carrying the configured key (compared as a hash — the key itself never appears), with a configured tier as the model, and no other credential, and the `claude` run exited 0 — it must neither time out nor be killed | FAIL: follow the fix line — usually a competing credential (see conflicts) or a settings file problem; re-run `claudes doctor`. WARN: the credential path is proven but the `claude` run exited non-zero, timed out or was killed — the exit status is a separate problem from the credential path |
| live (`--live` only) | Exactly one `POST /v1/messages` with `max_tokens 1` on the Haiku tier, through the real router with the real key; reports only the HTTP status and the router's request id, never the body — a request id carrying key material is withheld and never printed | FAIL: check the router is running and reachable; on a non-200, take the request id to the router's logs when one was shown — a request id carrying key material is withheld, so there is no id to take to the logs |
| effective-model | The models Claude Code will actually use under the generated settings: `model` = the sonnet tier, `advisorModel` = the haiku tier, plus `subagentModel` when configured | WARN: the router does not serve one of them — re-run `claudes login`, optionally with `--sonnet` / `--haiku` overrides |

Without `--live`, doctor costs no router quota: it only asks the router for
its health and model list, and the wiring probe talks to the local stub.

The wiring probe is the one check that needs the real key on disk: the
generated settings point Claude Code at the local recording stub, and the
stub sees the key only when `claudes key` serves it. So the probe writes a
throwaway copy of the config — the real key, 0600, inside 0700 directories
— and points the child's `HOME` and `XDG_CONFIG_HOME` at it. The key never
enters the child's environment: the probe proves the same helper path a real
session uses.

That copy lives inside the config directory
(`~/.config/claudes/probe.<pid>`), not in the OS temp directory: the
documented uninstall reaches it, and the next doctor run sweeps a probe
directory whose pid is dead. The probe deletes the copy when its child
exits — on the PASS path and on the FAIL path — and a run interrupted with
Ctrl-C or `SIGTERM` deletes it before the process dies. Cleanup deletes the
copy first, before the signal traps come off and before the stub's socket is
closed, so an interrupt during teardown finds nothing to strand.

A symlinked path is refused: the config directory, the probe's own
directory, or a directory inside it. The copy would live in the link's
target, where neither the uninstall nor the sweep reaches it. And when the
copy cannot be deleted at all, the probe keeps its signal traps armed — so
an interrupt during teardown still takes it — and fails with the copy's path
instead of claiming a clean run.

Pid liveness is judged in the prober's pid namespace, the same rule the
per-launch settings sweep uses (see "Network, proxies and certificates"), so
a config directory shared across containers can make another namespace's
live doctor run look dead: that run's probe directory is swept, and the key
copy under it is deleted while its probe is still running.

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

The generated per-launch settings file
(`~/.config/claudes/settings.<pid>.json`, 0600 inside the 0700 config
directory) can contain your shell's proxy URL, including any credentials
embedded in it. It deliberately outlives the launcher — Claude Code hands its
path to processes started later (`/restart`, tmux sessions, background
agents) — and a later `claudes` launch sweeps it once the launching pid is
dead.

Two caveats follow from that sweep. A descendant still running from a dead
launcher's session loses the file at the next launch's sweep and fails closed
with "Settings file not found". And pid liveness is judged in the prober's
pid namespace, so a config directory shared across containers can make
another namespace's live launcher look dead: the session keeps running, but
only the processes it starts later lose the file.

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

| Variable | Purpose | Default or refusal |
| --- | --- | --- |
| `XDG_CONFIG_HOME` | The base directory the config lives under: `$XDG_CONFIG_HOME/claudes/config.json`. | Defaults to `$HOME/.config`. A relative value is ignored, and with no absolute `HOME` either the commands that need the config directory refuse with exit 78; `claudes doctor` reports the config as a FAIL and exits 1, and `--version` exits 0. |
| `HOME` | The fallback base for the config directory: `$HOME/.config/claudes`. | No default: a relative `HOME` is ignored, and without an absolute `XDG_CONFIG_HOME` or `HOME` the commands that need the config directory refuse with exit 78; `claudes doctor` reports the config as a FAIL and exits 1, and `--version` exits 0. |
| `PATH` | Where `claudes` looks for the `claude` executable it launches. | No default: without `claude` on `PATH` the session does not start (exit 127). |
| `CLAUDES_PREFLIGHT_TIMEOUT_MS` | How long the router's pre-launch check waits, in milliseconds. | 1500. Any value that is not an integer from 1 to 2147483647 is ignored. |
| `BUN_CONFIG_VERBOSE_FETCH` | Bun's verbose request logging, which prints every request header; the generated settings pin it to `""`. | Unset. A truthy value in your shell refuses the session (exit 64): the router key would be printed. |
| `ANTHROPIC_BASE_URL` | The endpoint the session talks to; the generated settings pin it to the configured router. | Unset. A value that is not the configured router's origin makes `claudes key` refuse (exit 64): the key would be served to another endpoint. |
| `HTTP_PROXY`, `http_proxy` | The proxy for HTTP requests; pinned to your shell's own value in the generated settings. | Unset, then pinned to an empty string. The pair is pinned as a pair: set one spelling and both get it, set both and each keeps its own value. |
| `HTTPS_PROXY`, `https_proxy` | The proxy for HTTPS requests; pinned to your shell's own value in the generated settings. | Unset, then pinned to an empty string. The pair is pinned as a pair: set one spelling and both get it, set both and each keeps its own value. |
| `ALL_PROXY`, `all_proxy` | The catch-all proxy; pinned to your shell's own value in the generated settings. | Unset, then pinned to an empty string. The pair is pinned as a pair: set one spelling and both get it, set both and each keeps its own value. |
| `NO_PROXY`, `no_proxy` | The hosts that bypass the proxy; the two spellings get one merged list, with the router's own host and the loopback hosts prepended when the router runs on this machine. | Unset, then pinned to an empty string. |
| `NODE_TLS_REJECT_UNAUTHORIZED` | Whether Node accepts a certificate it cannot verify; pinned to your shell's own value. | Unset, then pinned to an empty string. |
| `NODE_EXTRA_CA_CERTS` | The CA bundle Node trusts; pinned to your shell's own value. | Unset, then pinned to an empty string. |
| `NODE_USE_ENV_PROXY` | Whether Node's own fetch goes through the proxy variables; pinned to your shell's own value. | Unset, then pinned to an empty string. The router check ignores `HTTP_PROXY` and `HTTPS_PROXY` unless this is set. |
| `NODE_OPTIONS` | Node's own options; pinned to your shell's own value and merged into the key helper's environment. | Unset, then pinned to an empty string. |
| `CLAUDE_CODE_CERT_STORE` | The certificate store Claude Code trusts; pinned to your shell's own value. | Unset, then pinned to an empty string. |
| `SSL_CERT_FILE` | The CA file the OpenSSL clients in the session use; carried over only when your shell sets it. | Unset, then left out of the generated settings: never pinned to an empty string, because an empty CA store breaks every HTTPS request those clients make. |
| `SSL_CERT_DIR` | The CA directory the OpenSSL clients in the session use; carried over only when your shell sets it. | Unset, then left out of the generated settings: never pinned to an empty string, because an empty CA store breaks every HTTPS request those clients make. |
| `CLAUDE_CODE_USE_BEDROCK` | A switch that points Claude Code at another provider; stripped from the session environment and pinned to `""` in the generated settings. | Off, so the session goes to the router. `claudes key` refuses (exit 64) when the switch is truthy in its own environment. |
| `CLAUDE_CODE_USE_VERTEX` | A switch that points Claude Code at another provider; stripped from the session environment and pinned to `""` in the generated settings. | Off, so the session goes to the router. `claudes key` refuses (exit 64) when the switch is truthy in its own environment. |
| `CLAUDE_CODE_USE_FOUNDRY` | A switch that points Claude Code at another provider; stripped from the session environment and pinned to `""` in the generated settings. | Off, so the session goes to the router. `claudes key` refuses (exit 64) when the switch is truthy in its own environment. |
| `CLAUDE_CODE_USE_MANTLE` | A switch that points Claude Code at another provider; stripped from the session environment and pinned to `""` in the generated settings. | Off, so the session goes to the router. `claudes key` refuses (exit 64) when the switch is truthy in its own environment. |
| `CLAUDE_CODE_USE_ANTHROPIC_AWS` | A switch that points Claude Code at another provider; stripped from the session environment and pinned to `""` in the generated settings. | Off, so the session goes to the router. `claudes key` refuses (exit 64) when the switch is truthy in its own environment. |
| `CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD` | A switch that points Claude Code at another provider; stripped from the session environment and pinned to `""` in the generated settings. | Off, so the session goes to the router. `claudes key` refuses (exit 64) when the switch is truthy in its own environment. |
| `CLAUDE_CODE_USE_GATEWAY` | A switch that points Claude Code at another provider; stripped from the session environment and pinned to `""` in the generated settings. | Off, so the session goes to the router. `claudes key` refuses (exit 64) when the switch is truthy in its own environment. |
| `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST` | A host process that manages Claude Code's provider and auth environment; Claude Code then ignores the generated settings file outright. | Unset. A truthy value refuses the session (exit 64): the session would silently skip the router. |
| `CLAUDE_CODE_HOST_AUTH_ENV_VAR` | The name of the env var holding the host's own credential. | Unset. Any non-empty value refuses the session (exit 64), `0` and `false` included: the variable is read as a name, not as a flag. |
| `CLAUDE_CODE_USE_POWERSHELL_TOOL` | A known-benign `CLAUDE_CODE_USE_` toggle: it picks a local tool implementation, not another provider. | Passed through to the session unchanged; never refused. |
| `CLAUDE_CODE_USE_NATIVE_FILE_SEARCH` | A known-benign `CLAUDE_CODE_USE_` toggle: it picks a local tool implementation, not another provider. | Passed through to the session unchanged; never refused. |
| `CLAUDE_CODE_USE_COWORK_PLUGINS` | A known-benign `CLAUDE_CODE_USE_` toggle: it picks a local tool implementation, not another provider. | Passed through to the session unchanged; never refused. |
| `CLAUDE_CODE_USE_*` | Every other variable under this prefix — a name that is neither one of the seven provider switches above nor one of the three known-benign toggles. `claudes` cannot know what such a name does, so it cannot rule out that it reroutes the session. | Refused (exit 64) when truthy: the launcher refuses it before the session starts, and `claudes key` refuses it too. A known provider switch is not refused at launch — it is stripped from the session and pinned off instead — though `claudes key` refuses a truthy one (exit 64). |
| `ANTHROPIC_*` | Anthropic's own credentials and endpoint settings; the session's copy is stripped, so a leftover personal key cannot win over the router. | Stripped from the session environment. The generated settings set the names Claude Code needs: the credential names to `""`, the base URL to the configured router. |
| `CLAUDE_CODE_OAUTH_*` | A claude.ai OAuth credential; stripped from the session environment so it cannot authenticate the session anywhere but the router. | Stripped from the session environment. |
| `AWS_BEARER_TOKEN_BEDROCK` | The Bedrock bearer credential, the one credential outside the namespaces above; stripped from the session environment. | Stripped from the session environment. |

## Uninstall

```sh
npm rm -g @developerz.ai/claudes && rm -rf ~/.config/claudes
```

(With `XDG_CONFIG_HOME` set, remove `$XDG_CONFIG_HOME/claudes` instead.)
Nothing else is left behind: `claudes` never writes `~/.claude`, and the
per-launch settings files and `claudes doctor`'s throwaway probe directory
live inside the config directory.

## Platforms

Linux, macOS and WSL. Node 22 or newer, plus Claude Code at or above the
version `claudes doctor` tests against (2.1.299 today). Native Windows is not
supported: there `claudes doctor` FAILs with the instruction to run inside
WSL.

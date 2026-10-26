# developerz-ai/claudes

> Project brain — established by dz-runner setup mode from this repo, then owned by
> its maintainers. Correct it in place; setup never overwrites a brain that exists.

Thin TypeScript launcher that runs the Claude Code CLI against a self-hosted, Anthropic-compatible router using a per-person key (never accepts the key on the command line, never lets a fragment of it leak into any output); `login`, `doctor` and `key` and the passthrough to `claude` are all shipped and tested, not scaffolded; maintained by the developerz.ai team as `@developerz.ai/claudes`.

## Stack

Bun + TypeScript

## Commands

| Task | Command |
|------|---------|
| setup | `bin/setup` — `bun install --frozen-lockfile`, skipped when `node_modules` already holds every pin `bun.lock` declares |
| dev | `bin/dev` — true (on developerz.ai runs, start it with code_bash_background when you need a running stack) |
| check | `bin/check` — `bin/check-bun-versions` (the three bun pins agree) → biome (`--error-on-warnings`) → `tsc` on both tsconfigs → `bun test` → `bun scripts/build.ts` → shebang / `--version` / exit-code smoke, incl. the `mar_live_` leak grep against a keyed config |
| stop | `bin/stop` — true (on developerz.ai runs, the platform runs this when your session ends — do not stop the stack yourself) |

## Structure

| Path | Purpose |
|---|---|
| `src/main.ts` | CLI entry; `dispatch` routes argv, `--version`/`-v` prints `VERSION` and exits 0, `login`/`key`/`doctor` hand off to `runLogin`/`runKey`/`runDoctor`, everything else to `run` (the passthrough to `claude`); the reserved branch ends in a compile-time exhaustiveness guard over `RESERVED_WORDS` (a `never`-typed binding of `result.word`), so `tsc` fails if a reserved word is added without a handler |
| `src/dispatch.ts` | Pure argv → `{kind: "version" | "reserved" | "passthrough"}`; `RESERVED_WORDS = ["login", "doctor", "key"]` |
| `src/version.ts` | `VERSION` constant; drift-guarded against `package.json` by `src/version.test.ts` |
| `src/tiers.ts` | Claude model-id regex parse, default tier table, "newest per family" resolver |
| `src/commands/login.ts` | `claudes login`: argv parse → stdin/TTY key read → router health → `/v1/models` → atomic config write |
| `src/commands/login-args.ts` | Argv parser; rejects any token containing `mar_live_` and names flags, never values, in errors |
| `src/commands/login-input.ts` | Echo-off secret reader (`MAX_INPUT_BYTES = 4096`, CSI/SS3 swallowed) and stdin first-line reader |
| `src/commands/login-harness.ts` | Framework-free test fixtures: stubbed `fetch`, TTY/stdin simulators, key-leak checker |
| `src/commands/doctor.ts` | `claudes doctor`: runs runtime → config → router → conflicts → wiring → (`--live`) → effective-model, printing each verdict as it lands; exits 1 on any FAIL |
| `src/commands/key.ts` | `claudes key`: the `apiKeyHelper` output — the router key on stdout with no trailing newline; refuses with exit 64 when stdout is a TTY or a `CLAUDE_CODE_USE_*` switch is set |
| `src/config/paths.ts` | `${XDG_CONFIG_HOME or $HOME/.config}/claudes/config.json`; rejects relative bases |
| `src/config/schema.ts` | zod: `ROUTER_KEY_PREFIX`/`ROUTER_KEY_PATTERN`, `baseUrlSchema` (https-only, no creds, bare origin), `configSchema` |
| `src/config/errors.ts` | `ConfigError` and its `InsecureConfigError` subclass — the vocabulary `config/store.ts` and `config/private-file.ts` raise for every refusal they own (`config/paths.ts` throws a plain `Error`, not one of these); re-exported by `config/store.ts` |
| `src/config/private-file.ts` | `writePrivateFile`: the one atomic private write (`mkdir 0700` → symlink and ownership refusals → `chmod 0700` → temp `O_EXCL 0600` → write → `fsync` → `fstat` size check → `rename` → dir `fsync`), shared by the config store and the launcher's generated settings file |
| `src/config/store.ts` | `writeConfig` validates with `configSchema` and delegates the whole atomic write to `writePrivateFile`; `readConfig` checks the config directory's uid and mode by a path stat, then opens `O_NOFOLLOW \| O_NONBLOCK` and checks the file's uid and mode against the fd's own `fstat` (directory checked before file) |
| `src/config/load.ts` | `loadConfig` for the commands that need credentials (the launcher, `claudes key`): no config at all → `MISSING_CONFIG_MESSAGE` + exit 78; a config it refuses to trust keeps the store's own message |
| `src/launch/` | The passthrough to `claude`: `run.ts` resolves the executable, writes the per-pid settings file and spawns, forwarding `SIGINT`/`SIGTERM`/`SIGHUP`; `argv.ts` builds the child argv (refusing `--settings`, `--key` and any key-shaped token); `env.ts` strips inherited credentials; `settings.ts` generates the `--settings` payload; `settings-file.ts` names, sweeps and refuses that file; `preflight.ts` holds the router health check and its notes; `provider-switches.ts` the switch list; `unsupported.ts` the features turned off; `run-harness.ts` the framework-free launch fixtures |
| `src/doctor/` | One module per check (`checks/{runtime,config,router,conflicts,wiring,live,effective-model}.ts`) plus `results.ts` (`CheckResult`, `anyFailed`), `run-proc.ts` (the spawn seam), `claude-version.ts` (`MIN_CLAUDE_VERSION`), `stub-server.ts` (the recording router) and `harness.ts` (fixtures) |
| `src/router/client.ts` | `/healthz` and `/v1/models`, 10 s timeout, body cap 1 MiB, `redirect: "error"`; `scrub`, `RouterError`, `isRouterError` and `errorName` are defined in `router/errors.ts` and re-exported here |
| `src/router/errors.ts` | Defines `scrub`, `RouterError` (`status`/`timedOut`/`tlsVerifyCode`), the trap-safe `isRouterError` and the class-shaped-only `errorName`; no `err.message` is ever interpolated, because Node's `fetch` quotes header values verbatim |
| `src/test-support/fixtures.ts` | Framework-free shared fake `ROUTER`/`KEY` fixtures used by tests and harnesses |
| `src/test-support/redact.ts` | `assertNoKeyFragment` (no 8-char window of the key body may appear in any output) |
| `src/test-support/readme-table.ts` | Parses README.md's "Refusals and exit codes" table into rows (`exit`, `when`, `message`); code-span messages are unquoted and `(message above)` resolves to the router-down block |
| `scripts/build.ts` | `Bun.build({ target: "node" })` of `src/main.ts` → `dist/claudes.js`, prepends `#!/usr/bin/env node`, `chmod 755` |
| `bin/check` | Gate: `bin/check-bun-versions` (bun-pin agreement) → biome (`--error-on-warnings`) → tsc on both tsconfigs → `bun test` → build → shebang/version/exit-code smoke (no `bunx` — it silently auto-installs unrelated npm packages) |
| `.github/workflows/ci.yml` | CI matrix: ubuntu-latest + macos-latest × Node 22 + 24; `bun install --frozen-lockfile` then `bin/check` |
| `.github/workflows/release.yml` | npm trusted publishing via OIDC; tag must equal `v` + `package.json` version, must be on `origin/main`, tarball verified to contain exactly `dist/claudes.js`, `package.json`, `README.md`, `LICENSE`; pre-releases refused; digest-verified pinned npm 12.2.0 |

Dependency direction (the live import graph under `src/`, checkable with `grep '^import .*from "\.' <file>`): `main.ts → commands/{doctor,key,login}.ts | dispatch.ts | launch/run.ts | version.ts`; `commands/doctor.ts → config/{load,paths}.ts | doctor/checks/*.ts | doctor/{results,run-proc,stub-server}.ts | launch/run.ts | router/{client,errors}.ts | version.ts`; `commands/key.ts → config/{load,paths}.ts | launch/provider-switches.ts`; `commands/login.ts → commands/login-{args,input}.ts | config/{paths,schema,store}.ts | router/client.ts | tiers.ts`; `commands/login-harness.ts → config/paths.ts | router/client.ts | test-support/{fixtures,redact}.ts | commands/login.ts`; `launch/run.ts → config/{load,paths,private-file}.ts | router/{client,errors}.ts | launch/{argv,env,preflight,provider-switches,settings,settings-file}.ts`; the other `launch/*` modules reach only `config/{paths,schema,errors}.ts`, `router/{client,errors}.ts` and each other — except the test fixture module `launch/run-harness.ts → config/{paths,schema,store}.ts | router/client.ts | test-support/fixtures.ts | launch/run.ts`; `config/store.ts → config/{errors,private-file,schema}.ts`; `config/load.ts → config/{paths,schema,store}.ts`; `config/private-file.ts → config/errors.ts`; `router/client.ts → router/errors.ts`; `doctor/checks/* → doctor/results.ts | doctor/run-proc.ts | doctor/stub-server.ts | the modules above` (notably `doctor/checks/config.ts → commands/login.ts` for `REDACTED_KEY`); `test-support/redact.ts → config/schema.ts`. Tests live as `*.test.ts` next to the source they exercise; `tsconfig.build.json` excludes `**/*.test.ts`, `tsconfig.json` includes them.

## Conventions

## Code style

- TypeScript `strict: true` with `noUncheckedIndexedAccess: true`; Biome lints with `noExplicitAny: error` — no ESLint, no Prettier.
- 2-space indent, 100-char line width, `esnext` modules — all owned by Biome (`biome.json`); do not hand-format.
- Two `tsconfig.*` files: `tsconfig.json` (types: `bun` + `node`, includes `**/*.ts`) for tests; `tsconfig.build.json` (types: `node`, includes `src/**/*.ts`, excludes `src/**/*.test.ts`) for the bundle.
- ESM only (`"type": "module"`) in application/module source (`src/**/*.ts`, `scripts/`): `require()` never appears in module code. The `require()` calls that do exist are workflow glue, not module code: `bin/check:44`'s `node -p "require('./package.json').version"` shell one-liner, and both `node -p` snippets in `.github/workflows/release.yml` — line 72's `require('./package.json')` and line 197's `require("fs").readFileSync(...)`. (`src/launch/run.e2e.test.ts:42` also holds a `require("node:fs")`, but inside the FAKE_CLAUDE template string — a script written to disk and run by `node`, not module code.)
- Public exports use `export function` / `export type`; never default-export an internal helper.

## Test layout

- Use `bun:test` (`describe` / `test` / `expect`); never install Jest or Vitest.
- Tests are colocated: `src/foo.ts` ships `src/foo.test.ts` next to it; the `src/test-support/` directory holds framework-free helpers (`assertNoKeyFragment` throws — it does not call `expect`).
- Subcommand flows get one test file per concern: `login-args.test.ts`, `login-input.test.ts`, `login-output.test.ts`, `login.test.ts`, `run-login.test.ts`.
- Any output path that might touch a key MUST be checked by `assertNoKeyFragment`; coverage of `REDACTED_KEY` and `scrub()` is the spec.

## CLI behaviour

- Dispatch is pure (`src/dispatch.ts`): `--version` / `-v` → `version`; first arg in `RESERVED_WORDS = ["login","doctor","key"]` → `reserved`; else → `passthrough` to `claude`.
- Exit codes follow sysexits.h: `64` usage error, `78` config error, `1` runtime error, `69` router unanswered by the pre-launch check, `127` `claude` missing from PATH (or unsignalable), `130` Ctrl-C at prompt, `0` success. `src/readme-refusals.test.ts` parses the README's own refusals table (`src/test-support/readme-table.ts`) and asserts every documented row against live behaviour, so a doc-side edit fails the guard too; 130 and 0 are asserted elsewhere.
- Every rejection of an argv value names the FLAG (e.g. `--url`, `#5`), never the VALUE — echoing input is the redaction leak path.
- `bin/check` uses `node_modules/.bin/biome` and `node_modules/.bin/tsc` — NOT `bunx biome` / `bunx tsc`, which silently auto-install the unrelated npm packages `biome` and `tsc`.

## Key safety (non-negotiable)

- The router key (`mar_live_` + 32 chars) MUST NEVER appear on argv, in an error message, in a log, in a test fixture output, or anywhere reachable from a `fetch` error message (Node's `fetch` quotes invalid header values verbatim — including the key).
- Every error message that crosses an I/O boundary passes through `scrub()` (`src/router/client.ts`); `assertNoKeyFragment` (`src/test-support/redact.ts`) checks no 8-char window of the key body appears in any output.
- The argv parser scans EVERY token (including `--x=value` and the value after `--x VALUE`) for the `mar_live_` substring before any other validation.

## Config safety (non-negotiable)

- Config directory mode `0700`, file mode `0600`, atomic temp-then-rename write, `O_NOFOLLOW` on read; the config directory's uid and mode are checked by a path stat, and the file's uid and mode against the fd's own `fstat` (directory checked before file). Every defence is independent — do not collapse them.

## Build / release (non-negotiable)

- `bun scripts/build.ts` is the ONLY build entry; the produced `dist/claudes.js` carries `#!/usr/bin/env node` and is `chmod 755`.
- `bin/check` is the gate: bun-pin agreement (`bin/check-bun-versions`), biome, tsc on both configs, `bun test`, build, then shebang/version/exit-code smoke. A PR is proven when it exits 0.
- CI pins bun `1.4.3`, and `.bun-version` carries that same pin; `.bun-version`, `ci.yml` and `release.yml` must agree — `bin/check-bun-versions` refuses drift among them. The committed `bun.lock` is v2 — bun < 1.4 cannot read it. Node is `>=22` per `engines.node`.
- A refused frozen install is that bun being older than the lockfile format, not a bad dependency: `bin/setup` prints `bun --version`, the `.bun-version` pin, `bun.lock`'s `lockfileVersion` and the CI-pinned bun version before it exits non-zero. Never edit `bun.lock` to make an install succeed.
- npm release is OIDC trusted publishing only (`release.yml`) — no `NPM_TOKEN` anywhere. The release tag MUST equal `v` + `package.json` version, and the commit MUST be an ancestor of `origin/main`; pre-releases are refused.

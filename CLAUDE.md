# developerz-ai/claudes

> Project brain — established by dz-runner setup mode from this repo, then owned by
> its maintainers. Correct it in place; setup never overwrites a brain that exists.

Thin TypeScript launcher that runs the Claude Code CLI against a self-hosted, Anthropic-compatible router using a per-person key (never accepts the key on the command line, never lets a fragment of it leak into any output); the `claudes login` subcommand is implemented and tested, the passthrough to `claude` is the remaining scaffolded piece; maintained by the developerz.ai team as `@developerz.ai/claudes`.

## Stack

Bun + TypeScript

## Commands

| Task | Command |
|------|---------|
| setup | `bin/setup` — bun install --frozen-lockfile |
| dev | `bin/dev` — true (on developerz.ai runs, start it with code_bash_background when you need a running stack) |
| check | `bin/check` — bin/check |
| stop | `bin/stop` — true (on developerz.ai runs, the platform runs this when your session ends — do not stop the stack yourself) |

## Structure

| Path | Purpose |
|---|---|
| `src/main.ts` | CLI entry; argv dispatch (`dispatch`) + version/usage exit 64 |
| `src/dispatch.ts` | Pure argv → `{kind: "version" | "reserved" | "passthrough"}`; `RESERVED_WORDS = ["login", "doctor", "key"]` |
| `src/version.ts` | `VERSION` constant; drift-guarded against `package.json` by `src/version.test.ts` |
| `src/tiers.ts` | Claude model-id regex parse, default tier table, "newest per family" resolver |
| `src/commands/login.ts` | `claudes login`: argv parse → stdin/TTY key read → router health → `/v1/models` → atomic config write |
| `src/commands/login-args.ts` | Argv parser; rejects any token containing `mar_live_` and names flags, never values, in errors |
| `src/commands/login-input.ts` | Echo-off secret reader (`MAX_INPUT_BYTES = 4096`, CSI/SS3 swallowed) and stdin first-line reader |
| `src/commands/login-harness.ts` | Framework-free test fixtures: stubbed `fetch`, TTY/stdin simulators, key-leak checker |
| `src/config/paths.ts` | `${XDG_CONFIG_HOME or $HOME/.config}/claudes/config.json`; rejects relative bases |
| `src/config/schema.ts` | zod: `ROUTER_KEY_PREFIX`/`ROUTER_KEY_PATTERN`, `baseUrlSchema` (https-only, no creds, bare origin), `configSchema` |
| `src/config/store.ts` | Atomic write (`mkdir 0700` + `chmodSync` + `open O_EXCL 0600` + `fsync` + `fstat` size check + `rename`); `readConfig` with `O_NOFOLLOW | O_NONBLOCK`, uid and mode checks against fd's own `fstat` |
| `src/router/client.ts` | `/healthz`, `/v1/models`, body cap 1 MiB, `redirect: "error"`, `scrub()` for any output, `RouterError`, error-name-only diagnostic |
| `src/test-support/redact.ts` | `assertNoKeyFragment` (no 8-char window of the key body may appear in any output) |
| `scripts/build.ts` | `Bun.build({ target: "node" })` of `src/main.ts` → `dist/claudes.js`, prepends `#!/usr/bin/env node`, `chmod 755` |
| `bin/check` | Gate: biome (`--error-on-warnings`) → tsc on both tsconfigs → `bun test` → build → shebang/version/exit-code smoke (no `bunx` — it silently auto-installs unrelated npm packages) |
| `.github/workflows/ci.yml` | CI matrix: ubuntu-latest + macos-latest × Node 22 + 24; `bun install --frozen-lockfile` then `bin/check` |
| `.github/workflows/release.yml` | npm trusted publishing via OIDC; tag must equal `v` + `package.json` version, must be on `origin/main`, tarball verified to contain exactly `dist/claudes.js`, `package.json`, `README.md`, `LICENSE`; pre-releases refused; digest-verified pinned npm 12.2.0 |

Dependency direction: `main.ts → dispatch.ts | version.ts | commands/`; `commands/login.ts → commands/login-{args,input}.ts | config/{paths,schema,store}.ts | router/client.ts | tiers.ts`; `commands/login-harness.ts → config/paths.ts | router/client.ts | test-support/redact.ts | commands/login.ts`; `config/store.ts → config/schema.ts`; `test-support/redact.ts → config/schema.ts`. Tests live as `*.test.ts` next to the source they exercise; `tsconfig.build.json` excludes `**/*.test.ts`, `tsconfig.json` includes them.

## Conventions

## Code style

- TypeScript `strict: true` with `noUncheckedIndexedAccess: true`; Biome lints with `noExplicitAny: error` — no ESLint, no Prettier.
- 2-space indent, 100-char line width, `esnext` modules — all owned by Biome (`biome.json`); do not hand-format.
- Two `tsconfig.*` files: `tsconfig.json` (types: `bun` + `node`, includes `**/*.ts`) for tests; `tsconfig.build.json` (types: `node`, includes `src/**/*.ts`, excludes `src/**/*.test.ts`) for the bundle.
- ESM only (`"type": "module"`); no `require()` outside `bin/check`.
- Public exports use `export function` / `export type`; never default-export an internal helper.

## Test layout

- Use `bun:test` (`describe` / `test` / `expect`); never install Jest or Vitest.
- Tests are colocated: `src/foo.ts` ships `src/foo.test.ts` next to it; the `src/test-support/` directory holds framework-free helpers (`assertNoKeyFragment` throws — it does not call `expect`).
- Subcommand flows get one test file per concern: `login-args.test.ts`, `login-input.test.ts`, `login-output.test.ts`, `login.test.ts`, `run-login.test.ts`.
- Any output path that might touch a key MUST be checked by `assertNoKeyFragment`; coverage of `REDACTED_KEY` and `scrub()` is the spec.

## CLI behaviour

- Dispatch is pure (`src/dispatch.ts`): `--version` / `-v` → `version`; first arg in `RESERVED_WORDS = ["login","doctor","key"]` → `reserved`; else → `passthrough` to `claude`.
- Exit codes follow sysexits.h: `64` usage error, `78` config error, `1` runtime error, `130` Ctrl-C at prompt, `0` success.
- Every rejection of an argv value names the FLAG (e.g. `--url`, `#5`), never the VALUE — echoing input is the redaction leak path.
- `bin/check` uses `node_modules/.bin/biome` and `node_modules/.bin/tsc` — NOT `bunx biome` / `bunx tsc`, which silently auto-install the unrelated npm packages `biome` and `tsc`.

## Key safety (non-negotiable)

- The router key (`mar_live_` + 32 chars) MUST NEVER appear on argv, in an error message, in a log, in a test fixture output, or anywhere reachable from a `fetch` error message (Node's `fetch` quotes invalid header values verbatim — including the key).
- Every error message that crosses an I/O boundary passes through `scrub()` (`src/router/client.ts`); `assertNoKeyFragment` (`src/test-support/redact.ts`) checks no 8-char window of the key body appears in any output.
- The argv parser scans EVERY token (including `--x=value` and the value after `--x VALUE`) for the `mar_live_` substring before any other validation.

## Config safety (non-negotiable)

- Config directory mode `0700`, file mode `0600`, atomic temp-then-rename write, `O_NOFOLLOW` on read; uid and mode checks run against the fd's own `fstat`, not the path. Every defence is independent — do not collapse them.

## Build / release (non-negotiable)

- `bun scripts/build.ts` is the ONLY build entry; the produced `dist/claudes.js` carries `#!/usr/bin/env node` and is `chmod 755`.
- `bin/check` is the gate: biome, tsc on both configs, `bun test`, build, then shebang/version/exit-code smoke. A PR is proven when it exits 0.
- CI pins bun `1.4.3`; the committed `bun.lock` is v2 — bun < 1.4 cannot read it. Node is `>=22` per `engines.node`.
- npm release is OIDC trusted publishing only (`release.yml`) — no `NPM_TOKEN` anywhere. The release tag MUST equal `v` + `package.json` version, and the commit MUST be an ancestor of `origin/main`; pre-releases are refused.

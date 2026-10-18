# Reviewer instructions — developerz-ai/claudes

> Read by the developerz.ai reviewer at EVERY review of this repository, at the reviewed
> commit, as this repo's own layer of the reviewer's prompt — established by dz-runner setup mode.
> It refines the platform rules (a finding is cited or withheld; the bot always discloses)
> and never overrides them. Edit freely; keep it under 12,000 characters — past that it is cut.

## Stack

Bun + TypeScript. The gate is `bin/check` (`bin/check`): a change that does not pass it is not proven, whatever its description says.

## Review conventions

- Reject any change that lets a router key (the 32 characters after `mar_live_`) reach argv, an error message, or any stdout/stderr path — even a fragment, even indirectly via `err.cause.message`, header-value quoting, or a test fixture.
- Reject any change to the argv parser that names a value instead of a flag in an error message (echoing input is the leak path); the `mar_live_` substring scan in `parseLoginArgs` must run on every token, including `--x=value` and the value after `--x VALUE`.
- Reject any change to the config store that drops the chmod-0700 directory, chmod-0600 file mode, the atomic temp-then-rename write, the `O_NOFOLLOW` open, or the uid check on directory and file; every defence is independent — none is redundant.
- Reject any change that weakens, drops, or skips an existing test in `src/commands/*.test.ts`; the redaction and exit-code tests are the spec.
- Reject any change to `bin/check` that swaps `node_modules/.bin/{biome,tsc}` for `bunx biome` / `bunx tsc` — `bunx` silently auto-installs the unrelated npm packages `biome` and `tsc`.

## Gates that matter

- `bin/check` is the single source of truth: biome check (`--error-on-warnings`), `tsc --noEmit` on both `tsconfig.json` and `tsconfig.build.json`, `bun test`, the build, and the shebang/version/exit-code smoke on `dist/claudes.js`. A PR is proven when this exits 0 on a clean checkout.
- CI (`.github/workflows/ci.yml`) is the merge gate on ubuntu-latest + macos-latest × Node 22 + 24; a PR must be green on the full matrix before merge.
- Release (`.github/workflows/release.yml`) is the only path to npm: the tag must equal `v` + `package.json` version, the commit must be an ancestor of `origin/main`, the tarball must contain exactly `dist/claudes.js`, `package.json`, `README.md`, `LICENSE`, and npm is reached via OIDC trusted publishing — no `NPM_TOKEN` anywhere.

## Never flag

- `bun.lock` v2-format drift from a local `bun install` on bun < 1.4 — the platform reverts it before the head proof; v2 requires bun ≥ 1.4.3.
- `dist/*` and the `#!/usr/bin/env node` shebang on `dist/claudes.js` — `scripts/build.ts` generates them; `bin/check` asserts their shape.
- Style choices Biome owns (2-space indent, 100-char lines, import order).
- Hardcoded test fixtures that contain the literal `mar_live_…` (the prefix string is part of the spec the tests are checking).
- The `package.json` `bin` entry pointing at `dist/claudes.js` — that is the published artifact, not a typo.

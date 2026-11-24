# 03 — profiles (several routers)

Depends on: 02. Fixes B4, B5, B6, B22.

## User-visible shape

```
claudes login --profile work --url <router>   # create or re-login; --url optional once stored
claudes --profile work -p "hi"                # leading flag only
CLAUDES_PROFILE=work claudes
claudes profile list | use <name> | remove <name>
claudes doctor --profile work
```

Selection: leading `--profile` → `CLAUDES_PROFILE` → the stored active profile → `default`. A named
profile that does not exist is exit 78 and lists the names that do. It never falls through to the next rule.

## Files

- `src/config/paths.ts` — `profileFile(dir, name)`: `config.json` for `default`, `config.<name>.json`
  otherwise, same directory, so the existing directory checks apply. `activeProfileFile(dir)`.
- `src/config/profile.ts` (new) — `PROFILE_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/`, selection, listing.
  A name is a path component: validate before any path is built. An invalid name is refused by position,
  never echoed, because it is where a pasted key lands. `mar_live_` contains `_`, so it cannot match.
- `src/config/load.ts:19` — takes the profile; keeps "no HOME" apart from "no config" (B22).
- `src/config/schema.ts:84` — optional `pins` (per family). `tiers` becomes the last resolved snapshot,
  used only when the catalog is unavailable. `version` stays 1: the change is additive.
- `src/commands/login.ts:57`, `src/commands/login-args.ts:33` — `--profile`; `--url` optional when the profile
  already has one; carry `subagentModel`, `maxContextTokens` and `pins` over; `--opus/--sonnet/--haiku`
  set pins; the value `auto` clears one.
- `src/commands/profile.ts` (new) — `list` (name, active mark, origin; never the key), `use`, `remove`.
- `src/commands/key.ts:26` — accept exactly `--profile <name>`, refuse anything else as today, and keep the
  order: argument refusal → TTY → provider switch → config. The origin check stays.
- `src/launch/settings.ts:28` — the helper always names its profile, `default` included, so a session keeps
  its own router whatever later logins or `profile use` do.
- `src/dispatch.ts:2`, `src/main.ts`, `src/help.ts` — reserved word `profile`; leading `--profile`.
- `src/commands/doctor.ts:62` — `--profile`.
- README, `CLAUDE.md` (the `key` row says "takes no arguments"), `.claude/agents/cli-flags.md`,
  `.claude/agents/config-store.md`, `.env.example`.

## Steps

1. Paths, names, selection and loading, with tests.
2. `key --profile`, then the helper, then login, then the `profile` command, then help and README.
3. `claudes profile` shadows a one-word prompt "profile"; note it where README lists the owned words, and
   change "five first arguments" to the new count.
4. Re-login with no `--url` and no stored profile keeps today's usage error. `bin/check` depends on it.

`profile remove` deletes only the named config file, after confirming it is a regular file the caller owns.
It refuses the active profile. Removing a profile under a live session makes that session's next key fetch
fail closed; say so in README.

## Tests

- Names: traversal (`../x`), uppercase, empty, 33 characters, a key; none is echoed (`assertNoKeyFragment`).
- A v1 `config.json` with no `pins` loads as `default` with identical behaviour.
- Re-login preserves the three optional fields; `auto` clears a pin.
- Two profiles: each helper command names its own; `key --profile a` refuses when `ANTHROPIC_BASE_URL` is b's.
- `key --profile` with a missing, invalid or extra argument: exit 64, config never read.
- Two concurrent logins to different profiles both survive.
- e2e: two sessions at once against two stub routers; each stub sees only its own key.

## Done when

The e2e above passes, and B4, B5 and B6 no longer reproduce.

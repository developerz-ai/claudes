# 05 — settings-file lifetime

Depends on: 04. Fixes B13.

## Files

- `src/launch/settings-file.ts:25,31,49` — naming and sweep.
- `src/config/paths.ts` — `settingsFile` takes a profile and a digest instead of a pid.
- `src/launch/run.ts:77` — build settings before the path; pass the path to `buildArgv`.
- README "Network, proxies and certificates" (the two sweep caveats), `CLAUDE.md` Structure rows.

## Design

Name: `settings.<profile>.<first 16 hex of SHA-256 of the payload>.json`. Equal content is the same file, so
a second launch reuses it and never changes it under a running session. Different content is a different
file, so pid namespaces cannot collide. `writePrivateFile` already replaces atomically; on reuse, rewrite it
so the mtime marks use.

Sweep by age: remove a settings file not used for 30 days, plus temp siblings older than a day. Keep the rule
that a symlinked directory is not swept. Remove the old `settings.<pid>.json` form only when the pid is dead,
for one release.

The file can hold a proxy URL with credentials, as today, and now lives longer: say so in README, and have
`profile remove` delete that profile's settings files.

## Tests

- Same payload → same path; a changed tier, proxy or profile → a new path and the old file untouched.
- A launch does not remove another session's file, whatever its pid.
- Age sweep at 29 and 31 days; temp siblings; symlinked directory; foreign names untouched.
- Old pid-named files: live kept, dead removed.

## Done when

Live: start `claudes --bg`, let the launcher exit, launch `claudes` again, then `claudes respawn <id>` works.
If a background daemon cannot run in the scratch environment, record that and keep the unit tests as proof.

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
file, so pid namespaces cannot collide. `writePrivateFile` already replaces atomically.

**No automatic sweep of settings files, in either naming form.** Neither age nor a dead launcher pid shows that a
detached session no longer needs its file, and no portable check does. Growth is bounded by distinct payloads, a
few KB each. Only temp siblings older than a day are removed; a symlinked directory is still not swept.

The file can hold a proxy URL with credentials, as today, and now stays until it is removed: say so in README.
`profile remove` deletes that profile's settings files and the uninstall removes all of them; both are explicit
user actions.

## Tests

- Same payload → same path; a changed tier, proxy or profile → a new path and the old file untouched.
- A launch does not remove another session's file, whatever its pid.
- A settings file 60 days old and a pid-named file with a dead pid both survive a launch.
- Temp siblings: 23 hours kept, 25 hours removed; symlinked directory and foreign names untouched.

## Done when

Live: start `claudes --bg`, let the launcher exit, launch `claudes` again, then `claudes respawn <id>` works.
If a background daemon cannot run in the scratch environment, record that and keep the unit tests as proof.

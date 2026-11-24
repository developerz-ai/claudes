# 06 — doctor

Depends on: nothing for B14, B15, B17, B18 and B19 (land them first); 04 for B16; 03 for per-profile output.

## Files

- `src/doctor/checks/wiring.ts:41` — add `SIGHUP` to `PROBE_SIGNALS` (B14).
- `src/doctor/checks/wiring.ts:221` — the probe child: delete `CLAUDE_CONFIG_DIR` (B15). Check whether
  `ANTHROPIC_CONFIG_DIR` is already stripped by prefix, and correct the doc comment's isolation claim.
- `src/doctor/checks/wiring.ts:431` — a request with no usable credential, and an unrecognised model while
  the saved `model` is foreign, each get their own verdict and fix (B15, B17).
- `src/doctor/stub-server.ts:171`, `credentialsOf` — a bare `Bearer` with nothing after it is "no credential".
  Node trims the header's trailing space, so the current `startsWith("Bearer ")` misses it.
- `src/doctor/checks/conflicts.ts:27,62,98` — settings and credentials under `CLAUDE_CONFIG_DIR` when it is
  set and absolute; `managed-settings.d/*.json` in alphabetical order, skipping dotfiles (B19).
  A drop-in that cannot be read is a FAIL, like the main file.
- `src/doctor/checks/launch-gate.ts` (new) — FAIL for every environment `run()` refuses, by calling the same
  `firstUnknownReroutingUseToggle` and `firstHostManagedEnv` (`src/launch/provider-switches.ts`). Then skip
  the wiring probe with an INFO, because its verdict would be noise (B18).
- `src/doctor/checks/effective-model.ts:19` — derive from slice 04's catalog: launch model, subagent model,
  window and its source. Drop `advisorModel` (B16).
- `src/doctor/checks/router.ts:9` — remedies name the profile and work as printed (B5).
- `src/doctor/checks/config.ts` — print the profile.
- README doctor table, `CLAUDE.md` Structure row.

## Tests

- SIGHUP during the probe removes the copy and re-raises; extend the existing signal cases in `wiring.test.ts`.
- A child env with `CLAUDE_CONFIG_DIR` never reaches the probe; a plant there is a WARN in conflicts.
- Stub: `Bearer`, `Bearer ` and an empty `x-api-key` record nothing.
- Each refused environment gives a FAIL naming the variable, and no wiring probe runs.
- Drop-ins: conflicting key, unreadable file, invalid JSON, dotfile, directory absent.
- The existing guards hold: no key fragment in any line.

## Done when

Live: SIGHUP leaves no copy; doctor with `CLAUDE_CONFIG_DIR` set changes nothing in that directory; doctor's
default model equals what the stub received.

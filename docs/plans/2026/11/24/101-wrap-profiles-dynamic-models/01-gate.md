# 01 — gate

Depends on: nothing. Fixes B20.

## Files

- `biome.json:3` — exclude `.claude/settings.local.json` from `files.includes`. The file is machine-local
  and hidden by a _global_ ignore file, so do not rely on biome's VCS ignore support.
- `biome.json:2` — schema URL 2.6.4 → the pinned 2.6.6 (biome prints an info on every run today).
- `bin/check:97` and `bin/check:145`, the bare `login` smoke and its newline check — both
  run with the developer's real `HOME`. Run them under the `env -i` isolation the doctor and key smokes
  already use. Slice 03 makes bare `login` depend on stored config, and then this smoke would prompt.

## Steps

1. Add a test to `bin/check.test.ts` that puts an unformatted `.claude/settings.local.json` in a scratch
   copy and expects the biome stage to pass. Watch it fail.
2. Apply the two edits, then isolate the login smokes with a scratch `HOME` and `XDG_CONFIG_HOME`.

## Tests

- The scratch-copy case above.
- The login smokes exit 64 with a populated `HOME/.config/claudes` outside the scratch directory.

## Done when

`heavy bin/check` exits 0 with an unformatted `.claude/settings.local.json` present.

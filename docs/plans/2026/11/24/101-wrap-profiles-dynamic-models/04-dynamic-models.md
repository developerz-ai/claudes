# 04 — dynamic models, windows and the key check

Depends on: 03. Fixes B7, B8, B9, B10, B11, B12.

## Files

- `src/router/client.ts:73` — `models()` returns entries: `id`, `displayName?`, `contextTokens?`,
  `maxOutputTokens?`, `resolvedModel?`. Read `max_input_tokens ?? context_length` and
  `max_tokens ?? max_completion_tokens`; anything but a positive integer is unknown. Keep the Bearer header,
  so older routers behave as now. Non-200 `/healthz` gets its own error kind (B8).
- `src/launch/catalog.ts` (new) — pure: entries → picker rows, tiers, windows.
- `src/launch/preflight.ts:75` — `/healthz` and `/v1/models` together, each within the existing budget.
- `src/launch/settings.ts:198` — `model`, `modelPicker`, window variables, Fable.
- `src/launch/run.ts:77` — pass the catalog in; warnings to stderr.
- `src/tiers.ts:10,13` — optional `fable` family. No default id: unserved means unpinned.
- `src/commands/login.ts` — warn when a family fell back to `DEFAULT_TIERS`; refuse a key listing no models.
- README ("Known gaps", refusals, a new "Models" section), `src/help.ts`, `.env.example`.

## Behaviour

**Launch checks.** `/v1/models` 401 or 403 → exit 77, "the router rejected the key: run `claudes login
--profile <name>`". Any other `/v1/models` failure → launch with the stored `tiers` snapshot and a one-line
note on stderr that the model list is not live. `/healthz` non-200 → exit 69 with the HTTP status.

**Ids are router text.** Drop an id that fails the existing `MODEL_ID_PATTERN` (widen it for `/`, which other
providers use) or carries key material (`keyFragmentOffset`, `src/config/schema.ts:31`): the ids land in a
file on disk and on screen. Scrub and cap `displayName` the same way.

**Picker.** `replaceBuiltInOptions: true`. One row per usable id: pinned tiers first, then other Claude ids
newest first, then the rest alphabetically. Drop an alias whose `resolvedModel` is also listed. Label is
`displayName`, or the id; description is the known sizes ("128K context · 16K output"). With zero usable
ids, emit no `modelPicker`.

**Tiers.** Catalog live: pin → newest served → the strongest other family that is served (opus, sonnet, haiku
order), with a note. Never the snapshot: a live list that dropped an id is the truth. If no Claude family is
served, every family and the session model use the first picker row, with a note. Catalog unavailable:
pin → snapshot → `DEFAULT_TIERS`, with a note.

**Session model.** Read the `model` key from the user's settings file (`CLAUDE_CONFIG_DIR` or `~/.claude`),
read-only. If it is a tier alias or a served id, leave it alone so a `/model` pick sticks. If it is not
served, pin `model` to the opus tier for this session and print one note. Neutralise a planted
`ANTHROPIC_MODEL` after verifying what an empty value does; if empty is not "unset", pin it to the chosen
model. `--model` with an unserved id: note, then pass it through, because routers may serve unlisted ids.

**Windows.** An explicit `maxContextTokens` wins. Otherwise, with W the router's window for the launch model:
`CLAUDE_CODE_AUTO_COMPACT_WINDOW=W` and `CLAUDE_CODE_MAX_CONTEXT_TOKENS=W`. When the launch model is a
Claude tier id, use for the latter the smallest known window among the non-tier ids.
No overflow guarantee is made across `/model`: these are session-wide, and a switch to a recognised model whose
router window is below both W and Claude Code's own figure can overflow. Verify what Claude Code does then
(step 3), and show the real window in each picker row. W unknown → emit neither. A value already in the user's shell wins, except that a claudes
session nested in another must not inherit the outer one's values: mark the generated ones and drop them
in `buildChildEnv`. Both are session-wide; document that after `/model` the window is the launch model's.

**`behavesAs`**: not emitted. It changes thinking and effort parameters, and the router states no mapping.

## Steps

1. Client parsing and its tests, both dialects.
2. `catalog.ts`.
3. Verify live: the empty-value questions above; `AUTO_COMPACT_WINDOW` at 64000, 128000 and 1000000 on a
   recognised id; a switch from a 1M model to one the stub limits to 200k; picker rows with 300 ids; a row with a `/` in the id.
4. Settings, pre-flight, run, login, README.
5. Raise `MIN_CLAUDE_VERSION` (`src/doctor/claude-version.ts:16`) to 2.1.325 and the README's two mentions;
   older versions ignore the window for unrecognised `claude-*` ids.

## Tests

- Both dialects, null sizes, string sizes, negative sizes, alias rows, hostile ids (control characters, a
  key fragment, 10 kB), duplicate ids, an empty list.
- Exit 77 on 401 and 403; launch with a note on 500, timeout and malformed body.
- Saved `model`: served, unserved, alias, `opus[1m]`, unreadable file, invalid JSON.
- Window table: explicit, tier launch, non-tier launch, unknown, shell-set, nested.
- Settings payload never contains a key fragment.
- A live list that lost the opus id: neither tier nor session model uses the stored one.
- A router that changes its list between two launches changes the second picker with no login.

## Done when

Live: `/model` shows exactly what the stub serves with sizes; `/context` matches the stub's window for a
recognised and an unrecognised id; a revoked key fails in under 2 s.

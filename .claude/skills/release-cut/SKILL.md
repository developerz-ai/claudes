---
description: Cuts a claudes npm release via the GitHub Actions release workflow. Use for release, tag, npm, version bump, publish, trusted publishing.
applies: [typescript, javascript, bun]
---

> House skill — established by dz-runner setup mode from this repo's own evidence, then owned by its maintainers. Correct it in place; setup never overwrites a skill that exists.

1. Bump `version` in `package.json` to the new semver (e.g., `0.1.0`). `src/version.ts` MUST match — `src/version.test.ts` reads `package.json` and asserts the drift.
2. Open a PR; merge to `main` only after `.github/workflows/ci.yml` is green on the full matrix (ubuntu-latest + macos-latest × Node 22 + 24).
3. Tag the merge commit on `main` as exactly `v${version}` (e.g., `v0.1.0`). `release.yml` refuses any other tag; an existing GitHub release with a mismatched tag will not publish.
4. Create the GitHub release from that tag. Mark it stable (NOT prerelease) — `release.yml` refuses pre-releases because they would move npm's `latest` tag.
5. The release workflow runs `bin/check`, packs the tarball with `npm pack`, verifies the tarball contains EXACTLY `dist/claudes.js`, `package.json`, `README.md`, `LICENSE` (no node_modules, no source), and publishes via OIDC trusted publishing (`npm publish --provenance` with `id-token: write`; no `NPM_TOKEN` anywhere).
6. The `verify` job polls the registry for the version to become visible; if it has not after 5 minutes, re-run ONLY the `verify` job — `publish` is immutable. `release.yml` installs npm 12.2.0 from a digest-verified tarball (sha512 base64) and refuses a mismatch.
7. Fail -> any of the guards in step 3, 4, 5 aborts the release: pre-release, tag/version mismatch, commit not on main, or tarball contents unexpected. Re-cut the release after the underlying fix — never re-run `publish`.

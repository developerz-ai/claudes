/**
 * The one fake router/key pair every test and harness shares. Framework-free
 * (no bun:test), like its sibling redact.ts, so the harness modules can
 * re-export the pair without pulling in a test framework. KEY satisfies
 * ROUTER_KEY_PATTERN (mar_live_ plus exactly 32 [A-Za-z0-9_-] characters) —
 * fixtures.test.ts pins both constants against the real config schema, so the
 * pair stays provable as it evolves.
 */
export const ROUTER = "https://router.example.test";
export const KEY = "mar_live_FAKEKEYabcdef0123456789abcdefghi";

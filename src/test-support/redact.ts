import { KEY_FRAGMENT_WINDOW, keyFragmentOffset, ROUTER_KEY_PREFIX } from "../config/schema";

/**
 * Fails when any 8-character window of the key body (the 32 secret characters
 * after `mar_live_`) appears in `text`. Checking only the whole key would miss
 * a partial leak, and half a key is still a leak. The window rule itself
 * lives in `keyFragmentOffset` (src/config/schema.ts), so this helper and the
 * doctor's request-id gate cannot drift apart. Deliberately framework-free:
 * it throws instead of calling expect, so it type-checks without bun:test.
 */
export function assertNoKeyFragment(text: string, key: string): void {
  const offset = keyFragmentOffset(text, key);
  if (offset === undefined) {
    return;
  }
  const start = ROUTER_KEY_PREFIX.length + offset;
  const fragment = key.slice(start, start + KEY_FRAGMENT_WINDOW);
  throw new Error(`output leaks the key fragment "${fragment}" starting at body offset ${offset}`);
}

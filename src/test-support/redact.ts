import { ROUTER_KEY_PREFIX } from "../config/schema";

/**
 * Fails when any 8-character window of the key body (the 32 secret characters
 * after `mar_live_`) appears in `text`. Checking only the whole key would miss
 * a partial leak, and half a key is still a leak. Deliberately framework-free:
 * it throws instead of calling expect, so it type-checks without bun:test.
 */
export function assertNoKeyFragment(text: string, key: string): void {
  const body = key.slice(ROUTER_KEY_PREFIX.length);
  for (let i = 0; i + 8 <= body.length; i++) {
    const fragment = body.slice(i, i + 8);
    if (text.includes(fragment)) {
      throw new Error(`output leaks the key fragment "${fragment}" starting at body offset ${i}`);
    }
  }
}

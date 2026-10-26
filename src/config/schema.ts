import { z } from "zod";

/** The prefix every router key starts with; the value after it is secret. */
export const ROUTER_KEY_PREFIX = "mar_live_";

/**
 * The one shape the router issues and accepts: `mar_live_` plus exactly 32
 * characters of `[A-Za-z0-9_-]`. Anything else — control bytes, spaces,
 * non-ASCII, wrong length — is refused before it can reach a network call,
 * because Node's fetch rejects such header values and names the value in the
 * thrown error.
 */
export const ROUTER_KEY_PATTERN = /^mar_live_[A-Za-z0-9_-]{32}$/;

/**
 * How much of the key body counts as a leak: eight characters. Half a key is
 * still a key, so the rule is a window over the body, not the whole secret.
 */
export const KEY_FRAGMENT_WINDOW = 8;

/**
 * The offset, into the key's body (the characters after `ROUTER_KEY_PREFIX`),
 * of the first `KEY_FRAGMENT_WINDOW`-character window of that body appearing
 * in `text`; undefined when the text carries no window of the body. This is
 * the one implementation of the window rule: the test helper and the doctor's
 * request-id gate both call it, so the window cannot drift apart. The gate
 * adds a rule of its own on top — it also treats the bare `mar_live_` prefix
 * as a leak — while the helper checks the window only, because scrubbed
 * output legitimately keeps that prefix.
 */
export function keyFragmentOffset(text: string, key: string): number | undefined {
  const body = key.slice(ROUTER_KEY_PREFIX.length);
  for (let offset = 0; offset + KEY_FRAGMENT_WINDOW <= body.length; offset++) {
    if (text.includes(body.slice(offset, offset + KEY_FRAGMENT_WINDOW))) {
      return offset;
    }
  }
  return undefined;
}

/**
 * Router base URL: `https://` for any host, `http://` only for loopback, and a
 * bare origin only — no path, query, fragment, trailing slash, credentials,
 * whitespace, or an explicit default port (the URL parser silently accepts all
 * of those; requiring `value === url.origin` rejects them in one stroke).
 */
export const baseUrlSchema = z.string().superRefine((value, ctx) => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    ctx.addIssue({
      code: "custom",
      message:
        "baseUrl must be a valid https:// URL (http:// is allowed only for 127.0.0.1, localhost, or [::1])",
    });
    return;
  }
  if (value !== url.origin) {
    ctx.addIssue({
      code: "custom",
      message: "baseUrl must be a bare origin (scheme, host, optional port) with nothing else",
    });
  }
  const loopback =
    url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    ctx.addIssue({
      code: "custom",
      message:
        "baseUrl must use https:// (http:// is allowed only for 127.0.0.1, localhost, or [::1])",
    });
  }
  if (url.username !== "" || url.password !== "") {
    ctx.addIssue({ code: "custom", message: "baseUrl must not embed credentials" });
  }
});

/** Per-person router key: `mar_live_` plus exactly 32 `[A-Za-z0-9_-]` characters. */
export const keySchema = z
  .string()
  .regex(ROUTER_KEY_PATTERN, 'key must be "mar_live_" followed by 32 characters');

export const configSchema = z.object({
  version: z.literal(1),
  baseUrl: baseUrlSchema,
  key: keySchema,
  tiers: z.object({
    opus: z.string().min(1),
    sonnet: z.string().min(1),
    haiku: z.string().min(1),
  }),
  subagentModel: z.string().min(1).optional(),
  maxContextTokens: z.number().int().positive().optional(),
});

export type Config = z.infer<typeof configSchema>;

/** Formats a failed parse into one stable, single-line message. */
export function formatZodIssues(error: z.ZodError): string {
  // A root-level issue has no path; printing it as ": message" would leave a
  // dangling separator, so the prefix is added only when there is a path.
  return error.issues
    .map((issue) => {
      const at = issue.path.join(".");
      return at === "" ? issue.message : `${at}: ${issue.message}`;
    })
    .join("; ");
}

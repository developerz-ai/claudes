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

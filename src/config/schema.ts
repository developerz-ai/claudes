import { z } from "zod";

/**
 * Router base URL: `https://` for any host, `http://` only for loopback, and
 * never with a path, query, fragment, trailing slash, or embedded credentials.
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
  if (url.pathname !== "/") {
    ctx.addIssue({ code: "custom", message: "baseUrl must not include a path" });
  }
  if (value.endsWith("/")) {
    ctx.addIssue({ code: "custom", message: "baseUrl must not end with a slash" });
  }
  if (url.search !== "") {
    ctx.addIssue({ code: "custom", message: "baseUrl must not include a query string" });
  }
  if (url.hash !== "") {
    ctx.addIssue({ code: "custom", message: "baseUrl must not include a fragment" });
  }
});

/** Per-person router key. The prefix is what the router issues; the value is secret. */
export const keySchema = z
  .string()
  .regex(/^mar_live_\S+$/, 'key must be a router key starting with "mar_live_"');

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
  return error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
}

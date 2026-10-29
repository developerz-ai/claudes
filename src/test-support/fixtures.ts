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

export type RouterResponseOptions = {
  healthStatus?: number;
  healthBody?: string;
  modelsStatus?: number;
  modelsBody?: string;
  healthResponse?: Response;
  modelsResponse?: Response;
};

/** Fresh defaults; supplied Responses pass through untouched, including their streams. */
export function routerResponse(url: string, options: RouterResponseOptions = {}): Response {
  switch (new URL(url).pathname) {
    case "/healthz":
      return (
        options.healthResponse ??
        new Response(options.healthBody ?? JSON.stringify({ version: "1.4.2" }), {
          status: options.healthStatus ?? 200,
        })
      );
    case "/v1/models":
      return (
        options.modelsResponse ??
        new Response(
          options.modelsBody ??
            JSON.stringify({
              data: [
                { id: "claude-opus-4-1" },
                { id: "claude-sonnet-4-5" },
                { id: "claude-haiku-4-5" },
              ],
            }),
          { status: options.modelsStatus ?? 200 },
        )
      );
    default:
      throw new Error("unexpected router fixture endpoint");
  }
}

/** Claude Code 2.1.331 first-argument commands that use its standalone environment. */
const MANAGE = new Set([
  "attach",
  "logs",
  "stop",
  "kill",
  "rm",
  "respawn",
  "daemon",
  "mcp",
  "plugin",
  "plugins",
  "update",
  "upgrade",
  "install",
  "auth",
  "auto-mode",
  "import",
  "purge",
  "setup-token",
  "gateway",
  "-h",
]);

const DISPATCH = new Set(["agents", "remote-control"]);
const OFF_ROUTER_FLAGS = new Set(["--cloud", "--environment", "--desktop"]);

// Only definite single values of these options can mask a flag-shaped token.
const TEXT_OPTIONS = new Set(["--system-prompt", "--append-system-prompt"]);

export function classify(args: readonly string[]): "manage" | "dispatch" | "session" {
  const first = args[0];
  if (first !== undefined && MANAGE.has(first)) return "manage";
  if (first !== undefined && DISPATCH.has(first)) return "dispatch";
  return "session";
}

export function offRouterOption(args: readonly string[]): string | undefined {
  if (args[0] === "ultrareview") return "ultrareview";
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined || arg === "--") break;
    const name = arg.split("=", 1)[0] ?? "";
    if (OFF_ROUTER_FLAGS.has(name)) return name;
    if (TEXT_OPTIONS.has(arg) && args[i + 1] !== "--") i++;
  }
  return undefined;
}

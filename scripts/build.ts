import { chmodSync } from "node:fs";

const OUTFILE = "dist/claudes.js";

const result = await Bun.build({
  entrypoints: ["src/main.ts"],
  target: "node",
  outdir: "dist",
  naming: "claudes.js",
  minify: false,
});

if (!result.success) {
  console.error(result.logs);
  process.exit(1);
}

// Prepend the shebang so dist/claudes.js is directly executable, then mark it so.
const code = await Bun.file(OUTFILE).text();
await Bun.write(OUTFILE, `#!/usr/bin/env node\n${code}`);
chmodSync(OUTFILE, 0o755);

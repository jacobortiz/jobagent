#!/usr/bin/env node
// Runs the TypeScript CLI directly via tsx (no build step). `npm run build` + `node dist/src/cli.js` also works.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const tsx = require.resolve("tsx/cli");
const result = spawnSync(process.execPath, [tsx, path.join(here, "..", "src", "cli.ts"), ...process.argv.slice(2)], {
  stdio: "inherit",
  // node:sqlite is still flagged experimental; hide that one warning in the child.
  env: { ...process.env, NODE_OPTIONS: [process.env.NODE_OPTIONS, "--no-warnings=ExperimentalWarning"].filter(Boolean).join(" ") },
});
process.exit(result.status ?? 1);

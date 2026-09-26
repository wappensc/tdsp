import { fileURLToPath } from "node:url";
import { main } from "./license-check.ts";

/**
 * `pnpm run licenses:check`'s entry point, kept separate from
 * `license-check.ts` so that importing the checker from a test never runs
 * it or exits the process — the same split `netcheck.ts`/`netcheck-cli.ts`
 * already use.
 */
const repoRoot = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
process.exit(main(repoRoot));

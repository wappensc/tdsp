import { fileURLToPath } from "node:url";
import { main } from "./netcheck.ts";

/**
 * `pnpm run netcheck`'s entry point, kept separate from `netcheck.ts` so
 * that importing the checker from a test never runs it or exits the
 * process — the same split `infra/matrix-testserver` uses between its
 * library modules and its runnable scripts.
 */
const repoRoot = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
process.exit(main(repoRoot));

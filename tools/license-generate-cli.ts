import { fileURLToPath } from "node:url";
import { main } from "./license-generate.ts";

/**
 * `pnpm run licenses:generate`'s entry point, kept separate from
 * `license-generate.ts` so that importing the generator from a test never
 * runs it or exits the process — the same split every other tool in this
 * directory uses.
 */
const repoRoot = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
process.exit(main(repoRoot));

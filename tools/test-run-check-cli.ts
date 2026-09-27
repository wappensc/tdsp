import { fileURLToPath } from "node:url";
import { main } from "./test-run-check.ts";

/** Entry point, kept apart from `test-run-check.ts` so that a test importing it never runs it. */
const repoRoot = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
process.exit(main(repoRoot, process.argv.slice(2)));

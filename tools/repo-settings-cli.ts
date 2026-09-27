import { fileURLToPath } from "node:url";
import { main } from "./repo-settings.ts";

/** Entry point, kept apart from `repo-settings.ts` so that a test importing it never runs it. */
const repoRoot = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
process.exit(main(repoRoot, process.argv.slice(2)));

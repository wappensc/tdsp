import { fileURLToPath } from "node:url";
import { main } from "./wire-lock.ts";

/** `pnpm run wire:lock`, kept apart from `wire-lock.ts` so that a test importing it never runs it. */
const repoRoot = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
process.exit(main(repoRoot, process.argv.slice(2)));

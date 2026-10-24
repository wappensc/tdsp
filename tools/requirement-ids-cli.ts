import { fileURLToPath } from "node:url";
import { check } from "./requirement-ids.ts";

// Kept apart from requirement-ids.ts so that importing the checker in a test never runs it.
const root = fileURLToPath(new URL("..", import.meta.url));
const found = check(root);
for (const { file, line, id } of found) {
  console.error(`${file}:${line}: ${id} is cited but not defined`);
}
if (found.length > 0) {
  process.exit(1);
}
console.log("requirement-ids: every cited requirement ID is defined.");

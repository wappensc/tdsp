import { linkSignalBridge } from "./link.ts";

/**
 * `pnpm run signal:link <bridge url>`: links the Signal bridge at that loopback URL to an
 * account by a QR code the account's phone scans (docs/testing.md, `link.ts`). Kept separate
 * from `link.ts` so that a test importing it never runs it.
 */
const url = process.argv[2];
if (url === undefined || url.startsWith("-")) {
  console.error("usage: pnpm run signal:link http://127.0.0.1:<bridge port>");
  process.exit(2);
}

try {
  const outcome = await linkSignalBridge(url, {
    print: (text) => console.log(text),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
  });
  if (outcome.groups.length === 0) {
    console.log(
      "The account shows no Signal group yet. The L4 tests need exactly one group that the two " +
        "test accounts share; create it in the Signal app, then check again with this command.",
    );
  } else {
    console.log(`Groups this account can see (${outcome.groups.length}):`);
    for (const group of outcome.groups) {
      console.log(`  ${group.name}  (${group.id})`);
    }
    console.log(
      "The L4 tests need exactly one group that the two test accounts share, and refuse to run otherwise.",
    );
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

import { InMemoryMessengerPort } from "@tdsp/messenger-mock";
import { getPlainText, insertPlainText } from "@tdsp/reconciliation";
import { bench, describe } from "vitest";
import { DocumentEngine } from "./index";

// Lightweight benchmarks: time to first content and concurrent edit latency.
// `pnpm run bench` logs the numbers; they are not pass/fail thresholds. They
// measure DocumentEngine + InMemoryMessengerPort overhead only: the mock has no
// real network, so they say nothing about a real messenger's latency.

const DOCUMENT_ID = "bench-doc";

// DocumentEngine.create()/.join() default to batchWindowMs: 500. Both benchmarks below measure the immediate,
// unbatched path by name ("prior edits" must actually be visible to join
// against; "one immediate sync" says what it measures) — batching would
// change what they measure, not just how long it takes, so both opt out.
const IMMEDIATE = { batchWindowMs: 0 };

// join() calls requestResync() before sync() (RSY-1). Against this mock,
// receive() replays the entire history anyway, so a joiner's content arrives
// through that replay; the request is cheap but not free, and these numbers
// measure request and sync together, not sync() alone.
describe("time to first render (join a document with prior history)", () => {
  for (const historySize of [10, 100, 1000]) {
    bench(`join after ${historySize} prior edits`, async () => {
      const messenger = new InMemoryMessengerPort();
      const author = await DocumentEngine.create(
        DOCUMENT_ID,
        "author",
        messenger,
        undefined,
        IMMEDIATE,
      );
      for (let i = 0; i < historySize; i++) {
        author.edit((fragment) => insertPlainText(fragment, getPlainText(fragment).length, "x"));
      }
      await DocumentEngine.join(DOCUMENT_ID, "joiner", messenger, undefined, IMMEDIATE);
    });
  }
});

describe("concurrent edit latency (local edit to remote sync)", () => {
  bench("one edit, one immediate sync", async () => {
    const messenger = new InMemoryMessengerPort();
    const alice = await DocumentEngine.create(
      DOCUMENT_ID,
      "alice",
      messenger,
      undefined,
      IMMEDIATE,
    );
    const bob = await DocumentEngine.join(DOCUMENT_ID, "bob", messenger, undefined, IMMEDIATE);

    alice.edit((fragment) => insertPlainText(fragment, 0, "x"));
    await bob.sync();
  });
});

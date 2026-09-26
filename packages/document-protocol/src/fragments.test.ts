import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FragmentationImpossibleError,
  FragmentInconsistentError,
  FrameTooLargeError,
  fragmentFrame,
  newMessageId,
  Reassembler,
} from "./fragments";
import {
  decodeFrame,
  encodeFragmentFrame,
  type FragmentFrame,
  frameByteLength,
  MAX_FRAGMENTS,
  textToUtf8,
  utf8ToText,
} from "./framing";

const DOC = { documentId: "doc-1" };
/** A fragment frame's bytes besides its slice, at the widest index and total there can be. */
const OVERHEAD =
  frameByteLength(
    encodeFragmentFrame({
      documentId: "doc-1",
      messageId: "0".repeat(16),
      index: MAX_FRAGMENTS - 1,
      total: MAX_FRAGMENTS,
      chunk: new Uint8Array(1),
    }),
  ) - 4;
/** How many bytes of a slice a fragment of at most `maxBytes` carries: Base64, 4 characters per 3 bytes. */
const capacity = (maxBytes: number) => Math.floor((maxBytes - OVERHEAD) / 4) * 3;
/** A limit that leaves exactly 75 bytes for a slice. */
const LIMIT = OVERHEAD + 100;

/** A frame's text of `length` distinguishable ASCII characters. */
const frameOf = (length: number): string =>
  Array.from({ length }, (_, i) => String.fromCharCode(97 + ((i * 7 + 3) % 26))).join("");

const asFragments = (frames: string[]): FragmentFrame[] =>
  frames.map((frame) => decodeFrame(frame) as FragmentFrame);

const cut = (length: number, maxBytes = LIMIT): FragmentFrame[] =>
  asFragments(fragmentFrame(frameOf(length), { ...DOC, maxBytes }));

describe("fragmentFrame", () => {
  it("cuts a frame into fragments none of which exceeds the limit, and no more of them than needed", () => {
    const fragments = fragmentFrame(frameOf(1000), { ...DOC, maxBytes: LIMIT });
    expect(fragments).toHaveLength(Math.ceil(1000 / capacity(LIMIT)));
    for (const fragment of fragments) {
      expect(frameByteLength(fragment)).toBeLessThanOrEqual(LIMIT);
    }
    // Every slice but the last is full.
    for (const fragment of asFragments(fragments).slice(0, -1)) {
      expect(fragment.chunk.length).toBe(capacity(LIMIT));
    }
  });

  it("gives every fragment of one frame the same message id, and different frames different ones", () => {
    const first = cut(500);
    const second = cut(500);
    expect(new Set(first.map((f) => f.messageId)).size).toBe(1);
    expect((first[0] as FragmentFrame).messageId).not.toBe((second[0] as FragmentFrame).messageId);
    expect(newMessageId()).toMatch(/^[0-9a-f]{16}$/);
  });

  it("numbers them from 0 with the same total", () => {
    const fragments = cut(500);
    expect(fragments.map((f) => f.index)).toEqual(fragments.map((_, i) => i));
    expect(new Set(fragments.map((f) => f.total))).toEqual(new Set([fragments.length]));
  });

  it("makes one fragment of a frame whose text fits one slice", () => {
    expect(fragmentFrame(frameOf(1), { ...DOC, maxBytes: LIMIT })).toHaveLength(1);
    expect(fragmentFrame(frameOf(capacity(LIMIT)), { ...DOC, maxBytes: LIMIT })).toHaveLength(1);
  });

  it("cuts by bytes of UTF-8, even through a character, and the reassembled text is exactly the original", () => {
    const frame = "äöü😀".repeat(100);
    const fragments = asFragments(fragmentFrame(frame, { ...DOC, maxBytes: LIMIT }));
    expect(fragments.length).toBeGreaterThan(1);
    const reassembler = new Reassembler();
    let whole: Uint8Array | undefined;
    for (const fragment of fragments) {
      whole = reassembler.add("bob", fragment) ?? whole;
    }
    expect(utf8ToText(whole as Uint8Array)).toBe(frame);
  });

  it("refuses a limit too small to carry a single byte of a slice", () => {
    expect(() => fragmentFrame(frameOf(10), { ...DOC, maxBytes: OVERHEAD + 3 })).toThrow(
      FragmentationImpossibleError,
    );
    expect(() => fragmentFrame(frameOf(10), { ...DOC, maxBytes: OVERHEAD + 4 })).not.toThrow();
  });

  it("refuses a frame that would need more fragments than can be counted", () => {
    const huge = frameOf(MAX_FRAGMENTS * 3 + 1);
    expect(() => fragmentFrame(huge, { ...DOC, maxBytes: OVERHEAD + 4 })).toThrow(
      FrameTooLargeError,
    );
  });
});

describe("Reassembler", () => {
  it("hands back the original frame, byte for byte, when the last fragment arrives", () => {
    const frame = frameOf(2345);
    const fragments = asFragments(fragmentFrame(frame, { ...DOC, maxBytes: OVERHEAD + 200 }));
    const reassembler = new Reassembler();
    let whole: Uint8Array | undefined;
    for (const [i, fragment] of fragments.entries()) {
      whole = reassembler.add("bob", fragment);
      if (i < fragments.length - 1) {
        expect(whole).toBeUndefined();
      }
    }
    expect(whole).toEqual(textToUtf8(frame));
    expect(reassembler.heldBytes).toBe(0);
  });

  it("does not care what order they arrive in", () => {
    const frame = frameOf(2345);
    const fragments = asFragments(fragmentFrame(frame, { ...DOC, maxBytes: OVERHEAD + 200 }));
    for (const order of [
      [...fragments].reverse(),
      [...fragments.slice(3), ...fragments.slice(0, 3)],
    ]) {
      const reassembler = new Reassembler();
      const results = order.map((fragment) => reassembler.add("bob", fragment));
      expect(results.filter((r) => r !== undefined)).toEqual([textToUtf8(frame)]);
    }
  });

  it("ignores a duplicate, and completes exactly once", () => {
    const frame = frameOf(500);
    const fragments = asFragments(fragmentFrame(frame, { ...DOC, maxBytes: LIMIT }));
    const reassembler = new Reassembler();
    const results: (Uint8Array | undefined)[] = [];
    for (const fragment of fragments) {
      results.push(reassembler.add("bob", fragment));
      results.push(reassembler.add("bob", fragment)); // delivered twice: at least once, not exactly once
    }
    expect(results.filter((r) => r !== undefined)).toHaveLength(1);
    expect(results.find((r) => r !== undefined)).toEqual(textToUtf8(frame));
  });

  it("refuses two different slices at one position: two messages claiming one id (FRG-6)", () => {
    const frame = frameOf(500);
    const [first, second] = asFragments(fragmentFrame(frame, { ...DOC, maxBytes: LIMIT }));
    if (first === undefined || second === undefined) {
      throw new Error("expected at least two fragments");
    }
    const reassembler = new Reassembler();
    reassembler.add("bob", first);
    const forged = { ...first, chunk: first.chunk.map((byte) => byte ^ 1) };
    expect(() => reassembler.add("bob", forged)).toThrow(FragmentInconsistentError);
    expect(reassembler.heldBytes).toBe(0); // the whole set is dropped
    expect(reassembler.add("bob", second)).toBeUndefined();
  });

  it("a single fragment that is the whole frame needs no holding", () => {
    const [only] = cut(10);
    const reassembler = new Reassembler();
    expect(reassembler.add("bob", only as FragmentFrame)).toEqual(textToUtf8(frameOf(10)));
    expect(reassembler.incomplete()).toEqual([]);
  });

  it("keeps messages from different senders apart", () => {
    const a = frameOf(700);
    const b = [...a].reverse().join("");
    const fa = asFragments(fragmentFrame(a, { ...DOC, maxBytes: LIMIT }));
    const fb = asFragments(fragmentFrame(b, { ...DOC, maxBytes: LIMIT }));
    const reassembler = new Reassembler();
    const done: Uint8Array[] = [];
    for (let i = 0; i < Math.max(fa.length, fb.length); i += 1) {
      for (const [sender, list] of [
        ["bob", fa],
        ["carol", fb],
      ] as const) {
        const fragment = list[i];
        if (fragment) {
          const whole = reassembler.add(sender, fragment);
          if (whole) {
            done.push(whole);
          }
        }
      }
    }
    expect(done).toHaveLength(2);
    expect(done).toContainEqual(textToUtf8(a));
    expect(done).toContainEqual(textToUtf8(b));
  });

  it("does not mix up the same message id from two senders", () => {
    const messageId = newMessageId();
    const x = asFragments(fragmentFrame(frameOf(300), { ...DOC, maxBytes: LIMIT, messageId }));
    const y = asFragments(
      fragmentFrame([...frameOf(300)].reverse().join(""), { ...DOC, maxBytes: LIMIT, messageId }),
    );
    const reassembler = new Reassembler();
    const done: Uint8Array[] = [];
    for (let i = 0; i < x.length; i += 1) {
      for (const [sender, list] of [
        ["bob", x],
        ["carol", y],
      ] as const) {
        const whole = reassembler.add(sender, list[i] as FragmentFrame);
        if (whole) {
          done.push(whole);
        }
      }
    }
    expect(done).toHaveLength(2);
    expect(done[0]).not.toEqual(done[1]);
  });

  it("does not let a sender name run into the message id: two senders whose names differ only there stay apart", () => {
    const messageId = newMessageId();
    const one = asFragments(fragmentFrame(frameOf(300), { ...DOC, maxBytes: LIMIT, messageId }));
    const reassembler = new Reassembler();
    reassembler.add("a", one[0] as FragmentFrame);
    reassembler.add("a:b", one[1] as FragmentFrame);
    expect(reassembler.incomplete().map((entry) => entry.sender)).toEqual(["a", "a:b"]);
  });

  it("refuses a fragment whose total disagrees with the rest of its message, and forgets that message", () => {
    const fragments = cut(500);
    const reassembler = new Reassembler();
    reassembler.add("bob", fragments[0] as FragmentFrame);
    expect(() =>
      reassembler.add("bob", { ...(fragments[1] as FragmentFrame), total: fragments.length + 1 }),
    ).toThrow(FragmentInconsistentError);
    expect(reassembler.incomplete()).toEqual([]);
  });

  describe("what it holds is bounded, because everything in it comes from other people", () => {
    let now = 1_000_000;
    beforeEach(() => {
      vi.useFakeTimers();
      now = 1_000_000;
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("reports what is started and unfinished, with who and since when", () => {
      const fragments = cut(500);
      const reassembler = new Reassembler({ now: () => now });
      reassembler.add("bob", fragments[0] as FragmentFrame);
      reassembler.add("bob", fragments[1] as FragmentFrame);
      expect(reassembler.incomplete()).toEqual([
        { sender: "bob", since: now, have: 2, total: fragments.length },
      ]);
    });

    it("drops a message that has not been completed within the time to live, and its bytes", () => {
      const reassembler = new Reassembler({ ttlMs: 60_000, now: () => now });
      reassembler.add("bob", cut(500)[0] as FragmentFrame);
      now += 59_999;
      expect(reassembler.incomplete()).toHaveLength(1);
      now += 1;
      expect(reassembler.incomplete()).toEqual([]);
      expect(reassembler.heldBytes).toBe(0);
    });

    it("holds only so many unfinished messages per sender, dropping the oldest", () => {
      const reassembler = new Reassembler({ maxIncompletePerSender: 2, now: () => now });
      const firsts: FragmentFrame[][] = [];
      for (let m = 0; m < 3; m += 1) {
        const fragments = cut(500 + m);
        firsts.push(fragments);
        reassembler.add("bob", fragments[0] as FragmentFrame);
        now += 1;
      }
      expect(reassembler.incomplete()).toHaveLength(2);
      // The oldest message is gone: finishing it now cannot complete it, since its first slice went.
      let completed = false;
      for (const fragment of (firsts[0] as FragmentFrame[]).slice(1)) {
        completed = reassembler.add("bob", fragment) !== undefined || completed;
      }
      expect(completed).toBe(false);
    });

    it("one sender cannot push another's unfinished messages out", () => {
      const reassembler = new Reassembler({ maxIncompletePerSender: 1, now: () => now });
      reassembler.add("carol", cut(500)[0] as FragmentFrame);
      for (let m = 0; m < 5; m += 1) {
        reassembler.add("mallory", cut(500)[0] as FragmentFrame);
      }
      const senders = reassembler.incomplete().map((entry) => entry.sender);
      expect(senders.filter((s) => s === "carol")).toHaveLength(1);
      expect(senders.filter((s) => s === "mallory")).toHaveLength(1);
    });

    it("holds only so many bytes in all, dropping the oldest first", () => {
      const reassembler = new Reassembler({ maxBytes: 250, now: () => now });
      for (let m = 0; m < 5; m += 1) {
        const fragments = cut(600);
        reassembler.add(`sender-${m}`, fragments[0] as FragmentFrame);
        reassembler.add(`sender-${m}`, fragments[1] as FragmentFrame);
        now += 1;
      }
      expect(reassembler.heldBytes).toBeLessThanOrEqual(250);
      expect(reassembler.incomplete().length).toBeGreaterThan(0);
    });

    it("drops a single message that is by itself more than may be held", () => {
      const reassembler = new Reassembler({ maxBytes: 100, now: () => now });
      for (const fragment of cut(2000).slice(0, -1)) {
        expect(reassembler.add("mallory", fragment)).toBeUndefined();
      }
      expect(reassembler.heldBytes).toBeLessThanOrEqual(100);
    });

    it("forgets everything on clear()", () => {
      const reassembler = new Reassembler();
      reassembler.add("bob", cut(500)[0] as FragmentFrame);
      reassembler.clear();
      expect(reassembler.incomplete()).toEqual([]);
      expect(reassembler.heldBytes).toBe(0);
    });
  });
});

import type { DocumentId, MemberId } from "@tdsp/messenger-port";
import {
  encodeFragmentFrame,
  type FragmentFrame,
  frameByteLength,
  MAX_FRAGMENTS,
  newRandomId,
  textToUtf8,
} from "./framing";

/**
 * Cutting a frame that is larger than one message may be into slices, and putting them back
 * together (SPECIFICATION.md §9.4). This is the last resort. A change made of several
 * updates is *spread*, one prefix per message, and needs none of this — every piece is a valid
 * update the receiver applies as it arrives. Only a single frame that is by itself over the
 * limit (one big paste, a full-state answer to a joiner) is cut, by the bytes of its UTF-8 text,
 * and then the receiver can apply nothing until every slice has arrived, and a lost slice is a
 * lost message.
 */

/** The transport's limit leaves no room for even one byte of a slice beside a fragment's other fields. */
export class FragmentationImpossibleError extends Error {
  constructor(maxBytes: number, overhead: number) {
    super(
      `a message of at most ${maxBytes} bytes cannot carry a slice of a larger one: ${overhead} bytes are taken by a fragment's other fields alone`,
    );
    this.name = "FragmentationImpossibleError";
  }
}

/** The frame would need more slices than a frame can count. */
export class FrameTooLargeError extends Error {
  constructor(bytes: number, maxBytes: number) {
    super(
      `a frame of ${bytes} bytes needs more than ${MAX_FRAGMENTS} messages of at most ${maxBytes} bytes`,
    );
    this.name = "FrameTooLargeError";
  }
}

/** The random 64-bit id every slice of one frame shares, as 16 lowercase hex digits. */
export function newMessageId(): string {
  return newRandomId();
}

/**
 * How many bytes of a slice fit in a fragment frame of at most `maxBytes`: the frame's other
 * fields are measured with the widest index and total there can be, and the slice travels as
 * Base64, four characters for every three bytes.
 */
function sliceCapacity(
  documentId: DocumentId,
  maxBytes: number,
): { bytes: number; overhead: number } {
  const overhead =
    frameByteLength(
      encodeFragmentFrame({
        documentId,
        messageId: "0".repeat(16),
        index: MAX_FRAGMENTS - 1,
        total: MAX_FRAGMENTS,
        chunk: new Uint8Array(1),
      }),
    ) - 4; // the Base64 of the one placeholder byte
  return { bytes: Math.floor((maxBytes - overhead) / 4) * 3, overhead };
}

/**
 * Cuts `frame` — a frame's JSON text — into fragment frames of at most `maxBytes` each, in
 * order. Throws if `maxBytes` is too small to carry any slice, or the frame would need more than
 * 65 535 of them.
 */
export function fragmentFrame(
  frame: string,
  options: {
    documentId: DocumentId;
    maxBytes: number;
    messageId?: string;
  },
): string[] {
  const { bytes: sliceSize, overhead } = sliceCapacity(options.documentId, options.maxBytes);
  if (sliceSize < 1) {
    throw new FragmentationImpossibleError(options.maxBytes, overhead);
  }
  const bytes = textToUtf8(frame);
  const total = Math.max(1, Math.ceil(bytes.length / sliceSize));
  if (total > MAX_FRAGMENTS) {
    throw new FrameTooLargeError(bytes.length, options.maxBytes);
  }
  const messageId = options.messageId ?? newMessageId();
  const fragments: string[] = [];
  for (let index = 0; index < total; index += 1) {
    fragments.push(
      encodeFragmentFrame({
        documentId: options.documentId,
        messageId,
        index,
        total,
        chunk: bytes.subarray(index * sliceSize, (index + 1) * sliceSize),
      }),
    );
  }
  return fragments;
}

/** Thrown for a fragment that contradicts the rest of its message. */
export class FragmentInconsistentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FragmentInconsistentError";
  }
}

export interface ReassemblerOptions {
  /** Incomplete messages held per sender; the oldest is dropped beyond this. */
  readonly maxIncompletePerSender?: number;
  /** Bytes held across every incomplete message; the oldest are dropped beyond this. */
  readonly maxBytes?: number;
  /** How long an incomplete message is kept. Long: a big change spread at a provider's rate takes a long time. */
  readonly ttlMs?: number;
  readonly now?: () => number;
}

interface Held {
  readonly sender: MemberId;
  readonly total: number;
  readonly parts: Map<number, Uint8Array>;
  readonly since: number;
  bytes: number;
}

export interface IncompleteMessage {
  readonly sender: MemberId;
  readonly since: number;
  readonly have: number;
  readonly total: number;
}

export const DEFAULT_REASSEMBLY_MAX_INCOMPLETE_PER_SENDER = 4;
export const DEFAULT_REASSEMBLY_MAX_BYTES = 32 * 1024 * 1024;
export const DEFAULT_REASSEMBLY_TTL_MS = 6 * 3_600_000;

/**
 * The receiving side: holds the slices of frames that have not all arrived, and hands back the
 * whole frame when the last one does. **Bounded** — everything in it comes from other people, so
 * what it may hold is capped per sender and in total, and what is not completed in a long while is
 * dropped. A message dropped that way is a lost message, which loss detection then treats like any
 * other.
 */
export class Reassembler {
  readonly #maxIncompletePerSender: number;
  readonly #maxBytes: number;
  readonly #ttlMs: number;
  readonly #now: () => number;
  // Insertion order is age order, which is what "the oldest" means below.
  readonly #held = new Map<string, Held>();
  #bytes = 0;

  constructor(options: ReassemblerOptions = {}) {
    this.#maxIncompletePerSender =
      options.maxIncompletePerSender ?? DEFAULT_REASSEMBLY_MAX_INCOMPLETE_PER_SENDER;
    this.#maxBytes = options.maxBytes ?? DEFAULT_REASSEMBLY_MAX_BYTES;
    this.#ttlMs = options.ttlMs ?? DEFAULT_REASSEMBLY_TTL_MS;
    this.#now = options.now ?? (() => Date.now());
  }

  /**
   * Takes one slice from `sender`. Returns the complete frame's UTF-8 bytes if this was the last one missing,
   * otherwise `undefined`. A slice already held (a duplicate) changes nothing. Throws
   * `FragmentInconsistentError` for a slice whose total disagrees with the rest of its message.
   */
  add(sender: MemberId, fragment: FragmentFrame): Uint8Array | undefined {
    this.#prune();
    // The sender's length first, so no sender name can run into the message id.
    const key = `${sender.length}:${sender}:${fragment.messageId}`;
    let held = this.#held.get(key);
    if (held === undefined) {
      if (fragment.total === 1) {
        return fragment.chunk; // one slice is the whole frame: nothing to hold
      }
      held = { sender, total: fragment.total, parts: new Map(), since: this.#now(), bytes: 0 };
      this.#held.set(key, held);
      this.#dropOldestOfSenderBeyondLimit(sender, key);
    } else if (held.total !== fragment.total) {
      this.#delete(key);
      throw new FragmentInconsistentError(
        `a fragment says its message has ${fragment.total} parts, another said ${held.total}`,
      );
    }
    const already = held.parts.get(fragment.index);
    if (already !== undefined && !sameBytes(already, fragment.chunk)) {
      // A resent slice is byte for byte the same (FRG-2); a different one under the same index
      // means two messages claim one id, and neither can be trusted to be put back together.
      this.#delete(key);
      throw new FragmentInconsistentError(
        `two different slices arrived as part ${fragment.index} of the same message`,
      );
    }
    if (already === undefined) {
      held.parts.set(fragment.index, fragment.chunk);
      held.bytes += fragment.chunk.length;
      this.#bytes += fragment.chunk.length;
    }
    if (held.parts.size === held.total) {
      const whole = concatenate(held);
      this.#delete(key);
      return whole;
    }
    this.#dropOldestBeyondBytes(key);
    return undefined;
  }

  /** The messages started and not finished, for loss detection. */
  incomplete(): IncompleteMessage[] {
    this.#prune();
    return [...this.#held.values()].map((held) => ({
      sender: held.sender,
      since: held.since,
      have: held.parts.size,
      total: held.total,
    }));
  }

  /** Forgets every message that had not been finished. */
  clear(): void {
    this.#held.clear();
    this.#bytes = 0;
  }

  /** Bytes currently held. */
  get heldBytes(): number {
    return this.#bytes;
  }

  #prune(): void {
    const now = this.#now();
    for (const [key, held] of this.#held) {
      if (now - held.since >= this.#ttlMs) {
        this.#delete(key);
      }
    }
  }

  #dropOldestOfSenderBeyondLimit(sender: MemberId, keepKey: string): void {
    const mine = [...this.#held.entries()].filter(([, held]) => held.sender === sender);
    let excess = mine.length - this.#maxIncompletePerSender;
    for (const [key] of mine) {
      if (excess <= 0) {
        break;
      }
      if (key !== keepKey) {
        this.#delete(key);
        excess -= 1;
      }
    }
  }

  #dropOldestBeyondBytes(keepKey: string): void {
    for (const key of [...this.#held.keys()]) {
      if (this.#bytes <= this.#maxBytes) {
        return;
      }
      if (key !== keepKey) {
        this.#delete(key);
      }
    }
    // Still over with only the message being added left: it alone is more than may be held.
    if (this.#bytes > this.#maxBytes) {
      this.#delete(keepKey);
    }
  }

  #delete(key: string): void {
    const held = this.#held.get(key);
    if (held !== undefined) {
      this.#bytes -= held.bytes;
      this.#held.delete(key);
    }
  }
}

function concatenate(held: Held): Uint8Array {
  const out = new Uint8Array(held.bytes);
  let offset = 0;
  for (let index = 0; index < held.total; index += 1) {
    const part = held.parts.get(index) as Uint8Array;
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

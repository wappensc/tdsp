/**
 * The bounds of Appendix A, "Reading without applying", that Yjs's own reader does not keep: no
 * variable-length integer above 2^53 − 1 or longer than 8 bytes, no client's structs and no delete
 * range ending beyond 2^53 − 1, and no JSON content or `Any` value nested more than 32 levels
 * (SPECIFICATION.md Appendix A, §1.6). Yjs adds a struct's length to its clock without a bound, so
 * two lengths within bounds can leave a replica at a clock whose state vector no receiver reads. lib0 checks an integer's range
 * only between its bytes, so the last byte can carry it past 2^53 − 1, and reads a long run of
 * zero bytes as NaN; and it reads `Any` values by recursion, so deep nesting ends in a stack
 * overflow rather than a rule. This walks the layout of encoding
 * version 1 once, iteratively, before Yjs reads it; what else is wrong with the bytes Yjs finds.
 */

/** Appendix A and §1.6: arrays and objects, the outermost counting as the first level. */
export const MAX_UPDATE_NESTING = 32;

/** Appendix A: enough for 2^53 − 1, unsigned (7 × 8 bits) and signed (6 + 7 × 7 bits). */
export const MAX_VARINT_BYTES = 8;

class OutOfBounds extends Error {}

const fail = (): never => {
  throw new OutOfBounds();
};

/**
 * Appendix A: `clock` plus `length`, an end, at most 2^53 − 1 — of a client's structs the state
 * vector entry it leaves (Yjs `getStateVector`: a struct's clock plus its length), of a delete
 * range the clock after it. Both are within 2^53 − 1 already, so the difference is exact.
 */
const end = (clock: number, length: number): number =>
  length > Number.MAX_SAFE_INTEGER - clock ? fail() : clock + length;

class Reader {
  at = 0;

  constructor(readonly bytes: Uint8Array) {}

  get atEnd(): boolean {
    return this.at === this.bytes.length;
  }

  byte(): number {
    if (this.at >= this.bytes.length) {
      fail();
    }
    return this.bytes[this.at++] as number;
  }

  /** lib0's unsigned varint: 7 bits a byte, least significant first; at most 8 bytes and 2^53 − 1. */
  varUint(): number {
    return this.rest(0, 1, MAX_VARINT_BYTES);
  }

  /** lib0's signed varint: 6 bits, the sign (0x40) and the continuation bit in the first byte. */
  varInt(): void {
    const first = this.byte();
    if (first >= 0x80) {
      this.rest(first & 0x3f, 64, MAX_VARINT_BYTES - 1);
    }
  }

  private rest(start: number, from: number, bytes: number): number {
    let value = start;
    let factor = from;
    for (let left = bytes; ; left -= 1) {
      if (left === 0) {
        fail();
      }
      const byte = this.byte();
      if ((byte & 0x7f) !== 0) {
        value += (byte & 0x7f) * factor;
        if (value > Number.MAX_SAFE_INTEGER) {
          fail();
        }
      }
      if (byte < 0x80) {
        return value;
      }
      factor *= 128;
    }
  }

  skip(length: number): number {
    if (length > this.bytes.length - this.at) {
      fail();
    }
    const from = this.at;
    this.at += length;
    return from;
  }

  /** A string's bytes, whose UTF-8 Yjs checks. */
  string(): { readonly from: number; readonly to: number } {
    const length = this.varUint();
    const from = this.skip(length);
    return { from, to: from + length };
  }

  /**
   * A string's length in UTF-16 code units, which its clocks count (Yjs `ContentString`): one for
   * each UTF-8 sequence, two for a four-byte one. Bytes that are no UTF-8 Yjs refuses itself.
   */
  stringLength(): number {
    const { from, to } = this.string();
    let units = 0;
    for (let i = from; i < to; i += 1) {
      const c = this.bytes[i] as number;
      if ((c & 0xc0) !== 0x80) {
        units += c >= 0xf0 ? 2 : 1;
      }
    }
    return units;
  }

  /**
   * JSON content: its arrays and objects counted outside strings, as JSN-1 counts a frame's. The
   * brackets, quotes and backslash are ASCII, which no byte of a multi-byte UTF-8 sequence is.
   */
  json(): void {
    const { from, to } = this.string();
    let depth = 0;
    let inString = false;
    for (let i = from; i < to; i += 1) {
      const c = this.bytes[i] as number;
      if (inString) {
        if (c === 0x5c) {
          i += 1;
        } else if (c === 0x22) {
          inString = false;
        }
      } else if (c === 0x22) {
        inString = true;
      } else if (c === 0x5b || c === 0x7b) {
        depth += 1;
        if (depth > MAX_UPDATE_NESTING) {
          fail();
        }
      } else if ((c === 0x5d || c === 0x7d) && depth > 0) {
        depth -= 1;
      }
    }
  }

  /** One `Any` value (lib0 `readAny`, tags 127 down to 116), without recursion. */
  any(): void {
    // Per open array or object: the values still to read, and whether each comes with a key.
    const remaining: number[] = [];
    const keyed: boolean[] = [];
    for (;;) {
      const tag = this.byte();
      switch (tag) {
        case 127: // undefined
        case 126: // null
        case 121: // false
        case 120: // true
          break;
        case 125:
          this.varInt();
          break;
        case 124:
          this.skip(4);
          break;
        case 123:
        case 122:
          this.skip(8);
          break;
        case 119:
          this.string();
          break;
        case 118: // object
        case 117: // array
          if (remaining.length === MAX_UPDATE_NESTING) {
            fail();
          }
          remaining.push(this.varUint());
          keyed.push(tag === 118);
          break;
        case 116:
          this.skip(this.varUint());
          break;
        default:
          fail();
      }
      for (;;) {
        const top = remaining.length - 1;
        if (top < 0) {
          return;
        }
        if (remaining[top] === 0) {
          remaining.pop();
          keyed.pop();
          continue;
        }
        remaining[top] = (remaining[top] as number) - 1;
        if (keyed[top] === true) {
          this.string();
        }
        break;
      }
    }
  }

  /**
   * Item content by the low five bits of the info byte (Yjs `readItemContent`), and its length,
   * the clocks the item takes (`getLength` of the content kind).
   */
  content(kind: number): number {
    switch (kind) {
      case 1: // deleted
        return this.varUint();
      case 2: {
        // JSON: Yjs writes `undefined` as that word, which holds no nesting.
        const entries = this.varUint();
        for (let n = entries; n > 0; n -= 1) {
          this.json();
        }
        return entries;
      }
      case 3: // binary
        this.skip(this.varUint());
        return 1;
      case 4: // string
        return this.stringLength();
      case 5: // embed
        this.json();
        return 1;
      case 6: // format: a key, then its value
        this.string();
        this.json();
        return 1;
      case 7: {
        // A type; an element and a hook carry a name.
        const ref = this.varUint();
        if (ref === 3 || ref === 5) {
          this.string();
        }
        return 1;
      }
      case 8: {
        const entries = this.varUint();
        for (let n = entries; n > 0; n -= 1) {
          this.any();
        }
        return entries;
      }
      case 9: // a subdocument: its guid and options
        this.string();
        this.any();
        return 1;
      default:
        return fail();
    }
  }
}

/**
 * Whether no variable-length integer of `update` lies above 2^53 − 1 or takes more than 8 bytes,
 * no client's structs and no delete range end beyond 2^53 − 1, and no JSON content or `Any` value
 * in it nests deeper than `MAX_UPDATE_NESTING` (Appendix A).
 * False also for bytes this walk cannot follow to their end; whether they are an update otherwise
 * is Yjs's to say.
 */
export function updateWithinBounds(update: Uint8Array): boolean {
  const r = new Reader(update);
  try {
    // The structs (Yjs `lazyStructReaderGenerator`): per client the number of its structs, its id
    // and the clock of the first; each struct's length moves the clock on, a skip's too
    // (`readClientsStructRefs`), and where it ends no struct of the update may end beyond.
    for (let clients = r.varUint(); clients > 0; clients -= 1) {
      let structs = r.varUint();
      r.varUint();
      let clock = r.varUint();
      for (; structs > 0; structs -= 1) {
        const info = r.byte();
        if (info === 10) {
          clock = end(clock, r.varUint()); // a skip
        } else if ((info & 0x1f) !== 0) {
          if ((info & 0x80) !== 0) {
            r.varUint(); // origin
            r.varUint();
          }
          if ((info & 0x40) !== 0) {
            r.varUint(); // right origin
            r.varUint();
          }
          if ((info & 0xc0) === 0) {
            // `readParentInfo`: 1 names a top-level type by its key, anything else an item.
            if (r.varUint() === 1) {
              r.string();
            } else {
              r.varUint();
              r.varUint();
            }
            if ((info & 0x20) !== 0) {
              r.string(); // parentSub
            }
          }
          clock = end(clock, r.content(info & 0x1f));
        } else {
          clock = end(clock, r.varUint()); // collected garbage
        }
      }
    }
    // The delete set: per client its id and ranges, each a clock and a length.
    for (let clients = r.varUint(); clients > 0; clients -= 1) {
      r.varUint();
      for (let ranges = r.varUint(); ranges > 0; ranges -= 1) {
        end(r.varUint(), r.varUint());
      }
    }
    return r.atEnd;
  } catch (error) {
    if (error instanceof OutOfBounds) {
      return false;
    }
    throw error;
  }
}

/** Whether `stateVector` reads to its last byte, every number within 2^53 − 1 and 8 bytes (Appendix A). */
export function stateVectorWithinBounds(stateVector: Uint8Array): boolean {
  const r = new Reader(stateVector);
  try {
    for (let entries = r.varUint(); entries > 0; entries -= 1) {
      r.varUint();
      r.varUint();
    }
    return r.atEnd;
  } catch (error) {
    if (error instanceof OutOfBounds) {
      return false;
    }
    throw error;
  }
}

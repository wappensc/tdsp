import * as Y from "yjs";

/**
 * Splitting an update into pieces (PRF-1, SPECIFICATION.md §9.4 and Appendix A):
 * each piece a valid Yjs update (encoding version 1), applicable in any order and with duplicates,
 * one that arrives before its predecessors held as Yjs holds any such update. What replaces the
 * `fragment` kind of 1.x: a frame too large for one message is sent as several frames of one piece
 * each (SND-17).
 *
 * A piece holds one contiguous run of one client's structs, or a part of the delete set. A run is
 * cut between structs and, where a struct alone is too large, inside it: Yjs merges a client's
 * consecutive insertions into one item, even across transactions (`split.test.ts`), so a long
 * text is one item however it was typed. A cut inside an item writes its prefix as a shortened
 * copy and its suffix as Yjs writes any partial struct (`write(encoder, offset)`); text is never cut
 * inside a surrogate pair, where Yjs would replace both halves. What cannot be divided is a unit of
 * length one — an embed, a binary, a format, a type, a subdocument — larger than a piece may be:
 * `UnsplittableUpdateError`, which an application avoids by writing such content in parts
 * (SND-19).
 */

/** An update holds a unit that does not fit into a piece of `maxBytes` and cannot be divided (SND-19). */
export class UnsplittableUpdateError extends Error {
  readonly bytes: number;
  readonly maxBytes: number;

  constructor(bytes: number, maxBytes: number) {
    super(`an indivisible unit of ${bytes} bytes does not fit into a piece of ${maxBytes} bytes`);
    this.name = "UnsplittableUpdateError";
    this.bytes = bytes;
    this.maxBytes = maxBytes;
  }
}

type Struct = Y.Item | Y.GC;

/** A stretch `[from, to)` of one struct, in units of its length. */
interface Slice {
  readonly struct: Struct;
  readonly from: number;
  readonly to: number;
}

/** The struct shortened to its first `length` units, for writing a prefix. */
function shortened(struct: Struct, length: number): Struct {
  if (length === struct.length) {
    return struct;
  }
  if (struct instanceof Y.GC) {
    return new Y.GC(struct.id, length);
  }
  const content = struct.content.copy();
  content.splice(length);
  return new Y.Item(
    struct.id,
    null,
    struct.origin,
    null,
    struct.rightOrigin,
    struct.parent,
    struct.parentSub,
    content,
  );
}

/** One run of one client's slices, contiguous, with an empty delete set. */
function encodeRun(slices: readonly Slice[]): Uint8Array {
  const first = slices[0] as Slice;
  const encoder = new Y.UpdateEncoderV1();
  // Version 1 writes every number of the header as a variable-length integer, as these do.
  encoder.writeClient(1);
  encoder.writeLen(slices.length);
  encoder.writeClient(first.struct.id.client);
  encoder.writeLen(first.struct.id.clock + first.from);
  for (const slice of slices) {
    shortened(slice.struct, slice.to).write(encoder, slice.from);
  }
  encoder.writeLen(0);
  return encoder.toUint8Array();
}

type DeleteRanges = readonly (readonly [
  client: number,
  ranges: readonly { clock: number; len: number }[],
])[];

/** A delete set alone, without structs. */
function encodeDeletes(entries: DeleteRanges): Uint8Array {
  const encoder = new Y.UpdateEncoderV1();
  encoder.writeClient(0);
  encoder.writeLen(entries.length);
  for (const [client, ranges] of entries) {
    encoder.resetDsCurVal();
    encoder.writeClient(client);
    encoder.writeLen(ranges.length);
    for (const range of ranges) {
      encoder.writeDsClock(range.clock);
      encoder.writeDsLen(range.len);
    }
  }
  return encoder.toUint8Array();
}

/** Whether a struct may be cut after `units` of it: never inside a surrogate pair. */
function mayCutAt(struct: Struct, units: number): boolean {
  if (units <= 0 || units >= struct.length) {
    return units > 0;
  }
  if (struct instanceof Y.GC) {
    return true;
  }
  const content = struct.content;
  if (content instanceof Y.ContentString) {
    const code = content.str.charCodeAt(units - 1);
    return code < 0xd800 || code > 0xdbff;
  }
  return (
    content instanceof Y.ContentAny ||
    content instanceof Y.ContentJSON ||
    content instanceof Y.ContentDeleted
  );
}

/** The bytes of a variable-length unsigned integer, as version 1 writes it. */
function varUintLength(value: number): number {
  let length = 1;
  for (let rest = value; rest >= 0x80; rest = Math.floor(rest / 0x80)) {
    length += 1;
  }
  return length;
}

/** A run's header and the empty delete set after it: one client, the struct count, the client, the first clock, no deletes. */
function runHeader(count: number, client: number, clock: number): number {
  return 1 + varUintLength(count) + varUintLength(client) + varUintLength(clock) + 1;
}

/** The bytes one slice adds to a run. */
function bodyOf(slice: Slice): number {
  return (
    encodeRun([slice]).length -
    runHeader(1, slice.struct.id.client, slice.struct.id.clock + slice.from)
  );
}

/**
 * The pieces of `update`, each at most `maxBytes` long; one piece when it fits. Throws
 * `UnsplittableUpdateError` for an indivisible unit that does not fit.
 */
export function splitUpdate(update: Uint8Array, maxBytes: number): Uint8Array[] {
  if (update.length <= maxBytes) {
    return [update];
  }
  const { structs, ds } = Y.decodeUpdate(update);
  const pieces: Uint8Array[] = [];
  // Version 1 is a plain concatenation: a run's length is its header, its structs' bytes and the
  // empty delete set's one byte, so a run's size is known without encoding it again.
  let run: Slice[] = [];
  let runBody = 0;
  const flush = (): void => {
    if (run.length > 0) {
      const piece = encodeRun(run);
      if (piece.length > maxBytes) {
        throw new Error(`internal error: a piece of ${piece.length} bytes exceeds ${maxBytes}`);
      }
      pieces.push(piece);
      run = [];
      runBody = 0;
    }
  };
  let previous: Struct | undefined;
  for (const struct of structs) {
    if (struct instanceof Y.Skip) {
      flush();
      previous = undefined;
      continue;
    }
    const s = struct as Struct;
    const contiguous =
      previous !== undefined &&
      s.id.client === previous.id.client &&
      s.id.clock === previous.id.clock + previous.length;
    if (!contiguous) {
      flush();
    }
    let from = 0;
    while (from < s.length) {
      const first = run[0] ?? { struct: s, from, to: from };
      const size = (to: number) =>
        runHeader(run.length + 1, first.struct.id.client, first.struct.id.clock + first.from) +
        runBody +
        bodyOf({ struct: s, from, to });
      if (size(s.length) <= maxBytes) {
        runBody += bodyOf({ struct: s, from, to: s.length });
        run.push({ struct: s, from, to: s.length });
        break;
      }
      let low = from;
      let high = s.length;
      while (high - low > 1) {
        const middle = Math.floor((low + high) / 2);
        if (size(middle) <= maxBytes) {
          low = middle;
        } else {
          high = middle;
        }
      }
      let to = low;
      while (to > from && !mayCutAt(s, to)) {
        to -= 1;
      }
      if (to > from) {
        runBody += bodyOf({ struct: s, from, to });
        run.push({ struct: s, from, to });
        flush();
        from = to;
        continue;
      }
      if (run.length > 0) {
        flush();
        continue;
      }
      // Alone in a run and not even one unit fits: an indivisible unit too large for a piece.
      let unit = from + 1;
      while (unit < s.length && !mayCutAt(s, unit)) {
        unit += 1;
      }
      throw new UnsplittableUpdateError(
        encodeRun([{ struct: s, from, to: unit }]).length,
        maxBytes,
      );
    }
    previous = s;
  }
  flush();

  // A delete set alone: no structs, the number of clients, then per client its id, the number of
  // ranges and each range's clock and length, all variable-length integers in version 1.
  let entries: [number, { clock: number; len: number }[]][] = [];
  let entriesBytes = 0;
  const deletesSize = (clients: number, body: number) => 1 + varUintLength(clients) + body;
  const flushDeletes = (): void => {
    if (entries.length > 0) {
      const piece = encodeDeletes(entries);
      if (piece.length > maxBytes) {
        throw new Error(`internal error: a piece of ${piece.length} bytes exceeds ${maxBytes}`);
      }
      pieces.push(piece);
      entries = [];
      entriesBytes = 0;
    }
  };
  for (const [client, ranges] of ds.clients) {
    let chunk: { clock: number; len: number }[] = [];
    let chunkBytes = 0;
    const clientBytes = (count: number, body: number) =>
      varUintLength(client) + varUintLength(count) + body;
    for (const range of ranges) {
      const rangeBytes = varUintLength(range.clock) + varUintLength(range.len);
      if (
        deletesSize(
          entries.length + 1,
          entriesBytes + clientBytes(chunk.length + 1, chunkBytes + rangeBytes),
        ) > maxBytes
      ) {
        if (chunk.length > 0) {
          entries.push([client, chunk]);
          entriesBytes += clientBytes(chunk.length, chunkBytes);
        }
        flushDeletes();
        chunk = [];
        chunkBytes = 0;
        if (deletesSize(1, clientBytes(1, rangeBytes)) > maxBytes) {
          throw new UnsplittableUpdateError(deletesSize(1, clientBytes(1, rangeBytes)), maxBytes);
        }
      }
      chunk.push({ clock: range.clock, len: range.len });
      chunkBytes += rangeBytes;
    }
    if (chunk.length > 0) {
      entries.push([client, chunk]);
      entriesBytes += clientBytes(chunk.length, chunkBytes);
    }
  }
  flushDeletes();
  return pieces;
}

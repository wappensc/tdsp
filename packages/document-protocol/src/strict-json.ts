/**
 * The two ways a text can be valid JSON (RFC 8259) and still have more than one reading, which a
 * frame must not have (SPECIFICATION.md §1.6, FRM-6): an object that names one member
 * twice — `JSON.parse` silently keeps the last, another parser the first — and a string with an
 * unpaired surrogate, which has no UTF-8 encoding and which parsers replace, keep or refuse as
 * they please. Excluding both is what I-JSON (RFC 7493) does.
 *
 * Run on text `JSON.parse` has already accepted, so the syntax is known to be valid and this
 * only has to follow strings and nesting. Linear in the length of the text.
 */
export function strictJsonProblem(text: string): string | undefined {
  const stack: { keys: Set<string> | undefined; expectKey: boolean }[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      const { value, end } = readString(text, i);
      const surrogate = unpairedSurrogate(value);
      if (surrogate !== undefined) {
        return `a string holds an unpaired surrogate (U+${surrogate.toString(16).toUpperCase()})`;
      }
      const top = stack.at(-1);
      if (top?.keys !== undefined && top.expectKey) {
        if (top.keys.has(value)) {
          return `an object names ${JSON.stringify(value)} twice`;
        }
        top.keys.add(value);
        top.expectKey = false;
      }
      i = end;
      continue;
    }
    if (c === "{") {
      stack.push({ keys: new Set(), expectKey: true });
    } else if (c === "[") {
      stack.push({ keys: undefined, expectKey: false });
    } else if (c === "}" || c === "]") {
      stack.pop();
    } else if (c === ",") {
      const top = stack.at(-1);
      if (top?.keys !== undefined) {
        top.expectKey = true;
      }
    }
    i += 1;
  }
  return undefined;
}

const ESCAPES: Readonly<Record<string, string>> = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
};

/** The string starting at the quote at `start`, unescaped, and the index just after its closing quote. */
function readString(text: string, start: number): { value: string; end: number } {
  let value = "";
  let i = start + 1;
  while (text[i] !== '"') {
    if (text[i] === "\\") {
      const marker = text[i + 1] as string;
      if (marker === "u") {
        value += String.fromCharCode(Number.parseInt(text.slice(i + 2, i + 6), 16));
        i += 6;
      } else {
        value += ESCAPES[marker] ?? marker;
        i += 2;
      }
    } else {
      value += text[i];
      i += 1;
    }
  }
  return { value, end: i + 1 };
}

/** The first unpaired surrogate code unit in `value`, or `undefined`. */
function unpairedSurrogate(value: string): number | undefined {
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        i += 1;
        continue;
      }
      return unit;
    }
    if (unit >= 0xdc00 && unit <= 0xdfff) {
      return unit;
    }
  }
  return undefined;
}

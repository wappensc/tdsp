import { describe, expect, it } from "vitest";
import { numbersNotInIntegerForm, strictJsonProblem } from "./strict-json";

describe("strictJsonProblem (I-JSON, RFC 7493)", () => {
  it.each([
    '{"a":1,"b":{"a":2},"c":[{"a":3},{"a":4}]}',
    '{"text":"😀 and \\ud83d\\ude00"}',
    '{"k":"a,b","l":"{\\"x\\":1,\\"x\\":2}"}',
    '{"a\\"b":1,"a":2}',
    "[1,2,3]",
    '{"":1}',
  ])("accepts %s", (text) => {
    expect(strictJsonProblem(text)).toBeUndefined();
  });

  it.each([
    ['{"a":1,"a":2}', "twice"],
    ['{"a":1,"b":{"x":1,"x":2}}', "twice"],
    ['[{"a":1},{"b":1,"b":2}]', "twice"],
    ['{"a":1,"\\u0061":2}', "twice"], // the same name, once escaped
    ['{"t":"\\ud83d"}', "unpaired surrogate"],
    ['{"t":"\\ude00x"}', "unpaired surrogate"],
    ['{"\\ud800":1}', "unpaired surrogate"],
    [`{"t":"${String.fromCharCode(0xd800)}"}`, "unpaired surrogate"], // a raw one, in the text itself
  ])("refuses %s", (text, problem) => {
    expect(strictJsonProblem(text)).toContain(problem);
  });
});

describe("numbersNotInIntegerForm (§1.6: an integer field has no fraction or exponent)", () => {
  it.each([
    ['{"due":0,"counter":12,"seen":{"x":-3}}'],
    ['{"text":"1.5 and 1e3 and -0 inside a string","n":7}'],
    ['{"a\\"1.0":2}'],
    ["[0,1,-1,4294967295]"],
  ])("finds nothing in %s", (text) => {
    expect(numbersNotInIntegerForm(text)).toStrictEqual([]);
  });

  it.each([
    ['{"due":1.0}', [["due"]]],
    ['{"due":1e3}', [["due"]]],
    ['{"due":1E+3}', [["due"]]],
    ['{"due":-0}', [["due"]]],
    ['{"counter":2,"seen":{"tag":1.5}}', [["seen", "tag"]]],
    ['{"pieces":[1,2.0,3]}', [["pieces", 1]]],
    ['{"a":{"b":[0,{"c":-0}]},"d":0.5}', [["a", "b", 1, "c"], ["d"]]],
  ])("finds %s at its path", (text, paths) => {
    expect(numbersNotInIntegerForm(text)).toStrictEqual(paths);
  });
});

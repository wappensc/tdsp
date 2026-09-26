import { describe, expect, it } from "vitest";
import { strictJsonProblem } from "./strict-json";

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

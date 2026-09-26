import { describe, expect, it } from "vitest";
import { classifySendFailure } from "./send-failure";

const smtp = (responseCode: number, response = "") =>
  Object.assign(new Error(`Mail command failed: ${response}`), { responseCode, response });

describe("classifySendFailure", () => {
  it("reads GMX's own refusal, a 450, as a rate limit", () => {
    expect(
      classifySendFailure(smtp(450, "450 Requested mail action not taken: mailbox unavailable")),
    ).toEqual({ status: 429 });
  });

  it.each([421, 451, 452])("reads a %i, any 4xx reply, as a rate limit", (code) => {
    expect(classifySendFailure(smtp(code)).status).toBe(429);
  });

  it("reads 552 as too large", () => {
    expect(classifySendFailure(smtp(552)).status).toBe(413);
  });

  it.each(["ECONNECTION", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ESOCKET", "EDNS"])(
    "reads %s, a failure to reach the server, as unavailable",
    (code) => {
      expect(classifySendFailure(Object.assign(new Error("x"), { code })).status).toBe(503);
    },
  );

  it.each([550, 553, 554, 535])(
    "does not single out a permanent %i reply: it stays a retryable failure, so no edit is dropped on a guess",
    (code) => {
      expect(classifySendFailure(smtp(code)).status).toBe(502);
    },
  );

  it("answers 502 for anything it does not recognise, including things that are not errors", () => {
    expect(classifySendFailure(new Error("boom")).status).toBe(502);
    expect(classifySendFailure("boom").status).toBe(502);
    expect(classifySendFailure(undefined).status).toBe(502);
    expect(classifySendFailure(null).status).toBe(502);
  });
});

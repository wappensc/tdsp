import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  checkPolicy,
  collectSourceFiles,
  type NetworkPolicy,
  readAnnotation,
  scanSource,
} from "./netcheck.ts";

const repoRoot = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");

/**
 * The static layer of the network-egress policy (docs/network-policy.md).
 * `credentials-gitignore.test.ts`'s discipline
 * applies here too: an invariant check is worth nothing unless it is
 * demonstrably able to *fail*, so most of what follows are violation
 * fixtures, not happy paths.
 */
describe("scanSource", () => {
  it("finds each network primitive that actually opens a connection", () => {
    const findings = scanSource(`
      import { createConnection } from "node:net";
      const a = await fetch("http://x");
      const b = new WebSocket("ws://x");
      const c = new RTCPeerConnection();
      navigator.sendBeacon("/x", "y");
      const d = require("node:http");
    `);
    const apis = new Set(findings.map((f) => f.api));
    expect(apis).toContain('import "node:net"');
    expect(apis).toContain("fetch");
    expect(apis).toContain("WebSocket");
    expect(apis).toContain("RTCPeerConnection");
    expect(apis).toContain("navigator.sendBeacon");
    expect(apis).toContain('require("node:http")');
  });

  /**
   * A third-party library that opens sockets entirely
   * inside its own code (never a raw `node:net`/`fetch` call in the
   * *importing* file's own AST) is invisible to this walk unless the
   * library itself is named in `FORBIDDEN_MODULES` — which is why
   * `imapflow`/`nodemailer`, which `bridges/email-bridge` uses, are named
   * there. `mailparser` is deliberately absent: it only parses an
   * already-fetched buffer, no network I/O of its own.
   */
  it("finds imapflow/nodemailer imports, but not mailparser", () => {
    const findings = scanSource(`
      import { ImapFlow } from "imapflow";
      import { createTransport } from "nodemailer";
      import { simpleParser } from "mailparser";
    `);
    const apis = new Set(findings.map((f) => f.api));
    expect(apis).toContain('import "imapflow"');
    expect(apis).toContain('import "nodemailer"');
    expect(apis).not.toContain('import "mailparser"');
  });

  it("reports the line a primitive is on", () => {
    const findings = scanSource('const x = 1;\nconst y = 2;\nawait fetch("http://x");');
    expect(findings).toEqual([{ line: 3, api: "fetch" }]);
  });

  it("catches an aliased global a call-only check would miss", () => {
    expect(scanSource("const f = fetch; f('http://x');")).toEqual([{ line: 1, api: "fetch" }]);
  });

  /**
   * The reason this is an AST walk and not a grep: this repository's own
   * doc comments discuss fetch() constantly, and a checker that flags
   * them trains reviewers to wave policy entries through.
   */
  it("ignores comments, strings, and property names that merely say fetch", () => {
    expect(
      scanSource(`
        // matrix-api.ts's fetch() is the sole transport.
        /** A thin fetch() wrapper — see WebSocket, which we never use. */
        const message = "call fetch() to reach the bridge";
        const config = { fetch: true, WebSocket: false };
        client.fetch("/x");
        this.WebSocket;
      `),
    ).toEqual([]);
  });

  it("ignores a type-only import, which creates no runtime capability", () => {
    expect(scanSource('import type { Server } from "node:http";')).toEqual([]);
    expect(scanSource('import { type Socket, type Server } from "node:net";')).toEqual([]);
  });

  it("still flags a mixed import that pulls in even one value binding", () => {
    expect(scanSource('import { type Socket, createConnection } from "node:net";')).toEqual([
      { line: 1, api: 'import "node:net"' },
    ]);
  });

  it("flags a side-effect-only import of a network module", () => {
    expect(scanSource('import "node:net";')).toEqual([{ line: 1, api: 'import "node:net"' }]);
  });
});

describe("readAnnotation", () => {
  it.each([
    ["loopback", "// network-policy: loopback — talks to the local bridge"],
    ["loopback-listener", "/** network-policy: loopback-listener — inbound only */"],
    ["configured-messenger-endpoint", "// network-policy: configured-messenger-endpoint — Matrix"],
  ])("reads the %s class", (expected, source) => {
    expect(readAnnotation(source)).toBe(expected);
  });

  it("returns null when there is no annotation", () => {
    expect(readAnnotation("// just a normal comment about the network")).toBeNull();
  });
});

const GRANTED = {
  file: "infra/example-server/server.ts",
  zone: "A",
  destination: "loopback",
  reason: "A long enough written justification to satisfy the policy check.",
} as const;

function check(files: Record<string, string>, policy: NetworkPolicy): string[] {
  return checkPolicy({ files: new Map(Object.entries(files)), policy });
}

describe("checkPolicy — both halves of the double opt-out are required", () => {
  const withPrimitive = '// network-policy: loopback\nawait fetch("http://127.0.0.1:1");';

  it("passes when the annotation and the policy entry agree", () => {
    expect(check({ [GRANTED.file]: withPrimitive }, { grants: [GRANTED] })).toEqual([]);
  });

  it("fails on a network primitive with neither half", () => {
    const violations = check({ [GRANTED.file]: 'await fetch("http://x");' }, { grants: [] });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("neither an annotation nor a network-policy.json entry");
  });

  it("fails on an annotation with no policy entry", () => {
    const violations = check({ [GRANTED.file]: withPrimitive }, { grants: [] });
    expect(violations[0]).toContain("no network-policy.json entry");
  });

  it("fails on a policy entry with no annotation at the code site", () => {
    const violations = check(
      { [GRANTED.file]: 'await fetch("http://127.0.0.1:1");' },
      { grants: [GRANTED] },
    );
    expect(violations[0]).toContain('no "network-policy:" annotation');
  });

  it("fails when the two halves disagree about the destination", () => {
    const violations = check(
      {
        [GRANTED.file]:
          '// network-policy: configured-messenger-endpoint\nawait fetch("http://x");',
      },
      { grants: [GRANTED] },
    );
    expect(violations[0]).toContain("the two halves must agree");
  });
});

describe("checkPolicy — the zone rules outrank whatever an entry claims", () => {
  it("refuses to grant a zero-network package, however the entry is worded", () => {
    const violations = check(
      { "packages/reconciliation/src/index.ts": '// network-policy: loopback\nfetch("http://x");' },
      {
        grants: [
          {
            file: "packages/reconciliation/src/index.ts",
            zone: "A",
            destination: "loopback",
            reason: "A long enough written justification to satisfy the policy check.",
          },
        ],
      },
    );
    expect(violations.join("\n")).toContain("zero-network package");
  });

  it("refuses a Zone A file a messenger endpoint", () => {
    const violations = check(
      {
        "packages/messenger-matrix/src/index.ts":
          '// network-policy: configured-messenger-endpoint\nfetch("http://x");',
      },
      {
        grants: [
          {
            file: "packages/messenger-matrix/src/index.ts",
            zone: "A",
            destination: "configured-messenger-endpoint",
            reason: "A long enough written justification to satisfy the policy check.",
          },
        ],
      },
    );
    expect(violations.join("\n")).toContain("may only reach loopback");
  });

  it("rejects a grant whose justification is not a real one", () => {
    const violations = check(
      { [GRANTED.file]: withAnnotation() },
      { grants: [{ ...GRANTED, reason: "needed" }] },
    );
    expect(violations.join("\n")).toContain("needs a real written justification");
  });

  it("rejects a stale entry for a file that no longer touches the network", () => {
    const violations = check({ [GRANTED.file]: "export const x = 1;" }, { grants: [GRANTED] });
    expect(violations.join("\n")).toContain("uses no network primitive");
  });

  it("rejects an entry for a file that does not exist at all", () => {
    const violations = check({}, { grants: [{ ...GRANTED, file: "infra/gone/x.ts" }] });
    expect(violations.join("\n")).toContain("no such scanned source file");
  });
});

function withAnnotation(): string {
  return '// network-policy: loopback\nawait fetch("http://127.0.0.1:1");';
}

/**
 * The check that makes the whole thing load-bearing rather than
 * decorative: the real repository, as it actually stands right now, must
 * satisfy its own policy. This is what turns a fresh `fetch()` added
 * anywhere in `packages/`, `bridges/`, `infra/` or `tools/` into a red build.
 */
describe("the repository itself", () => {
  it("satisfies its own network-egress policy", async () => {
    const policy = JSON.parse(
      await import("node:fs").then((fs) =>
        fs.readFileSync(`${repoRoot}/network-policy.json`, "utf8"),
      ),
    ) as NetworkPolicy;
    expect(checkPolicy({ files: collectSourceFiles(repoRoot), policy })).toEqual([]);
  });

  it("actually scans a non-trivial number of files, so a broken glob cannot pass silently", () => {
    expect(collectSourceFiles(repoRoot).size).toBeGreaterThan(20);
  });
});

import { globSync, readFileSync } from "node:fs";
import ts from "typescript";

/**
 * The static layer of the network-egress policy (docs/network-policy.md):
 * find every network primitive in
 * first-party source and require each one to be covered by a **human
 * double opt-out** — a file-level annotation at the code site *and* a
 * matching, justified entry in `network-policy.json`. Either alone fails.
 *
 * **Why an AST walk and not a grep.** Half this repository's doc comments
 * legitimately talk *about* `fetch()` — `crypto-machine.ts` alone says
 * "matrix-api.ts's fetch() is the sole transport". A regex flags all of
 * those, and a check that cries wolf trains reviewers to add policy
 * entries reflexively, which is exactly what destroys a double opt-out's
 * value. The TypeScript AST sees code and ignores comments and strings
 * for free.
 *
 * **Why `*.test.ts` is excluded.** Test files legitimately open loopback
 * servers and fetch them all over this repository, and granting a dozen
 * of them would be noise. This mirrors the carve-out
 * `.dependency-cruiser.cjs` already makes for the same reason. The gap is
 * covered better elsewhere than static analysis could: the Vitest runtime
 * guard checks the *actual destination* of every connection a test makes,
 * which is a stronger statement than "this file mentions fetch". Test
 * files also never ship.
 */

/** Modules that cannot be imported without the ability to talk to a network. */
const FORBIDDEN_MODULES = new Set([
  "node:http",
  "node:https",
  "node:net",
  "node:dgram",
  "node:tls",
  "node:http2",
  "http",
  "https",
  "net",
  "dgram",
  "tls",
  "http2",
  "ws",
  "socket.io",
  "socket.io-client",
  "simple-peer",
  "y-webrtc",
  "y-websocket",
  // bridges/email-bridge's own SMTP/IMAP libraries — each
  // opens real sockets entirely inside its own code (nodemailer's SMTP
  // client, imapflow's IMAP client), invisible to this AST walk the same
  // way ws/socket.io/simple-peer already are, so both are named here
  // explicitly rather than left for the static scanner to silently miss.
  // mailparser is deliberately not listed: it only parses an already-
  // fetched message buffer, no network I/O of its own.
  "imapflow",
  "nodemailer",
]);

/** Ambient globals that open a connection with no import statement at all. */
const FORBIDDEN_GLOBALS = new Set([
  "fetch",
  "XMLHttpRequest",
  "WebSocket",
  "EventSource",
  "RTCPeerConnection",
  "RTCDataChannel",
]);

export type DestinationClass = "loopback" | "loopback-listener" | "configured-messenger-endpoint";

const DESTINATION_CLASSES: readonly DestinationClass[] = [
  "loopback",
  "loopback-listener",
  "configured-messenger-endpoint",
];

export interface NetworkFinding {
  readonly line: number;
  readonly api: string;
}

export interface PolicyGrant {
  readonly file: string;
  readonly zone: "A" | "B";
  readonly destination: DestinationClass;
  readonly reason: string;
}

export interface NetworkPolicy {
  readonly grants: readonly PolicyGrant[];
}

/**
 * Packages that must contain no network primitive at all, under any
 * policy entry — Zone A's "zero network" tier. A grant
 * naming one of these is itself a violation, so the policy file cannot
 * quietly re-permit what the architecture forbids.
 */
const ZERO_NETWORK_PREFIXES = [
  "packages/reconciliation/",
  "packages/document-protocol/",
  "packages/messenger-port/",
  "packages/messenger-mock/",
];

/** Everything under `packages/` is Zone A: it may never reach a real messenger. */
const ZONE_A_PREFIX = "packages/";

/** Finds every network primitive actually used as code in one source file. */
export function scanSource(source: string, fileName = "input.ts"): NetworkFinding[] {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const findings: NetworkFinding[] = [];
  const lineOf = (node: ts.Node): number =>
    sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;

  const visit = (node: ts.Node): void => {
    // `import ... from "node:net"` — but a type-only import creates no
    // runtime capability, and several files legitimately import only the
    // `Server`/`Socket` types to annotate a value they never construct.
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const specifier = node.moduleSpecifier.text;
      if (FORBIDDEN_MODULES.has(specifier) && !isTypeOnlyImport(node)) {
        findings.push({ line: lineOf(node), api: `import "${specifier}"` });
      }
    }
    // `require("node:net")`
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const [first] = node.arguments;
      if (
        node.expression.text === "require" &&
        first !== undefined &&
        ts.isStringLiteral(first) &&
        FORBIDDEN_MODULES.has(first.text)
      ) {
        findings.push({ line: lineOf(node), api: `require("${first.text}")` });
      }
    }
    // `navigator.sendBeacon(...)`
    if (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === "sendBeacon" &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "navigator"
    ) {
      findings.push({ line: lineOf(node), api: "navigator.sendBeacon" });
    }
    // A reference to an ambient global: `fetch(...)`, `new WebSocket(...)`,
    // and also the aliasing forms (`const f = fetch`) that a call-only
    // check would walk straight past.
    if (ts.isIdentifier(node) && FORBIDDEN_GLOBALS.has(node.text) && isGlobalReference(node)) {
      findings.push({ line: lineOf(node), api: node.text });
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return findings;
}

function isTypeOnlyImport(node: ts.ImportDeclaration): boolean {
  const clause = node.importClause;
  if (!clause) {
    // `import "node:net"` for side effects only — very much a runtime import.
    return false;
  }
  if (clause.isTypeOnly) {
    return true;
  }
  if (clause.name) {
    return false; // a default import binding is a value
  }
  const bindings = clause.namedBindings;
  if (bindings && ts.isNamedImports(bindings)) {
    // Mixed `import { type Socket, createConnection }` counts as a value
    // import unless every single binding is type-only.
    return bindings.elements.every((element) => element.isTypeOnly);
  }
  return false;
}

/**
 * True when this identifier is a *use* of the global, not something that
 * merely shares its name — a property (`this.fetch`), a declaration name,
 * or an object-literal key.
 */
function isGlobalReference(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (!parent) {
    return true;
  }
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) {
    return false;
  }
  if ((ts.isPropertyAssignment(parent) || ts.isPropertySignature(parent)) && parent.name === node) {
    return false;
  }
  if (
    (ts.isVariableDeclaration(parent) ||
      ts.isFunctionDeclaration(parent) ||
      ts.isParameter(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isBindingElement(parent) ||
      ts.isImportSpecifier(parent)) &&
    parent.name === node
  ) {
    return false;
  }
  return true;
}

const ANNOTATION_PATTERN =
  /network-policy:\s*(loopback-listener|loopback|configured-messenger-endpoint)\b/;

/** Reads the file-level annotation — half of the double opt-out. */
export function readAnnotation(source: string): DestinationClass | null {
  const match = ANNOTATION_PATTERN.exec(source);
  return match ? (match[1] as DestinationClass) : null;
}

export interface CheckInput {
  /** Repo-relative path → file contents, for every non-test source file. */
  readonly files: ReadonlyMap<string, string>;
  readonly policy: NetworkPolicy;
}

/**
 * Returns a human-readable violation for every way the two halves of the
 * double opt-out can fail to line up. An empty array means the promise
 * holds as far as static analysis can tell.
 */
export function checkPolicy({ files, policy }: CheckInput): string[] {
  const violations: string[] = [];
  const grantsByFile = new Map<string, PolicyGrant>();

  for (const grant of policy.grants) {
    if (grantsByFile.has(grant.file)) {
      violations.push(`${grant.file}: listed twice in network-policy.json`);
    }
    grantsByFile.set(grant.file, grant);

    if (!DESTINATION_CLASSES.includes(grant.destination)) {
      violations.push(`${grant.file}: unknown destination "${grant.destination}"`);
    }
    if (!grant.reason || grant.reason.trim().length < 20) {
      violations.push(
        `${grant.file}: needs a real written justification, not "${grant.reason ?? ""}"`,
      );
    }
    // Zone rules outrank whatever the entry claims for itself.
    if (ZERO_NETWORK_PREFIXES.some((prefix) => grant.file.startsWith(prefix))) {
      violations.push(
        `${grant.file}: is in a zero-network package (Zone A) and can never be granted network access`,
      );
    }
    if (
      grant.file.startsWith(ZONE_A_PREFIX) &&
      grant.destination === "configured-messenger-endpoint"
    ) {
      violations.push(
        `${grant.file}: is Zone A and may only reach loopback, never a messenger endpoint directly`,
      );
    }
    if (grant.file.startsWith(ZONE_A_PREFIX) && grant.zone !== "A") {
      violations.push(`${grant.file}: is under packages/ and must be declared zone "A"`);
    }
    if (!files.has(grant.file)) {
      violations.push(
        `${grant.file}: has a policy entry but no such scanned source file — remove the stale entry`,
      );
    }
  }

  for (const [file, source] of files) {
    const findings = scanSource(source, file);
    const grant = grantsByFile.get(file);
    const annotation = readAnnotation(source);

    if (findings.length === 0) {
      if (grant) {
        violations.push(
          `${file}: has a policy entry but uses no network primitive — remove the stale entry`,
        );
      }
      continue;
    }

    const used = [...new Set(findings.map((f) => f.api))].sort().join(", ");
    if (!grant && !annotation) {
      violations.push(
        `${file}: uses ${used} with neither an annotation nor a network-policy.json entry (lines ${findings.map((f) => f.line).join(", ")})`,
      );
      continue;
    }
    if (!grant) {
      violations.push(
        `${file}: is annotated "${annotation}" but has no network-policy.json entry — both halves are required`,
      );
      continue;
    }
    if (!annotation) {
      violations.push(
        `${file}: has a network-policy.json entry but no "network-policy:" annotation at the code site — both halves are required`,
      );
      continue;
    }
    if (annotation !== grant.destination) {
      violations.push(
        `${file}: annotation says "${annotation}" but network-policy.json says "${grant.destination}" — the two halves must agree`,
      );
    }
  }

  return violations;
}

/** Source globs the scanner covers. Tests are excluded — see the module comment. */
export const SOURCE_GLOBS = [
  "packages/*/src/**/*.ts",
  "bridges/*/src/**/*.ts",
  "infra/*/**/*.ts",
  "tools/**/*.ts",
];

export function collectSourceFiles(repoRoot: string): Map<string, string> {
  const files = new Map<string, string>();
  for (const glob of SOURCE_GLOBS) {
    for (const relative of globSync(glob, { cwd: repoRoot })) {
      const path = relative.split("\\").join("/");
      if (path.endsWith(".test.ts") || path.endsWith(".bench.ts") || path.includes("/dist/")) {
        continue;
      }
      files.set(path, readFileSync(`${repoRoot}/${path}`, "utf8"));
    }
  }
  return files;
}

export function main(repoRoot: string): number {
  const policy = JSON.parse(
    readFileSync(`${repoRoot}/network-policy.json`, "utf8"),
  ) as NetworkPolicy;
  const files = collectSourceFiles(repoRoot);
  const violations = checkPolicy({ files, policy });

  if (violations.length > 0) {
    console.error(`netcheck: ${violations.length} network-egress policy violation(s):\n`);
    for (const violation of violations) {
      console.error(`  - ${violation}`);
    }
    console.error(
      "\nEvery file that opens a network connection needs BOTH a `network-policy:` annotation\n" +
        "at the code site AND a justified entry in network-policy.json. See\n" +
        "docs/network-policy.md.\n",
    );
    return 1;
  }
  console.log(`netcheck: ${files.size} source files scanned, network-egress policy holds.`);
  return 0;
}

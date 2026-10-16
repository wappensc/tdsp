import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The local test servers stay on this machine (docs/network-policy.md, Zone A): every port a
 * Docker Compose file of this repository publishes is bound to 127.0.0.1. A mapping without a
 * host address — `"18008:8008"` — makes Docker listen on every interface of the host, IPv4 and
 * IPv6, and so offers a Synapse with known test passwords, or a Greenmail that accepts any
 * login, to whoever shares the network. Security test: only the CI role may change this file
 * (.github/CODEOWNERS, CONTRIBUTING.md); it depends on nothing outside it.
 */

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SKIPPED_DIRECTORIES = new Set(["node_modules", ".git", "credentials"]);
const COMPOSE_FILE = /^(docker-)?compose(\.[\w-]+)?\.ya?ml$/;

/** Every Compose file in the repository, as a path relative to its root. */
function composeFiles(directory = ROOT): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) {
        found.push(...composeFiles(join(directory, entry.name)));
      }
    } else if (COMPOSE_FILE.test(entry.name)) {
      found.push(relative(ROOT, join(directory, entry.name)));
    }
  }
  return found.sort();
}

interface PublishedPorts {
  /** Each entry of a `ports:` list, in the short form, without quotes or comment. */
  readonly mappings: string[];
  /** What this reading does not understand, and therefore refuses rather than passes. */
  readonly refused: string[];
}

/**
 * Reads the `ports:` lists of a Compose file. Only the short form, one mapping per list entry,
 * is understood; the long form, a flow list (`ports: [...]`) and `network_mode: host`, which
 * publishes every port of the container without a list, are refused — so a file this cannot
 * read fails the test instead of passing it.
 */
function publishedPorts(text: string): PublishedPorts {
  const mappings: string[] = [];
  const refused: string[] = [];
  let listIndent: number | undefined;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/\s+#.*$/, "").trimEnd();
    if (line.trim() === "" || line.trim().startsWith("#")) {
      continue;
    }
    const indent = line.length - line.trimStart().length;
    const content = line.trim();
    if (listIndent !== undefined && indent > listIndent) {
      const entry = /^-\s+(["']?)([^"']+)\1$/.exec(content);
      if (entry?.[2] !== undefined && !entry[2].includes(": ") && !entry[2].endsWith(":")) {
        mappings.push(entry[2]);
      } else {
        refused.push(content);
      }
      continue;
    }
    listIndent = undefined;
    if (/^ports:$/.test(content)) {
      listIndent = indent;
    } else if (/^ports:/.test(content)) {
      refused.push(content);
    } else if (/^network_mode:\s*["']?host["']?$/.test(content)) {
      refused.push(content);
    }
  }
  return { mappings, refused };
}

describe("the local test servers publish their ports on loopback only", () => {
  const files = composeFiles();

  it("finds the Compose files of both test servers", () => {
    // Without them, the checks below would pass on nothing.
    expect(files).toEqual(
      expect.arrayContaining([
        "infra/email-testserver/docker-compose.yml",
        "infra/matrix-testserver/docker-compose.yml",
      ]),
    );
  });

  it.each(files)("%s binds every published port to 127.0.0.1", (file) => {
    const { mappings, refused } = publishedPorts(readFileSync(join(ROOT, file), "utf8"));
    expect(refused).toEqual([]);
    expect(mappings.length).toBeGreaterThan(0);
    expect(
      mappings.filter((mapping) => !/^127\.0\.0\.1:\d+:\d+(\/(tcp|udp))?$/.test(mapping)),
    ).toEqual([]);
  });

  describe("the reading itself", () => {
    it("takes a mapping bound to loopback, quoted or not, with a comment", () => {
      expect(
        publishedPorts(
          'services:\n  a:\n    ports:\n      - "127.0.0.1:1:2" # one\n      - 127.0.0.1:3:4/udp\n    volumes:\n      - ./x:/y\n',
        ),
      ).toEqual({ mappings: ["127.0.0.1:1:2", "127.0.0.1:3:4/udp"], refused: [] });
    });

    it("reports a mapping without a host address, which the test then refuses", () => {
      expect(
        publishedPorts('services:\n  a:\n    ports:\n      - "18008:8008"\n').mappings,
      ).toEqual(["18008:8008"]);
    });

    it("refuses the long form, a flow list and the host network", () => {
      for (const text of [
        "services:\n  a:\n    ports:\n      - target: 8008\n        published: 18008\n",
        'services:\n  a:\n    ports: ["127.0.0.1:1:2"]\n',
        "services:\n  a:\n    network_mode: host\n",
      ]) {
        expect(publishedPorts(text).refused).not.toEqual([]);
      }
    });
  });
});

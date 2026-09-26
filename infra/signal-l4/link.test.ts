import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { linkSignalBridge, qrForTerminal } from "./link.ts";

/** A stand-in for a Signal bridge's auth routes: linked after `scansAfter` status calls. */
function fakeBridge(state: { linked: boolean; scansAfter: number; groupsAfter: number }) {
  let statusCalls = 0;
  let channelCalls = 0;
  const calls: string[] = [];
  const server = createServer((req, res) => {
    calls.push(`${req.method} ${req.url}`);
    res.setHeader("content-type", "application/json");
    if (req.url === "/auth/status") {
      statusCalls++;
      if (!state.linked && state.scansAfter > 0 && statusCalls > state.scansAfter) {
        state.linked = true;
      }
      res.end(
        JSON.stringify(state.linked ? { linked: true, accountId: "aci-1" } : { linked: false }),
      );
    } else if (req.url === "/auth/link" && req.method === "POST") {
      res.end(JSON.stringify({ linkingUri: "sgnl://linkdevice?uuid=fake&pub_key=fake" }));
    } else if (req.url === "/channels") {
      channelCalls++;
      res.end(JSON.stringify(channelCalls > state.groupsAfter ? [{ id: "g1", name: "L4" }] : []));
    } else {
      res.statusCode = 404;
      res.end("{}");
    }
  });
  return { server, calls };
}

function listen(server: Server): Promise<string> {
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`),
    ),
  );
}

/** Instant sleeps on a virtual clock, and everything printed. */
function io() {
  let clock = 0;
  const printed: string[] = [];
  return {
    printed,
    print: (text: string) => printed.push(text),
    sleep: async (ms: number) => {
      clock += ms;
    },
    now: () => clock,
  };
}

describe("linking a Signal bridge", () => {
  let server: Server | undefined;
  afterEach(() => server?.close());

  it("asks for no link when the bridge is already linked", async () => {
    const bridge = fakeBridge({ linked: true, scansAfter: 0, groupsAfter: 0 });
    server = bridge.server;
    const outcome = await linkSignalBridge(await listen(server), io());
    expect(outcome).toEqual({
      alreadyLinked: true,
      accountId: "aci-1",
      groups: [{ id: "g1", name: "L4" }],
    });
    expect(bridge.calls).not.toContain("POST /auth/link");
  });

  it("shows the link as a QR code, waits for the scan, then for the account's groups", async () => {
    const bridge = fakeBridge({ linked: false, scansAfter: 3, groupsAfter: 2 });
    server = bridge.server;
    const out = io();
    const outcome = await linkSignalBridge(await listen(server), out);
    expect(outcome).toEqual({
      alreadyLinked: false,
      accountId: "aci-1",
      groups: [{ id: "g1", name: "L4" }],
    });
    const shown = out.printed.join("\n");
    expect(shown).toContain(await qrForTerminal("sgnl://linkdevice?uuid=fake&pub_key=fake"));
    expect(shown).toContain("Linked devices");
    expect(shown).toContain("sgnl://linkdevice?uuid=fake&pub_key=fake");
    expect(bridge.calls.filter((call) => call === "POST /auth/link")).toHaveLength(1);
  });

  it("gives up when nobody scans in time, and says how to get a new code", async () => {
    server = fakeBridge({ linked: false, scansAfter: 0, groupsAfter: 0 }).server;
    await expect(
      linkSignalBridge(await listen(server), io(), { pollMs: 1000, timeoutMs: 5000 }),
    ).rejects.toThrow(/did not scan the code within 5 s — run this again/);
  });

  it("refuses a bridge that is not on a loopback address, before asking anything", async () => {
    await expect(linkSignalBridge("http://192.0.2.1:8787", io())).rejects.toThrow(/tunnel/);
  });

  it("draws a QR code a terminal can show", async () => {
    const qr = await qrForTerminal("sgnl://linkdevice?uuid=x&pub_key=y");
    expect(qr.split("\n").length).toBeGreaterThan(10);
    expect(qr).toMatch(/[█▀▄]/);
  });
});

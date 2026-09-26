/**
 * The transport-exclusivity rule: all document data between participants crosses one
 * MessengerPort. The engine (document-protocol), the document profile (reconciliation) and the
 * MessengerPort interface itself must not depend on a concrete adapter, and no package may open a
 * transport channel directly. Only a package's own tests and benchmarks, or an application that
 * composes the pieces, may wire a concrete adapter in.
 *
 * @type {import('dependency-cruiser').IConfiguration}
 */
module.exports = {
  forbidden: [
    {
      name: "no-core-to-messenger-adapter",
      comment:
        "reconciliation, document-protocol and messenger-port must not depend on a concrete messenger adapter. Every adapter package is named packages/messenger-<name>, so this rule covers the mock and every real adapter, present and future, while excluding messenger-port itself, the interface every adapter implements. A package's own *.test.ts / *.bench.ts may use an adapter as a fixture.",
      severity: "error",
      from: {
        path: "^packages/(reconciliation|document-protocol|messenger-port)/",
        pathNot: "\\.(test|bench)\\.ts$",
      },
      to: {
        path: "^packages/messenger-(?!port(/|$))",
      },
    },
    {
      name: "no-transport-imports-in-core",
      comment:
        "No package under packages/ may import a transport module: everything there runs in a browser and may reach nothing but a loopback bridge, and all data between participants must cross the MessengerPort. This rule and tools/netcheck.ts overlap on purpose: an import graph sees module specifiers a source scan could misread, and the scanner sees ambient globals (fetch, WebSocket, ...) an import graph cannot. Note that `to.path` matches the RESOLVED path, not the specifier as written: dependency-cruiser strips the `node:` prefix, so a core builtin resolves to bare `tls`, and an npm package to `node_modules/.pnpm/ws@x/node_modules/ws/...` — hence both alternatives below.",
      severity: "error",
      from: {
        path: "^packages/",
        pathNot: "\\.(test|bench)\\.ts$",
      },
      to: {
        path: "^(node:)?(http|https|net|dgram|tls|http2)$|/node_modules/(ws|socket\\.io|socket\\.io-client|simple-peer|y-webrtc|y-websocket)/",
      },
    },
    {
      name: "no-circular",
      comment: "a dependency cycle between packages makes the module boundaries meaningless.",
      severity: "error",
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    tsPreCompilationDeps: true,
    tsConfig: {
      fileName: "tsconfig.json",
    },
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "types", "node", "default"],
    },
    doNotFollow: {
      path: "node_modules",
    },
  },
};

---
title: "Versioning and releases"
summary: "What a release tag vX.Y.Z of the reference implementation names and promises, how it relates to the specification's own version, which number a change moves, how tags are made and not yet protected, and how another project depends on a release through Git."
read_when:
  - "Tagging a release, or deciding whether a change needs a new major, minor or patch version"
  - "Changing an export of a package, or the shape of persisted engine state"
  - "Another project asks how to depend on a version of TDSP"
  - "Creating a maintenance branch or a ruleset for tags"
---

# Versioning and releases

A release of this repository is a Git tag `vX.Y.Z` with a GitHub release. The first is
`v1.0.0`, on `efcfc95`. Packages are not published to a registry: another project takes a
release from Git.

## Three numbers, kept apart

| What | Where | Moves when |
| --- | --- | --- |
| The reference implementation | The tag `vX.Y.Z`, and `version` in every `package.json` | This document, below |
| The specification | Its header line, "TDSP 1.0" | [CONTRIBUTING.md](../CONTRIBUTING.md), "A change to the wire" |
| The wire | `tdsp` in every frame and envelope, the profile id | SPECIFICATION.md §14 |

A tag names the implementation, not the specification. Its release notes say which
version of the specification it implements: `v1.0.0` implements TDSP 1.0. The two numbers
may drift apart; an incompatible change to a package's exports needs a new major version
of the implementation even when every byte on the wire stays the same.

## What a version promises

Within one major version, nothing in the following breaks:

- **The wire**: what the implementation sends and accepts. The specification and the wire
  lock govern it; an incompatible change of the specification's version is an
  incompatible change of the implementation.
- **The exports** of `@tdsp/document-protocol`, `@tdsp/reconciliation`,
  `@tdsp/messenger-port`, `@tdsp/messenger-mock` and the adapters
  `@tdsp/messenger-signal`, `-matrix` and `-email`.
- **Persisted engine state**: a `PersistedControlState` an earlier version of the same
  major wrote can be read again.

Not covered yet: the bridges' local interface and configuration, because
SPECIFICATION.md §12.6 is not yet stable ([CONFORMANCE.md](../CONFORMANCE.md), "Known
gaps"), and `@tdsp/bridge-log` and `@tdsp/loopback`, which exist for the adapters and
bridges in this repository.

| Version | When |
| --- | --- |
| **Major** | Anything above changes incompatibly, a new major version of the specification included |
| **Minor** | A compatible addition: a new export, option or frame kind, a new minor version of the specification |
| **Patch** | A fix that changes none of the above |

## Tags and branches

- A tag is annotated, named `vX.Y.Z`, and placed on a commit of `main` whose CI runs
  passed. Its message names the version of the specification it implements.
- A tag is never moved or deleted once pushed: a wrong release is superseded by the next
  patch version.
- There is no maintenance branch. When a fix is needed for an older major version while
  `main` has moved on, a branch `release/X.x` is created from that major's last tag.

**Tags are not protected yet.** The only ruleset applies to the branch `main`, so any
account with write access can move or delete a tag. The intended protection is a ruleset
for `refs/tags/v*` that forbids deletion and update and restricts creation to the admins
and ci teams, together with a check of it in `tools/repo-settings.ts`
([docs/repository-settings.md](repository-settings.md)). Until then, compare the commit a
tag points to (`git ls-remote --tags origin`) with the one named in its release notes
before relying on it.

## Depending on a release

Every package exports its TypeScript source, and its relative imports carry no file
extension. A consumer therefore needs a bundler; Node alone runs none of it, neither from
a workspace nor from `node_modules`. The two ways below were tried with pnpm 11.22 and
esbuild 0.25; npm and Yarn have not been tried.

**The whole repository, pinned to a tag.** This works for every package:

```sh
git submodule add https://github.com/wappensc/tdsp vendor/tdsp
git -C vendor/tdsp checkout v1.0.0
```

The consumer's `pnpm-workspace.yaml` lists `vendor/tdsp/packages/*`, and its
`package.json` depends on, for example, `"@tdsp/document-protocol": "workspace:*"`. A new
version is taken by checking out its tag in the submodule.

**One package as a Git dependency.** This works only for a package that depends on no
other package of this repository — `@tdsp/messenger-port` and `@tdsp/reconciliation`. For
the others, pnpm stops with `ERR_PNPM_WORKSPACE_PKG_NOT_FOUND` because of their
`workspace:*` dependencies.

```jsonc
// A fixed version
"@tdsp/messenger-port": "github:wappensc/tdsp#v1.0.0&path:/packages/messenger-port"
// The newest compatible version
"@tdsp/messenger-port": "github:wappensc/tdsp#semver:^1.0.0&path:/packages/messenger-port"
```

With `semver:`, pnpm picks the highest tag in the range and pins its commit in the
lockfile.

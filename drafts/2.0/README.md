# TDSP 2.0, the working text

**Not normative.** The specification in force is [SPECIFICATION.md](../../SPECIFICATION.md),
TDSP 1.4.1, with its bindings in [bindings/](../../bindings/). Nothing in this folder is
implemented by the reference implementation yet, and nothing here is under the wire lock.

This folder holds the text of TDSP 2.0 while it is written: the core in
[SPECIFICATION.md](SPECIFICATION.md) and the bindings in [bindings/](bindings/). It starts as
the fifth revision of the 2.0 draft (draft-5, 20 October 2026), unchanged but for the note at
the top of SPECIFICATION.md and one link that pointed to a file this folder does not have. That revision was reviewed and is what the draft
engine implements; issue #71 is where the proposal began.

How it continues:

1. Each pull request rewrites one section for readability — long requirements split, rationales
   without the history of the draft, an overview before §7 and §10 — without changing what it
   requires. §7 and §10 come first. Requirement IDs stay; a requirement that is split keeps its
   ID for its first part.
2. Changes of substance are decided first and named as such in their pull request.
3. Once the text is done, one pull request makes it SPECIFICATION.md and bindings/, under a
   draft marker on the wire, together with the engine, and the wire lock takes it up.

The diff of a pull request here against this baseline shows exactly what changed from the
reviewed draft; the diff of `bindings/` here against `../../bindings/` shows what 2.0 changes
in the bindings.

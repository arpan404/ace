<!-- SPDX-License-Identifier: CC-BY-4.0 -->
<!-- Text between spec:begin and spec:end marks is written from Spade's data (ADR 0201 §4). Don't edit it by hand: change the data and run `SPADE_WRITE_SPEC=1 cargo test -p spade-core spec_doc`. -->

<!-- spec:begin version -->
# Spade Agent Format 1.0
<!-- spec:end version -->

The Spade Agent Format is an open standard for agent packages: a folder with a manifest that
says what the agent is, what starts its work, what it may do beyond reading and its own things,
what it shows, and the typed calls other agents may make to it. A runtime that installs a
package holds it to what it declared, on every call.

Spade is its reference implementation. ace stewards the format until two implementations not
written by ace conform at the Runtime level (ADR 0201 §6).

## Parts

Each part has its own version. A minor version adds optional fields, tools, card parts or rules
that a reader can ignore safely; a major version changes the meaning of anything, or refuses
something it used to accept. A runtime MUST read every minor version of its major. A security
change that closes a hole MAY refuse what a minor version accepted; it ships as a patch version
with a note.

<!-- spec:begin parts -->
| Part | Version | What it fixes |
| --- | --- | --- |
| [`package`](package.md) | 1.0 | The folder, its limits and `bot.json` version 3: every field, what is refused, how unknown fields are kept and grant nothing. |
| [`effects`](effects.md) | 1.0 | The effect words and their order, the ceiling rule, install switches, the person-only effects, workers inheriting the ceiling. |
| [`runtime`](runtime.md) | 1.0 | `spade.v1`: its modules, tool names, the effect of each tool, `since`, aliases and the major and minor rule. |
| [`surfaces`](surfaces.md) | 1.0 | Card layout parts and actions, panels, their state and actions, the panel message protocol and `confirm` actions. |
| [`contracts`](contracts.md) | 1.0 | Contract declaration, call and return, the bounded schema subset, input and output bounds, held effects, taint at entry, exactly-once keys, compatible changes. |
| [`distribution`](distribution.md) | 1.0 | The content hash, the signed version manifest, withdrawal and scenario test files. |
<!-- spec:end parts -->

A package names the spec version it was written for with the optional field `"spec": "1.0"`. A
missing `spec` reads as `1.0`. `requires.runtime` names the `runtime` part's major version.

## Levels of conformance

Each level builds on the one before.

1. **Reader.** Parses a package, refuses what the spec refuses, keeps unknown fields, computes
   the content hash and verifies a signed version manifest against keys it trusts. A registry, a
   scanner or an editor plugin is a reader.
2. **Runtime.** Installs and runs packages. It MUST enforce the ceiling on every call in every
   mode, keep the person-only effects with the person on every call, start schedule, event and
   webhook triggers paused, keep update and rollback as one step each, and never report a bot as
   done while any part of it works or waits on the person. It MUST NOT let a package's words
   change the effect a call is read as.
3. **Surfaces.** Draws cards from data only and isolates panels as the `surfaces` part says,
   with `confirm` actions confirmed outside the page.

What a runtime does inside its gate (a sandbox, a classifier, a reviewer, the person's
approvals) is its own, as long as the level's MUSTs hold. The spec names these as places a
runtime decides, never how.

A runtime MAY leave out the `devices` module and `agents`' `delegate` and answer them as
unavailable. A package that `uses` a module the runtime lacks MUST be refused at install with
the module's name, never half installed.

## The conformance suite

[`conformance/`](conformance/) holds the cases every reader MUST agree with: each an input and
the expected result, `accept`, or a refusal whose problem says the case's words. Each case has
an `id` that never changes. Spade's two readers, `spade_core::package::read` and `readRecipe` in
`@ace/marketplace`, both run every case from these files, so a case removed here is removed from
both.

<!-- spec:begin suite -->
| File | Part | Cases |
| --- | --- | --- |
| [`conformance/package/manifests.json`](conformance/package/manifests.json) | [`package`](package.md) | 9 |
| [`conformance/effects/manifests.json`](conformance/effects/manifests.json) | [`effects`](effects.md) | 15 |
| [`conformance/contracts/manifests.json`](conformance/contracts/manifests.json) | [`contracts`](contracts.md) | 18 |
| [`conformance/surfaces/manifests.json`](conformance/surfaces/manifests.json) | [`surfaces`](surfaces.md) | 16 |
| [`conformance/package/checks.json`](conformance/package/checks.json) | [`package`](package.md) | 20 |
| [`conformance/contracts/schemas.json`](conformance/contracts/schemas.json) | [`contracts`](contracts.md) | 11 |
| [`conformance/package/check-rules.json`](conformance/package/check-rules.json) | [`package`](package.md) | 21 |
<!-- spec:end suite -->

## Changes

Proposals are issues in this repository labelled `spec`, with a written change and its
conformance cases. A change lands with its cases or not at all.

## License

This text is licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). The
schemas and the conformance suite are Apache-2.0. Anyone may implement the spec without asking.
"Spade Agent Format" names the spec; the Spade name and mark stay ace's, and the spec's license
does not grant them. See [LICENSE.md](LICENSE.md).

# 0201: The Spade agent format is an open standard

Status: accepted. Date: 2026-11-20. Decided by: the founder (2026-11-20), taking every
recommendation below. Builds on [ADR 0200](0200-spade-is-an-agent-operating-system.md) (the
package, `spade.v1`, surfaces, contracts and its amendments),
[ADR 0168](0168-ace-marketplace.md) §6 (signed version manifests) and
[ADR 0174](0174-market-publishers-discovery-and-scanning.md) (the scanner). Bridges to other
standards are [ADR 0202](0202-spade-bridges-to-shared-agent-standards.md); code in packages is
[ADR 0203](0203-spade-packages-ship-sandboxed-webassembly.md).

## Context

ADR 0200 made the bot recipe at version 3 a full agent package: a manifest, declared effects as a
ceiling the person grants into, a versioned runtime API, cards and panels, typed contracts and
scenario tests. Outside reviews call this the strongest package and permission design they have
seen. They also say it is isolated:

- Only Spade reads it. A publisher who learns it can ship to one runtime, with no users yet.
- The field is settling on shared formats: MCP for tools, `SKILL.md` folders for skills,
  agent-to-agent protocols for calls between agents. A private format competes with all of them.
- Open, self-hosted agent registries have shipped malicious skills. The safety in Spade's format
  (effects that bind at run time, signed and pinned versions, no executions in a manifest) is
  worth more if other runtimes can hold packages to it too.

The format already lives in tables both readers share: `spade_core::package`, `readRecipe` in
`@ace/marketplace`, `package/rules.json`, and the runtime table that writes
`spade/docs/runtime.md`. Publishing it costs little. Keeping it closed costs publishers.

## Options considered

- **Keep the format private.** Simplest. Every publisher learns a one-runtime format. Rejected.
- **Drop our format and adopt a shared one whole.** No shared standard has declared effects as a
  ceiling, install-time switches, linked updates with rollback, or typed contracts with held
  effects. Adopting one would lose the safety the reviews valued. Rejected; we bridge instead
  (ADR 0202).
- **Publish the spec as prose only.** Cheap, but readers drift and nobody can prove they conform.
  Rejected.
- **Publish the spec with a conformance suite, Spade as the reference implementation, ace as
  steward until a second implementation exists.** Chosen.
- **Give it to a foundation now.** A foundation wants several implementations and members. We
  have one. Deferred to a stated trigger (decision 6).

## Decision

### 1. What the standard is

The **Spade Agent Format**, version 1.0. One spec, in five parts, each with its own version:

| Part           | What it fixes                                                                                                                        | Comes from                    | Version |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------- | ------- |
| `package`      | The folder, its limits, `bot.json` v3: every field, what is refused, how unknown fields are kept and grant nothing                   | 0200 §3, `packages.md`        | 1.0     |
| `effects`      | The effect words, their order, the ceiling rule, install switches, the person-only effects, workers inheriting the ceiling           | 0171 decision 3, 0200 §3.4    | 1.0     |
| `runtime`      | `spade.v1`: modules, tool names, arguments, answers, effect per tool, `since`, aliases and the major/minor rule                      | 0200 §4, `runtime.md`         | 1.0     |
| `surfaces`     | The bounded schema subset, card layout parts and actions, the panel message protocol, `confirm` actions                             | 0200 §5, amendment 1          | 1.0     |
| `contracts`    | Contract declaration, call and return, input and output bounds, held effects, taint at entry, exactly-once keys, compatible changes | 0200 §7, amendment 2          | 1.0     |
| `distribution` | Content hash, the signed version manifest, withdrawal lists, scenario test files                                                     | 0014, 0168 §6, 0200 §9        | 1.0     |

`requires.runtime` keeps naming the `runtime` part's major version. A package names the spec
version it was written for with a new optional field, `"spec": "1.0"`. A missing `spec` reads as
`1.0`.

### 2. Normative words and levels of conformance

The spec uses MUST, SHOULD and MAY as [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119) and
[RFC 8174](https://www.rfc-editor.org/rfc/rfc8174) define them. There are three levels. Each
builds on the one before:

1. **Reader.** Parses a package, refuses what the spec refuses, keeps unknown fields, computes the
   content hash and verifies a signed version manifest against keys it trusts. A registry, a
   scanner or an editor plugin is a reader.
2. **Runtime.** Installs and runs packages. It MUST enforce the ceiling on every call in every
   mode, keep the person-only effects with the person on every call, start schedule, event and
   webhook triggers paused, keep update and rollback as one step each, and never report a bot as
   done while any part of it works or waits on the person. It MUST NOT let a package's words
   change the effect a call is read as.
3. **Surfaces.** Draws cards from data only and isolates panels as the `surfaces` part says,
   with `confirm` actions confirmed outside the page.

What a runtime does inside its gate (an OS sandbox, a classifier, a reviewer model, the person's
approvals) is its own, as long as the level's MUSTs hold. The spec names these as places a
runtime decides, never how.

### 3. What stays Spade's

Not in the standard, and free to change in any build:

- the gate's insides: `spade_core::effect::route` past the ceiling, the shell reader, the
  classifier (0172), the reviewer (0163), the sandbox (0167);
- ace's market: its keys, "By ace", "Reviewed by ace", ranking, publisher verification, the
  scanner's rules (the scanner is a reader that adds policy);
- ace's integration: the `devices` module's tools come from ace and are listed in `runtime` only
  as names and effects; `delegate`, threads and `@` mentions are ace's;
- the look: Suits, the accent check, the Running page, the install review's wording;
- the fleet: bot moves (0187), the main Spade's host, machine credentials;
- the harness tools outside `spade.v1` (`decision_log`, `skill_*`).

A runtime that is not Spade MAY leave the `devices` and `agents.delegate` tools out and still
conform, by answering them as unavailable. A package that `uses` a module the runtime lacks is
refused at install with the module's name, never half installed.

### 4. Where it lives and how it stays true

- **In this repository**, under `spade/spec/`: one Markdown file per part, the JSON Schemas, and
  the conformance suite. Every table in the spec that Spade already holds as data is written from
  that data, as `runtime.md` is today (`SPADE_WRITE_SPEC=1 cargo test -p spade-core spec_doc`), so
  the spec and the code cannot drift. A test fails when a written file differs from what the data
  would write.
- **Published** as a static site from those files, at `spec.acehq.dev`, on Cloudflare Pages like
  the marketing site. The site is generated, never edited by hand.
- **JSON Schemas** at stable addresses: `https://spec.acehq.dev/1.0/bot.schema.json`,
  `card.schema.json`, `contract.schema.json`, `scenario.schema.json`,
  `version-manifest.schema.json`. `ace bot init` writes `"$schema"` pointing at the first, so
  editors validate without Spade.

### 5. The conformance suite

- **Fixtures, not code.** A folder of cases, each a package folder (or a manifest and its bytes)
  and an expected result: `accept`, or `refuse` with the rule id; for runtime cases, a scripted
  model and fake tool results in today's scenario format, and the calls, refusals, effects, cards
  and outputs that must follow. Rule ids come from `package/rules.json`, so a refusal is matched
  by id, not by wording.
- **Where the cases come from.** Today's tables in `spade_core::package`, `spade_core::effect`,
  `spade_core::contract`, `spade_core::panel` and `@ace/marketplace`'s recipe tests are moved to
  read their cases from the suite folder. The suite is then the test of both readers, not a copy.
- **A runner.** `spade-conform`, a small binary in `spade/crates/spade-conform`, runs the suite
  against any implementation through one of two doors: a reader command (`<cmd> read <folder>`
  answering JSON), or a runtime's HTTP API in the shape Spade's `POST /v1/agents` and
  `spade --bot-test` already speak. Its report lists each case passed or failed, per level.
- **Spade passes all three levels on every build.** CI's Spade job runs the suite.

### 6. License and governance

- **License.** The spec text is CC BY 4.0. The schemas, the suite and `spade-conform` are
  Apache-2.0, like the rest of ace. Anyone may implement the spec without asking.
- **Name and mark.** "Spade Agent Format" names the spec. An implementation may say it
  "conforms to Spade Agent Format 1.0 at the Runtime level" when `spade-conform` passes at that
  level for that version. ace keeps the Spade name and mark; the spec's license does not grant
  them.
- **Changes.** Proposals are issues in this repository labelled `spec`, with a written change and
  its conformance cases. ace's maintainers decide. A change lands with its cases or not at all.
- **Versions.** A minor version adds optional fields, tools, card parts or rules a reader can
  ignore safely. A major version changes the meaning of anything, or refuses something it used
  to accept. A runtime MUST read every minor version of its major. The `runtime` part keeps
  ADR 0200 §4.3's six-month alias rule.
- **Security changes** that close a hole may refuse what a minor version accepted. They ship as a
  patch version with a note, because a hole is not a feature.
- **A neutral home** is considered once two implementations not written by ace pass the Runtime
  level, or when a standards body asks. Until then ace stewards it.

### 7. Phases

1. **First slice.** `spade/spec/` with the six parts written from today's data; the schemas; the
   suite holding every case today's tables test; `spade-conform` with the reader door; both of
   ace's readers running from the suite; `spec.acehq.dev` published; `"spec"` read and written.
2. **Runtime door.** `spade-conform` drives a runtime through its HTTP API; Spade passes the
   Runtime and Surfaces levels in CI.
3. **Outside readers.** A small reference reader in TypeScript with no ace imports, published as
   an npm package (`@spade-format/reader`), so a registry or editor can validate packages.
   Bridges (ADR 0202) declare their mappings as spec annexes.

## Decided

The founder took each recommendation on 2026-11-20.

1. **Its name.** "Spade Agent Format", with the wire names unchanged (`format: "spade-bot"`).
   A neutral name would cost a rename across readers for no user gain now.
2. **The license.** CC BY 4.0 for the text, Apache-2.0 for schemas, suite and runner.
3. **Who decides changes.** ace's maintainers, through public issues with cases, until two
   outside Runtime implementations exist.
4. **Where it lives.** In this repository, written from the data, published to
   `spec.acehq.dev`. A separate repository would let it drift from the code.

## Consequences

- A publisher can learn one format that a second runtime may also run, and prove a package
  valid without Spade.
- Spade's readers move to the shared cases. A refusal changes in one place.
- Every table that becomes spec becomes a promise. The gate's insides stay free to change, which
  is where most of the churn is.
- ace takes on the work of a steward: answering proposals and keeping the site and suite true.
- Another runtime could run Spade packages with weaker insides. The Runtime level's MUSTs are
  the floor; the mark is only for what passes.

## Tests

- The spec files are written from the data, and a test fails when a committed file differs.
- `spade_core`'s package, effect, contract and panel tables, and `@ace/marketplace`'s recipe
  tests, read their cases from `spade/spec/conformance/`; deleting a case from the suite drops it
  from both, and a reader that disagrees with a case fails.
- `spade-conform` against Spade passes every case at every level; against a reader that accepts
  a manifest with `publisher`, or a runtime that runs a call outside the ceiling in Full access,
  it fails the named case.
- The published JSON Schema accepts every `accept` case's manifest and refuses every case the
  schema alone can decide.

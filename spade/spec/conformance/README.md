<!-- SPDX-License-Identifier: Apache-2.0 -->

# The Spade Agent Format's conformance suite

The cases every reader of the [Spade Agent Format](../README.md) MUST agree with, as data. Each
file holds the cases of one part; each case has an `id` that never changes and names it in
reports. Spade's two readers run every case from these files: `spade_core::package::read` (in
`spade_core`'s tests) and `readRecipe` in `@ace/marketplace` (`package.test.ts`,
`schema.test.ts`). A case removed here is removed from both; a reader that disagrees with a case
fails.

## Manifest cases

`<part>/manifests.json`: `{license, part, about, base, cases}`. Each case is
`{id, name, with, files?, refused?}`:

- the manifest is `base` with `with`'s fields set over it, at the top level;
- `files` are the package's other files by path, a contract's schema file among them, which a
  reader writes into its contract before it reads the manifest;
- without `rule` a reader MUST accept the manifest; with it, a reader MUST refuse it with a
  problem naming that rule. Words are each reader's own; a refusal is matched by its rule's id.

## Schema cases

`contracts/schemas.json`: `{license, part, about, cases}`. Each case is
`{id, name, schema, rule?, fits?, misfits?}`: a reader MUST refuse `schema` with a problem
naming `rule`, or read it and find every value in `fits` fits and every `misfits` entry's
`value` misses at the place its `at` names.

## Rules

`rules.json` lists every rule a reader refuses a package by: `{id, part, says, schema}`. An id
never changes. `schema` says whether the part's JSON Schema (`../schemas/`) alone decides the
rule; a schema-only validator refuses those cases too. It is written from `spade_core::rule`.

## Runtime and Surfaces cases

`runtime/packages.json` and `surfaces/panels.json` are steps over a runtime's HTTP API, in the
shape Spade's speaks; `runtime/scenarios.json` and `surfaces/cards.json` are scenario tests (the
[distribution](../distribution.md) part's format) run through a runtime's scenario door. Each
file's `about` says what its steps and expectations mean.

## The runner

`spade-conform` (`spade/crates/spade-conform`) runs every case, level by level, through an
implementation's doors, and reports each case passed or failed:

- the reader door: `<cmd> read <folder>` answers `{accepted, problems: [{rule, message}]}`;
  `<cmd> fit <file>`, for a file of `{schema, at, values}`, answers `{accepted, problems,
values}`, each value's answer `{fits, misfits}`;
- the HTTP door: the runtime's API root, its token in `SPADE_CONFORM_TOKEN`;
- the scenario door: `<cmd> <folder>` answers the report `spade --bot-test` prints. The runner
  judges the calls it lists itself.

```sh
cargo run -p spade-conform -- --reader spade --reader-arg --conform \
  --runtime http://127.0.0.1:7777 --scenarios spade --scenarios-arg --bot-test
```

It exits 0 only when every case of every level run passed. Spade runs it on itself in
`spade-server`'s `tests/conformance.rs`.

## Adding a case

A change to the format lands with its cases. Add the case to its part's file with a new `id`
(a refusal names its rule from `rules.json`; a new rule is added to `spade_core::rule`), run both
readers' tests and `spade-conform`, and write the spec again
(`SPADE_WRITE_SPEC=1 cargo test -p spade-core spec_doc`), which lists every case.

## License

Apache-2.0, like the rest of this repository. The spec's text is CC BY 4.0
([LICENSE.md](../LICENSE.md)).

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
- without `refused` a reader MUST accept the manifest; with it, a reader MUST refuse it, and one
  of its problems contains `refused`'s words.

## Schema cases

`contracts/schemas.json`: `{license, part, about, cases}`. Each case is
`{id, name, schema, refused?, fits?, misfits?}`: a reader MUST refuse `schema` with a problem
containing `refused`'s words, or read it and find every value in `fits` fits and every
`misfits` entry's `value` misses at the place its `at` names.

## Adding a case

A change to the format lands with its cases. Add the case to its part's file with a new `id`,
run both readers' tests, and write the spec again
(`SPADE_WRITE_SPEC=1 cargo test -p spade-core spec_doc`), which lists every case.

## License

Apache-2.0, like the rest of this repository. The spec's text is CC BY 4.0
([LICENSE.md](../LICENSE.md)).

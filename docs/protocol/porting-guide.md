# Porting the wire contract to Rust

The wire's types and shape table are generated from `packages/protocol`, the one source of truth.
This guide states the rules the generators keep; `docs/transport/porting-guide.md` covers the
transport that uses them.

## Generated files

- `native/daemon/crates/ace-protocol/src/generated.rs` and `wire.rs` come from
  `scripts/generate-rust-protocol.ts` (Zod's JSON Schema through `typify`).
- `native/daemon/crates/ace-protocol/src/shapes/` comes from
  `scripts/rust-protocol-shapes.ts` (Zod's parse: key order, defaults, bounds, refinements).
- Run `bun scripts/generate-rust-protocol.ts` after a schema or generator change, then its
  `--check` mode. `--check` also refuses a shape file left behind by a removed root.

## Refinements

A `.refine()`/`.superRefine()` is a constraint JSON Schema cannot state. Every one reachable from
a wire root is named in `scripts/rust-protocol-checks.ts` and implemented in
`native/daemon/crates/ace-protocol/src/checks.rs`; the generator fails, naming the path, when a
reachable check has no entry. A check on a whole message body stays in `ace-wire/src/refine.rs`
(the registry marks it `message`) so its error still names the rule.

String checks run in Zod's order, because `.trim()` changes what the checks after it see. A
triggered `.refine()` on an object sees the object after its defaults are filled and its unknown
keys are stripped, as Zod's refine does.

## Presence and loose objects

`Option` alone cannot tell an absent key from `null`, and `Vec` cannot tell absent from `[]`. The
generator rewrites an optional nullable field to `Option<Option<T>>` with a present `null` kept by
`crate::presence::some_or_none`, and an optional array to `Option<Vec<T>>`. A loose object keeps
its unnamed keys in `crate::presence::Extra`.

`z.record` with string keys drops `__proto__` as Zod does; the opaque-id maps built by
`records()` in `wire-core.ts` keep it, because that helper rebuilds them from their own entries.
Enum-keyed records and `z.partialRecord` become objects whose keys are the enum's values.

## Intended differences

None. Every difference found so far was the Rust side missing a check Zod applies; the Rust side
now matches Zod's accept/reject decision and output.

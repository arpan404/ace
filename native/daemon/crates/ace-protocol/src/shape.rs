// SPDX-License-Identifier: Apache-2.0
//! What a Zod parse keeps of a value, hand-written and dependency-free. `shapes` is generated
//! from the schemas by `scripts/rust-protocol-shapes.ts` (porting guide 5.3b): the shape walk in
//! [`ace_projection`](../../ace_projection) uses it to reproduce Zod's stripping and defaults.
//!
//! Recursion in the walk follows this table, never the input: a [`Shape::Copy`] subtree is
//! cloned by `ace-json` in one non-recursive pass, so the walk's depth is the table's however
//! deeply a value nests.

/// What Zod's parse keeps of a value, generated from the schema.
pub enum Shape {
    /// Kept as it is: strings, numbers, booleans, null, enums, literals, `z.unknown`, and
    /// unions, arrays and nullables whose every part is `Copy`.
    Copy,
    /// `z.object` in strip mode: the fields in schema order; any other key is dropped.
    Object(&'static [Field]),
    /// `z.array`: each element through the shape.
    Array(&'static Shape),
    /// `z.record` with string keys: own keys in JavaScript order, `__proto__` dropped, each
    /// value through the shape.
    Record(&'static Shape),
    /// `.nullable()`: null is kept, anything else goes through the shape.
    Nullable(&'static Shape),
    /// `z.discriminatedUnion`: the option whose literal, as JSON text (`"\"pr\""`), equals the
    /// value's `key` field printed.
    Tagged {
        key: &'static str,
        options: &'static [(&'static str, Shape)],
    },
}

/// One key of a [`Shape::Object`]: its schema order, whether an absent key stays absent and,
/// for a default, the JSON text inserted at the key's place.
pub struct Field {
    pub key: &'static str,
    pub presence: Presence,
    pub shape: Shape,
}

/// What an absent object key becomes.
pub enum Presence {
    Required,
    /// `.optional()`: an absent key stays absent.
    Optional,
    /// `.default(v)`, `v` as JSON text: an absent key gets `v` at its place.
    Default(&'static str),
}

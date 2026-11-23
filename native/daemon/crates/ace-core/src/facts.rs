// SPDX-License-Identifier: Apache-2.0
//! E0 stub: the `facts` port of `packages/core/src/facts.ts` lands here in E4
//! as a serde enum tagged by `type`. Translators return facts; only the core
//! allocates ace ids.

use serde_json::value::RawValue;

/// A native fact key, namespaced per provider process (E4 refines this).
pub type Key = String;

/// E0 placeholder: the fact enum E4 ports. The `data` is the fact's JSON as
/// the translator built it, kept whole.
pub struct Fact {
    /// The fact's `type` tag, which the E4 enum matches on.
    pub fact_type: String,
    /// The fact's body as JSON.
    pub data: Box<RawValue>,
}

//! The conformance suite's case tables (`spade/spec/conformance/`, ADR 0201 §5), as Spade's own
//! tests read them. The suite is the test of both of ace's readers, not a copy: Spade's reader
//! here and the marketplace's (`packages/marketplace/src/package.test.ts`, `schema.test.ts`) run
//! every case from the same files, so deleting a case drops it from both.

use serde_json::Value;

/// One case file: its part, and its text.
pub struct Suite {
    pub part: &'static str,
    pub text: &'static str,
}

/// The manifest cases, by part: each a base manifest with a case's fields merged over it.
pub const MANIFESTS: [Suite; 4] = [
    Suite {
        part: "package",
        text: include_str!("../../../../spec/conformance/package/manifests.json"),
    },
    Suite {
        part: "effects",
        text: include_str!("../../../../spec/conformance/effects/manifests.json"),
    },
    Suite {
        part: "contracts",
        text: include_str!("../../../../spec/conformance/contracts/manifests.json"),
    },
    Suite {
        part: "surfaces",
        text: include_str!("../../../../spec/conformance/surfaces/manifests.json"),
    },
];

/// The bounded schema subset's cases.
pub const SCHEMAS: Suite = Suite {
    part: "contracts",
    text: include_str!("../../../../spec/conformance/contracts/schemas.json"),
};

impl Suite {
    /// The file, parsed; `Null` when it isn't JSON, which every reader of it then fails on.
    pub fn json(&self) -> Value {
        serde_json::from_str(self.text).unwrap_or_default()
    }

    /// Its cases, in order.
    pub fn cases(&self) -> Vec<Value> {
        self.json()["cases"].as_array().cloned().unwrap_or_default()
    }
}

/// A manifest case's `bot.json`: the suite's base with the case's `with` merged over it at the
/// top level.
pub fn manifest(suite: &Value, case: &Value) -> Value {
    let mut manifest = suite["base"].clone();
    for (key, value) in case["with"].as_object().cloned().unwrap_or_default() {
        manifest[key] = value;
    }
    manifest
}

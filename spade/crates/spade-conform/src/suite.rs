//! The conformance suite, compiled in from `spade/spec/conformance/`: each file's text, and how
//! a case's manifest is made from its file's base.

use serde_json::Value;

/// One case file: its path under `spade/spec/conformance/` and its text.
pub struct File {
    pub path: &'static str,
    pub text: &'static str,
}

macro_rules! file {
    ($path:literal) => {
        File {
            path: $path,
            text: include_str!(concat!("../../../spec/conformance/", $path)),
        }
    };
}

/// The Reader level's manifest cases, by part.
pub const MANIFESTS: [File; 5] = [
    file!("package/manifests.json"),
    file!("effects/manifests.json"),
    file!("contracts/manifests.json"),
    file!("surfaces/manifests.json"),
    file!("code/manifests.json"),
];
/// The Reader level's schema cases.
pub const SCHEMAS: File = file!("contracts/schemas.json");
/// The Runtime level's cases over the HTTP API, and through the scenario door.
pub const RUNTIME_PACKAGES: File = file!("runtime/packages.json");
pub const RUNTIME_SCENARIOS: File = file!("runtime/scenarios.json");
/// The Surfaces level's panel cases over the HTTP API, and its card cases through the scenario
/// door.
pub const SURFACES_PANELS: File = file!("surfaces/panels.json");
pub const SURFACES_CARDS: File = file!("surfaces/cards.json");
/// The rule table refusals are named by.
pub const RULES: File = file!("rules.json");

impl File {
    /// The file, parsed; `Null` when it isn't JSON, so every case of it fails.
    pub fn json(&self) -> Value {
        serde_json::from_str(self.text).unwrap_or_default()
    }

    /// Its cases, in order.
    pub fn cases(&self) -> Vec<Value> {
        self.json()["cases"].as_array().cloned().unwrap_or_default()
    }
}

/// `base` with `with`'s fields set over it, at the top level.
pub fn merged(base: &Value, with: &Value) -> Value {
    let mut out = base.clone();
    if let (Some(out), Some(with)) = (out.as_object_mut(), with.as_object()) {
        for (key, value) in with {
            out.insert(key.clone(), value.clone());
        }
    }
    out
}

/// A case's id, for its report line.
pub fn id(case: &Value) -> String {
    case["id"]
        .as_str()
        .unwrap_or("(a case without an id)")
        .to_owned()
}

//! The Spade Agent Format's spec, `spade/spec/` (ADR 0201): one Markdown file per part, and the
//! conformance suite. Every table in the spec that Spade holds as data is written here from that
//! data, between `<!-- spec:begin NAME -->` and `<!-- spec:end NAME -->` marks in the committed
//! file; the prose around the marks is the spec's own. A test fails when a committed file differs
//! from what the data writes (`SPADE_WRITE_SPEC=1 cargo test -p spade-core spec_doc` writes them),
//! so the spec and the readers can't drift. Pure: the test does the reading and writing.

pub mod conformance;
mod contracts;
mod distribution;
mod effects;
mod index;
mod markdown;
mod package;
mod runtime;
pub mod schemas;
mod surfaces;
#[cfg(test)]
mod tests;

pub use markdown::fill;

/// The format's version.
pub const VERSION: &str = "1.0";

/// One part of the spec (ADR 0201 §1).
pub struct Part {
    pub id: &'static str,
    pub title: &'static str,
    pub version: &'static str,
    /// What it fixes, in one line.
    pub fixes: &'static str,
}

/// The parts, in the order the spec reads.
pub const PARTS: [Part; 6] = [
    Part {
        id: "package",
        title: "Package",
        version: "1.0",
        fixes: "The folder, its limits and `bot.json` version 3: every field, what is refused, how unknown fields are kept and grant nothing.",
    },
    Part {
        id: "effects",
        title: "Effects",
        version: "1.0",
        fixes: "The effect words and their order, the ceiling rule, install switches, the person-only effects, workers inheriting the ceiling.",
    },
    Part {
        id: "runtime",
        title: "Runtime",
        version: "1.0",
        fixes: "`spade.v1`: its modules, tool names, the effect of each tool, `since`, aliases and the major and minor rule.",
    },
    Part {
        id: "surfaces",
        title: "Surfaces",
        version: "1.0",
        fixes: "Card layout parts and actions, panels, their state and actions, the panel message protocol and `confirm` actions.",
    },
    Part {
        id: "contracts",
        title: "Contracts",
        version: "1.0",
        fixes: "Contract declaration, call and return, the bounded schema subset, input and output bounds, held effects, taint at entry, exactly-once keys, compatible changes.",
    },
    Part {
        id: "distribution",
        title: "Distribution",
        version: "1.0",
        fixes: "The content hash, the signed version manifest, withdrawal and scenario test files.",
    },
];

/// One written file of the spec: its path under `spade/spec/`, and each region's text.
pub struct File {
    pub path: String,
    pub regions: Vec<(&'static str, String)>,
}

/// Every file the data writes, or what keeps the data from being written (a field the reader
/// knows that the spec doesn't describe, say).
pub fn files() -> Result<Vec<File>, Vec<String>> {
    let mut problems = Vec::new();
    let mut out = vec![File {
        path: "README.md".to_owned(),
        regions: index::regions(),
    }];
    for part in &PARTS {
        let regions = match part.id {
            "package" => package::regions(),
            "effects" => Ok(effects::regions()),
            "runtime" => Ok(runtime::regions()),
            "surfaces" => Ok(surfaces::regions()),
            "contracts" => contracts::regions(),
            _ => Ok(distribution::regions()),
        };
        match regions {
            Ok(regions) => {
                let mut all = vec![("header", markdown::header(part))];
                all.extend(regions);
                out.push(File {
                    path: format!("{}.md", part.id),
                    regions: all,
                });
            }
            Err(more) => problems.extend(more.into_iter().map(|p| format!("{}: {p}", part.id))),
        }
    }
    if problems.is_empty() {
        Ok(out)
    } else {
        Err(problems)
    }
}

/// A file the data writes whole: its path under `spade/spec/` and its text.
pub struct Whole {
    pub path: String,
    pub text: String,
}

/// Every file the data writes whole: the rule table and the JSON Schemas.
pub fn wholes() -> Vec<Whole> {
    let mut out = vec![Whole {
        path: "conformance/rules.json".to_owned(),
        text: pretty(&rules_json()),
    }];
    out.extend(schemas::all().into_iter().map(|(name, schema)| Whole {
        path: format!("schemas/{name}"),
        text: pretty(&schema),
    }));
    out
}

/// JSON as the spec keeps it: two spaces, one value a line, a newline at the end.
fn pretty(value: &serde_json::Value) -> String {
    let mut text = serde_json::to_string_pretty(value).unwrap_or_default();
    text.push('\n');
    text
}

fn rules_json() -> serde_json::Value {
    serde_json::json!({
        "license": "Apache-2.0",
        "about": "Every rule a reader of the Spade Agent Format refuses a package by. A refusal names its rule's `id`, which never changes, so a conformance case matches a refusal by id and never by words. `schema` says whether the part's JSON Schema alone decides it. Written from spade_core::rule; don't edit by hand.",
        "version": VERSION,
        "rules": crate::rule::RULES,
    })
}

//! The `code` part's regions, from `spade_core::package::code`'s own lists and bounds: the
//! imports a component may have, what a call may use, and the part's cases.

use super::conformance;
use super::markdown::{cases, number, table};
use crate::package::code::{self, Import};

pub fn regions() -> Vec<(&'static str, String)> {
    vec![
        ("imports", imports()),
        ("bounds", bounds()),
        ("cases", cases(&conformance::MANIFESTS[4])),
    ]
}

fn imports() -> String {
    table(
        &["Import", "Effect the gate reads"],
        Import::ALL.iter().map(|import| {
            let effect = match (import, import.effect()) {
                (Import::Tools, _) => "the called tool's, at each call".to_owned(),
                (_, Some(effect)) => format!("`{}`", effect.name()),
                (_, None) => "none".to_owned(),
            };
            vec![format!("`{}`", import.name()), effect]
        }),
    )
}

fn bounds() -> String {
    let mib = |bytes: usize| number((bytes / (1024 * 1024)) as u64);
    table(
        &["Bound", "Value"],
        [
            vec![
                "Components in a package".to_owned(),
                code::MOST_COMPONENTS.to_string(),
            ],
            vec![
                "A component's size".to_owned(),
                format!("{} MiB", mib(code::MOST_BYTES)),
            ],
            vec![
                "A call's running time".to_owned(),
                format!(
                    "{} s by default, up to {} s with `timeout_s`; waits on the runtime don't count",
                    code::DEFAULT_TIMEOUT_S,
                    code::MOST_TIMEOUT_S
                ),
            ],
            vec![
                "A call's fuel".to_owned(),
                format!("{} units", number(code::FUEL_PER_CALL)),
            ],
            vec![
                "An instance's linear memory".to_owned(),
                format!(
                    "{} MiB by default, up to {} MiB with `memory_mb`",
                    code::DEFAULT_MEMORY_MB,
                    code::MOST_MEMORY_MB
                ),
            ],
            vec![
                "Tables per instance".to_owned(),
                code::MOST_TABLES.to_string(),
            ],
        ],
    )
}

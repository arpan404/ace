//! `README.md`'s regions: the parts and their versions, and the conformance suite's files.

use super::markdown::{cell, table};
use super::{PARTS, VERSION, conformance};

pub fn regions() -> Vec<(&'static str, String)> {
    vec![
        ("version", format!("# Spade Agent Format {VERSION}\n")),
        ("parts", parts()),
        ("suite", suite()),
    ]
}

fn parts() -> String {
    table(
        &["Part", "Version", "What it fixes"],
        PARTS.iter().map(|part| {
            vec![
                format!("[`{id}`]({id}.md)", id = part.id),
                part.version.to_owned(),
                cell(part.fixes),
            ]
        }),
    )
}

fn suite() -> String {
    let all = conformance::MANIFESTS
        .iter()
        .chain(std::iter::once(&conformance::SCHEMAS))
        .chain(&conformance::LEVELS);
    table(
        &["File", "Part", "Cases"],
        all.map(|suite| {
            let file = format!("conformance/{}", suite.file);
            vec![
                format!("[`{file}`]({file})"),
                format!("[`{part}`]({part}.md)", part = suite.part),
                suite.cases().len().to_string(),
            ]
        }),
    )
}

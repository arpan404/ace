//! The `contracts` part's regions: a contract's fields and bounds from
//! `spade_core::package::contract`, the schema subset from `spade_core::schema`, and the call
//! tools from `spade.v1`'s table.

use super::conformance;
use super::markdown::{bytes, cases, code_list, number, table};
use crate::effect::runtime;
use crate::package::{contract, contract_files};
use crate::schema;

pub fn regions() -> Result<Vec<(&'static str, String)>, Vec<String>> {
    Ok(vec![
        ("fields", format!("{}.\n", code_list(contract::FIELDS))),
        ("bounds", bounds()),
        ("subset", subset()),
        ("subset-bounds", subset_bounds()),
        ("tools", tools()?),
        ("cases", cases(&conformance::MANIFESTS[2])),
        ("schema-cases", cases(&conformance::SCHEMAS)),
    ])
}

fn bounds() -> String {
    let rows = [
        (
            "contracts in a package",
            format!("at most {}", contract::MOST_CONTRACTS),
        ),
        (
            "`summary`",
            format!("at most {} characters", contract::SUMMARY_CHARS),
        ),
        ("`examples`", format!("at most {}", contract::MOST_EXAMPLES)),
        ("a call's input, as JSON", bytes(contract::INPUT_BYTES)),
        ("a call's output, as JSON", bytes(contract::OUTPUT_BYTES)),
        (
            "a contract's schema file",
            bytes(contract_files::MOST_FILE_BYTES),
        ),
    ];
    table(
        &["What", "Bound"],
        rows.into_iter()
            .map(|(what, bound)| vec![what.to_owned(), bound]),
    )
}

fn subset() -> String {
    let rows = schema::KINDS.into_iter().map(|(kind, keywords)| {
        let kind = kind
            .split(", ")
            .map(|kind| format!("`{kind}`"))
            .collect::<Vec<_>>()
            .join(", ");
        let keywords = if keywords.is_empty() {
            "none".to_owned()
        } else {
            code_list(keywords.iter().copied())
        };
        vec![kind, keywords]
    });
    format!(
        "{}\nEvery kind also takes {}.\n",
        table(&["`type`", "Keywords"], rows),
        code_list(schema::COMMON)
    )
}

fn subset_bounds() -> String {
    let rows = [
        (
            "levels deep, the top value being one",
            schema::MOST_DEPTH.to_string(),
        ),
        (
            "an object's `properties`",
            format!("at most {}", schema::MOST_FIELDS),
        ),
        ("an `enum`'s words", format!("1 to {}", schema::MOST_ENUM)),
        (
            "an `enum` word",
            format!("at most {} characters", schema::ENUM_CHARS),
        ),
        (
            "a string's `maxLength`, which it MUST have",
            format!("1 to {}", number(schema::LONGEST_STRING)),
        ),
        (
            "a list's `maxItems`, which it MUST have",
            format!("1 to {}", number(schema::MOST_ITEMS)),
        ),
        (
            "`description` and `title`",
            format!("at most {} characters", schema::DESCRIPTION_CHARS),
        ),
        (
            "the whole schema, as JSON",
            bytes(schema::MOST_SCHEMA_BYTES),
        ),
    ];
    table(
        &["What", "Bound"],
        rows.into_iter()
            .map(|(what, bound)| vec![what.to_owned(), bound]),
    )
}

/// The call tools, from the runtime table, so their effects are the gate's.
fn tools() -> Result<String, Vec<String>> {
    let names = [
        crate::contract::CONTRACTS_FIND,
        crate::contract::CONTRACT_CALL,
        crate::contract::CONTRACT_RETURN,
    ];
    let mut rows = Vec::new();
    let mut problems = Vec::new();
    for name in names {
        match runtime::tool(name) {
            Some(tool) => rows.push(vec![
                format!("`{name}`"),
                format!("`{}`", tool.module.name()),
                runtime::effect_words(tool),
                tool.since.to_owned(),
            ]),
            None => problems.push(format!("{name} isn't in spade.v{}", runtime::VERSION)),
        }
    }
    if problems.is_empty() {
        Ok(table(&["Tool", "Module", "Effect", "Since"], rows))
    } else {
        Err(problems)
    }
}

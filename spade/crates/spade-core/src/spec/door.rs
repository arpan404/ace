//! Spade as a reader behind `spade-conform`'s reader door (ADR 0201 §5): what `spade --conform
//! read <folder>` and `spade --conform fit <file>` answer, as JSON. Pure: the caller brings the
//! files; the reading is the one every install takes ([`package::read`] after
//! [`contract_files::inline`]).
//!
//! - `read`: `{accepted, problems: [{rule, message}], spec?, unused?}`.
//! - `fit`, for `{schema, at, values}`: `{accepted, problems, values: [{fits, misfits: [at]}]}`.

use serde_json::{Value, json};

use crate::package::{self, contract_files, manifest::Build};
use crate::rule::{self, Problem};
use crate::schema;

fn problems(found: &[Problem]) -> Value {
    Value::Array(
        found
            .iter()
            .map(|p| json!({ "rule": p.rule, "message": p.text }))
            .collect(),
    )
}

/// A package folder's answer: `bot` is `bot.json`'s text, `file` reads its other files by path.
pub fn read(bot: &str, file: impl Fn(&str) -> Option<String>, build: Build<'_>) -> Value {
    let Ok(value) = serde_json::from_str::<Value>(bot) else {
        let found = [Problem::new(rule::NOT_OBJECT, "bot.json isn't JSON")];
        return json!({ "accepted": false, "problems": problems(&found) });
    };
    // A contract's schema file is read only from where a schema file may be.
    let file = |path: &str| {
        if contract_files::schema_path(path) {
            file(path)
        } else {
            None
        }
    };
    match contract_files::inline(&value, file).and_then(|v| package::read(&v, build)) {
        Ok(manifest) => json!({
            "accepted": true,
            "problems": [],
            "spec": manifest.spec,
            "unused": manifest.unused,
        }),
        Err(found) => json!({ "accepted": false, "problems": problems(&found) }),
    }
}

/// A schema's answer for `{schema, at, values}`: read, then each value checked against it.
pub fn fit(asked: &Value) -> Value {
    let at = asked["at"].as_str().unwrap_or("input");
    match schema::read(&asked["schema"], at) {
        Err(found) => json!({ "accepted": false, "problems": problems(&found), "values": [] }),
        Ok(schema) => {
            let values: Vec<Value> = asked["values"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|value| {
                    let misfits: Vec<String> =
                        schema.check(value, at).into_iter().map(|m| m.at).collect();
                    json!({ "fits": misfits.is_empty(), "misfits": misfits })
                })
                .collect();
            json!({ "accepted": true, "problems": [], "values": values })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const BUILD: Build<'static> = Build {
        version: "0.0.25",
        task_chars: 4000,
    };

    #[test]
    fn a_refused_package_answers_each_problems_rule() {
        let bot = r#"{"format":"spade-bot","version":3,"name":"A","publisher":"acme"}"#;
        let answer = read(bot, |_| None, BUILD);
        assert_eq!(answer["accepted"], false);
        assert_eq!(answer["problems"][0]["rule"], "package.identity");
    }

    #[test]
    fn a_contracts_schema_file_is_read_only_from_the_contracts_folder() {
        let bot = r#"{"format":"spade-bot","version":3,"name":"A","contracts":[
            {"name":"a","summary":"A.","file":"contracts/a.json"}]}"#;
        let schemas = r#"{"input":{"type":"boolean"},"output":{"type":"boolean"}}"#;
        let answer = read(
            bot,
            |path| (path == "contracts/a.json").then(|| schemas.to_owned()),
            BUILD,
        );
        assert_eq!(answer["accepted"], true, "{answer}");
    }

    #[test]
    fn a_schemas_answer_says_where_each_value_misses() {
        let asked = json!({
            "schema": {"type": "object", "properties": {"from": {"type": "string", "maxLength": 3}}},
            "at": "input",
            "values": [{"from": "KTM"}, {"from": "Kathmandu"}],
        });
        let answer = fit(&asked);
        assert_eq!(answer["values"][0]["fits"], true);
        assert_eq!(answer["values"][1]["misfits"], json!(["input.from"]));
    }
}

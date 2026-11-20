use serde_json::{Value, json};

use super::*;

/// Every case of `cases.json`, which the marketplace's reader runs too.
#[test]
fn both_readers_agree_on_every_schema_case() {
    let all: Value = serde_json::from_str(include_str!("cases.json")).unwrap_or_default();
    let cases = all["cases"].as_array().cloned().unwrap_or_default();
    assert!(cases.len() >= 10, "the cases are read");
    for case in cases {
        let name = case["name"].as_str().unwrap_or_default();
        let read = read(&case["schema"], "input");
        if let Some(word) = case["refused"].as_str() {
            let problems = read.err().unwrap_or_default();
            assert!(
                problems.iter().any(|p| p.contains(word)),
                "{name}: refused for {word:?}, got {problems:?}"
            );
            continue;
        }
        let schema = read.unwrap_or_else(|problems| panic!("{name}: {problems:?}"));
        for value in case["fits"].as_array().into_iter().flatten() {
            assert_eq!(schema.check(value, "input"), Vec::new(), "{name}: {value}");
        }
        for miss in case["misfits"].as_array().into_iter().flatten() {
            let misfits = schema.check(&miss["value"], "input");
            let at = miss["at"].as_str().unwrap_or_default();
            assert!(
                misfits.iter().any(|m| m.at == at),
                "{name}: {} misses at {at}, got {misfits:?}",
                miss["value"]
            );
        }
    }
}

#[test]
fn a_misfit_says_what_to_fix_in_words() {
    let schema = read(
        &json!({"type": "object", "properties": {"from": {"type": "string", "maxLength": 3}}, "required": ["from"]}),
        "input",
    )
    .unwrap_or_else(|p| panic!("{p:?}"));
    let misfits = schema.check(&json!({"from": "Kathmandu", "to": "DEL"}), "input");
    assert_eq!(
        lines(&misfits),
        "- input.from: is at most 3 characters\n- input.to: isn't a field this takes"
    );
}

#[test]
fn a_value_that_misses_everywhere_lists_twenty_places_at_most() {
    let schema = read(
        &json!({"type": "array", "maxItems": 1000, "items": {"type": "boolean"}}),
        "output",
    )
    .unwrap_or_else(|p| panic!("{p:?}"));
    let many: Vec<Value> = (0..500).map(|n| json!(n)).collect();
    assert_eq!(schema.check(&Value::Array(many), "output").len(), 20);
}

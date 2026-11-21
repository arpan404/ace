use serde_json::json;

use super::*;

/// Every rule case of the conformance suite (`spade/spec/conformance/package/check-rules.json`),
/// which the marketplace's reader runs too.
#[test]
fn both_readers_agree_on_every_rule_case() {
    let cases = crate::spec::conformance::RULES.cases();
    assert!(cases.len() >= 10, "the cases are read");
    for case in cases {
        let name = case["id"].as_str().unwrap_or_default();
        let read = read(&case["rule"], "rule");
        if let Some(word) = case["refused"].as_str() {
            let problems = read.err().unwrap_or_default();
            assert!(
                problems.iter().any(|p| p.contains(word)),
                "{name}: refused for {word:?}, got {problems:?}"
            );
            continue;
        }
        let rule = read.unwrap_or_else(|problems| panic!("{name}: {problems:?}"));
        for value in case["fits"].as_array().into_iter().flatten() {
            assert_eq!(rule.check(value, "output"), Vec::new(), "{name}: {value}");
        }
        for miss in case["misfits"].as_array().into_iter().flatten() {
            let misfits = rule.check(&miss["value"], "output");
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
fn a_rule_that_misses_says_what_to_fix_in_words() {
    let rule = read(
        &json!({ "required": ["link"], "properties": { "link": { "pattern": "^https://" } } }),
        "rule",
    )
    .unwrap_or_else(|p| panic!("{p:?}"));
    let words: Vec<String> = rule
        .check(&json!({ "link": "http://x" }), "output")
        .iter()
        .map(ToString::to_string)
        .collect();
    assert_eq!(
        words,
        vec!["output.link: doesn't match ^https://".to_owned()]
    );
    let missing: Vec<String> = rule
        .check(&json!({}), "output")
        .iter()
        .map(ToString::to_string)
        .collect();
    assert_eq!(missing, vec!["output.link: is missing".to_owned()]);
}

#[test]
fn every_pattern_the_subset_takes_compiles_and_every_other_is_refused_before_compiling() {
    let taken = [
        "^https://",
        "^[A-Z]{3}-[A-Z]{3}$",
        "a|b|(c+d?)*",
        "[^a-z0-9\\-]",
        "x{2,}y{0,5}",
        "\\.\\$\\(\\)\\/",
    ];
    for pattern in taken {
        assert_eq!(pattern_problem(pattern), None, "{pattern}");
        assert!(Regex::new(&format!("(?s){pattern}")).is_ok(), "{pattern}");
    }
    let refused = [
        "\\d",
        "\\w+",
        "(?i)a",
        "[[:alpha:]]",
        "a]",
        "a}",
        "[]",
        "[^]",
        "a{",
        "[a~~b]",
        "\\",
    ];
    for pattern in refused {
        assert!(pattern_problem(pattern).is_some(), "{pattern}");
    }
}

// SPDX-License-Identifier: Apache-2.0

//! `vectors/text.json` holds what the TypeScript rules return (ADR 0206); the ports must agree.

#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

use history_text::{js, sanitize_typed_text, sanitize_user_text, session_title, summarize_output};
use serde_json::Value;

fn vectors() -> Value {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../vectors/text.json");
    serde_json::from_str(&std::fs::read_to_string(path).expect("vectors")).expect("json")
}

fn cases(name: &str) -> Vec<Value> {
    vectors()[name].as_array().expect("cases").clone()
}

#[test]
fn user_text_is_cleaned_as_the_typescript_cleans_it() {
    for case in cases("sanitize") {
        let input = case["input"].as_str().expect("input");
        assert_eq!(
            sanitize_user_text(input),
            case["user"].as_str().expect("user"),
            "user: {input:?}"
        );
        assert_eq!(
            sanitize_typed_text(input),
            case["typed"].as_str().expect("typed"),
            "typed: {input:?}"
        );
    }
}

#[test]
fn session_titles_match_the_typescript() {
    for case in cases("title") {
        let (preferred, prompt) = (
            case["preferred"].as_str().expect("p"),
            case["prompt"].as_str().expect("q"),
        );
        let at = case["at"].as_i64().expect("at");
        assert_eq!(
            session_title(preferred, prompt, at),
            case["output"].as_str().expect("out"),
            "{preferred:?} / {prompt:?}"
        );
    }
}

#[test]
fn output_summaries_match_the_projection() {
    for case in cases("output") {
        let text = case["text"].as_str().expect("text");
        let summary = summarize_output("item-1", text);
        let expected = &case["output"];
        assert_eq!(
            summary.stream_id,
            expected["streamId"].as_str().expect("id")
        );
        assert_eq!(
            summary.bytes as u64,
            expected["bytes"].as_u64().expect("bytes"),
            "{text:.20}"
        );
        assert_eq!(
            summary.tail,
            expected["tail"].as_str().expect("tail"),
            "{text:.20}"
        );
        assert_eq!(
            summary.truncated,
            expected["truncated"].as_bool().expect("t"),
            "{text:.20}"
        );
    }
}

#[test]
fn timestamps_parse_as_date_parse_does_for_iso_strings() {
    for case in cases("timestamp") {
        let Some(input) = case["input"].as_str() else {
            continue;
        };
        assert_eq!(
            js::parse_date(input).filter(|ms| *ms >= 0),
            case["output"].as_i64(),
            "{input:?}"
        );
    }
}

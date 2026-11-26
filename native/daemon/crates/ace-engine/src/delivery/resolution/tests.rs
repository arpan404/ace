// SPDX-License-Identifier: Apache-2.0
//! `validResolution`'s table, at the unit level: the approval and question shapes, the dismissal,
//! the option ids and free text, and the multi-select rules. `resolution.process.test.ts` proves
//! the same rules through a real answer.

use super::*;

fn value(text: &str) -> Value {
    ace_json::parse(text).expect("json")
}

fn question_request() -> Value {
    value(
        r#"{"kind":"question","questions":[
          {"id":"one","text":"Choose one","options":[{"id":"a"},{"id":"b"}],"multiSelect":false,"allowOther":false},
          {"id":"many","text":"Choose several","options":[{"id":"a"},{"id":"b"}],"multiSelect":true,"allowOther":true}
        ]}"#,
    )
}

fn question(answers: &str) -> Value {
    value(&format!(r#"{{"kind":"question","answers":{answers}}}"#))
}

#[test]
fn an_approval_answers_only_one_of_the_offered_options() {
    let request = value(r#"{"kind":"approval","options":[{"id":"allow"},{"id":"deny"}]}"#);
    assert!(valid_resolution(
        &request,
        &value(r#"{"kind":"approval","optionId":"allow"}"#)
    ));
    assert!(!valid_resolution(
        &request,
        &value(r#"{"kind":"approval","optionId":"maybe"}"#)
    ));
    assert!(!valid_resolution(
        &request,
        &value(r#"{"kind":"question","answers":{}}"#)
    ));
}

#[test]
fn a_question_answers_every_question_with_its_own_options_or_free_text() {
    let request = question_request();
    assert!(valid_resolution(
        &request,
        &question(r#"{"one":["a"],"many":["a","b"]}"#)
    ));
    // Every question, and no others.
    assert!(!valid_resolution(&request, &question(r#"{"one":["a"]}"#)));
    assert!(!valid_resolution(
        &request,
        &question(r#"{"one":["a"],"many":["a"],"extra":["a"]}"#)
    ));
    // A single-select takes exactly one; a multi-select takes several, each once.
    assert!(!valid_resolution(
        &request,
        &question(r#"{"one":["a","b"],"many":["a"]}"#)
    ));
    assert!(!valid_resolution(
        &request,
        &question(r#"{"one":["a"],"many":["a","a"]}"#)
    ));
    // An unknown option is refused; free text is allowed only where the request allows it.
    assert!(!valid_resolution(
        &request,
        &question(r#"{"one":["z"],"many":["a"]}"#)
    ));
    assert!(!valid_resolution(
        &request,
        &question(r#"{"one":["something else"],"many":["a"]}"#)
    ));
    // Where the request allows it, free text is an answer.
    assert!(valid_resolution(
        &request,
        &question(r#"{"one":["a"],"many":["a","something else"]}"#)
    ));
    // A dismissal answers nothing.
    assert!(valid_resolution(
        &request,
        &value(r#"{"kind":"question","answers":{},"dismissed":true}"#)
    ));
    assert!(!valid_resolution(
        &request,
        &value(r#"{"kind":"question","answers":{"one":["a"]},"dismissed":true}"#)
    ));
}

#[test]
fn a_duplicate_question_id_keeps_the_last_question_as_the_typescripts_map_does() {
    // `new Map(...)` keeps the last entry for a repeated id, and the answer count is compared
    // with the map's size: one question, answered once, whose options are the last one's.
    let request = value(
        r#"{"kind":"question","questions":[
          {"id":"one","text":"first","options":[{"id":"a"}],"multiSelect":false,"allowOther":false},
          {"id":"one","text":"second","options":[{"id":"b"}],"multiSelect":false,"allowOther":false}
        ]}"#,
    );
    assert!(valid_resolution(&request, &question(r#"{"one":["b"]}"#)));
    assert!(!valid_resolution(&request, &question(r#"{"one":["a"]}"#)));
    // Two answers for one map entry is one too many.
    assert!(!valid_resolution(
        &request,
        &question(r#"{"one":["b"],"two":["b"]}"#)
    ));
}

#[test]
fn a_kind_that_is_neither_approval_nor_question_passes_on_its_kind_alone() {
    let request = value(r#"{"kind":"notice"}"#);
    assert!(valid_resolution(&request, &value(r#"{"kind":"notice"}"#)));
    assert!(!valid_resolution(
        &request,
        &value(r#"{"kind":"approval"}"#)
    ));
}

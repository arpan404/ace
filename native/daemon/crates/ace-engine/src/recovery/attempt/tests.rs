// SPDX-License-Identifier: Apache-2.0
//! The attempt record and the unsettled fold, over adapter frames: what a send records, what
//! settles it, and which runs an open turn's frames leave open.
//!
//! Ported cases: `cursor-attempt-record.test.ts:71` ("whether Cursor had an attempted send is read
//! from its record, not by searching the thread's frames"), narrowed to the pure fold; the store
//! half of that case is `provider_recovery`'s test of the same name.

use super::*;

fn frame(kind: &str, body: &str, operation: &str, command: Option<&str>) -> Value {
    ace_json::parse(&format!(
        r#"{{"kind":"{kind}","operationId":"{operation}","segment":0{}{}}}"#,
        command.map_or(String::new(), |command| format!(
            r#","commandId":"{command}""#
        )),
        if body.is_empty() {
            String::new()
        } else {
            format!(r#","body":{body}"#)
        }
    ))
    .unwrap()
}

#[test]
fn a_send_starts_the_record_and_later_evidence_of_the_same_send_marks_it() {
    let send = note_attempt(
        None,
        &frame(
            "send",
            r#"{"attemptedAt":1,"runFramed":true}"#,
            "send-1",
            Some("send-1"),
        ),
    )
    .expect("a send starts the record");
    assert_eq!(send.command_id, "send-1");
    assert_eq!(send.operation_id, "send-1");
    assert!(!send.evidence);
    assert_eq!(send.admitted, None);
    // Output of the send's own operation is evidence Cursor had it.
    let output = note_attempt(
        Some(send.clone()),
        &frame(
            "delta",
            r#"{"type":"text-delta","text":"hello"}"#,
            "send-1",
            None,
        ),
    )
    .expect("the record stays");
    assert!(output.evidence);
    // Another operation's output says nothing of this send.
    let other = note_attempt(
        Some(send.clone()),
        &frame("delta", r#"{"type":"text-delta"}"#, "other", None),
    )
    .expect("the record stays");
    assert!(!other.evidence);
    assert_eq!(other, send);
    // Bookkeeping frames say nothing of whether Cursor had the send.
    for kind in ["run", "snapshot", "host-output", "error", "cancel"] {
        let kept = note_attempt(Some(send.clone()), &frame(kind, "{}", "send-1", None))
            .expect("the record stays");
        assert!(!kept.evidence, "{kind}");
    }
}

#[test]
fn an_admission_for_the_same_command_records_what_cursor_read_back() {
    let send = note_attempt(
        None,
        &frame("send", r#"{"attemptedAt":1}"#, "send-1", Some("send-1")),
    )
    .unwrap();
    let admitted = note_attempt(
        Some(send.clone()),
        &frame(
            "admission",
            r#"{"admitted":false,"commandId":"send-1"}"#,
            "open",
            Some("open"),
        ),
    )
    .unwrap();
    assert_eq!(admitted.admitted, Some(false));
    // An admission for another command leaves the record as it was.
    let other = note_attempt(
        Some(send.clone()),
        &frame(
            "admission",
            r#"{"admitted":true,"commandId":"send-2"}"#,
            "open",
            None,
        ),
    )
    .unwrap();
    assert_eq!(other, send);
}

#[test]
fn the_unsettled_fold_names_the_attempted_send_and_the_run_it_started() {
    let mut runs = UnsettledRuns::new();
    runs.add(&frame(
        "send",
        r#"{"attemptedAt":1,"runFramed":true}"#,
        "send-1",
        Some("send-1"),
    ));
    let unsettled = runs.result();
    assert_eq!(
        unsettled.attempt.as_ref().map(|attempt| attempt.at),
        Some(1)
    );
    assert_eq!(
        unsettled
            .attempt
            .as_ref()
            .and_then(|attempt| attempt.run_id.clone()),
        None
    );
    // The run the SDK was about to create for the attempt names what Cursor may have.
    runs.add(&frame("run", r#"{"nativeRunId":"run-1"}"#, "send-1", None));
    assert_eq!(
        runs.result()
            .attempt
            .and_then(|attempt| attempt.run_id)
            .as_deref(),
        Some("run-1")
    );
    // Output of the attempt names its run: Cursor had it.
    runs.add(
        &ace_json::parse(
            r#"{"kind":"delta","operationId":"send-1","segment":0,"runId":"run-1","body":{"type":"text-delta"}}"#,
        )
        .unwrap(),
    );
    let unsettled = runs.result();
    assert!(unsettled.attempt.is_none());
    assert_eq!(unsettled.runs.len(), 1);
    assert_eq!(unsettled.runs[0].run_id, "run-1");
    assert!(unsettled.runs[0].legacy);
    // A result ends that run.
    runs.add(&frame("result", "{}", "send-1", None));
    assert!(runs.result().runs.is_empty());
}

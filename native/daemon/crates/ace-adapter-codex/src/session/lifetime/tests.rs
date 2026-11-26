// SPDX-License-Identifier: Apache-2.0
//! The moved (b) cases of `session-lifetime.test.ts` (behaviour.md section 19),
//! plus the evidence the exit diagnostic and the stderr tail carry.

use super::*;
use crate::session::frames::Frames;
use crate::session::host::{ExitReason, HostExit};

fn unredacted() -> Redactor {
    Box::new(|line: &str| line.to_owned())
}

/// A busy session alone on a shared host whose stop does not confirm.
fn busy_alone() -> Lifetime {
    let mut lifetime = Lifetime::new("g1".to_owned(), unredacted(), None);
    lifetime.attached(true, true);
    lifetime
}

fn note(effect: &Effect) -> Option<Value> {
    let Effect::Frame { dir, text, .. } = effect else {
        return None;
    };
    assert_eq!(*dir, FrameDir::Note);
    ace_json::parse(text).ok()
}

fn notes(effects: &[Effect]) -> Vec<Value> {
    effects.iter().filter_map(note).collect()
}

/// Native only (behaviour.md section 20): TypeScript cleans the session up
/// before the retire is confirmed, so a failed retire leaves it empty. Rust
/// cleans up only after confirmation, so a failed retirement leaves the
/// tenant's pending calls and frames intact and the close rejects.
#[test]
fn a_retirement_that_fails_leaves_the_tenants_pending_calls_intact() {
    let mut lifetime = busy_alone();
    let started = lifetime.close(Retirement::User, true);
    assert_eq!(
        started,
        vec![Effect::Retire {
            reason: Retirement::User
        }]
    );
    let settled = lifetime.retired(
        &Frames::new(None),
        Err("Windows process tree survived its stop".to_owned()),
    );
    assert!(!settled.contains(&Effect::Cleanup));
    assert_eq!(
        settled,
        vec![Effect::Closed(Err(
            "Windows process tree survived its stop".to_owned()
        ))]
    );
}

#[test]
fn a_cancelled_session_whose_stop_fails_records_it_and_a_later_close_still_sees_the_failure() {
    let mut lifetime = busy_alone();
    let started = lifetime.abort(&Frames::new(None), "cancelled".to_owned(), true);
    assert_eq!(
        started,
        vec![Effect::Retire {
            reason: Retirement::Aborted
        }]
    );
    let settled = lifetime.retired(
        &Frames::new(None),
        Err("Windows process tree survived its stop".to_owned()),
    );
    assert_eq!(
        settled[0],
        Effect::Closed(Err("Windows process tree survived its stop".to_owned()))
    );
    let recorded = &notes(&settled)[0];
    assert_eq!(
        recorded.get("event").and_then(Value::as_str),
        Some("codex-stop-failed")
    );
    assert_eq!(
        recorded.get("retirement").and_then(Value::as_str),
        Some("aborted")
    );
    let later = lifetime.close(Retirement::User, true);
    assert_eq!(
        later,
        vec![Effect::Closed(Err(
            "Windows process tree survived its stop".to_owned()
        ))]
    );
}

#[test]
fn a_transport_failure_whose_stop_fails_records_it_on_the_session() {
    let mut lifetime = busy_alone();
    let started = lifetime.fail_transport(&Frames::new(None), true);
    assert_eq!(
        started,
        vec![Effect::Retire {
            reason: Retirement::RpcFailed
        }]
    );
    let settled = lifetime.retired(
        &Frames::new(None),
        Err("Windows process tree survived its stop".to_owned()),
    );
    assert_eq!(
        notes(&settled)[0].get("retirement").and_then(Value::as_str),
        Some("rpc_failed")
    );
}

#[test]
fn a_shared_host_with_other_tenants_stops_this_trees_work_before_it_detaches() {
    let mut lifetime = Lifetime::new("g1".to_owned(), unredacted(), None);
    lifetime.attached(true, false);
    let started = lifetime.close(Retirement::User, true);
    assert_eq!(
        started,
        vec![Effect::StopWork {
            reason: Retirement::User
        }]
    );
    let detached = lifetime.work_stopped(Ok(()));
    assert_eq!(
        detached,
        vec![Effect::Detach {
            reason: Retirement::User,
            message: "Codex session closed (user)".to_owned()
        }]
    );
    // The cleanup follows the detach's confirmation, never precedes it.
    let settled = lifetime.detached(&Frames::new(None), Ok(()));
    assert_eq!(settled, vec![Effect::Cleanup, Effect::Closed(Ok(()))]);
}

#[test]
fn work_that_cannot_be_confirmed_retires_the_host_instead() {
    let mut lifetime = Lifetime::new("g1".to_owned(), unredacted(), None);
    lifetime.attached(true, false);
    lifetime.close(Retirement::User, true);
    let retired = lifetime.work_stopped(Err("interrupt timed out".to_owned()));
    assert_eq!(
        retired[0],
        Effect::Retire {
            reason: Retirement::User
        }
    );
    let settled = lifetime.retired(&Frames::new(None), Ok(()));
    assert_eq!(settled, vec![Effect::Cleanup, Effect::Closed(Ok(()))]);
}

#[test]
fn a_private_sessions_close_detaches_before_its_cleanup() {
    let mut lifetime = Lifetime::new("g1".to_owned(), unredacted(), None);
    lifetime.attached(false, false);
    assert_eq!(
        lifetime.close(Retirement::Shutdown, false),
        vec![Effect::Detach {
            reason: Retirement::Shutdown,
            message: "Codex session closed (shutdown)".to_owned()
        }]
    );
    assert_eq!(
        lifetime.detached(&Frames::new(None), Ok(())),
        vec![Effect::Cleanup, Effect::Closed(Ok(()))]
    );
}

#[test]
fn a_session_retired_up_front_closes_at_once_after_its_cleanup() {
    let mut lifetime = busy_alone();
    lifetime.close(Retirement::User, true);
    lifetime.retired(&Frames::new(None), Ok(()));
    // A stop after the process died only finishes cleanup, which the close
    // already released: the exit evidence is the next thing emitted.
    let exit = lifetime.exited(&Frames::new(None), &host_exit(ExitReason::Exit));
    assert!(!exit.contains(&Effect::Cleanup));
    let diagnostic = notes(&exit)[0].clone();
    assert_eq!(
        diagnostic.get("deliberate").and_then(Value::as_bool),
        Some(true)
    );
    assert_eq!(
        diagnostic.get("retirement").and_then(Value::as_str),
        Some("user")
    );
    assert_eq!(
        exit.last(),
        Some(&Effect::Exited {
            deliberate: true,
            message: format!(
                "Codex app-server retired (user): {}",
                ace_json::to_string(&diagnostic)
            ),
        })
    );
}

#[test]
fn a_process_that_died_on_its_own_is_not_reported_as_deliberate() {
    let mut lifetime = Lifetime::new("g1".to_owned(), unredacted(), None);
    lifetime.attached(false, false);
    let exit = lifetime.exited(&Frames::new(None), &host_exit(ExitReason::Signal));
    let diagnostic = notes(&exit)[0].clone();
    assert_eq!(
        diagnostic.get("deliberate").and_then(Value::as_bool),
        Some(false)
    );
    assert_eq!(diagnostic.get("retirement"), Some(&Value::Null));
    assert_eq!(
        diagnostic.get("reason").and_then(Value::as_str),
        Some("signal")
    );
    assert!(matches!(
        exit.last(),
        Some(Effect::Exited {
            deliberate: false,
            ..
        })
    ));
}

#[test]
fn the_stderr_tail_keeps_the_last_4096_bytes_and_its_last_1024_characters() {
    let mut lifetime = Lifetime::new("g1".to_owned(), unredacted(), None);
    for index in 0..200 {
        lifetime.stderr_line(&Frames::new(None), &format!("line {index}"));
    }
    assert!(lifetime.stderr_tail().len() <= STDERR_BYTES);
    assert!(lifetime.stderr_tail().ends_with("line 199\n"));
    let exit = lifetime.exited(&Frames::new(None), &host_exit(ExitReason::Exit));
    let diagnostic = notes(&exit)[0].clone();
    let tail = diagnostic
        .get("stderr")
        .and_then(Value::as_str)
        .expect("kept");
    let summary = diagnostic
        .get("stderrSummary")
        .and_then(Value::as_str)
        .expect("summarised");
    assert!(summary.chars().count() <= STDERR_SUMMARY);
    assert!(tail.ends_with(summary));
}

#[test]
fn the_bearer_never_reaches_the_tail_the_note_or_the_exit_message() {
    let bearer = "a".repeat(64);
    // A redactor that knows nothing of the bearer, as a generic one may not.
    let mut lifetime = Lifetime::new("g1".to_owned(), unredacted(), Some(bearer.clone()));
    lifetime.attached(false, false);
    lifetime.stderr_line(
        &Frames::new(Some(bearer.clone())),
        &format!("bearer {bearer}"),
    );
    assert!(!lifetime.stderr_tail().contains(&bearer));
    let exit = lifetime.exited(
        &Frames::new(Some(bearer.clone())),
        &HostExit {
            reason: ExitReason::Exit,
            code: Some(0),
            signal: None,
            pid: Some(42),
            output_drained: true,
        },
    );
    let diagnostic = notes(&exit)[0].clone();
    assert!(!ace_json::to_string(&diagnostic).contains(&bearer));
    let Some(Effect::Exited { message, .. }) = exit.last() else {
        panic!("the exit is reported");
    };
    assert!(!message.contains(&bearer), "{message}");
}

#[test]
fn a_line_is_scrubbed_before_it_is_retained_or_emitted() {
    let mut lifetime = Lifetime::new(
        "g1".to_owned(),
        Box::new(|line: &str| line.replace("secret-token", "<CREDENTIAL>")),
        None,
    );
    let effects = lifetime.stderr_line(&Frames::new(None), "bearer secret-token");
    assert!(!lifetime.stderr_tail().contains("secret-token"));
    assert_eq!(lifetime.stderr_tail(), "bearer <CREDENTIAL>\n");
    let Effect::Frame { dir, text, .. } = &effects[0] else {
        panic!("a stderr line is a frame");
    };
    assert_eq!(*dir, FrameDir::Stderr);
    assert_eq!(text, "\"bearer <CREDENTIAL>\"");
}

fn host_exit(reason: ExitReason) -> HostExit {
    HostExit {
        reason,
        code: Some(0),
        signal: None,
        pid: Some(42),
        output_drained: true,
    }
}

#[test]
fn the_exit_note_keeps_a_split_low_surrogate_in_the_stderr_summary() {
    let mut lifetime = Lifetime::new("g1".to_owned(), unredacted(), None);
    let frames = Frames::new(None);
    lifetime.stderr_line(&frames, &format!("😀{}", "x".repeat(STDERR_SUMMARY - 2)));
    let effects = lifetime.exited(&frames, &host_exit(ExitReason::Exit));
    let notes = notes(&effects);
    let summary = notes[0]
        .get("stderrSummary")
        .and_then(Value::as_js_str)
        .expect("summary");
    assert_eq!(summary.len_utf16(), STDERR_SUMMARY);
    assert_eq!(summary.units().next(), Some(0xde00));
}

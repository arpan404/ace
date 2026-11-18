//! A bot run that can't be contained must not be launched plainly (ADR 0167 Windows hardening,
//! review round 3 item 1). `Confine::confine` returns `NeedsReview` for such a run, and every
//! caller refuses it unless the call was reviewed or approved to run outside. These tests drive
//! the shell and plugin-hook path (`run_job`) with a stub that always needs review.

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use spade_server::workspace::shell::{Confine, Confinement, Job, Kind, Launch, Shell};

/// A sandbox that can never contain a run — it always needs review.
struct AlwaysNeedsReview;

impl Confine for AlwaysNeedsReview {
    fn confine(&self, _home: &Path, _kind: &Kind) -> Result<Confinement, String> {
        Ok(Confinement::NeedsReview("needs your folders".to_owned()))
    }
    fn contains(&self, _home: &Path) -> bool {
        false
    }
}

fn job<'a>(dir: &'a Path, script: &'a str, may_run_uncontained: bool) -> Job<'a> {
    Job {
        dir,
        script,
        timeout: Duration::from_secs(10),
        env: &[],
        tee: None,
        cleanup: None,
        stdin: None,
        kind: Kind::Command,
        outside: false,
        may_run_uncontained,
        clean: false,
    }
}

#[tokio::test]
async fn a_run_that_needs_review_is_refused_when_the_gate_expected_containment() {
    let dir = tempfile::tempdir().unwrap_or_else(|_| std::process::abort());
    let shell = Shell::system().confined(Arc::new(AlwaysNeedsReview));

    // The gate skipped review expecting containment (may_run_uncontained == false): refuse, and
    // prove the command did not run by having it write a file that must not appear.
    let marker = dir.path().join("ran.txt");
    let script = format!("echo x > {}", marker.display());
    let refused = shell.run_job(job(dir.path(), &script, false)).await;
    assert!(
        refused.is_err(),
        "a needs-review run must be refused: {refused:?}"
    );
    assert!(!marker.exists(), "the refused command must not have run");
}

#[tokio::test]
async fn a_reviewed_run_that_needs_review_runs_plainly() {
    let dir = tempfile::tempdir().unwrap_or_else(|_| std::process::abort());
    let shell = Shell::system().confined(Arc::new(AlwaysNeedsReview));

    // The call was reviewed or approved to run outside (may_run_uncontained == true): it runs
    // plainly, its exit code observed.
    let ran = shell
        .run_job(job(dir.path(), "exit 7", true))
        .await
        .unwrap_or_else(|e| panic!("a reviewed run should execute: {e}"));
    assert_eq!(ran.code, Some(7));
}

#[test]
fn a_command_cleared_as_contained_never_launches_plainly_whatever_changed_since() {
    // Cleared as contained and still held: launches contained, and a run that turns out to need
    // review is refused rather than run plainly.
    let held = Launch::Contained
        .plan(true)
        .unwrap_or_else(|e| panic!("{e}"));
    assert!(held.sandboxed && !held.may_run_uncontained && !held.outside);
    // Cleared as contained but no longer held: refused before anything starts.
    assert!(Launch::Contained.plan(false).is_err());
    // Reviewed without relying on the sandbox: contained when held, plainly when not.
    let reviewed_held = Launch::Reviewed
        .plan(true)
        .unwrap_or_else(|e| panic!("{e}"));
    assert!(reviewed_held.sandboxed && reviewed_held.may_run_uncontained);
    let reviewed_plain = Launch::Reviewed
        .plan(false)
        .unwrap_or_else(|e| panic!("{e}"));
    assert!(!reviewed_plain.sandboxed && reviewed_plain.may_run_uncontained);
    // Sent outside by the gate: outside, whether or not the sandbox would hold it.
    for holds in [true, false] {
        let outside = Launch::Outside
            .plan(holds)
            .unwrap_or_else(|e| panic!("{e}"));
        assert!(outside.outside && !outside.sandboxed && outside.may_run_uncontained);
    }
}

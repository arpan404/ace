//! A bot run that can't be contained must not be launched plainly (ADR 0167 Windows hardening,
//! review round 3 item 1). `Confine::confine` returns `NeedsReview` for such a run, and every
//! caller refuses it unless the call was reviewed or approved to run outside. These tests drive
//! the shell and plugin-hook path (`run_job`) with a stub that always needs review.

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use spade_core::event::Authorized;
use spade_server::workspace::outside::{Bound, Warrant};
use spade_server::workspace::shell::{By, Confine, Confinement, Job, Kind, Launch, Shell};

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
    // Reviewed: the verdict's warrant, for a launch as the sandbox finds it.
    let warrant = Warrant {
        limit: Authorized::AsFound,
        bound: Bound::Nothing,
    };
    job_by(
        dir,
        script,
        may_run_uncontained,
        false,
        By::Bot(Some(warrant)),
    )
}

fn job_by<'a>(
    dir: &'a Path,
    script: &'a str,
    may_run_uncontained: bool,
    outside: bool,
    by: By,
) -> Job<'a> {
    Job {
        dir,
        script,
        asked: None,
        timeout: Duration::from_secs(10),
        env: &[],
        tee: None,
        cleanup: None,
        stdin: None,
        kind: Kind::Command,
        outside,
        may_run_uncontained,
        contained_only: false,
        by,
        clean: false,
        read_only: false,
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

/// Every way a bot's command can start with nothing holding it: no sandbox on the machine, one
/// that can't contain this run after a review, and one the gate sent outside.
fn plain_starts() -> Vec<(&'static str, Shell, bool)> {
    vec![
        ("no sandbox here", Shell::system(), false),
        (
            "the sandbox can't hold it",
            Shell::system().confined(Arc::new(AlwaysNeedsReview)),
            false,
        ),
        (
            "sent outside",
            Shell::system().confined(Arc::new(AlwaysNeedsReview)),
            true,
        ),
    ]
}

#[tokio::test]
async fn a_bot_command_nothing_holds_never_starts_without_its_verdicts_warrant() {
    for (how, shell, outside) in plain_starts() {
        let dir = tempfile::tempdir().unwrap_or_else(|_| std::process::abort());
        let marker = dir.path().join("ran.txt");
        let script = format!("echo x > {}", marker.display());
        let refused = shell
            .run_job(job_by(dir.path(), &script, true, outside, By::Bot(None)))
            .await;
        let said = refused.err().unwrap_or_default();
        assert!(said.contains("Nothing allowed"), "{how}: {said}");
        assert!(!marker.exists(), "{how}: it ran");
        // A warrant for a narrower launch than this one doesn't let it start either.
        let narrow = Warrant {
            limit: Authorized::Contained,
            bound: Bound::Nothing,
        };
        let refused = shell
            .run_job(job_by(
                dir.path(),
                &script,
                true,
                outside,
                By::Bot(Some(narrow)),
            ))
            .await;
        assert!(refused.is_err(), "{how}");
        assert!(!marker.exists(), "{how}: it ran on a narrower warrant");
        // With the warrant of a verdict for this launch, it starts.
        let warrant = Warrant {
            limit: Authorized::Outside,
            bound: Bound::Nothing,
        };
        let ran = shell
            .run_job(job_by(
                dir.path(),
                &script,
                true,
                outside,
                By::Bot(Some(warrant)),
            ))
            .await;
        assert!(ran.is_ok_and(|r| r.code == Some(0)), "{how}");
        assert!(marker.exists(), "{how}: it didn't run on its warrant");
    }
}

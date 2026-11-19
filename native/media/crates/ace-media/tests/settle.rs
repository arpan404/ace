// SPDX-License-Identifier: Apache-2.0
//! The tests' wait for the probe's final answer is bounded: a trial or a child that never
//! reports fails the wait, naming what's missing, instead of blocking the run.
#![cfg(target_os = "macos")]
mod support;

use ace_media::probe::{Cancel, Trial, probe};
use media_wire::control::{Backend, Capability, Step, TrialState};
use std::time::{Duration, Instant};
use support::Media;
use support::probed::settle;

/// Never publishes, and only returns once stopped.
struct Hung;

impl Trial for Hung {
    fn steps(&self) -> Vec<(Step, Option<String>, Backend)> {
        vec![(Step::Decode, Some("hvc1".into()), Backend::Vt)]
    }
    fn run(self: Box<Self>, _publish: &mut dyn FnMut(Vec<Capability>), stop: &dyn Fn() -> bool) {
        while !stop() {
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}

#[test]
fn a_trial_that_never_finishes_fails_the_wait_with_what_is_missing() {
    let cancel = Cancel::default();
    let (capabilities, late) = probe(vec![Box::new(Hung)], Duration::from_millis(20), &cancel);
    let started = Instant::now();
    let settled = settle(capabilities, &late, Duration::from_millis(300));
    cancel.cancel();
    assert!(started.elapsed() < Duration::from_secs(2));
    let Err(missing) = settled else {
        panic!("a hung trial settled");
    };
    assert!(
        missing.contains("decode") && missing.contains("timed-out"),
        "{missing}"
    );
}

#[test]
fn a_child_that_never_reports_an_expected_step_fails_the_wait_with_it() {
    let mut media = Media::spawn("settle-missing");
    media.start();
    // A step this child never finds: no VA-API on a Mac.
    let expected = [Capability {
        step: Step::Encode,
        codec: Some("avc1.640028".into()),
        backend: Backend::Vaapi,
        hardware: true,
        zero_copy: true,
        state: TrialState::Ok,
        max_width: 4096,
        max_height: 2304,
    }];
    let started = Instant::now();
    let settled = media.try_settle_probe(&expected, Duration::from_millis(500));
    assert!(started.elapsed() < Duration::from_secs(5));
    let Err(missing) = settled else {
        panic!("the child settled on a step it doesn't have");
    };
    assert!(missing.contains("\"vaapi\""), "{missing}");
}

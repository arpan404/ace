// SPDX-License-Identifier: Apache-2.0
#![cfg(target_os = "macos")]
use media_vt::{ProbeCancel, ProbeOptions, TrialInput, probe};
use media_wire::capability::{Backend, Capability, Step, TrialState};
use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

/// Probes share one worker per process, so these tests take turns.
static TURN: Mutex<()> = Mutex::new(());
fn turn() -> MutexGuard<'static, ()> {
    TURN.lock().unwrap_or_else(PoisonError::into_inner)
}

fn find<'a>(caps: &'a [Capability], step: Step, codec: &str) -> Option<&'a Capability> {
    caps.iter()
        .find(|c| c.step == step && c.codec.as_deref().unwrap_or("").starts_with(codec))
}

#[test]
fn the_probe_lists_every_step_within_its_deadline() {
    let _turn = turn();
    let started = Instant::now();
    let report = probe(&ProbeOptions::default());
    assert!(
        started.elapsed() < Duration::from_millis(2_200),
        "took {:?}",
        started.elapsed()
    );
    assert_eq!(report.capabilities.len(), 7);
    assert!(report.capabilities.iter().all(|c| c.backend == Backend::Vt));
}

#[cfg(target_arch = "aarch64")]
#[test]
fn apple_silicon_reports_hardware_zero_copy_encode_and_decode() {
    let _turn = turn();
    let caps = probe(&ProbeOptions {
        deadline: Duration::from_secs(10),
        ..ProbeOptions::default()
    })
    .capabilities;
    for step in [Step::Encode, Step::Decode] {
        for codec in ["avc1.", "hvc1."] {
            let found = find(&caps, step, codec);
            let Some(cap) = found else {
                panic!("no {step:?} {codec} in {caps:?}");
            };
            assert_eq!(cap.state, TrialState::Ok, "{cap:?}");
            assert!(cap.hardware && cap.zero_copy, "{cap:?}");
            assert!(cap.max_width >= 3840 && cap.max_height >= 2160, "{cap:?}");
        }
    }
}

#[test]
fn forcing_a_cpu_copy_reports_encode_as_not_zero_copy() {
    let _turn = turn();
    let caps = probe(&ProbeOptions {
        deadline: Duration::from_secs(10),
        input: TrialInput::Cpu,
        ..ProbeOptions::default()
    })
    .capabilities;
    for codec in ["avc1", "hvc1"] {
        let Some(cap) = find(&caps, Step::Encode, codec) else {
            panic!("no encode {codec} in {caps:?}");
        };
        assert!(!cap.zero_copy, "{cap:?}");
    }
}

#[test]
fn jpeg_and_scale_steps_report_what_their_sessions_say() {
    let _turn = turn();
    let caps = probe(&ProbeOptions {
        deadline: Duration::from_secs(10),
        ..ProbeOptions::default()
    })
    .capabilities;
    for step in [Step::JpegEncode, Step::JpegDecode] {
        let Some(cap) = find(&caps, step, "jpeg") else {
            panic!("no {step:?} in {caps:?}");
        };
        assert_eq!(cap.state, TrialState::Ok, "{cap:?}");
        assert_eq!(
            cap.zero_copy, cap.hardware,
            "the CPU fallback costs a copy: {cap:?}"
        );
    }
    let Some(scale) = caps.iter().find(|c| c.step == Step::Scale) else {
        panic!("no scale in {caps:?}");
    };
    assert_eq!(
        (scale.state, scale.hardware, scale.codec.as_deref()),
        (TrialState::Ok, false, None)
    );
}

#[test]
fn a_cancelled_probe_returns_at_once_and_starts_nothing() {
    let _turn = turn();
    let cancel = ProbeCancel::default();
    cancel.cancel();
    let started = Instant::now();
    let report = probe(&ProbeOptions {
        cancel,
        ..ProbeOptions::default()
    });
    assert!(started.elapsed() < Duration::from_millis(50));
    assert!(
        report
            .capabilities
            .iter()
            .all(|c| c.state == TrialState::TimedOut && !c.hardware)
    );
    assert!(
        report
            .late
            .recv_timeout(Duration::from_millis(500))
            .is_err(),
        "nothing runs, nothing arrives"
    );
}

#[test]
fn past_its_deadline_the_worker_stops_starting_trials() {
    let _turn = turn();
    // Let any earlier worker finish so this probe starts its own.
    std::thread::sleep(Duration::from_millis(500));
    let report = probe(&ProbeOptions {
        deadline: Duration::from_millis(5),
        ..ProbeOptions::default()
    });
    let on_time = report
        .capabilities
        .iter()
        .filter(|c| c.state == TrialState::Ok)
        .count();
    let started = Instant::now();
    let mut late = 0;
    // The channel closes when the worker stops; only the trial already
    // inside VideoToolbox may still report.
    while let Ok(capability) = report.late.recv_timeout(Duration::from_secs(5)) {
        assert_eq!(capability.state, TrialState::Ok);
        late += 1;
    }
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "the worker stopped"
    );
    assert!(
        on_time + late < 7,
        "{on_time} on time, {late} late: the worker kept going"
    );
}

#[test]
fn concurrent_probes_share_one_worker_and_each_get_every_step() {
    let _turn = turn();
    let options = ProbeOptions {
        deadline: Duration::from_secs(10),
        ..ProbeOptions::default()
    };
    let other = options.clone();
    let joined = std::thread::spawn(move || probe(&other).capabilities);
    let mine = probe(&options).capabilities;
    let theirs = joined.join().unwrap_or_default();
    assert_eq!(mine, theirs);
    assert!(mine.iter().all(|c| c.state == TrialState::Ok), "{mine:?}");
}

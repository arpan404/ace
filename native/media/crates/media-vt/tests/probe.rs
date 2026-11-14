// SPDX-License-Identifier: Apache-2.0
#![cfg(target_os = "macos")]
use media_vt::{ProbeCancel, ProbeOptions, TrialInput, probe};
use media_wire::capability::{Backend, Capability, Step, TrialState};
use std::time::{Duration, Instant};

fn find<'a>(caps: &'a [Capability], step: Step, codec: &str) -> Option<&'a Capability> {
    caps.iter()
        .find(|c| c.step == step && c.codec.as_deref().unwrap_or("").starts_with(codec))
}

#[test]
fn the_probe_lists_every_step_within_its_deadline() {
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
fn a_cancelled_probe_returns_at_once_and_reports_timed_out_steps() {
    let cancel = ProbeCancel::default();
    cancel.cancel();
    let started = Instant::now();
    let report = probe(&ProbeOptions {
        cancel,
        ..ProbeOptions::default()
    });
    assert!(started.elapsed() < Duration::from_millis(200));
    assert!(
        report
            .capabilities
            .iter()
            .all(|c| c.state == TrialState::TimedOut && !c.hardware)
    );
}

#[test]
fn a_trial_past_its_deadline_is_timed_out_and_arrives_late() {
    let report = probe(&ProbeOptions {
        deadline: Duration::ZERO,
        ..ProbeOptions::default()
    });
    assert!(
        report
            .capabilities
            .iter()
            .all(|c| c.state == TrialState::TimedOut)
    );
    let late = report.late.recv_timeout(Duration::from_secs(10));
    assert!(late.is_ok_and(|c| c.step == Step::Encode && c.state == TrialState::Ok));
}

// SPDX-License-Identifier: Apache-2.0
use crate::enc_abi::CODEC_H264;
use crate::fake::{self, dec, enc};
use crate::load::NvRuntime;
use crate::probe::{NvProbe, ProbeEntry, ProbeOutcome, ProbeStep, probe_gated, probe_with};
use media_codec::{Codec, Size};
use std::cell::Cell;

fn outcome(probe: &NvProbe, step: ProbeStep, codec: Codec) -> ProbeOutcome {
    let NvProbe::Present(entries) = probe else {
        panic!("expected a present backend");
    };
    entries
        .iter()
        .find(|e: &&ProbeEntry| e.step == step && e.codec == codec)
        .map(|e| e.outcome.clone())
        .unwrap()
}

#[test]
fn a_machine_without_the_driver_has_no_backend_and_no_crash() {
    let runtime = NvRuntime {
        missing: vec!["libnvidia-encode.so.1 not loadable".into()],
        ..NvRuntime::default()
    };
    assert_eq!(
        probe_with(&runtime, &|| false),
        NvProbe::Absent(vec!["libnvidia-encode.so.1 not loadable".into()])
    );
}

#[test]
fn a_working_gpu_encodes_one_picture_and_decodes_it_at_a_smaller_size() {
    let runtime = fake::runtime();
    let probe = probe_with(&runtime, &|| false);
    for codec in [Codec::H264, Codec::Hevc] {
        assert_eq!(
            outcome(&probe, ProbeStep::Encode, codec),
            ProbeOutcome::Ok {
                max: Size {
                    width: 4096,
                    height: 4096
                }
            }
        );
        assert!(matches!(
            outcome(&probe, ProbeStep::Decode, codec),
            ProbeOutcome::Ok { .. }
        ));
    }
    let targets: Vec<_> = dec(|d| d.created.iter().map(|c| c.target).collect());
    assert_eq!(targets, [(160, 120), (160, 120)]);
    assert_eq!(enc(|e| e.live.sessions), 0, "trial sessions are closed");
    assert_eq!(dec(|d| d.contexts), 0, "trial contexts are destroyed");
}

#[test]
fn a_gpu_without_hevc_encode_lists_h264_only() {
    let runtime = fake::runtime();
    enc(|e| e.guids = vec![CODEC_H264]);
    let probe = probe_with(&runtime, &|| false);
    assert!(matches!(
        outcome(&probe, ProbeStep::Encode, Codec::H264),
        ProbeOutcome::Ok { .. }
    ));
    assert!(matches!(
        outcome(&probe, ProbeStep::Encode, Codec::Hevc),
        ProbeOutcome::Failed(_)
    ));
    assert!(matches!(
        outcome(&probe, ProbeStep::Decode, Codec::Hevc),
        ProbeOutcome::Failed(_)
    ));
}

#[test]
fn a_trial_stopped_by_its_deadline_is_cancelled_and_leaves_nothing_open() {
    let runtime = fake::runtime();
    // Stop after the first session is configured, mid-trial.
    let checks = Cell::new(0);
    let stop = || {
        checks.set(checks.get() + 1);
        checks.get() > 2
    };
    let probe = probe_with(&runtime, &stop);
    let NvProbe::Present(entries) = &probe else {
        panic!("expected a present backend");
    };
    assert!(entries.iter().all(|e| e.outcome == ProbeOutcome::Cancelled));
    assert_eq!(enc(|e| e.live.sessions), 0);
    assert_eq!(dec(|d| d.contexts), 0);
    assert!(enc(|e| e.calls.contains(&"open")), "it had started");
}

#[test]
fn without_the_opt_in_the_probe_reports_unverified_layout_and_never_opens_the_driver() {
    // The fake loader stands for dlopen: had it run, the working fake driver would make the
    // probe report a present backend with encode and decode entries.
    let opened = Cell::new(false);
    let probe = probe_gated(
        false,
        || {
            opened.set(true);
            fake::runtime()
        },
        &|| false,
    );
    assert_eq!(probe, NvProbe::Unavailable("unverified layout".into()));
    assert!(!opened.get());
}

#[test]
fn with_the_opt_in_the_probe_opens_the_driver_and_runs_the_trial() {
    let probe = probe_gated(true, fake::runtime, &|| false);
    assert!(matches!(
        outcome(&probe, ProbeStep::Encode, Codec::H264),
        ProbeOutcome::Ok { .. }
    ));
}

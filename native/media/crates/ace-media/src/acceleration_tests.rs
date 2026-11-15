// SPDX-License-Identifier: Apache-2.0
use super::*;
use crate::encode::select::{encoder_for, jpeg_decode_hardware};
use media_codec::Codec;

fn entry(step: Step, codec: Option<&str>, backend: Backend, hardware: bool) -> Capability {
    Capability {
        step,
        codec: codec.map(Into::into),
        backend,
        hardware,
        zero_copy: hardware,
        state: TrialState::Ok,
        max_width: 4096,
        max_height: 4096,
    }
}

fn failed(mut capability: Capability, state: TrialState) -> Capability {
    capability.state = state;
    capability.hardware = false;
    capability.zero_copy = false;
    capability
}

/// What a machine with `backend` working finds, plus the CPU path and the last-resort encoder.
fn machine(backend: Option<Backend>) -> Vec<Capability> {
    let mut found = vec![
        entry(Step::JpegDecode, Some("jpeg"), Backend::Cpu, false),
        entry(Step::JpegEncode, Some("jpeg"), Backend::Cpu, false),
        entry(Step::Scale, None, Backend::Cpu, false),
    ];
    if let Some(backend) = backend {
        found.push(entry(Step::Encode, Some("avc1.640028"), backend, true));
        found.push(entry(Step::Decode, Some("avc1.640028"), backend, true));
        // NVIDIA's JPEG is never used: media-nv lists no JPEG step.
        if backend != Backend::Nv {
            found.push(entry(Step::JpegDecode, Some("jpeg"), backend, true));
        }
    } else {
        found.push(entry(
            Step::Encode,
            Some("avc1.42E01F"),
            Backend::Chrome,
            false,
        ));
    }
    found
}

/// The steps a "Use my Chrome" source runs on `probed`, as the JPEG encoder chooses them
/// (`encode::select`): JPEG decode, then the H.264 encode.
fn picture_steps(probed: &[Capability]) -> Vec<SourceStep> {
    let Some((encoder, hardware)) = encoder_for(probed, Codec::H264) else {
        return Vec::new();
    };
    let decode_hardware = jpeg_decode_hardware(probed, encoder);
    let step = |step, backend, hardware, uploads| SourceStep {
        step,
        backend,
        hardware,
        readbacks: 0,
        uploads,
    };
    vec![
        if decode_hardware {
            step(Step::JpegDecode, encoder, true, 0)
        } else {
            step(Step::JpegDecode, Backend::Cpu, false, u32::from(hardware))
        },
        step(Step::Encode, encoder, hardware, 0),
    ]
}

#[test]
fn each_backend_absent_in_turn_takes_the_cpu_and_last_resort_steps() {
    for backend in [Backend::Vt, Backend::Mf, Backend::Vaapi, Backend::Nv] {
        let present = machine(Some(backend));
        let steps = picture_steps(&present);
        let report = assess(&present, steps);
        let encode = report.steps.iter().find(|s| s.step == Step::Encode);
        assert_eq!(
            encode.map(|s| (s.backend, s.hardware)),
            Some((backend, true))
        );
        assert!(!report.degraded, "{backend:?} present: {report:?}");

        let absent = machine(None);
        let report = assess(&absent, picture_steps(&absent));
        let backends: Vec<_> = report.steps.iter().map(|s| (s.step, s.backend)).collect();
        assert_eq!(
            backends,
            [
                (Step::JpegDecode, Backend::Cpu),
                (Step::Encode, Backend::Chrome)
            ],
            "{backend:?} absent"
        );
        assert!(report.degraded);
        assert_eq!(
            report.reason.as_deref(),
            Some("Video runs on the processor here: this computer has no hardware video encoder.")
        );
    }
}

#[test]
fn nvidia_decodes_jpeg_on_the_cpu_without_being_degraded() {
    let probed = machine(Some(Backend::Nv));
    let report = assess(&probed, picture_steps(&probed));
    let decode = report.steps.iter().find(|s| s.step == Step::JpegDecode);
    assert_eq!(
        decode.map(|s| (s.backend, s.hardware, s.uploads)),
        Some((Backend::Cpu, false, 1))
    );
    assert!(!report.degraded);
    assert_eq!(report.reason, None);
}

#[test]
fn a_hardware_listed_step_running_on_the_cpu_is_degraded() {
    // VA-API's JPEG decoder worked in the trial, but the source decodes on the CPU (a watchdog).
    let probed = machine(Some(Backend::Vaapi));
    let steps = vec![
        SourceStep {
            step: Step::JpegDecode,
            backend: Backend::Cpu,
            hardware: false,
            readbacks: 0,
            uploads: 1,
        },
        SourceStep {
            step: Step::Encode,
            backend: Backend::Vaapi,
            hardware: true,
            readbacks: 0,
            uploads: 0,
        },
    ];
    let report = assess(&probed, steps);
    assert!(report.degraded);
    assert_eq!(
        report.reason.as_deref(),
        Some("Pictures are decoded on the processor here: the hardware decoder failed.")
    );
}

#[test]
fn a_backend_whose_trial_failed_is_no_hardware_and_its_cpu_fallback_is_degraded() {
    // VA-API lists H.264 encode and JPEG decode, but both trials failed their frame.
    let mut probed = machine(None);
    probed.push(failed(
        entry(Step::Encode, Some("avc1.640028"), Backend::Vaapi, true),
        TrialState::Failed,
    ));
    probed.push(failed(
        entry(Step::JpegDecode, Some("jpeg"), Backend::Vaapi, true),
        TrialState::TimedOut,
    ));
    let steps = picture_steps(&probed);
    assert_eq!(
        steps.iter().map(|s| s.backend).collect::<Vec<_>>(),
        [Backend::Cpu, Backend::Chrome],
        "a failed trial is never chosen"
    );
    let report = assess(&probed, steps);
    assert!(report.degraded);
    assert_eq!(
        report.reason.as_deref(),
        Some("Video runs on the processor here: the hardware video encoder didn't start.")
    );
}

#[test]
fn a_software_mft_encode_is_degraded_but_a_scale_with_no_hardware_entry_is_not() {
    let probed = vec![
        entry(Step::Encode, Some("avc1.640028"), Backend::Mf, false),
        entry(Step::Scale, None, Backend::Vt, false),
    ];
    let scale_only = vec![SourceStep {
        step: Step::Scale,
        backend: Backend::Cpu,
        hardware: false,
        readbacks: 1,
        uploads: 0,
    }];
    assert!(!assess(&probed, scale_only).degraded);
    let encode = vec![SourceStep {
        step: Step::Encode,
        backend: Backend::Mf,
        hardware: false,
        readbacks: 0,
        uploads: 0,
    }];
    assert!(assess(&probed, encode).degraded);
}

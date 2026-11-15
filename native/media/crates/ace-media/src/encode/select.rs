// SPDX-License-Identifier: Apache-2.0
//! Which backend encodes a JPEG source (docs/media/plan.md, "Acceleration"): the probe's
//! observed hardware first, the last-resort Chrome encoder only where no hardware encoder
//! works, and never a software H.264/HEVC encoder of ace-media's own. Pure.
use media_codec::Codec;
use media_wire::capability::{Backend, Capability, Step, TrialState};

/// The codec family of a WebCodecs codec string, for the encodes ace-media can run.
pub fn family(codec: &str) -> Option<Codec> {
    match codec.get(..4)? {
        "avc1" | "avc3" => Some(Codec::H264),
        "hvc1" | "hev1" => Some(Codec::Hevc),
        _ => None,
    }
}

fn family_of(capability: &Capability) -> Option<Codec> {
    capability.codec.as_deref().and_then(family)
}

fn working(capability: &Capability, step: Step) -> bool {
    capability.step == step && capability.state == TrialState::Ok
}

/// A hardware encode the probe saw work on a backend this build can construct (`built`, the
/// platform's table): the only entries that count for choosing an encoder, and for turning the
/// last-resort encoder off.
fn usable_hardware(capability: &Capability, built: &[Backend]) -> bool {
    working(capability, Step::Encode)
        && capability.hardware
        && capability.backend != Backend::Chrome
        && built.contains(&capability.backend)
}

/// The last-resort Chrome encoder is needed where no usable hardware encoder works.
pub fn last_resort_needed(capabilities: &[Capability], built: &[Backend]) -> bool {
    !capabilities.iter().any(|c| usable_hardware(c, built))
}

/// The encoder for `codec`: a usable hardware backend whose trial encoded it, else Chrome
/// (H.264 only) when its trial worked. `(backend, hardware)`; none when the machine has neither.
pub fn encoder_for(
    capabilities: &[Capability],
    codec: Codec,
    built: &[Backend],
) -> Option<(Backend, bool)> {
    let hardware = capabilities
        .iter()
        .find(|c| usable_hardware(c, built) && family_of(c) == Some(codec));
    if let Some(found) = hardware {
        return Some((found.backend, true));
    }
    let chrome = capabilities
        .iter()
        .any(|c| working(c, Step::Encode) && c.backend == Backend::Chrome);
    (chrome && codec == Codec::H264).then_some((Backend::Chrome, false))
}

/// Whether the probe observed a hardware JPEG decoder on `backend`.
pub fn jpeg_decode_hardware(capabilities: &[Capability], backend: Backend) -> bool {
    capabilities
        .iter()
        .any(|c| working(c, Step::JpegDecode) && c.hardware && c.backend == backend)
}

#[cfg(test)]
mod tests {
    use super::*;

    const ALL: [Backend; 4] = [Backend::Vt, Backend::Mf, Backend::Vaapi, Backend::Nv];

    fn entry(step: Step, codec: &str, backend: Backend, hardware: bool, ok: bool) -> Capability {
        Capability {
            step,
            codec: Some(codec.into()),
            backend,
            hardware,
            zero_copy: hardware,
            state: if ok {
                TrialState::Ok
            } else {
                TrialState::Failed
            },
            max_width: 4096,
            max_height: 4096,
        }
    }

    #[test]
    fn a_hardware_encoder_the_probe_observed_wins_over_the_last_resort() {
        let caps = [
            entry(Step::Encode, "avc1.42E033", Backend::Chrome, false, true),
            entry(Step::Encode, "avc1.640033", Backend::Vt, true, true),
            entry(Step::Encode, "hvc1.1.6.L153.B0", Backend::Vt, true, true),
        ];
        assert_eq!(
            encoder_for(&caps, Codec::H264, &ALL),
            Some((Backend::Vt, true))
        );
        assert_eq!(
            encoder_for(&caps, Codec::Hevc, &ALL),
            Some((Backend::Vt, true))
        );
    }

    #[test]
    fn chrome_encodes_only_h264_and_only_where_no_hardware_encoder_works() {
        let caps = [
            entry(Step::Encode, "avc1.640033", Backend::Vaapi, true, false),
            entry(Step::Encode, "avc1.42E033", Backend::Chrome, false, true),
        ];
        assert_eq!(
            encoder_for(&caps, Codec::H264, &ALL),
            Some((Backend::Chrome, false))
        );
        assert_eq!(encoder_for(&caps, Codec::Hevc, &ALL), None);
    }

    #[test]
    fn a_software_session_or_a_cpu_entry_is_never_an_encoder() {
        let caps = [
            entry(Step::Encode, "avc1.640033", Backend::Mf, false, true),
            entry(Step::JpegDecode, "jpeg", Backend::Cpu, false, true),
        ];
        assert_eq!(encoder_for(&caps, Codec::H264, &ALL), None);
    }

    #[test]
    fn jpeg_decode_counts_as_hardware_only_where_observed_on_that_backend() {
        let caps = [
            entry(Step::JpegDecode, "jpeg", Backend::Vt, true, true),
            entry(Step::JpegDecode, "jpeg", Backend::Cpu, false, true),
        ];
        assert!(jpeg_decode_hardware(&caps, Backend::Vt));
        assert!(!jpeg_decode_hardware(&caps, Backend::Vaapi));
    }

    #[test]
    fn a_probed_backend_this_build_cannot_construct_leaves_the_last_resort_on() {
        // VA-API's trial worked, but the JPEG encoder can't build a VA-API encoder here.
        let caps = [
            entry(Step::Encode, "avc1.640028", Backend::Vaapi, true, true),
            entry(Step::Encode, "hvc1.1.6.L120.B0", Backend::Vaapi, true, true),
            entry(Step::Encode, "avc1.42E01F", Backend::Chrome, false, true),
        ];
        let built = [Backend::Vt];
        assert!(last_resort_needed(&caps, &built));
        assert_eq!(
            encoder_for(&caps, Codec::H264, &built),
            Some((Backend::Chrome, false))
        );
        assert_eq!(encoder_for(&caps, Codec::Hevc, &built), None);
        // Once the build can construct it, the probe's entry wins and the fallback goes.
        let built = [Backend::Vt, Backend::Vaapi];
        assert!(!last_resort_needed(&caps, &built));
        assert_eq!(
            encoder_for(&caps, Codec::Hevc, &built),
            Some((Backend::Vaapi, true))
        );
    }

    #[test]
    fn codec_families_follow_the_webcodecs_prefix() {
        assert_eq!(family("avc1.640033"), Some(Codec::H264));
        assert_eq!(family("hev1.1.6.L93.B0"), Some(Codec::Hevc));
        assert_eq!(family("vp09.00.41.08"), None);
        assert_eq!(family("av"), None);
    }
}

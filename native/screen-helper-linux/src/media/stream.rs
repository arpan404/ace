//! `stream.configure`'s settings and what they decide: the encode size and spec, and every
//! encoder's output as the Annex B the daemon's viewers take (parameter sets before each IDR,
//! the codec string on keyframes). Pure.
use media_bitstream::{avcc::AvcConfig, nal};
use media_codec::{BitstreamFormat, Codec, EncodeSpec, EncodedUnit, RateControl, Size};
use serde::Deserialize;

/// A view's request, as `ScreenStreamSettings` in `@ace/protocol`.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StreamSettings {
    pub codec: String,
    pub max_width: u32,
    pub max_height: u32,
    pub fps: u32,
    pub bitrate: u32,
}

impl StreamSettings {
    pub fn valid(&self) -> bool {
        matches!(self.codec.as_str(), "jpeg" | "h264")
            && (64..=3840).contains(&self.max_width)
            && (64..=3840).contains(&self.max_height)
            && (1..=60).contains(&self.fps)
            && (128_000..=20_000_000).contains(&self.bitrate)
    }

    pub fn video(&self) -> bool {
        self.codec == "h264"
    }
}

/// The size a `width`×`height` picture is encoded at: within the view's bounds, never larger
/// than the picture, even on both sides (H.264 4:2:0), at least 64.
pub fn encode_size(width: u32, height: u32, settings: &StreamSettings) -> Size {
    let ratio = (f64::from(settings.max_width) / f64::from(width.max(1)))
        .min(f64::from(settings.max_height) / f64::from(height.max(1)))
        .min(1.);
    let even = |side: u32| ((f64::from(side) * ratio) as u32 / 2 * 2).max(64);
    Size {
        width: even(width),
        height: even(height),
    }
}

/// The encoder's spec for that size: H.264 at the view's rate.
pub fn encode_spec(size: Size, settings: &StreamSettings) -> EncodeSpec {
    EncodeSpec {
        codec: Codec::H264,
        size,
        fps: settings.fps,
        rate: RateControl::Bitrate(settings.bitrate),
    }
}

/// One encoder unit as Annex B, and its codec string on keyframes. An AVCC unit (the
/// last-resort encoder's) takes its parameter sets from the record it carries or, without one,
/// from the last record seen, which `record` keeps. `None` for a unit that can't be read.
pub fn annex_b(
    unit: &EncodedUnit,
    record: &mut Option<AvcConfig>,
) -> Option<(Vec<u8>, Option<String>)> {
    if unit.codec != Codec::H264 || unit.data.is_empty() {
        return None;
    }
    if let Some(description) = &unit.description {
        *record = Some(AvcConfig::parse(description).ok()?);
    }
    let mut out = Vec::with_capacity(unit.data.len() + 64);
    match unit.format {
        BitstreamFormat::AnnexB => {
            if unit.key && !has_sps(&unit.data) {
                push_sets(&mut out, record.as_ref()?);
            }
            out.extend_from_slice(&unit.data);
        }
        BitstreamFormat::Avcc => {
            let config = record.as_ref()?;
            let mut body = Vec::new();
            nal::length_prefixed_to_annex_b(&unit.data, usize::from(config.length_size), &mut body)
                .ok()?;
            if unit.key && !has_sps(&body) {
                push_sets(&mut out, config);
            }
            out.extend_from_slice(&body);
        }
        _ => return None,
    }
    let codec = unit
        .key
        .then(|| codec_string(&out, record.as_ref()))
        .flatten();
    Some((out, codec))
}

fn has_sps(stream: &[u8]) -> bool {
    nal::annex_b_units(stream).any(|unit| nal::h264::unit_type(unit) == Some(7))
}

fn push_sets(out: &mut Vec<u8>, config: &AvcConfig) {
    for unit in config.sps.iter().chain(&config.pps) {
        out.extend_from_slice(&[0, 0, 0, 1]);
        out.extend_from_slice(unit);
    }
}

/// `avc1.PPCCLL` from the stream's own SPS, else the record.
fn codec_string(stream: &[u8], record: Option<&AvcConfig>) -> Option<String> {
    let sps = nal::annex_b_units(stream).find(|unit| nal::h264::unit_type(unit) == Some(7));
    match sps {
        Some(sps) if sps.len() >= 4 => {
            Some(format!("avc1.{:02X}{:02X}{:02X}", sps[1], sps[2], sps[3]))
        }
        _ => record.map(AvcConfig::codec_string),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings(max_width: u32, max_height: u32) -> StreamSettings {
        StreamSettings {
            codec: "h264".into(),
            max_width,
            max_height,
            fps: 60,
            bitrate: 4_000_000,
        }
    }

    const SPS: [u8; 4] = [0x67, 0x64, 0x00, 0x28];
    const PPS: [u8; 2] = [0x68, 0xee];

    fn record() -> Vec<u8> {
        AvcConfig {
            profile: 0x64,
            compatibility: 0,
            level: 0x28,
            length_size: 4,
            sps: vec![SPS.to_vec()],
            pps: vec![PPS.to_vec()],
            high: None,
        }
        .to_bytes()
        .unwrap()
    }

    fn unit(
        format: BitstreamFormat,
        data: Vec<u8>,
        key: bool,
        description: Option<Vec<u8>>,
    ) -> EncodedUnit {
        EncodedUnit {
            codec: Codec::H264,
            size: Size {
                width: 64,
                height: 64,
            },
            format,
            data,
            key,
            description,
            pts_us: 0,
            duration_us: 0,
        }
    }

    #[test]
    fn a_picture_is_encoded_within_the_views_bounds_on_even_sides() {
        assert_eq!(
            encode_size(2560, 1600, &settings(1920, 1080)),
            Size {
                width: 1728,
                height: 1080
            }
        );
        assert_eq!(
            encode_size(1279, 799, &settings(3840, 3840)),
            Size {
                width: 1278,
                height: 798
            }
        );
        assert_eq!(
            encode_size(40, 30, &settings(3840, 3840)),
            Size {
                width: 64,
                height: 64
            }
        );
    }

    #[test]
    fn settings_outside_the_protocols_bounds_are_refused() {
        assert!(settings(1920, 1080).valid());
        assert!(
            !StreamSettings {
                fps: 61,
                ..settings(1920, 1080)
            }
            .valid()
        );
        assert!(
            !StreamSettings {
                codec: "vp9".into(),
                ..settings(1920, 1080)
            }
            .valid()
        );
    }

    #[test]
    fn an_avcc_keyframe_becomes_annex_b_with_its_parameter_sets_first() {
        let mut kept = None;
        let idr = [0, 0, 0, 3, 0x65, 0xaa, 0xbb];
        let (bytes, codec) = annex_b(
            &unit(BitstreamFormat::Avcc, idr.to_vec(), true, Some(record())),
            &mut kept,
        )
        .unwrap();
        let units: Vec<&[u8]> = nal::annex_b_units(&bytes).collect();
        assert_eq!(units, [&SPS[..], &PPS[..], &[0x65, 0xaa, 0xbb][..]]);
        assert_eq!(codec.as_deref(), Some("avc1.640028"));
        // A later keyframe without a record still gets the sets; a delta gets none.
        let (again, _) = annex_b(
            &unit(BitstreamFormat::Avcc, idr.to_vec(), true, None),
            &mut kept,
        )
        .unwrap();
        assert_eq!(again, bytes);
        let (delta, codec) = annex_b(
            &unit(
                BitstreamFormat::Avcc,
                vec![0, 0, 0, 2, 0x41, 1],
                false,
                None,
            ),
            &mut kept,
        )
        .unwrap();
        assert_eq!(delta, vec![0, 0, 0, 1, 0x41, 1]);
        assert_eq!(codec, None);
    }

    #[test]
    fn an_annex_b_keyframe_that_carries_its_sets_is_passed_through() {
        let mut stream = vec![0, 0, 0, 1];
        stream.extend_from_slice(&SPS);
        stream.extend_from_slice(&[0, 0, 0, 1]);
        stream.extend_from_slice(&PPS);
        stream.extend_from_slice(&[0, 0, 0, 1, 0x65, 9]);
        let (bytes, codec) = annex_b(
            &unit(BitstreamFormat::AnnexB, stream.clone(), true, None),
            &mut None,
        )
        .unwrap();
        assert_eq!((bytes, codec.as_deref()), (stream, Some("avc1.640028")));
    }

    #[test]
    fn an_avcc_unit_with_no_record_yet_is_dropped_rather_than_sent_undecodable() {
        assert!(
            annex_b(
                &unit(BitstreamFormat::Avcc, vec![0, 0, 0, 1, 0x41], false, None),
                &mut None
            )
            .is_none()
        );
    }
}

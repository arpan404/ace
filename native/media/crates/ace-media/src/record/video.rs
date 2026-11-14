// SPDX-License-Identifier: Apache-2.0
//! Turning an encoded video unit into an MP4 sample and its track configuration. Pure.
//!
//! - AVCC and HVCC units (codecs 2 and 4) are already length-prefixed; their configuration
//!   record arrives as the frame's description.
//! - Annex B units (codecs 1 and 3) are rewritten with 4-byte length prefixes (ISO/IEC
//!   14496-15 §5.3.2, §8.3.2). Parameter sets and access unit delimiters move out of the
//!   samples, and the configuration record is built from the keyframe's own parameter sets:
//!   `avcC` per 14496-15 §5.3.3.1, `hvcC` per §8.3.3.1.
use media_mp4::VideoCodec;
use media_wire::frame::MediaFrame;

pub const CODEC_H264_ANNEXB: u8 = 1;
pub const CODEC_H264_AVCC: u8 = 2;
pub const CODEC_HEVC_ANNEXB: u8 = 3;
pub const CODEC_HEVC_HVCC: u8 = 4;

/// One unit, ready for the muxer.
pub struct Unit {
    pub codec: VideoCodec,
    /// Length-prefixed NAL units.
    pub data: Vec<u8>,
    /// The configuration record this unit carried or implied (keyframes only).
    pub description: Option<Vec<u8>>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Refused {
    /// A codec MP4 recordings don't take (VP8, VP9, JPEG, PNG).
    Codec,
    /// Nothing decodable in the unit.
    Empty,
}

pub fn unit(frame: &MediaFrame) -> Result<Unit, Refused> {
    let given = (!frame.description.is_empty()).then(|| frame.description.clone());
    match frame.codec {
        CODEC_H264_AVCC | CODEC_HEVC_HVCC => {
            if frame.payload.is_empty() {
                return Err(Refused::Empty);
            }
            Ok(Unit {
                codec: if frame.codec == CODEC_H264_AVCC {
                    VideoCodec::H264
                } else {
                    VideoCodec::Hevc
                },
                data: frame.payload.clone(),
                description: given,
            })
        }
        CODEC_H264_ANNEXB => annex_b(&frame.payload, VideoCodec::H264, given),
        CODEC_HEVC_ANNEXB => annex_b(&frame.payload, VideoCodec::Hevc, given),
        _ => Err(Refused::Codec),
    }
}

/// The NAL units of an Annex B stream, without their start codes (H.264 Annex B.2).
pub fn nal_units(bytes: &[u8]) -> Vec<&[u8]> {
    let mut starts = Vec::new();
    let mut i = 0;
    while i + 3 <= bytes.len() {
        if bytes[i] == 0 && bytes[i + 1] == 0 && bytes[i + 2] == 1 {
            starts.push(i + 3);
            i += 3;
        } else {
            i += 1;
        }
    }
    let mut out = Vec::with_capacity(starts.len());
    for (n, &start) in starts.iter().enumerate() {
        let mut end = starts.get(n + 1).map_or(bytes.len(), |next| next - 3);
        // A four-byte start code, or trailing zero bytes, belong to no NAL unit.
        while end > start && bytes[end - 1] == 0 {
            end -= 1;
        }
        if end > start {
            out.push(&bytes[start..end]);
        }
    }
    out
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Role {
    Vps,
    Sps,
    Pps,
    Delimiter,
    Picture,
}

fn role(codec: VideoCodec, nal: &[u8]) -> Role {
    match codec {
        VideoCodec::H264 => match nal[0] & 0x1f {
            7 => Role::Sps,
            8 => Role::Pps,
            9 => Role::Delimiter,
            _ => Role::Picture,
        },
        VideoCodec::Hevc => match (nal[0] >> 1) & 0x3f {
            32 => Role::Vps,
            33 => Role::Sps,
            34 => Role::Pps,
            35 => Role::Delimiter,
            _ => Role::Picture,
        },
    }
}

fn annex_b(bytes: &[u8], codec: VideoCodec, given: Option<Vec<u8>>) -> Result<Unit, Refused> {
    let mut data = Vec::with_capacity(bytes.len() + 16);
    let (mut vps, mut sps, mut pps) = (None, None, None);
    for nal in nal_units(bytes) {
        let header = if codec == VideoCodec::Hevc { 2 } else { 1 };
        if nal.len() < header {
            continue;
        }
        match role(codec, nal) {
            Role::Vps => vps = vps.or(Some(nal)),
            Role::Sps => sps = sps.or(Some(nal)),
            Role::Pps => pps = pps.or(Some(nal)),
            Role::Delimiter => {}
            Role::Picture => {
                data.extend_from_slice(&(nal.len() as u32).to_be_bytes());
                data.extend_from_slice(nal);
            }
        }
    }
    if data.is_empty() {
        return Err(Refused::Empty);
    }
    let built = match (codec, vps, sps, pps) {
        (VideoCodec::H264, _, Some(sps), Some(pps)) => avcc(sps, pps),
        (VideoCodec::Hevc, Some(vps), Some(sps), Some(pps)) => hvcc(vps, sps, pps),
        _ => None,
    };
    Ok(Unit {
        codec,
        data,
        description: given.or(built),
    })
}

/// `AVCDecoderConfigurationRecord` with one SPS and one PPS and 4-byte lengths. Profiles other
/// than Baseline, Main and Extended carry the chroma format and bit depths, read from the SPS.
pub fn avcc(sps: &[u8], pps: &[u8]) -> Option<Vec<u8>> {
    if sps.len() < 4 || pps.is_empty() || sps.len() > 0xffff || pps.len() > 0xffff {
        return None;
    }
    let profile = sps[1];
    let mut out = vec![1, profile, sps[2], sps[3], 0xff, 0xe1];
    out.extend_from_slice(&(sps.len() as u16).to_be_bytes());
    out.extend_from_slice(sps);
    out.push(1);
    out.extend_from_slice(&(pps.len() as u16).to_be_bytes());
    out.extend_from_slice(pps);
    if !matches!(profile, 66 | 77 | 88) {
        let (chroma, luma, depth) = avc_format(sps).unwrap_or((1, 0, 0));
        out.extend_from_slice(&[0xfc | chroma, 0xf8 | luma, 0xf8 | depth, 0]);
    }
    Some(out)
}

/// chroma_format_idc and the bit depths of an H.264 SPS (H.264 §7.3.2.1.1); 4:2:0 8-bit for
/// profiles that don't code them.
fn avc_format(sps: &[u8]) -> Option<(u8, u8, u8)> {
    let body = rbsp(sps, 1);
    if !matches!(
        body.first()?,
        100 | 110 | 122 | 244 | 44 | 83 | 86 | 118 | 128 | 138 | 139 | 134 | 135
    ) {
        return Some((1, 0, 0));
    }
    let mut bits = Bits {
        bytes: &body,
        at: 24,
    };
    bits.ue()?; // seq_parameter_set_id
    let chroma = bits.ue()?;
    if chroma == 3 {
        bits.bit()?;
    }
    let (luma, depth) = (bits.ue()?, bits.ue()?);
    (chroma <= 3 && luma <= 7 && depth <= 7).then_some((chroma as u8, luma as u8, depth as u8))
}

/// The RBSP of a NAL unit: its payload without emulation prevention bytes (H.265 §7.4.2).
fn rbsp(nal: &[u8], header: usize) -> Vec<u8> {
    let mut out = Vec::with_capacity(nal.len());
    let mut zeros = 0;
    for &b in nal.iter().skip(header) {
        if zeros >= 2 && b == 3 {
            zeros = 0;
            continue;
        }
        zeros = if b == 0 { zeros + 1 } else { 0 };
        out.push(b);
    }
    out
}

/// Reads exp-Golomb and fixed-width fields (H.265 §9.2).
struct Bits<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl Bits<'_> {
    fn bit(&mut self) -> Option<u32> {
        let byte = *self.bytes.get(self.at / 8)?;
        let bit = (byte >> (7 - self.at % 8)) & 1;
        self.at += 1;
        Some(u32::from(bit))
    }
    fn bits(&mut self, n: u32) -> Option<u32> {
        (0..n).try_fold(0, |v, _| Some((v << 1) | self.bit()?))
    }
    fn ue(&mut self) -> Option<u32> {
        let mut zeros = 0;
        while self.bit()? == 0 {
            zeros += 1;
            if zeros > 31 {
                return None;
            }
        }
        Some((1 << zeros) - 1 + self.bits(zeros)?)
    }
}

/// `HEVCDecoderConfigurationRecord` with one VPS, SPS and PPS and 4-byte lengths. The general
/// profile, tier and level are the SPS's own 12 bytes; chroma format and bit depths are read
/// from the SPS when it has a single sub-layer, and default to 4:2:0 8-bit otherwise.
pub fn hvcc(vps: &[u8], sps: &[u8], pps: &[u8]) -> Option<Vec<u8>> {
    let body = rbsp(sps, 2);
    // sps_video_parameter_set_id (4), max_sub_layers_minus1 (3), temporal_id_nesting (1),
    // then profile_tier_level's 12 general bytes.
    let general = body.get(1..13)?;
    let sub_layers = (body[0] >> 1) & 7;
    let (mut chroma, mut luma_depth, mut chroma_depth) = (1, 0, 0);
    if sub_layers == 0 {
        let mut bits = Bits {
            bytes: &body,
            at: 13 * 8,
        };
        let parsed = (|| {
            bits.ue()?; // sps_seq_parameter_set_id
            let chroma = bits.ue()?;
            if chroma == 3 {
                bits.bit()?;
            }
            bits.ue()?; // pic_width_in_luma_samples
            bits.ue()?; // pic_height_in_luma_samples
            if bits.bit()? == 1 {
                for _ in 0..4 {
                    bits.ue()?; // conformance window offsets
                }
            }
            Some((chroma, bits.ue()?, bits.ue()?))
        })();
        if let Some((c, l, d)) = parsed
            && c <= 3
            && l <= 7
            && d <= 7
        {
            (chroma, luma_depth, chroma_depth) = (c as u8, l as u8, d as u8);
        }
    }
    let mut out = vec![1];
    out.extend_from_slice(general);
    out.extend_from_slice(&[
        0xf0,
        0x00, // min_spatial_segmentation_idc 0
        0xfc, // parallelismType 0
        0xfc | chroma,
        0xf8 | luma_depth,
        0xf8 | chroma_depth,
        0,
        0, // avgFrameRate unknown
        // One temporal layer per sub-layer; nesting left unasserted, as encoders write it.
        ((sub_layers + 1) << 3) | 3,
        3,
    ]);
    for (kind, nal) in [(32u8, vps), (33, sps), (34, pps)] {
        if nal.len() > 0xffff {
            return None;
        }
        out.push(0x80 | kind);
        out.extend_from_slice(&1u16.to_be_bytes());
        out.extend_from_slice(&(nal.len() as u16).to_be_bytes());
        out.extend_from_slice(nal);
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(codec: u8, payload: Vec<u8>) -> MediaFrame {
        MediaFrame {
            kind: 1,
            flags: 1,
            age_us: 0,
            width: 64,
            height: 64,
            display_width: 64,
            display_height: 64,
            scale: 1000,
            rotation: 0,
            codec,
            encode: 0,
            epoch: 0,
            codec_string: String::new(),
            description: Vec::new(),
            extension: Vec::new(),
            payload,
        }
    }

    #[test]
    fn an_annex_b_keyframe_becomes_length_prefixed_pictures_and_its_own_avcc() {
        let sps = [0x67, 0x42, 0xc0, 0x1e, 0xda];
        let pps = [0x68, 0xce, 0x3c, 0x80];
        let idr = [0x65, 0x88, 0x84, 0x00, 0x21];
        let mut stream = vec![0, 0, 0, 1, 0x09, 0xf0];
        for nal in [&sps[..], &pps, &idr] {
            stream.extend_from_slice(&[0, 0, 0, 1]);
            stream.extend_from_slice(nal);
        }
        let Ok(unit) = unit(&frame(CODEC_H264_ANNEXB, stream)) else {
            panic!("refused");
        };
        // The delimiter and parameter sets leave the sample; the IDR's own trailing zero
        // byte stays in it, since only bytes before a start code are padding.
        assert_eq!(unit.data, [&[0, 0, 0, 5][..], &idr].concat());
        let Some(avcc) = unit.description else {
            panic!("no avcC");
        };
        assert_eq!(&avcc[..6], &[1, 0x42, 0xc0, 0x1e, 0xff, 0xe1]);
        assert_eq!(&avcc[8..13], &sps);
        assert_eq!(&avcc[16..], &pps);
    }

    #[test]
    fn a_delta_without_parameter_sets_has_no_description_and_codecs_mp4_cannot_hold_are_refused() {
        let Ok(delta) = unit(&frame(CODEC_H264_ANNEXB, vec![0, 0, 1, 0x41, 0x9a, 0x01])) else {
            panic!("refused");
        };
        assert!(delta.description.is_none());
        assert_eq!(delta.data, [0, 0, 0, 3, 0x41, 0x9a, 0x01]);
        assert_eq!(
            unit(&frame(7, vec![0xff, 0xd8])).err(),
            Some(Refused::Codec)
        );
        assert_eq!(
            unit(&frame(
                CODEC_H264_ANNEXB,
                vec![0, 0, 1, 0x67, 0x42, 0xc0, 0x1e]
            ))
            .err(),
            Some(Refused::Empty)
        );
    }

    /// The configuration record a fixture from the platform encoder carries, and the parameter
    /// sets inside it: (type, NAL unit) per array (14496-15 §5.3.3.1, §8.3.3.1).
    fn record(fixture: &[u8]) -> Vec<u8> {
        let n = u32::from_be_bytes([fixture[0], fixture[1], fixture[2], fixture[3]]) as usize;
        fixture[4..4 + n].to_vec()
    }

    fn hevc_arrays(record: &[u8]) -> Vec<Vec<u8>> {
        let mut at = 23;
        let mut out = Vec::new();
        for _ in 0..record[22] {
            let count = u16::from_be_bytes([record[at + 1], record[at + 2]]);
            at += 3;
            for _ in 0..count {
                let len = u16::from_be_bytes([record[at], record[at + 1]]) as usize;
                out.push(record[at + 2..at + 2 + len].to_vec());
                at += 2 + len;
            }
        }
        out
    }

    #[test]
    fn records_built_from_parameter_sets_match_what_videotoolbox_writes() {
        let h264 = record(include_bytes!("../../../media-mp4/tests/vectors/h264.bin"));
        let sps_len = u16::from_be_bytes([h264[6], h264[7]]) as usize;
        let sps = &h264[8..8 + sps_len];
        let pps_at = 8 + sps_len + 1;
        let pps_len = u16::from_be_bytes([h264[pps_at], h264[pps_at + 1]]) as usize;
        let pps = &h264[pps_at + 2..pps_at + 2 + pps_len];
        assert_eq!(avcc(sps, pps), Some(h264.clone()), "High profile avcC");

        let hevc = record(include_bytes!("../../../media-mp4/tests/vectors/hevc.bin"));
        let sets = hevc_arrays(&hevc);
        assert_eq!(sets.len(), 3);
        assert_eq!(hvcc(&sets[0], &sets[1], &sets[2]), Some(hevc));
    }
}

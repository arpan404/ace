// SPDX-License-Identifier: Apache-2.0
//! `@ace/browser/h264.ts` and `h264-sps.ts`: H.264 in AVC form (length-prefixed NAL units with
//! an avcC description, as WebCodecs and serve-sim give it) rewritten as Annex B, the form
//! device and computer-use live views carry: parameter sets in front of every keyframe, so a
//! decoder can join at any IDR. `simulator-avcc.ts` re-exports these for the capture path.

use crate::platform::Error;

/// Annex B's four-byte start code, in front of every parameter set and NAL unit.
const START_CODE: [u8; 4] = [0, 0, 0, 1];

/// What an avcC record says about the stream that follows it (ISO/IEC 14496-15 5.3.3.1).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AvcConfig {
    /// WebCodecs codec string, `avc1.PPCCLL`.
    pub codec: String,
    /// How each NAL unit's length is spelled in front of it: 1, 2 or 4 bytes.
    pub length_size: usize,
    pub width: u32,
    pub height: u32,
    /// SPS then PPS, each with an Annex B start code, ready to lead a keyframe.
    pub parameter_sets: Vec<u8>,
}

/// Reads an avcC description: its codec string, NAL length size, the SPS's cropped picture
/// size, and the parameter sets that lead every keyframe.
pub fn avc_config(record: &[u8]) -> Result<AvcConfig, Error> {
    if record.len() < 7 || record[0] != 1 {
        return Err(invalid("H.264 description invalid"));
    }
    let codec = format!("avc1.{:02X}{:02X}{:02X}", record[1], record[2], record[3]);
    // `(record[4] & 3) + 1`: the TypeScript also refuses a length size of 3, which this
    // expression can never produce, so that branch is unreachable there too.
    let length_size = usize::from(record[4] & 3) + 1;
    let mut parameter_sets = Vec::new();
    let mut sps: Option<&[u8]> = None;
    let mut offset = 5;
    for (is_sps, mask) in [(true, 0x1f), (false, 0xff)] {
        let count = record.get(offset).copied().unwrap_or(0) & mask;
        offset += 1;
        for _ in 0..count {
            if offset + 2 > record.len() {
                return Err(invalid("H.264 description truncated"));
            }
            let length = usize::from(u16::from_be_bytes([record[offset], record[offset + 1]]));
            let start = offset + 2;
            let end = start + length;
            if length == 0 || end > record.len() {
                return Err(invalid("H.264 description truncated"));
            }
            let nal = &record[start..end];
            offset = end;
            if is_sps && sps.is_none() {
                sps = Some(nal);
            }
            parameter_sets.extend_from_slice(&START_CODE);
            parameter_sets.extend_from_slice(nal);
        }
    }
    let sps = sps.ok_or_else(|| invalid("H.264 description has no SPS"))?;
    let (width, height) = sps_dimensions(sps)?;
    Ok(AvcConfig {
        codec,
        length_size,
        width,
        height,
        parameter_sets,
    })
}

/// Rewrites one length-prefixed access unit as Annex B: each length prefix becomes a start code
/// and a keyframe is led by the parameter sets. The NAL bytes are copied once, never decoded.
pub fn annex_b(sample: &[u8], config: &AvcConfig, keyframe: bool) -> Result<Vec<u8>, Error> {
    let lead: &[u8] = if keyframe {
        &config.parameter_sets
    } else {
        &[]
    };
    let extra = 4usize.saturating_sub(config.length_size);
    let mut units = 0usize;
    let mut offset = 0usize;
    while offset < sample.len() {
        let length = read_length(sample, offset, config.length_size)?;
        offset += config.length_size + length;
        if length == 0 || offset > sample.len() {
            return Err(invalid("H.264 sample is truncated"));
        }
        units += 1;
    }
    let mut out = Vec::with_capacity(lead.len() + sample.len() + units * extra);
    out.extend_from_slice(lead);
    let mut offset = 0usize;
    while offset < sample.len() {
        let length = read_length(sample, offset, config.length_size)?;
        offset += config.length_size;
        out.extend_from_slice(&START_CODE);
        out.extend_from_slice(&sample[offset..offset + length]);
        offset += length;
    }
    Ok(out)
}

/// The coded picture size from an H.264 sequence parameter set (ITU-T H.264 7.3.2.1.1), after
/// frame cropping. Only the fields that precede the size are read.
pub fn sps_dimensions(nal: &[u8]) -> Result<(u32, u32), Error> {
    if nal.is_empty() {
        return Err(invalid("Truncated H.264 parameter set"));
    }
    let rbsp = unescape(&nal[1..]);
    let mut bits = BitReader::new(&rbsp);
    let profile = bits.read(8)?;
    bits.read(16)?; // constraint flags and level
    bits.ue()?; // seq_parameter_set_id
    let mut chroma = 1;
    if HIGH_PROFILES.contains(&profile) {
        chroma = bits.ue()?;
        if chroma > 3 {
            return Err(invalid("Invalid H.264 chroma format"));
        }
        if chroma == 3 && bits.read(1)? == 1 {
            chroma = 0; // separate colour planes crop like 4:0:0
        }
        bits.ue()?; // bit_depth_luma_minus8
        bits.ue()?; // bit_depth_chroma_minus8
        bits.read(1)?; // qpprime_y_zero_transform_bypass_flag
        if bits.read(1)? == 1 {
            let lists = if chroma == 3 { 12 } else { 8 };
            for list in 0..lists {
                if bits.read(1)? == 1 {
                    skip_scaling_list(&mut bits, if list < 6 { 16 } else { 64 })?;
                }
            }
        }
    }
    bits.ue()?; // log2_max_frame_num_minus4
    let order = bits.ue()?;
    if order == 0 {
        bits.ue()?;
    } else if order == 1 {
        bits.read(1)?;
        bits.se()?;
        bits.se()?;
        let cycle = bits.ue()?;
        if cycle > 255 {
            return Err(invalid("Invalid H.264 picture order cycle"));
        }
        for _ in 0..cycle {
            bits.se()?;
        }
    } else if order != 2 {
        return Err(invalid("Invalid H.264 picture order type"));
    }
    bits.ue()?; // max_num_ref_frames
    bits.read(1)?; // gaps_in_frame_num_value_allowed_flag
    let width_mbs = bits.ue()? + 1;
    let height_units = bits.ue()? + 1;
    let frame_only = bits.read(1)?;
    if frame_only == 0 {
        bits.read(1)?; // mb_adaptive_frame_field_flag
    }
    bits.read(1)?; // direct_8x8_inference_flag
    let mut width = width_mbs * 16;
    let mut height = (2 - frame_only) * height_units * 16;
    if bits.read(1)? == 1 {
        let crop_x = if chroma == 1 || chroma == 2 { 2 } else { 1 };
        let crop_y = (if chroma == 1 { 2 } else { 1 }) * (2 - frame_only);
        let left = bits.ue()?;
        let right = bits.ue()?;
        let top = bits.ue()?;
        let bottom = bits.ue()?;
        width = width
            .checked_sub(crop_x * (left + right))
            .ok_or_else(|| invalid("Invalid H.264 picture size"))?;
        height = height
            .checked_sub(crop_y * (top + bottom))
            .ok_or_else(|| invalid("Invalid H.264 picture size"))?;
    }
    if width == 0 || height == 0 || width > 16384 || height > 16384 {
        return Err(invalid("Invalid H.264 picture size"));
    }
    let width = u32::try_from(width).map_err(|_| invalid("Invalid H.264 picture size"))?;
    let height = u32::try_from(height).map_err(|_| invalid("Invalid H.264 picture size"))?;
    Ok((width, height))
}

/// Profiles whose parameter set carries chroma format and scaling matrices, as `h264-sps.ts`.
const HIGH_PROFILES: [u64; 13] = [100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135];

fn skip_scaling_list(bits: &mut BitReader<'_>, size: usize) -> Result<(), Error> {
    let mut last = 8i64;
    let mut next = 8i64;
    for _ in 0..size {
        if next != 0 {
            next = (last + bits.se()? + 256) % 256;
        }
        last = if next == 0 { last } else { next };
    }
    Ok(())
}

/// Removes emulation-prevention bytes (00 00 03 -> 00 00) so the RBSP can be read as bits.
fn unescape(source: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(source.len());
    let mut zeros = 0u32;
    for &byte in source {
        if zeros >= 2 && byte == 3 {
            zeros = 0;
            continue;
        }
        out.push(byte);
        zeros = if byte == 0 { zeros + 1 } else { 0 };
    }
    out
}

/// Reads a length prefix of `length_size` bytes, big endian, in the sample's bounds.
fn read_length(sample: &[u8], offset: usize, length_size: usize) -> Result<usize, Error> {
    let end = offset
        .checked_add(length_size)
        .ok_or_else(|| invalid("H.264 sample is truncated"))?;
    if end > sample.len() {
        return Err(invalid("H.264 sample is truncated"));
    }
    let mut value = 0usize;
    for byte in &sample[offset..end] {
        value = value * 256 + usize::from(*byte);
    }
    Ok(value)
}

struct BitReader<'a> {
    bytes: &'a [u8],
    offset: usize,
}

impl<'a> BitReader<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, offset: 0 }
    }

    fn read(&mut self, count: u32) -> Result<u64, Error> {
        let mut value = 0u64;
        for _ in 0..count {
            let byte = *self
                .bytes
                .get(self.offset >> 3)
                .ok_or_else(|| invalid("Truncated H.264 parameter set"))?;
            value = value * 2 + u64::from((byte >> (7 - (self.offset & 7))) & 1);
            self.offset += 1;
        }
        Ok(value)
    }

    /// An Exp-Golomb code: `zeros` leading zero bits, then the value plus its leading one.
    fn ue(&mut self) -> Result<u64, Error> {
        let mut zeros = 0u32;
        while self.read(1)? == 0 {
            zeros += 1;
            if zeros > 31 {
                return Err(invalid("Invalid H.264 Exp-Golomb code"));
            }
        }
        Ok((1u64 << zeros) - 1 + self.read(zeros)?)
    }

    /// A signed Exp-Golomb code: 0, 1, -1, 2, -2, ...
    fn se(&mut self) -> Result<i64, Error> {
        let value = self.ue()?;
        Ok(if value % 2 == 1 {
            value.div_ceil(2) as i64
        } else {
            -((value / 2) as i64)
        })
    }
}

fn invalid(message: &str) -> Error {
    Error::Invalid(message.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(text: &str) -> Vec<u8> {
        (0..text.len())
            .step_by(2)
            .map(|at| u8::from_str_radix(&text[at..at + 2], 16).expect("valid hex"))
            .collect()
    }

    /// The decoder configuration serve-sim 0.1.48 sent for an iPhone 16 Pro (High 5.1, 1206x2622).
    fn description() -> Vec<u8> {
        hex("01640033ffe1001627640033ac13143c04c0149e6a9a81010103c20108f801000428ee3cb0")
    }

    fn sample(nals: &[&[u8]]) -> Vec<u8> {
        let mut out = Vec::new();
        for nal in nals {
            out.extend_from_slice(&(nal.len() as u32).to_be_bytes());
            out.extend_from_slice(nal);
        }
        out
    }

    #[test]
    fn serve_sims_description_names_the_high_profile_codec_and_the_cropped_screen_size() {
        let config = avc_config(&description()).expect("reads");
        assert_eq!(config.codec, "avc1.640033");
        assert_eq!(config.length_size, 4);
        assert_eq!((config.width, config.height), (1206, 2622));
        assert_eq!(
            config.parameter_sets,
            hex("0000000127640033ac13143c04c0149e6a9a81010103c20108f80000000128ee3cb0")
        );
    }

    #[test]
    fn a_keyframe_becomes_annex_b_led_by_sps_and_pps_and_a_delta_carries_only_its_slices() {
        let config = avc_config(&description()).expect("reads");
        let idr = hex("25b8004001");
        let slice = hex("219a02");
        let start = "00000001";
        let sps = "27640033ac13143c04c0149e6a9a81010103c20108f8";
        let pps = "28ee3cb0";
        assert_eq!(
            annex_b(&sample(&[&idr]), &config, true).expect("rewrites"),
            hex(&format!("{start}{sps}{start}{pps}{start}25b8004001"))
        );
        assert_eq!(
            annex_b(&sample(&[&slice, &idr]), &config, false).expect("rewrites"),
            hex(&format!("{start}219a02{start}25b8004001"))
        );
        assert!(
            annex_b(&sample(&[&idr])[..6], &config, false)
                .expect_err("refused")
                .to_string()
                .contains("truncated")
        );
    }

    #[test]
    fn a_description_without_an_sps_is_refused() {
        let mut record = description();
        record[5] = 0; // no SPS
        assert!(
            avc_config(&record)
                .expect_err("refused")
                .to_string()
                .contains("no SPS")
        );
        assert!(avc_config(&[1, 0x64]).is_err());
    }

    #[test]
    fn picture_size_honours_frame_cropping_for_4_2_0_and_4_4_4_parameter_sets() {
        // Parameter sets x264 wrote for 1920x1080 Baseline, 640x360 High and 1280x720 High 4:4:4.
        for (text, width, height) in [
            (
                "6742c028d900780227e5c044000003000400000300c83c60c920",
                1920,
                1080,
            ),
            (
                "6764001eacd940a02ff97011000003000100000300320f162d96",
                640,
                360,
            ),
            (
                "67f4001f919b280a00b76022000003000200000300641e30632c",
                1280,
                720,
            ),
        ] {
            assert_eq!(sps_dimensions(&hex(text)).expect("reads"), (width, height));
        }
        assert!(
            sps_dimensions(&hex("6764"))
                .expect_err("refused")
                .to_string()
                .contains("Truncated")
        );
    }
}

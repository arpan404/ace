// SPDX-License-Identifier: Apache-2.0
//! The bitstream glue between Media Foundation and the pipeline (ITU-T H.264 Annex B,
//! H.265 Annex B, ISO/IEC 14496-15). Media Foundation encoders write Annex B with the
//! parameter sets in-band or in `MF_MT_MPEG_SEQUENCE_HEADER`; the pipeline carries
//! length-prefixed samples with an `avcC`/`hvcC` record on keyframes, as the other
//! backends do. Decoders go the other way. Pure: no I/O.
//!
//! When `media-bitstream` (B3) lands with its NAL parser, this module moves there.
use media_codec::Codec;

/// NAL units of an Annex B stream, without their start codes. Leading zero bytes and
/// trailing zeros before the next start code are dropped.
pub fn annexb_units(data: &[u8]) -> impl Iterator<Item = &[u8]> {
    let mut rest = data;
    std::iter::from_fn(move || {
        let start = find_start(rest)?;
        let body = &rest[start..];
        let end = next_start(body).unwrap_or(body.len());
        let mut unit = &body[..end];
        rest = &body[end..];
        while let [head @ .., 0] = unit {
            unit = head;
        }
        Some(unit)
    })
    .filter(|unit| !unit.is_empty())
}

/// Index just past the first start code (`00 00 01`).
fn find_start(data: &[u8]) -> Option<usize> {
    data.windows(3).position(|w| w == [0, 0, 1]).map(|i| i + 3)
}

/// Index of the next `00 00 01` (or of the `00` before it, for a 4-byte start code).
fn next_start(data: &[u8]) -> Option<usize> {
    data.windows(3).position(|w| w == [0, 0, 1])
}

fn nal_type(codec: Codec, unit: &[u8]) -> u8 {
    match (codec, unit.first()) {
        (Codec::Hevc, Some(byte)) => (byte >> 1) & 0x3f,
        (_, Some(byte)) => byte & 0x1f,
        (_, None) => 0,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Kind {
    Vps,
    Sps,
    Pps,
    /// Access unit delimiters and filler: dropped from samples.
    Drop,
    Key,
    Other,
}

fn kind(codec: Codec, unit: &[u8]) -> Kind {
    let t = nal_type(codec, unit);
    match codec {
        Codec::Hevc => match t {
            32 => Kind::Vps,
            33 => Kind::Sps,
            34 => Kind::Pps,
            35 | 38 => Kind::Drop,
            16..=21 => Kind::Key,
            _ => Kind::Other,
        },
        _ => match t {
            7 => Kind::Sps,
            8 => Kind::Pps,
            9 | 12 => Kind::Drop,
            5 => Kind::Key,
            _ => Kind::Other,
        },
    }
}

/// The parameter sets most recently seen in a stream.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ParameterSets {
    pub vps: Vec<u8>,
    pub sps: Vec<u8>,
    pub pps: Vec<u8>,
}
impl ParameterSets {
    /// Takes the first VPS, SPS and PPS out of Annex B bytes (a sequence header or a unit).
    /// Returns whether any changed.
    pub fn absorb(&mut self, codec: Codec, annexb: &[u8]) -> bool {
        let mut changed = false;
        let mut seen = [false; 3];
        for unit in annexb_units(annexb) {
            let (slot, index) = match kind(codec, unit) {
                Kind::Vps => (&mut self.vps, 0),
                Kind::Sps => (&mut self.sps, 1),
                Kind::Pps => (&mut self.pps, 2),
                _ => continue,
            };
            if seen[index] {
                continue;
            }
            seen[index] = true;
            if slot.as_slice() != unit {
                slot.clear();
                slot.extend_from_slice(unit);
                changed = true;
            }
        }
        changed
    }
    pub fn complete(&self, codec: Codec) -> bool {
        !self.sps.is_empty()
            && !self.pps.is_empty()
            && (codec != Codec::Hevc || !self.vps.is_empty())
    }
    /// The `avcC` or `hvcC` record for these parameter sets.
    pub fn record(&self, codec: Codec) -> Option<Vec<u8>> {
        if !self.complete(codec) {
            return None;
        }
        match codec {
            Codec::H264 => avcc(&self.sps, &self.pps),
            Codec::Hevc => hvcc(&self.vps, &self.sps, &self.pps),
            _ => None,
        }
    }
}

/// One encoder output converted for the pipeline.
#[derive(Debug, PartialEq, Eq)]
pub struct Sample {
    pub key: bool,
    /// The parameter sets changed in this unit.
    pub sets_changed: bool,
}

/// Converts one Annex B access unit into 4-byte length-prefixed NAL units in `out`,
/// moving parameter sets into `sets`. `key` is true when the unit holds an IDR/IRAP.
pub fn annexb_to_sample(
    codec: Codec,
    annexb: &[u8],
    sets: &mut ParameterSets,
    out: &mut Vec<u8>,
) -> Sample {
    out.clear();
    let sets_changed = sets.absorb(codec, annexb);
    let mut key = false;
    for unit in annexb_units(annexb) {
        match kind(codec, unit) {
            Kind::Vps | Kind::Sps | Kind::Pps | Kind::Drop => continue,
            Kind::Key => key = true,
            Kind::Other => {}
        }
        out.extend_from_slice(&(unit.len() as u32).to_be_bytes());
        out.extend_from_slice(unit);
    }
    Sample { key, sets_changed }
}

const START: [u8; 4] = [0, 0, 0, 1];

/// Converts a length-prefixed sample back to Annex B for a decoder, putting the
/// parameter sets before it when `sets` is given. `None` for a malformed sample.
pub fn sample_to_annexb(
    sample: &[u8],
    sets: Option<&ParameterSets>,
    out: &mut Vec<u8>,
) -> Option<()> {
    out.clear();
    if let Some(sets) = sets {
        for unit in [&sets.vps, &sets.sps, &sets.pps] {
            if !unit.is_empty() {
                out.extend_from_slice(&START);
                out.extend_from_slice(unit);
            }
        }
    }
    let mut rest = sample;
    while !rest.is_empty() {
        let (len, tail) = rest.split_first_chunk::<4>()?;
        let len = u32::from_be_bytes(*len) as usize;
        if len == 0 || len > tail.len() {
            return None;
        }
        out.extend_from_slice(&START);
        out.extend_from_slice(&tail[..len]);
        rest = &tail[len..];
    }
    Some(())
}

/// Annex B input for a decoder, with the parameter sets put before a keyframe that lacks them.
pub fn annexb_with_sets(
    codec: Codec,
    annexb: &[u8],
    sets: &ParameterSets,
    key: bool,
    out: &mut Vec<u8>,
) {
    out.clear();
    let has_sps = annexb_units(annexb).any(|u| kind(codec, u) == Kind::Sps);
    if key && !has_sps {
        for unit in [&sets.vps, &sets.sps, &sets.pps] {
            if !unit.is_empty() {
                out.extend_from_slice(&START);
                out.extend_from_slice(unit);
            }
        }
    }
    out.extend_from_slice(annexb);
}

/// The parameter sets in an `avcC` or `hvcC` record.
pub fn sets_from_record(codec: Codec, record: &[u8]) -> Option<ParameterSets> {
    let mut sets = ParameterSets::default();
    match codec {
        Codec::H264 => {
            let mut at = 5;
            let sps_count = usize::from(*record.get(at)? & 0x1f);
            at += 1;
            for i in 0..sps_count {
                let unit = length16(record, &mut at)?;
                if i == 0 {
                    sets.sps = unit.to_vec();
                }
            }
            let pps_count = usize::from(*record.get(at)?);
            at += 1;
            for i in 0..pps_count {
                let unit = length16(record, &mut at)?;
                if i == 0 {
                    sets.pps = unit.to_vec();
                }
            }
        }
        Codec::Hevc => {
            let mut at = 22;
            let arrays = usize::from(*record.get(at)?);
            at += 1;
            for _ in 0..arrays {
                let t = *record.get(at)? & 0x3f;
                let count = u16::from_be_bytes([*record.get(at + 1)?, *record.get(at + 2)?]);
                at += 3;
                for i in 0..count {
                    let unit = length16(record, &mut at)?;
                    let slot = match t {
                        32 => &mut sets.vps,
                        33 => &mut sets.sps,
                        34 => &mut sets.pps,
                        _ => continue,
                    };
                    if i == 0 && slot.is_empty() {
                        *slot = unit.to_vec();
                    }
                }
            }
        }
        _ => return None,
    }
    sets.complete(codec).then_some(sets)
}

fn length16<'a>(data: &'a [u8], at: &mut usize) -> Option<&'a [u8]> {
    let len = usize::from(u16::from_be_bytes([*data.get(*at)?, *data.get(*at + 1)?]));
    let unit = data.get(*at + 2..*at + 2 + len)?;
    *at += 2 + len;
    Some(unit)
}

/// ISO/IEC 14496-15 §5.3.3.1, with 4-byte NAL lengths.
fn avcc(sps: &[u8], pps: &[u8]) -> Option<Vec<u8>> {
    let [_, profile, compat, level, ..] = *sps else {
        return None;
    };
    let mut out = vec![1, profile, compat, level, 0xff, 0xe1];
    push16(&mut out, sps)?;
    out.push(1);
    push16(&mut out, pps)?;
    if !matches!(profile, 66 | 77 | 88) {
        // High profiles carry chroma format and bit depth: 4:2:0, 8-bit, no SPS extensions.
        out.extend_from_slice(&[0xfc | 1, 0xf8, 0xf8, 0]);
    }
    Some(out)
}

fn push16(out: &mut Vec<u8>, unit: &[u8]) -> Option<()> {
    out.extend_from_slice(&u16::try_from(unit.len()).ok()?.to_be_bytes());
    out.extend_from_slice(unit);
    Some(())
}

/// Emulation prevention removed (`00 00 03` → `00 00`).
fn rbsp(unit: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(unit.len());
    let mut zeros = 0;
    for &byte in unit {
        if zeros >= 2 && byte == 3 {
            zeros = 0;
            continue;
        }
        zeros = if byte == 0 { zeros + 1 } else { 0 };
        out.push(byte);
    }
    out
}

struct Bits<'a> {
    data: &'a [u8],
    at: usize,
}
impl Bits<'_> {
    fn bit(&mut self) -> Option<u32> {
        let byte = *self.data.get(self.at / 8)?;
        let bit = (byte >> (7 - self.at % 8)) & 1;
        self.at += 1;
        Some(u32::from(bit))
    }
    fn bits(&mut self, n: u32) -> Option<u32> {
        (0..n).try_fold(0, |acc, _| Some((acc << 1) | self.bit()?))
    }
    fn ue(&mut self) -> Option<u32> {
        let mut zeros = 0;
        while self.bit()? == 0 {
            zeros += 1;
            if zeros > 31 {
                return None;
            }
        }
        Some((1u32 << zeros) - 1 + self.bits(zeros)?)
    }
}

/// The fields of an H.265 SPS that `hvcC` repeats (H.265 §7.3.2.2).
struct HevcSps {
    /// profile_tier_level's general part: 12 bytes.
    general: [u8; 12],
    chroma_format: u32,
    luma_depth: u32,
    chroma_depth: u32,
    temporal_nesting: bool,
    sub_layers: u32,
}

fn hevc_sps(sps: &[u8]) -> Option<HevcSps> {
    let data = rbsp(sps.get(2..)?);
    let mut bits = Bits { data: &data, at: 0 };
    bits.bits(4)?; // sps_video_parameter_set_id
    let max_sub_layers_minus1 = bits.bits(3)?;
    let temporal_nesting = bits.bit()? == 1;
    let start = bits.at / 8;
    let general: [u8; 12] = data.get(start..start + 12)?.try_into().ok()?;
    bits.at += 96;
    // Sub-layer flags, alignment, then each present sub-layer's profile and level.
    let mut sub_profile = [false; 8];
    let mut sub_level = [false; 8];
    for i in 0..max_sub_layers_minus1 as usize {
        sub_profile[i] = bits.bit()? == 1;
        sub_level[i] = bits.bit()? == 1;
    }
    if max_sub_layers_minus1 > 0 {
        bits.at += 2 * (8 - max_sub_layers_minus1 as usize);
    }
    for i in 0..max_sub_layers_minus1 as usize {
        if sub_profile[i] {
            bits.at += 88;
        }
        if sub_level[i] {
            bits.at += 8;
        }
    }
    bits.ue()?; // sps_seq_parameter_set_id
    let chroma_format = bits.ue()?;
    if chroma_format == 3 {
        bits.bit()?;
    }
    bits.ue()?; // width
    bits.ue()?; // height
    if bits.bit()? == 1 {
        for _ in 0..4 {
            bits.ue()?; // conformance window
        }
    }
    let luma_depth = bits.ue()?;
    let chroma_depth = bits.ue()?;
    Some(HevcSps {
        general,
        chroma_format,
        luma_depth,
        chroma_depth,
        temporal_nesting,
        sub_layers: max_sub_layers_minus1 + 1,
    })
}

/// ISO/IEC 14496-15 §8.3.3.1, with 4-byte NAL lengths.
fn hvcc(vps: &[u8], sps: &[u8], pps: &[u8]) -> Option<Vec<u8>> {
    let info = hevc_sps(sps)?;
    let mut out = Vec::with_capacity(64 + vps.len() + sps.len() + pps.len());
    out.push(1);
    out.extend_from_slice(&info.general);
    out.extend_from_slice(&[0xf0, 0x00]); // min_spatial_segmentation_idc = 0
    out.push(0xfc); // parallelismType = 0
    out.push(0xfc | (info.chroma_format as u8 & 3));
    out.push(0xf8 | (info.luma_depth as u8 & 7));
    out.push(0xf8 | (info.chroma_depth as u8 & 7));
    out.extend_from_slice(&[0, 0]); // avgFrameRate
    out.push(((info.sub_layers as u8 & 7) << 3) | (u8::from(info.temporal_nesting) << 2) | 3);
    out.push(3);
    for (t, unit) in [(32u8, vps), (33, sps), (34, pps)] {
        out.push(0x80 | t);
        out.extend_from_slice(&1u16.to_be_bytes());
        push16(&mut out, unit)?;
    }
    Some(out)
}

/// The WebCodecs codec string for an `avcC` or `hvcC` record.
pub fn codec_string(codec: Codec, record: &[u8]) -> Option<String> {
    match codec {
        Codec::H264 => {
            let [_, profile, compat, level, ..] = *record else {
                return None;
            };
            Some(format!("avc1.{profile:02X}{compat:02X}{level:02X}"))
        }
        Codec::Hevc => {
            let first = *record.get(1)?;
            let space = ["", "A", "B", "C"][usize::from(first >> 6)];
            let tier = if first & 0x20 != 0 { 'H' } else { 'L' };
            let profile = first & 0x1f;
            let compat = u32::from_be_bytes(record.get(2..6)?.try_into().ok()?).reverse_bits();
            let constraints = record.get(6..12)?;
            let level = record.get(12)?;
            let used = constraints
                .iter()
                .rposition(|b| *b != 0)
                .map_or(0, |i| i + 1);
            let mut out = format!("hvc1.{space}{profile}.{compat:X}.{tier}{level}");
            for byte in &constraints[..used] {
                out.push_str(&format!(".{byte:X}"));
            }
            Some(out)
        }
        _ => None,
    }
}

#[cfg(test)]
#[path = "nal_tests.rs"]
mod tests;

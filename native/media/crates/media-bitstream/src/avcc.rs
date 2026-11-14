// SPDX-License-Identifier: Apache-2.0
//! `AVCDecoderConfigurationRecord` (ISO/IEC 14496-15 §5.3.3.1).
use crate::BitstreamError;
use crate::h264::Sps;

/// The High-profile tail: chroma format, bit depths and SPS extensions.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AvcHighExt {
    pub chroma_format: u8,
    pub bit_depth_luma_minus8: u8,
    pub bit_depth_chroma_minus8: u8,
    pub sps_ext: Vec<Vec<u8>>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AvcConfig {
    pub profile: u8,
    pub compatibility: u8,
    pub level: u8,
    /// 1, 2 or 4.
    pub length_size: u8,
    pub sps: Vec<Vec<u8>>,
    pub pps: Vec<Vec<u8>>,
    pub high: Option<AvcHighExt>,
}

fn is_high(profile: u8) -> bool {
    matches!(profile, 100 | 110 | 122 | 144)
}

struct Cursor<'a>(&'a [u8]);

impl<'a> Cursor<'a> {
    fn u8(&mut self) -> Result<u8, BitstreamError> {
        let (first, rest) = self.0.split_first().ok_or(BitstreamError::Truncated)?;
        self.0 = rest;
        Ok(*first)
    }
    fn bytes(&mut self, n: usize) -> Result<&'a [u8], BitstreamError> {
        let (head, rest) = self
            .0
            .split_at_checked(n)
            .ok_or(BitstreamError::Truncated)?;
        self.0 = rest;
        Ok(head)
    }
    fn unit(&mut self) -> Result<Vec<u8>, BitstreamError> {
        let len = u16::from_be_bytes([self.u8()?, self.u8()?]);
        Ok(self.bytes(usize::from(len))?.to_vec())
    }
}

pub(crate) fn push_unit(out: &mut Vec<u8>, unit: &[u8]) -> Result<(), BitstreamError> {
    let len =
        u16::try_from(unit.len()).map_err(|_| BitstreamError::Invalid("parameter set too long"))?;
    out.extend_from_slice(&len.to_be_bytes());
    out.extend_from_slice(unit);
    Ok(())
}

pub(crate) fn read_unit(data: &mut &[u8]) -> Result<Vec<u8>, BitstreamError> {
    let mut c = Cursor(data);
    let unit = c.unit()?;
    *data = c.0;
    Ok(unit)
}

impl AvcConfig {
    /// The record for one SPS and one PPS NAL unit (no start codes), with 4-byte lengths.
    pub fn from_parameter_sets(sps: &[u8], pps: &[u8]) -> Result<Self, BitstreamError> {
        let parsed = Sps::parse(sps)?;
        let high = is_high(parsed.profile_idc).then(|| {
            let c = parsed
                .chroma
                .unwrap_or(crate::h264::ChromaInfo::YUV420_8BIT);
            AvcHighExt {
                chroma_format: c.chroma_format_idc as u8,
                bit_depth_luma_minus8: c.bit_depth_luma_minus8 as u8,
                bit_depth_chroma_minus8: c.bit_depth_chroma_minus8 as u8,
                sps_ext: Vec::new(),
            }
        });
        Ok(Self {
            profile: parsed.profile_idc,
            compatibility: parsed.constraint_flags,
            level: parsed.level_idc,
            length_size: 4,
            sps: vec![sps.to_vec()],
            pps: vec![pps.to_vec()],
            high,
        })
    }

    /// The WebCodecs / RFC 6381 codec string, `avc1.PPCCLL`.
    pub fn codec_string(&self) -> String {
        format!(
            "avc1.{:02x}{:02x}{:02x}",
            self.profile, self.compatibility, self.level
        )
    }

    pub fn parse(record: &[u8]) -> Result<Self, BitstreamError> {
        let mut c = Cursor(record);
        if c.u8()? != 1 {
            return Err(BitstreamError::Invalid("avcC configurationVersion"));
        }
        let profile = c.u8()?;
        let compatibility = c.u8()?;
        let level = c.u8()?;
        let length_size = (c.u8()? & 3) + 1;
        if length_size == 3 {
            return Err(BitstreamError::Invalid("avcC lengthSizeMinusOne"));
        }
        let sps_count = c.u8()? & 0x1f;
        let sps = (0..sps_count).map(|_| c.unit()).collect::<Result<_, _>>()?;
        let pps_count = c.u8()?;
        let pps = (0..pps_count).map(|_| c.unit()).collect::<Result<_, _>>()?;
        // Writers before 14496-15:2010 left the High tail out; accept both.
        let high = if is_high(profile) && !c.0.is_empty() {
            let chroma_format = c.u8()? & 3;
            let bit_depth_luma_minus8 = c.u8()? & 7;
            let bit_depth_chroma_minus8 = c.u8()? & 7;
            let count = c.u8()?;
            let sps_ext = (0..count).map(|_| c.unit()).collect::<Result<_, _>>()?;
            Some(AvcHighExt {
                chroma_format,
                bit_depth_luma_minus8,
                bit_depth_chroma_minus8,
                sps_ext,
            })
        } else {
            None
        };
        Ok(Self {
            profile,
            compatibility,
            level,
            length_size,
            sps,
            pps,
            high,
        })
    }

    pub fn to_bytes(&self) -> Result<Vec<u8>, BitstreamError> {
        if self.sps.len() > 31 || self.pps.len() > 255 {
            return Err(BitstreamError::Invalid("too many parameter sets"));
        }
        let mut out = vec![
            1,
            self.profile,
            self.compatibility,
            self.level,
            0xfc | (self.length_size.saturating_sub(1) & 3),
            0xe0 | self.sps.len() as u8,
        ];
        for unit in &self.sps {
            push_unit(&mut out, unit)?;
        }
        out.push(self.pps.len() as u8);
        for unit in &self.pps {
            push_unit(&mut out, unit)?;
        }
        if let Some(h) = &self.high {
            out.push(0xfc | (h.chroma_format & 3));
            out.push(0xf8 | (h.bit_depth_luma_minus8 & 7));
            out.push(0xf8 | (h.bit_depth_chroma_minus8 & 7));
            out.push(h.sps_ext.len() as u8);
            for unit in &h.sps_ext {
                push_unit(&mut out, unit)?;
            }
        }
        Ok(out)
    }
}

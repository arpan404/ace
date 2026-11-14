// SPDX-License-Identifier: Apache-2.0
//! `HEVCDecoderConfigurationRecord` (ISO/IEC 14496-15 §8.3.3.1).
use crate::BitstreamError;
use crate::avcc::{push_unit, read_unit};
use crate::hevc::{Pps, Sps};
use crate::nal::hevc::{PPS, SPS, VPS};

/// One NAL unit array of the record.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NalArray {
    pub complete: bool,
    pub nal_unit_type: u8,
    pub units: Vec<Vec<u8>>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HevcConfig {
    /// Profile space, tier, profile, compatibility flags, constraint flags and level, as in
    /// the SPS's `profile_tier_level`.
    pub general: [u8; 12],
    pub min_spatial_segmentation_idc: u16,
    pub parallelism_type: u8,
    pub chroma_format: u8,
    pub bit_depth_luma_minus8: u8,
    pub bit_depth_chroma_minus8: u8,
    pub avg_frame_rate: u16,
    pub constant_frame_rate: u8,
    pub num_temporal_layers: u8,
    pub temporal_id_nested: bool,
    pub length_size: u8,
    pub arrays: Vec<NalArray>,
}

impl HevcConfig {
    /// The record for one VPS, SPS and PPS NAL unit each (no start codes), 4-byte lengths.
    pub fn from_parameter_sets(vps: &[u8], sps: &[u8], pps: &[u8]) -> Result<Self, BitstreamError> {
        let parsed = Sps::parse(sps)?;
        let pps_parsed = Pps::parse(pps)?;
        let min_spatial = parsed
            .vui
            .as_ref()
            .and_then(|v| v.restriction)
            .map_or(0, |r| r.min_spatial_segmentation_idc as u16);
        let array = |nal_unit_type, unit: &[u8]| NalArray {
            complete: true,
            nal_unit_type,
            units: vec![unit.to_vec()],
        };
        Ok(Self {
            general: parsed.ptl.general_bytes(),
            min_spatial_segmentation_idc: min_spatial,
            // 0 mixed or unknown, 3 wavefront.
            parallelism_type: if min_spatial == 0 {
                0
            } else if pps_parsed.entropy_coding_sync_enabled {
                3
            } else {
                1
            },
            chroma_format: parsed.chroma_format_idc as u8,
            bit_depth_luma_minus8: parsed.bit_depth_luma_minus8 as u8,
            bit_depth_chroma_minus8: parsed.bit_depth_chroma_minus8 as u8,
            avg_frame_rate: 0,
            constant_frame_rate: 0,
            num_temporal_layers: parsed.max_sub_layers_minus1 + 1,
            temporal_id_nested: parsed.temporal_id_nesting,
            length_size: 4,
            arrays: vec![array(VPS, vps), array(SPS, sps), array(PPS, pps)],
        })
    }

    pub fn parse(record: &[u8]) -> Result<Self, BitstreamError> {
        let (head, mut rest) = record
            .split_at_checked(23)
            .ok_or(BitstreamError::Truncated)?;
        if head[0] != 1 {
            return Err(BitstreamError::Invalid("hvcC configurationVersion"));
        }
        let mut general = [0u8; 12];
        general.copy_from_slice(&head[1..13]);
        let flags = head[21];
        let length_size = (flags & 3) + 1;
        if length_size == 3 {
            return Err(BitstreamError::Invalid("hvcC lengthSizeMinusOne"));
        }
        let mut arrays = Vec::with_capacity(usize::from(head[22]));
        for _ in 0..head[22] {
            let (&kind, tail) = rest.split_first().ok_or(BitstreamError::Truncated)?;
            let (count, tail) = tail.split_at_checked(2).ok_or(BitstreamError::Truncated)?;
            rest = tail;
            let count = u16::from_be_bytes([count[0], count[1]]);
            let units = (0..count)
                .map(|_| read_unit(&mut rest))
                .collect::<Result<_, _>>()?;
            arrays.push(NalArray {
                complete: kind & 0x80 != 0,
                nal_unit_type: kind & 0x3f,
                units,
            });
        }
        Ok(Self {
            general,
            min_spatial_segmentation_idc: u16::from_be_bytes([head[13], head[14]]) & 0x0fff,
            parallelism_type: head[15] & 3,
            chroma_format: head[16] & 3,
            bit_depth_luma_minus8: head[17] & 7,
            bit_depth_chroma_minus8: head[18] & 7,
            avg_frame_rate: u16::from_be_bytes([head[19], head[20]]),
            constant_frame_rate: flags >> 6,
            num_temporal_layers: (flags >> 3) & 7,
            temporal_id_nested: flags & 4 != 0,
            length_size,
            arrays,
        })
    }

    pub fn to_bytes(&self) -> Result<Vec<u8>, BitstreamError> {
        if self.arrays.len() > 255 {
            return Err(BitstreamError::Invalid("too many NAL arrays"));
        }
        let mut out = Vec::with_capacity(64);
        out.push(1);
        out.extend_from_slice(&self.general);
        out.extend_from_slice(
            &(0xf000 | (self.min_spatial_segmentation_idc & 0x0fff)).to_be_bytes(),
        );
        out.push(0xfc | (self.parallelism_type & 3));
        out.push(0xfc | (self.chroma_format & 3));
        out.push(0xf8 | (self.bit_depth_luma_minus8 & 7));
        out.push(0xf8 | (self.bit_depth_chroma_minus8 & 7));
        out.extend_from_slice(&self.avg_frame_rate.to_be_bytes());
        out.push(
            ((self.constant_frame_rate & 3) << 6)
                | ((self.num_temporal_layers & 7) << 3)
                | (u8::from(self.temporal_id_nested) << 2)
                | (self.length_size.saturating_sub(1) & 3),
        );
        out.push(self.arrays.len() as u8);
        for array in &self.arrays {
            out.push((u8::from(array.complete) << 7) | (array.nal_unit_type & 0x3f));
            let count = u16::try_from(array.units.len())
                .map_err(|_| BitstreamError::Invalid("too many NAL units"))?;
            out.extend_from_slice(&count.to_be_bytes());
            for unit in &array.units {
                push_unit(&mut out, unit)?;
            }
        }
        Ok(out)
    }
}

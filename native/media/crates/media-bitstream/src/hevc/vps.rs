// SPDX-License-Identifier: Apache-2.0
//! `video_parameter_set_rbsp()` (H.265 §7.3.2.1) for a single-layer stream.
use super::{ProfileTierLevel, SubLayerOrdering, read_ordering, write_ordering};
use crate::nal::hevc::{VPS, header};
use crate::{BitReader, BitWriter, BitstreamError, nal_unit, rbsp_of};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Vps {
    pub id: u8,
    pub base_layer_internal: bool,
    pub base_layer_available: bool,
    pub max_sub_layers_minus1: u8,
    pub temporal_id_nesting: bool,
    pub ptl: ProfileTierLevel,
    pub sub_layer_ordering_info_present: bool,
    pub ordering: Vec<SubLayerOrdering>,
    /// `(num_units_in_tick, time_scale, num_ticks_poc_diff_one_minus1)`.
    pub timing: Option<(u32, u32, Option<u32>)>,
}

impl Vps {
    pub fn single_layer(ptl: ProfileTierLevel, max_dec_pic_buffering_minus1: u32) -> Self {
        Self {
            id: 0,
            base_layer_internal: true,
            base_layer_available: true,
            max_sub_layers_minus1: 0,
            temporal_id_nesting: true,
            ptl,
            sub_layer_ordering_info_present: true,
            ordering: vec![SubLayerOrdering {
                max_dec_pic_buffering_minus1,
                max_num_reorder_pics: 0,
                max_latency_increase_plus1: 0,
            }],
            timing: None,
        }
    }

    pub fn parse(nal: &[u8]) -> Result<Self, BitstreamError> {
        if crate::nal::hevc::unit_type(nal) != Some(VPS) {
            return Err(BitstreamError::Invalid("not a VPS"));
        }
        let rbsp = rbsp_of(nal, 2)?;
        let r = &mut BitReader::new(&rbsp);
        let id = r.u8(4)?;
        let base_layer_internal = r.flag()?;
        let base_layer_available = r.flag()?;
        if r.bits(6)? != 0 {
            return Err(BitstreamError::Unsupported("multi-layer VPS"));
        }
        let max_sub_layers_minus1 = r.u8(3)?;
        let temporal_id_nesting = r.flag()?;
        if r.bits(16)? != 0xffff {
            return Err(BitstreamError::Invalid("vps_reserved_0xffff_16bits"));
        }
        let ptl = ProfileTierLevel::read(r, max_sub_layers_minus1)?;
        let (sub_layer_ordering_info_present, ordering) = read_ordering(r, max_sub_layers_minus1)?;
        let _max_layer_id = r.bits(6)?;
        if r.ue()? != 0 {
            return Err(BitstreamError::Unsupported("VPS layer sets"));
        }
        let timing = if r.flag()? {
            let units = r.bits(32)?;
            let scale = r.bits(32)?;
            let ticks = if r.flag()? { Some(r.ue()?) } else { None };
            if r.ue()? != 0 {
                return Err(BitstreamError::Unsupported("VPS HRD parameters"));
            }
            Some((units, scale, ticks))
        } else {
            None
        };
        if r.flag()? {
            return Err(BitstreamError::Unsupported("VPS extension"));
        }
        r.trailing()?;
        Ok(Self {
            id,
            base_layer_internal,
            base_layer_available,
            max_sub_layers_minus1,
            temporal_id_nesting,
            ptl,
            sub_layer_ordering_info_present,
            ordering,
            timing,
        })
    }

    pub fn rbsp(&self) -> Vec<u8> {
        let mut w = BitWriter::new();
        w.bits(u32::from(self.id), 4);
        w.bit(self.base_layer_internal);
        w.bit(self.base_layer_available);
        w.bits(0, 6); // vps_max_layers_minus1
        w.bits(u32::from(self.max_sub_layers_minus1), 3);
        w.bit(self.temporal_id_nesting);
        w.bits(0xffff, 16);
        self.ptl.write(&mut w);
        write_ordering(&mut w, self.sub_layer_ordering_info_present, &self.ordering);
        w.bits(0, 6); // vps_max_layer_id
        w.ue(0); // vps_num_layer_sets_minus1
        w.bit(self.timing.is_some());
        if let Some((units, scale, ticks)) = self.timing {
            w.bits(units, 32);
            w.bits(scale, 32);
            w.bit(ticks.is_some());
            if let Some(t) = ticks {
                w.ue(t);
            }
            w.ue(0); // vps_num_hrd_parameters
        }
        w.bit(false); // vps_extension_flag
        w.trailing();
        w.into_bytes()
    }

    pub fn to_nal(&self) -> Vec<u8> {
        nal_unit(&header(VPS, 0), &self.rbsp())
    }
}

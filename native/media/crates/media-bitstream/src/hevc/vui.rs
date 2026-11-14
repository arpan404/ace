// SPDX-License-Identifier: Apache-2.0
//! `vui_parameters()` (H.265 E.2.1), without HRD parameters.
use crate::vui::{
    read_aspect, read_optional_flag, read_pair, read_signal, write_aspect, write_optional_flag,
    write_pair, write_signal,
};
use crate::{AspectRatio, BitReader, BitWriter, BitstreamError, VideoSignal};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Timing {
    pub num_units_in_tick: u32,
    pub time_scale: u32,
    pub num_ticks_poc_diff_one_minus1: Option<u32>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Restriction {
    pub tiles_fixed_structure: bool,
    pub motion_vectors_over_pic_boundaries: bool,
    pub restricted_ref_pic_lists: bool,
    pub min_spatial_segmentation_idc: u32,
    pub max_bytes_per_pic_denom: u32,
    pub max_bits_per_min_cu_denom: u32,
    pub log2_max_mv_length_horizontal: u32,
    pub log2_max_mv_length_vertical: u32,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Vui {
    pub aspect_ratio: Option<AspectRatio>,
    pub overscan_appropriate: Option<bool>,
    pub signal: Option<VideoSignal>,
    pub chroma_loc: Option<(u32, u32)>,
    pub neutral_chroma_indication: bool,
    pub field_seq: bool,
    pub frame_field_info_present: bool,
    /// left, right, top, bottom offsets.
    pub default_display_window: Option<[u32; 4]>,
    pub timing: Option<Timing>,
    pub restriction: Option<Restriction>,
}

impl Vui {
    pub(crate) fn read(r: &mut BitReader<'_>) -> Result<Self, BitstreamError> {
        let aspect_ratio = read_aspect(r)?;
        let overscan_appropriate = read_optional_flag(r)?;
        let signal = read_signal(r)?;
        let chroma_loc = read_pair(r)?;
        let neutral_chroma_indication = r.flag()?;
        let field_seq = r.flag()?;
        let frame_field_info_present = r.flag()?;
        let default_display_window = if r.flag()? {
            Some([r.ue()?, r.ue()?, r.ue()?, r.ue()?])
        } else {
            None
        };
        let timing = if r.flag()? {
            let num_units_in_tick = r.bits(32)?;
            let time_scale = r.bits(32)?;
            let num_ticks_poc_diff_one_minus1 = if r.flag()? { Some(r.ue()?) } else { None };
            if r.flag()? {
                return Err(BitstreamError::Unsupported("HEVC VUI HRD parameters"));
            }
            Some(Timing {
                num_units_in_tick,
                time_scale,
                num_ticks_poc_diff_one_minus1,
            })
        } else {
            None
        };
        let restriction = if r.flag()? {
            Some(Restriction {
                tiles_fixed_structure: r.flag()?,
                motion_vectors_over_pic_boundaries: r.flag()?,
                restricted_ref_pic_lists: r.flag()?,
                min_spatial_segmentation_idc: r.ue_max(4095, "min_spatial_segmentation_idc")?,
                max_bytes_per_pic_denom: r.ue()?,
                max_bits_per_min_cu_denom: r.ue()?,
                log2_max_mv_length_horizontal: r.ue()?,
                log2_max_mv_length_vertical: r.ue()?,
            })
        } else {
            None
        };
        Ok(Self {
            aspect_ratio,
            overscan_appropriate,
            signal,
            chroma_loc,
            neutral_chroma_indication,
            field_seq,
            frame_field_info_present,
            default_display_window,
            timing,
            restriction,
        })
    }

    pub(crate) fn write(&self, w: &mut BitWriter) {
        write_aspect(w, self.aspect_ratio);
        write_optional_flag(w, self.overscan_appropriate);
        write_signal(w, self.signal);
        write_pair(w, self.chroma_loc);
        w.bit(self.neutral_chroma_indication);
        w.bit(self.field_seq);
        w.bit(self.frame_field_info_present);
        w.bit(self.default_display_window.is_some());
        if let Some(window) = self.default_display_window {
            for v in window {
                w.ue(v);
            }
        }
        w.bit(self.timing.is_some());
        if let Some(t) = self.timing {
            w.bits(t.num_units_in_tick, 32);
            w.bits(t.time_scale, 32);
            w.bit(t.num_ticks_poc_diff_one_minus1.is_some());
            if let Some(n) = t.num_ticks_poc_diff_one_minus1 {
                w.ue(n);
            }
            w.bit(false); // vui_hrd_parameters_present_flag
        }
        w.bit(self.restriction.is_some());
        if let Some(b) = self.restriction {
            w.bit(b.tiles_fixed_structure);
            w.bit(b.motion_vectors_over_pic_boundaries);
            w.bit(b.restricted_ref_pic_lists);
            w.ue(b.min_spatial_segmentation_idc);
            w.ue(b.max_bytes_per_pic_denom);
            w.ue(b.max_bits_per_min_cu_denom);
            w.ue(b.log2_max_mv_length_horizontal);
            w.ue(b.log2_max_mv_length_vertical);
        }
    }
}

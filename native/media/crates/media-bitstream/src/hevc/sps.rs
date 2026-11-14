// SPDX-License-Identifier: Apache-2.0
//! `seq_parameter_set_rbsp()` (H.265 §7.3.2.2.1) and `st_ref_pic_set()` (§7.3.7).
use super::{ProfileTierLevel, SubLayerOrdering, Vui, read_ordering, write_ordering};
use crate::nal::hevc::{SPS, header};
use crate::{BitReader, BitWriter, BitstreamError, nal_unit, rbsp_of};

/// The conformance window, in chroma sample units (2 luma samples for 4:2:0).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Conformance {
    pub left: u32,
    pub right: u32,
    pub top: u32,
    pub bottom: u32,
}

/// A short-term reference picture set coded explicitly (no inter-RPS prediction):
/// `(delta_poc_minus1, used_by_curr_pic)` for each picture before and after.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ShortTermRps {
    pub negative: Vec<(u32, bool)>,
    pub positive: Vec<(u32, bool)>,
}

impl ShortTermRps {
    /// Only the previous picture, used for reference: the IPPP set.
    pub fn previous_only() -> Self {
        Self {
            negative: vec![(0, true)],
            positive: Vec::new(),
        }
    }

    /// `NumPicTotalCurr` from the short-term pictures.
    pub fn used_count(&self) -> u32 {
        self.negative
            .iter()
            .chain(&self.positive)
            .filter(|(_, used)| *used)
            .count() as u32
    }

    pub(crate) fn read(r: &mut BitReader<'_>, index: u32) -> Result<Self, BitstreamError> {
        if index != 0 && r.flag()? {
            return Err(BitstreamError::Unsupported("inter-RPS prediction"));
        }
        let negatives = r.ue_max(16, "num_negative_pics")?;
        let positives = r.ue_max(16, "num_positive_pics")?;
        let mut set = Self::default();
        for _ in 0..negatives {
            set.negative
                .push((r.ue_max(32767, "delta_poc_s0_minus1")?, r.flag()?));
        }
        for _ in 0..positives {
            set.positive
                .push((r.ue_max(32767, "delta_poc_s1_minus1")?, r.flag()?));
        }
        Ok(set)
    }

    pub(crate) fn write(&self, w: &mut BitWriter, index: u32) {
        if index != 0 {
            w.bit(false); // inter_ref_pic_set_prediction_flag
        }
        w.ue(self.negative.len() as u32);
        w.ue(self.positive.len() as u32);
        for (delta, used) in self.negative.iter().chain(&self.positive) {
            w.ue(*delta);
            w.bit(*used);
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Sps {
    pub vps_id: u8,
    pub max_sub_layers_minus1: u8,
    pub temporal_id_nesting: bool,
    pub ptl: ProfileTierLevel,
    pub id: u32,
    pub chroma_format_idc: u32,
    pub separate_colour_plane: bool,
    pub pic_width_in_luma_samples: u32,
    pub pic_height_in_luma_samples: u32,
    pub conformance: Option<Conformance>,
    pub bit_depth_luma_minus8: u32,
    pub bit_depth_chroma_minus8: u32,
    pub log2_max_pic_order_cnt_lsb_minus4: u32,
    pub sub_layer_ordering_info_present: bool,
    pub ordering: Vec<SubLayerOrdering>,
    pub log2_min_luma_coding_block_size_minus3: u32,
    pub log2_diff_max_min_luma_coding_block_size: u32,
    pub log2_min_luma_transform_block_size_minus2: u32,
    pub log2_diff_max_min_luma_transform_block_size: u32,
    pub max_transform_hierarchy_depth_inter: u32,
    pub max_transform_hierarchy_depth_intra: u32,
    /// With the default lists; explicit lists are unsupported.
    pub scaling_list_enabled: bool,
    pub amp_enabled: bool,
    pub sample_adaptive_offset_enabled: bool,
    /// `(luma bits − 1, chroma bits − 1, log2 min size − 3, log2 diff, loop filter disabled)`.
    pub pcm: Option<(u8, u8, u32, u32, bool)>,
    pub short_term_rps: Vec<ShortTermRps>,
    /// `long_term_ref_pics_present_flag` with its SPS candidates `(poc_lsb, used)`.
    pub long_term: Option<Vec<(u32, bool)>>,
    pub temporal_mvp_enabled: bool,
    pub strong_intra_smoothing_enabled: bool,
    pub vui: Option<Vui>,
    /// `sps_extension_present_flag` with every extension flag zero.
    pub extension_present: bool,
}

impl Sps {
    /// A progressive 4:2:0 8-bit SPS whose coded size is `width`×`height` rounded up to
    /// `align` (a multiple of the minimum coding block, 8), cropped back to the exact size.
    #[allow(clippy::too_many_arguments)]
    pub fn progressive(
        ptl: ProfileTierLevel,
        width: u32,
        height: u32,
        align: u32,
        log2_ctb_size: u32,
        max_dec_pic_buffering_minus1: u32,
        short_term_rps: Vec<ShortTermRps>,
        vui: Option<Vui>,
    ) -> Self {
        let coded_w = width.div_ceil(align) * align;
        let coded_h = height.div_ceil(align) * align;
        let conformance = Conformance {
            left: 0,
            right: (coded_w - width) / 2,
            top: 0,
            bottom: (coded_h - height) / 2,
        };
        Self {
            vps_id: 0,
            max_sub_layers_minus1: 0,
            temporal_id_nesting: true,
            ptl,
            id: 0,
            chroma_format_idc: 1,
            separate_colour_plane: false,
            pic_width_in_luma_samples: coded_w,
            pic_height_in_luma_samples: coded_h,
            conformance: (conformance != Conformance::default()).then_some(conformance),
            bit_depth_luma_minus8: 0,
            bit_depth_chroma_minus8: 0,
            log2_max_pic_order_cnt_lsb_minus4: 4,
            sub_layer_ordering_info_present: true,
            ordering: vec![SubLayerOrdering {
                max_dec_pic_buffering_minus1,
                max_num_reorder_pics: 0,
                max_latency_increase_plus1: 0,
            }],
            log2_min_luma_coding_block_size_minus3: 0,
            log2_diff_max_min_luma_coding_block_size: log2_ctb_size.saturating_sub(3),
            log2_min_luma_transform_block_size_minus2: 0,
            log2_diff_max_min_luma_transform_block_size: 3,
            max_transform_hierarchy_depth_inter: 2,
            max_transform_hierarchy_depth_intra: 2,
            scaling_list_enabled: false,
            amp_enabled: true,
            sample_adaptive_offset_enabled: true,
            pcm: None,
            short_term_rps,
            long_term: None,
            temporal_mvp_enabled: false,
            strong_intra_smoothing_enabled: true,
            vui,
            extension_present: false,
        }
    }

    pub fn log2_max_poc_lsb(&self) -> u32 {
        self.log2_max_pic_order_cnt_lsb_minus4 + 4
    }

    pub fn log2_ctb_size(&self) -> u32 {
        self.log2_min_luma_coding_block_size_minus3
            + 3
            + self.log2_diff_max_min_luma_coding_block_size
    }

    /// `PicSizeInCtbsY`.
    pub fn ctb_count(&self) -> u32 {
        let ctb = 1 << self.log2_ctb_size();
        self.pic_width_in_luma_samples.div_ceil(ctb) * self.pic_height_in_luma_samples.div_ceil(ctb)
    }

    /// `ChromaArrayType`.
    pub fn chroma_array_type(&self) -> u32 {
        if self.separate_colour_plane {
            0
        } else {
            self.chroma_format_idc
        }
    }

    /// The displayed size, after the conformance window.
    pub fn frame_size(&self) -> (u32, u32) {
        let (sub_w, sub_h) = match self.chroma_array_type() {
            1 => (2, 2),
            2 => (2, 1),
            _ => (1, 1),
        };
        let c = self.conformance.unwrap_or_default();
        (
            self.pic_width_in_luma_samples
                .saturating_sub(sub_w * (c.left + c.right)),
            self.pic_height_in_luma_samples
                .saturating_sub(sub_h * (c.top + c.bottom)),
        )
    }

    pub fn parse(nal: &[u8]) -> Result<Self, BitstreamError> {
        if crate::nal::hevc::unit_type(nal) != Some(SPS) {
            return Err(BitstreamError::Invalid("not an SPS"));
        }
        let rbsp = rbsp_of(nal, 2)?;
        let r = &mut BitReader::new(&rbsp);
        let vps_id = r.u8(4)?;
        let max_sub_layers_minus1 = r.u8(3)?;
        if max_sub_layers_minus1 > 6 {
            return Err(BitstreamError::Invalid("sps_max_sub_layers_minus1"));
        }
        let temporal_id_nesting = r.flag()?;
        let ptl = ProfileTierLevel::read(r, max_sub_layers_minus1)?;
        let id = r.ue_max(15, "sps_seq_parameter_set_id")?;
        let chroma_format_idc = r.ue_max(3, "chroma_format_idc")?;
        let separate_colour_plane = chroma_format_idc == 3 && r.flag()?;
        let pic_width_in_luma_samples = r.ue_max(16888, "pic_width_in_luma_samples")?;
        let pic_height_in_luma_samples = r.ue_max(16888, "pic_height_in_luma_samples")?;
        let conformance = if r.flag()? {
            Some(Conformance {
                left: r.ue()?,
                right: r.ue()?,
                top: r.ue()?,
                bottom: r.ue()?,
            })
        } else {
            None
        };
        let bit_depth_luma_minus8 = r.ue_max(8, "bit_depth_luma_minus8")?;
        let bit_depth_chroma_minus8 = r.ue_max(8, "bit_depth_chroma_minus8")?;
        let log2_max_pic_order_cnt_lsb_minus4 = r.ue_max(12, "log2_max_poc_lsb_minus4")?;
        let (sub_layer_ordering_info_present, ordering) = read_ordering(r, max_sub_layers_minus1)?;
        let log2_min_luma_coding_block_size_minus3 = r.ue_max(3, "log2_min_cb_minus3")?;
        let log2_diff_max_min_luma_coding_block_size = r.ue_max(3, "log2_diff_max_min_cb")?;
        let log2_min_luma_transform_block_size_minus2 = r.ue_max(3, "log2_min_tb_minus2")?;
        let log2_diff_max_min_luma_transform_block_size = r.ue_max(3, "log2_diff_max_min_tb")?;
        let max_transform_hierarchy_depth_inter = r.ue_max(4, "max_th_depth_inter")?;
        let max_transform_hierarchy_depth_intra = r.ue_max(4, "max_th_depth_intra")?;
        let scaling_list_enabled = r.flag()?;
        if scaling_list_enabled && r.flag()? {
            return Err(BitstreamError::Unsupported("explicit scaling lists"));
        }
        let amp_enabled = r.flag()?;
        let sample_adaptive_offset_enabled = r.flag()?;
        let pcm = if r.flag()? {
            Some((
                r.u8(4)?,
                r.u8(4)?,
                r.ue_max(2, "pcm size")?,
                r.ue_max(2, "pcm diff")?,
                r.flag()?,
            ))
        } else {
            None
        };
        let sets = r.ue_max(64, "num_short_term_ref_pic_sets")?;
        let short_term_rps = (0..sets)
            .map(|i| ShortTermRps::read(r, i))
            .collect::<Result<_, _>>()?;
        let long_term = if r.flag()? {
            let count = r.ue_max(32, "num_long_term_ref_pics_sps")?;
            let bits = (log2_max_pic_order_cnt_lsb_minus4 + 4) as u8;
            let mut list = Vec::new();
            for _ in 0..count {
                list.push((r.bits(bits)?, r.flag()?));
            }
            Some(list)
        } else {
            None
        };
        let temporal_mvp_enabled = r.flag()?;
        let strong_intra_smoothing_enabled = r.flag()?;
        let vui = if r.flag()? { Some(Vui::read(r)?) } else { None };
        let extension_present = r.flag()?;
        if extension_present && r.bits(8)? != 0 {
            return Err(BitstreamError::Unsupported("SPS extensions"));
        }
        r.trailing()?;
        Ok(Self {
            vps_id,
            max_sub_layers_minus1,
            temporal_id_nesting,
            ptl,
            id,
            chroma_format_idc,
            separate_colour_plane,
            pic_width_in_luma_samples,
            pic_height_in_luma_samples,
            conformance,
            bit_depth_luma_minus8,
            bit_depth_chroma_minus8,
            log2_max_pic_order_cnt_lsb_minus4,
            sub_layer_ordering_info_present,
            ordering,
            log2_min_luma_coding_block_size_minus3,
            log2_diff_max_min_luma_coding_block_size,
            log2_min_luma_transform_block_size_minus2,
            log2_diff_max_min_luma_transform_block_size,
            max_transform_hierarchy_depth_inter,
            max_transform_hierarchy_depth_intra,
            scaling_list_enabled,
            amp_enabled,
            sample_adaptive_offset_enabled,
            pcm,
            short_term_rps,
            long_term,
            temporal_mvp_enabled,
            strong_intra_smoothing_enabled,
            vui,
            extension_present,
        })
    }

    pub fn rbsp(&self) -> Vec<u8> {
        let mut w = BitWriter::new();
        w.bits(u32::from(self.vps_id), 4);
        w.bits(u32::from(self.max_sub_layers_minus1), 3);
        w.bit(self.temporal_id_nesting);
        self.ptl.write(&mut w);
        w.ue(self.id);
        w.ue(self.chroma_format_idc);
        if self.chroma_format_idc == 3 {
            w.bit(self.separate_colour_plane);
        }
        w.ue(self.pic_width_in_luma_samples);
        w.ue(self.pic_height_in_luma_samples);
        w.bit(self.conformance.is_some());
        if let Some(c) = self.conformance {
            for v in [c.left, c.right, c.top, c.bottom] {
                w.ue(v);
            }
        }
        w.ue(self.bit_depth_luma_minus8);
        w.ue(self.bit_depth_chroma_minus8);
        w.ue(self.log2_max_pic_order_cnt_lsb_minus4);
        write_ordering(&mut w, self.sub_layer_ordering_info_present, &self.ordering);
        w.ue(self.log2_min_luma_coding_block_size_minus3);
        w.ue(self.log2_diff_max_min_luma_coding_block_size);
        w.ue(self.log2_min_luma_transform_block_size_minus2);
        w.ue(self.log2_diff_max_min_luma_transform_block_size);
        w.ue(self.max_transform_hierarchy_depth_inter);
        w.ue(self.max_transform_hierarchy_depth_intra);
        w.bit(self.scaling_list_enabled);
        if self.scaling_list_enabled {
            w.bit(false); // sps_scaling_list_data_present_flag
        }
        w.bit(self.amp_enabled);
        w.bit(self.sample_adaptive_offset_enabled);
        w.bit(self.pcm.is_some());
        if let Some((luma, chroma, size, diff, loop_off)) = self.pcm {
            w.bits(u32::from(luma), 4);
            w.bits(u32::from(chroma), 4);
            w.ue(size);
            w.ue(diff);
            w.bit(loop_off);
        }
        w.ue(self.short_term_rps.len() as u32);
        for (i, set) in self.short_term_rps.iter().enumerate() {
            set.write(&mut w, i as u32);
        }
        w.bit(self.long_term.is_some());
        if let Some(list) = &self.long_term {
            w.ue(list.len() as u32);
            for (lsb, used) in list {
                w.bits(*lsb, self.log2_max_poc_lsb() as u8);
                w.bit(*used);
            }
        }
        w.bit(self.temporal_mvp_enabled);
        w.bit(self.strong_intra_smoothing_enabled);
        w.bit(self.vui.is_some());
        if let Some(vui) = &self.vui {
            vui.write(&mut w);
        }
        w.bit(self.extension_present);
        if self.extension_present {
            w.bits(0, 8);
        }
        w.trailing();
        w.into_bytes()
    }

    pub fn to_nal(&self) -> Vec<u8> {
        nal_unit(&header(SPS, 0), &self.rbsp())
    }
}

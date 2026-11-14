// SPDX-License-Identifier: Apache-2.0
//! `slice_segment_header()` (H.265 §7.3.6.1) and `ref_pic_lists_modification()` (§7.3.6.2),
//! without long-term pictures. The writer stops before `byte_alignment()`, which is where VA-API's
//! packed slice header ends.
use super::{Pps, ShortTermRps, Sps};
use crate::nal::hevc::{self, header, is_idr_type, is_irap_type};
use crate::{BitReader, BitWriter, BitstreamError, PredWeightTable, rbsp_of};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SliceType {
    B,
    P,
    I,
}

impl SliceType {
    pub fn code(self) -> u32 {
        match self {
            Self::B => 0,
            Self::P => 1,
            Self::I => 2,
        }
    }
}

/// Which short-term reference picture set a slice uses.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RpsChoice {
    Sps(u32),
    Explicit(ShortTermRps),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SliceSegmentHeader {
    pub nal_unit_type: u8,
    pub temporal_id: u8,
    pub first_slice_segment_in_pic: bool,
    pub no_output_of_prior_pics: bool,
    pub pps_id: u32,
    pub dependent_slice_segment: bool,
    pub slice_segment_address: u32,
    pub reserved_flags: u8,
    pub slice_type: SliceType,
    pub pic_output: bool,
    pub colour_plane_id: u8,
    /// Coded for non-IDR pictures.
    pub pic_order_cnt_lsb: u32,
    pub rps: RpsChoice,
    pub temporal_mvp_enabled: bool,
    pub sao_luma: bool,
    pub sao_chroma: bool,
    pub num_ref_idx_override: Option<(u32, u32)>,
    /// `list_entry_l0[]` and `list_entry_l1[]` when their modification flags are set.
    pub list_entries: (Option<Vec<u32>>, Option<Vec<u32>>),
    pub mvd_l1_zero: bool,
    pub cabac_init: bool,
    pub collocated_from_l0: bool,
    pub collocated_ref_idx: u32,
    /// Coded when the PPS enables weighted prediction for the slice type.
    pub pred_weights: Option<PredWeightTable>,
    pub five_minus_max_num_merge_cand: u32,
    pub slice_qp_delta: i32,
    pub cb_qp_offset: i32,
    pub cr_qp_offset: i32,
    /// `deblocking_filter_override_flag` set: `(disabled, beta_offset_div2, tc_offset_div2)`.
    pub deblocking_override: Option<(bool, i32, i32)>,
    pub loop_filter_across_slices: bool,
    /// `(offset_len_minus1, entry_point_offset_minus1[])`, coded with WPP or tiles.
    pub entry_points: (u32, Vec<u32>),
}

fn ceil_log2(n: u32) -> u8 {
    if n <= 1 {
        0
    } else {
        (32 - (n - 1).leading_zeros()) as u8
    }
}

impl SliceSegmentHeader {
    /// An IPPP picture's single slice: IDR_W_RADL, or TRAIL_R predicted from SPS set 0.
    pub fn simple(idr: bool, pic_order_cnt_lsb: u32, slice_qp_delta: i32, sps: &Sps) -> Self {
        Self {
            nal_unit_type: if idr { hevc::IDR_W_RADL } else { hevc::TRAIL_R },
            temporal_id: 0,
            first_slice_segment_in_pic: true,
            no_output_of_prior_pics: false,
            pps_id: 0,
            dependent_slice_segment: false,
            slice_segment_address: 0,
            reserved_flags: 0,
            slice_type: if idr { SliceType::I } else { SliceType::P },
            pic_output: true,
            colour_plane_id: 0,
            pic_order_cnt_lsb,
            rps: RpsChoice::Sps(0),
            temporal_mvp_enabled: !idr && sps.temporal_mvp_enabled,
            sao_luma: sps.sample_adaptive_offset_enabled,
            sao_chroma: sps.sample_adaptive_offset_enabled,
            num_ref_idx_override: (!idr).then_some((0, 0)),
            list_entries: (None, None),
            mvd_l1_zero: false,
            cabac_init: false,
            collocated_from_l0: true,
            collocated_ref_idx: 0,
            pred_weights: None,
            five_minus_max_num_merge_cand: 0,
            slice_qp_delta,
            cb_qp_offset: 0,
            cr_qp_offset: 0,
            deblocking_override: None,
            loop_filter_across_slices: false,
            entry_points: (0, Vec::new()),
        }
    }

    /// Parses a slice segment's header. Returns it with its length in RBSP bits, the two NAL
    /// header bytes included and `byte_alignment()` excluded.
    pub fn parse(nal: &[u8], sps: &Sps, pps: &Pps) -> Result<(Self, usize), BitstreamError> {
        let nal_unit_type = hevc::unit_type(nal).ok_or(BitstreamError::Truncated)?;
        if nal_unit_type > hevc::CRA || (10..16).contains(&nal_unit_type) {
            return Err(BitstreamError::Invalid("not a slice segment"));
        }
        let temporal_id = nal.get(1).ok_or(BitstreamError::Truncated)?.wrapping_sub(1) & 7;
        let rbsp = rbsp_of(nal, 2)?;
        let r = &mut BitReader::new(&rbsp);
        let mut h = Self::simple(is_idr_type(nal_unit_type), 0, 0, sps);
        h.nal_unit_type = nal_unit_type;
        h.temporal_id = temporal_id;
        h.first_slice_segment_in_pic = r.flag()?;
        h.no_output_of_prior_pics = is_irap_type(nal_unit_type) && r.flag()?;
        h.pps_id = r.ue_max(63, "slice_pic_parameter_set_id")?;
        if !h.first_slice_segment_in_pic {
            h.dependent_slice_segment = pps.dependent_slice_segments_enabled && r.flag()?;
            h.slice_segment_address = r.bits(ceil_log2(sps.ctb_count()))?;
        }
        h.num_ref_idx_override = None;
        h.sao_luma = false;
        h.sao_chroma = false;
        h.temporal_mvp_enabled = false;
        if !h.dependent_slice_segment {
            h.reserved_flags = r.u8(pps.num_extra_slice_header_bits)?;
            h.slice_type = match r.ue_max(2, "slice_type")? {
                0 => SliceType::B,
                1 => SliceType::P,
                _ => SliceType::I,
            };
            h.pic_output = !pps.output_flag_present || r.flag()?;
            if sps.separate_colour_plane {
                h.colour_plane_id = r.u8(2)?;
            }
            let mut used = 0;
            if !is_idr_type(nal_unit_type) {
                h.pic_order_cnt_lsb = r.bits(sps.log2_max_poc_lsb() as u8)?;
                let sets = sps.short_term_rps.len() as u32;
                h.rps = if r.flag()? {
                    let idx = if sets > 1 {
                        r.bits(ceil_log2(sets))?
                    } else {
                        0
                    };
                    used = sps
                        .short_term_rps
                        .get(idx as usize)
                        .ok_or(BitstreamError::Invalid("short_term_ref_pic_set_idx"))?
                        .used_count();
                    RpsChoice::Sps(idx)
                } else {
                    let set = ShortTermRps::read(r, sets)?;
                    used = set.used_count();
                    RpsChoice::Explicit(set)
                };
                if sps.long_term.is_some() {
                    return Err(BitstreamError::Unsupported("long-term reference pictures"));
                }
                h.temporal_mvp_enabled = sps.temporal_mvp_enabled && r.flag()?;
            }
            if sps.sample_adaptive_offset_enabled {
                h.sao_luma = r.flag()?;
                h.sao_chroma = sps.chroma_array_type() != 0 && r.flag()?;
            }
            if h.slice_type != SliceType::I {
                if r.flag()? {
                    let l0 = r.ue_max(14, "num_ref_idx_l0_active_minus1")?;
                    let l1 = if h.slice_type == SliceType::B {
                        r.ue_max(14, "num_ref_idx_l1_active_minus1")?
                    } else {
                        0
                    };
                    h.num_ref_idx_override = Some((l0, l1));
                }
                if pps.lists_modification_present && used > 1 {
                    let bits = ceil_log2(used);
                    let mut entries = |count: u32| -> Result<Option<Vec<u32>>, BitstreamError> {
                        if !r.flag()? {
                            return Ok(None);
                        }
                        (0..count)
                            .map(|_| r.bits(bits))
                            .collect::<Result<_, _>>()
                            .map(Some)
                    };
                    let l0 = entries(h.l0_active_minus1(pps) + 1)?;
                    let l1 = if h.slice_type == SliceType::B {
                        entries(h.l1_active_minus1(pps) + 1)?
                    } else {
                        None
                    };
                    h.list_entries = (l0, l1);
                }
                if h.slice_type == SliceType::B {
                    h.mvd_l1_zero = r.flag()?;
                }
                if pps.cabac_init_present {
                    h.cabac_init = r.flag()?;
                }
                if h.temporal_mvp_enabled {
                    if h.slice_type == SliceType::B {
                        h.collocated_from_l0 = r.flag()?;
                    }
                    if h.needs_collocated_ref_idx(pps) {
                        h.collocated_ref_idx = r.ue_max(14, "collocated_ref_idx")?;
                    }
                }
                if h.weighted(pps) {
                    let l1 = if h.slice_type == SliceType::B {
                        h.l1_active_minus1(pps) + 1
                    } else {
                        0
                    };
                    h.pred_weights = Some(PredWeightTable::read_hevc(
                        r,
                        sps.chroma_array_type() != 0,
                        h.l0_active_minus1(pps) + 1,
                        l1,
                    )?);
                }
                h.five_minus_max_num_merge_cand = r.ue_max(4, "five_minus_max_num_merge_cand")?;
            }
            h.slice_qp_delta = r.se()?;
            if pps.slice_chroma_qp_offsets_present {
                h.cb_qp_offset = r.se()?;
                h.cr_qp_offset = r.se()?;
            }
            if pps.deblocking.is_some_and(|(o, ..)| o) && r.flag()? {
                let disabled = r.flag()?;
                let (beta, tc) = if disabled { (0, 0) } else { (r.se()?, r.se()?) };
                h.deblocking_override = Some((disabled, beta, tc));
            }
            if pps.loop_filter_across_slices_enabled
                && (h.sao_luma || h.sao_chroma || !h.deblocking_disabled(pps))
            {
                h.loop_filter_across_slices = r.flag()?;
            }
        }
        if pps.entropy_coding_sync_enabled {
            let count = r.ue_max(1 << 16, "num_entry_point_offsets")?;
            if count > 0 {
                let len = r.ue_max(31, "offset_len_minus1")?;
                let offsets = (0..count)
                    .map(|_| r.bits(len as u8 + 1))
                    .collect::<Result<_, _>>()?;
                h.entry_points = (len, offsets);
            }
        }
        if pps.slice_segment_header_extension_present && r.ue()? != 0 {
            return Err(BitstreamError::Unsupported("slice header extension"));
        }
        let bits = 16 + r.position();
        if !r.flag()? {
            return Err(BitstreamError::Invalid(
                "missing alignment_bit_equal_to_one",
            ));
        }
        Ok((h, bits))
    }

    fn l0_active_minus1(&self, pps: &Pps) -> u32 {
        self.num_ref_idx_override
            .map_or(pps.num_ref_idx_l0_default_active_minus1, |(l0, _)| l0)
    }

    fn l1_active_minus1(&self, pps: &Pps) -> u32 {
        self.num_ref_idx_override
            .map_or(pps.num_ref_idx_l1_default_active_minus1, |(_, l1)| l1)
    }

    /// `NumPicTotalCurr`: the short-term pictures the current picture may reference.
    fn num_pic_total_curr(&self, sps: &Sps) -> u32 {
        match &self.rps {
            RpsChoice::Sps(idx) => sps
                .short_term_rps
                .get(*idx as usize)
                .map_or(0, ShortTermRps::used_count),
            RpsChoice::Explicit(set) => set.used_count(),
        }
    }

    fn weighted(&self, pps: &Pps) -> bool {
        (pps.weighted_pred && self.slice_type == SliceType::P)
            || (pps.weighted_bipred && self.slice_type == SliceType::B)
    }

    fn needs_collocated_ref_idx(&self, pps: &Pps) -> bool {
        (self.collocated_from_l0 && self.l0_active_minus1(pps) > 0)
            || (!self.collocated_from_l0 && self.l1_active_minus1(pps) > 0)
    }

    fn deblocking_disabled(&self, pps: &Pps) -> bool {
        self.deblocking_override
            .map_or(pps.deblocking.is_some_and(|(_, d, ..)| d), |(d, ..)| d)
    }

    /// The two NAL header bytes and the header's bits, unescaped, before `byte_alignment()`.
    pub fn write(&self, sps: &Sps, pps: &Pps) -> BitWriter {
        let mut w = BitWriter::new();
        for b in header(self.nal_unit_type, self.temporal_id) {
            w.bits(u32::from(b), 8);
        }
        w.bit(self.first_slice_segment_in_pic);
        if is_irap_type(self.nal_unit_type) {
            w.bit(self.no_output_of_prior_pics);
        }
        w.ue(self.pps_id);
        if !self.first_slice_segment_in_pic {
            if pps.dependent_slice_segments_enabled {
                w.bit(self.dependent_slice_segment);
            }
            w.bits(self.slice_segment_address, ceil_log2(sps.ctb_count()));
        }
        if !self.dependent_slice_segment {
            w.bits(
                u32::from(self.reserved_flags),
                pps.num_extra_slice_header_bits,
            );
            w.ue(self.slice_type.code());
            if pps.output_flag_present {
                w.bit(self.pic_output);
            }
            if sps.separate_colour_plane {
                w.bits(u32::from(self.colour_plane_id), 2);
            }
            if !is_idr_type(self.nal_unit_type) {
                w.bits(self.pic_order_cnt_lsb, sps.log2_max_poc_lsb() as u8);
                let sets = sps.short_term_rps.len() as u32;
                match &self.rps {
                    RpsChoice::Sps(idx) => {
                        w.bit(true);
                        if sets > 1 {
                            w.bits(*idx, ceil_log2(sets));
                        }
                    }
                    RpsChoice::Explicit(set) => {
                        w.bit(false);
                        set.write(&mut w, sets);
                    }
                }
                if sps.temporal_mvp_enabled {
                    w.bit(self.temporal_mvp_enabled);
                }
            }
            if sps.sample_adaptive_offset_enabled {
                w.bit(self.sao_luma);
                if sps.chroma_array_type() != 0 {
                    w.bit(self.sao_chroma);
                }
            }
            if self.slice_type != SliceType::I {
                w.bit(self.num_ref_idx_override.is_some());
                if let Some((l0, l1)) = self.num_ref_idx_override {
                    w.ue(l0);
                    if self.slice_type == SliceType::B {
                        w.ue(l1);
                    }
                }
                let used = self.num_pic_total_curr(sps);
                if pps.lists_modification_present && used > 1 {
                    let bits = ceil_log2(used);
                    let lists: &[&Option<Vec<u32>>] = if self.slice_type == SliceType::B {
                        &[&self.list_entries.0, &self.list_entries.1]
                    } else {
                        &[&self.list_entries.0]
                    };
                    for list in lists {
                        w.bit(list.is_some());
                        for entry in list.iter().flatten() {
                            w.bits(*entry, bits);
                        }
                    }
                }
                if self.slice_type == SliceType::B {
                    w.bit(self.mvd_l1_zero);
                }
                if pps.cabac_init_present {
                    w.bit(self.cabac_init);
                }
                if self.temporal_mvp_enabled {
                    if self.slice_type == SliceType::B {
                        w.bit(self.collocated_from_l0);
                    }
                    if self.needs_collocated_ref_idx(pps) {
                        w.ue(self.collocated_ref_idx);
                    }
                }
                if self.weighted(pps) {
                    let table = self
                        .pred_weights
                        .clone()
                        .unwrap_or_else(|| PredWeightTable {
                            l0: vec![Default::default(); self.l0_active_minus1(pps) as usize + 1],
                            l1: if self.slice_type == SliceType::B {
                                vec![Default::default(); self.l1_active_minus1(pps) as usize + 1]
                            } else {
                                Vec::new()
                            },
                            ..Default::default()
                        });
                    table.write_hevc(&mut w, sps.chroma_array_type() != 0);
                }
                w.ue(self.five_minus_max_num_merge_cand);
            }
            w.se(self.slice_qp_delta);
            if pps.slice_chroma_qp_offsets_present {
                w.se(self.cb_qp_offset);
                w.se(self.cr_qp_offset);
            }
            if pps.deblocking.is_some_and(|(o, ..)| o) {
                w.bit(self.deblocking_override.is_some());
                if let Some((disabled, beta, tc)) = self.deblocking_override {
                    w.bit(disabled);
                    if !disabled {
                        w.se(beta);
                        w.se(tc);
                    }
                }
            }
            if pps.loop_filter_across_slices_enabled
                && (self.sao_luma || self.sao_chroma || !self.deblocking_disabled(pps))
            {
                w.bit(self.loop_filter_across_slices);
            }
        }
        if pps.entropy_coding_sync_enabled {
            let (len, offsets) = &self.entry_points;
            w.ue(offsets.len() as u32);
            if !offsets.is_empty() {
                w.ue(*len);
                for o in offsets {
                    w.bits(*o, *len as u8 + 1);
                }
            }
        }
        if pps.slice_segment_header_extension_present {
            w.ue(0);
        }
        w
    }
}

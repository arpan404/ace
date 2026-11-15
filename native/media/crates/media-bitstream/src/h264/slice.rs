// SPDX-License-Identifier: Apache-2.0
//! `slice_header()` (H.264 §7.3.3) for progressive frames with one slice group. The writer
//! produces the bits VA-API takes as a packed slice header; the reader parses platform
//! encoders' headers so the two can be checked against each other.
use super::{PocType, Pps, Sps};
use crate::nal::h264::IDR;
use crate::{BitReader, BitWriter, BitstreamError, PredWeightTable, rbsp_of};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SliceType {
    P,
    B,
    I,
    Sp,
    Si,
}

impl SliceType {
    pub fn code(self) -> u32 {
        match self {
            Self::P => 0,
            Self::B => 1,
            Self::I => 2,
            Self::Sp => 3,
            Self::Si => 4,
        }
    }
    fn from_code(code: u32) -> Self {
        match code % 5 {
            0 => Self::P,
            1 => Self::B,
            2 => Self::I,
            3 => Self::Sp,
            _ => Self::Si,
        }
    }
}

/// One `modification_of_pic_nums_idc` entry (§7.3.3.1).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RefModification {
    Subtract { abs_diff_pic_num_minus1: u32 },
    Add { abs_diff_pic_num_minus1: u32 },
    LongTerm { long_term_pic_num: u32 },
}

/// One `memory_management_control_operation` (§7.3.3.3).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MemoryOp {
    ShortTermUnused {
        difference_of_pic_nums_minus1: u32,
    },
    LongTermUnused {
        long_term_pic_num: u32,
    },
    ShortTermToLong {
        difference_of_pic_nums_minus1: u32,
        long_term_frame_idx: u32,
    },
    MaxLongTermIdx {
        max_long_term_frame_idx_plus1: u32,
    },
    AllUnused,
    CurrentToLong {
        long_term_frame_idx: u32,
    },
}

/// `dec_ref_pic_marking()`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RefMarking {
    Idr {
        no_output_of_prior_pics: bool,
        long_term_reference: bool,
    },
    SlidingWindow,
    Adaptive(Vec<MemoryOp>),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SliceHeader {
    pub nal_ref_idc: u8,
    pub idr: bool,
    pub first_mb_in_slice: u32,
    /// As coded: 0–9, where 5–9 say every slice of the picture has this type.
    pub slice_type: u32,
    pub pps_id: u32,
    pub colour_plane_id: u8,
    pub frame_num: u32,
    pub idr_pic_id: u32,
    pub pic_order_cnt_lsb: u32,
    pub delta_pic_order_cnt_bottom: i32,
    pub delta_pic_order_cnt: [i32; 2],
    pub redundant_pic_cnt: u32,
    pub direct_spatial_mv_pred: bool,
    /// `num_ref_idx_active_override_flag` and the counts it sets (l1 used for B only).
    pub num_ref_idx_override: Option<(u32, u32)>,
    pub ref_modification_l0: Option<Vec<RefModification>>,
    pub ref_modification_l1: Option<Vec<RefModification>>,
    /// Coded when the PPS enables weighted prediction for the slice type.
    pub pred_weights: Option<PredWeightTable>,
    /// Coded when `nal_ref_idc` is nonzero.
    pub ref_marking: RefMarking,
    pub cabac_init_idc: u32,
    pub slice_qp_delta: i32,
    pub disable_deblocking_filter_idc: u32,
    pub slice_alpha_c0_offset_div2: i32,
    pub slice_beta_offset_div2: i32,
}

impl SliceHeader {
    pub fn kind(&self) -> SliceType {
        SliceType::from_code(self.slice_type)
    }

    /// An IPPP frame's single slice: an IDR when `idr`, else a P slice on the one reference.
    pub fn simple(idr: bool, frame_num: u32, idr_pic_id: u32, slice_qp_delta: i32) -> Self {
        Self {
            nal_ref_idc: 3,
            idr,
            first_mb_in_slice: 0,
            slice_type: if idr { 7 } else { 5 },
            pps_id: 0,
            colour_plane_id: 0,
            frame_num,
            idr_pic_id: if idr { idr_pic_id } else { 0 },
            pic_order_cnt_lsb: 0,
            delta_pic_order_cnt_bottom: 0,
            delta_pic_order_cnt: [0, 0],
            redundant_pic_cnt: 0,
            direct_spatial_mv_pred: false,
            num_ref_idx_override: (!idr).then_some((0, 0)),
            ref_modification_l0: None,
            ref_modification_l1: None,
            pred_weights: None,
            ref_marking: if idr {
                RefMarking::Idr {
                    no_output_of_prior_pics: false,
                    long_term_reference: false,
                }
            } else {
                RefMarking::SlidingWindow
            },
            cabac_init_idc: 0,
            slice_qp_delta,
            disable_deblocking_filter_idc: 0,
            slice_alpha_c0_offset_div2: 0,
            slice_beta_offset_div2: 0,
        }
    }

    /// Parses the header of a slice NAL unit. Returns it with its length in RBSP bits,
    /// NAL header byte included.
    pub fn parse(nal: &[u8], sps: &Sps, pps: &Pps) -> Result<(Self, usize), BitstreamError> {
        let first = *nal.first().ok_or(BitstreamError::Truncated)?;
        let unit_type = first & 0x1f;
        if unit_type != IDR && unit_type != crate::nal::h264::SLICE {
            return Err(BitstreamError::Invalid("not a slice"));
        }
        let rbsp = rbsp_of(nal, 1)?;
        let r = &mut BitReader::new(&rbsp);
        let nal_ref_idc = (first >> 5) & 3;
        let idr = unit_type == IDR;
        let first_mb_in_slice = r.ue()?;
        let slice_type = r.ue_max(9, "slice_type")?;
        let kind = SliceType::from_code(slice_type);
        let pps_id = r.ue_max(255, "pic_parameter_set_id")?;
        let colour_plane_id = if sps.chroma.is_some_and(|c| c.separate_colour_plane) {
            r.u8(2)?
        } else {
            0
        };
        let frame_num = r.bits(sps.log2_max_frame_num() as u8)?;
        if !sps.frame_mbs_only {
            return Err(BitstreamError::Unsupported("field coding"));
        }
        let idr_pic_id = if idr {
            r.ue_max(65535, "idr_pic_id")?
        } else {
            0
        };
        let mut delta_pic_order_cnt = [0; 2];
        let mut pic_order_cnt_lsb = 0;
        let mut delta_pic_order_cnt_bottom = 0;
        match &sps.poc {
            PocType::Zero {
                log2_max_pic_order_cnt_lsb_minus4,
            } => {
                pic_order_cnt_lsb = r.bits(*log2_max_pic_order_cnt_lsb_minus4 as u8 + 4)?;
                if pps.bottom_field_pic_order_in_frame_present {
                    delta_pic_order_cnt_bottom = r.se()?;
                }
            }
            PocType::One {
                delta_pic_order_always_zero: false,
                ..
            } => {
                delta_pic_order_cnt[0] = r.se()?;
                if pps.bottom_field_pic_order_in_frame_present {
                    delta_pic_order_cnt[1] = r.se()?;
                }
            }
            _ => {}
        }
        let redundant_pic_cnt = if pps.redundant_pic_cnt_present {
            r.ue_max(127, "redundant_pic_cnt")?
        } else {
            0
        };
        let direct_spatial_mv_pred = kind == SliceType::B && r.flag()?;
        let num_ref_idx_override =
            if matches!(kind, SliceType::P | SliceType::Sp | SliceType::B) && r.flag()? {
                let l0 = r.ue_max(31, "num_ref_idx_l0_active_minus1")?;
                let l1 = if kind == SliceType::B {
                    r.ue_max(31, "num_ref_idx_l1_active_minus1")?
                } else {
                    0
                };
                Some((l0, l1))
            } else {
                None
            };
        let ref_modification_l0 = if matches!(kind, SliceType::I | SliceType::Si) {
            None
        } else {
            read_modification(r)?
        };
        let ref_modification_l1 = if kind == SliceType::B {
            read_modification(r)?
        } else {
            None
        };
        let (l0, l1) = active_counts(num_ref_idx_override, pps, kind);
        let pred_weights = if weighted(pps, kind) {
            Some(PredWeightTable::read_h264(
                r,
                sps.chroma_format_idc() != 0,
                l0,
                l1,
            )?)
        } else {
            None
        };
        let ref_marking = if nal_ref_idc == 0 {
            RefMarking::SlidingWindow
        } else {
            read_marking(r, idr)?
        };
        let cabac_init_idc =
            if pps.entropy_coding_mode && !matches!(kind, SliceType::I | SliceType::Si) {
                r.ue_max(2, "cabac_init_idc")?
            } else {
                0
            };
        let slice_qp_delta = r.se()?;
        if matches!(kind, SliceType::Sp | SliceType::Si) {
            return Err(BitstreamError::Unsupported("SP and SI slices"));
        }
        let (mut disable, mut alpha, mut beta) = (0, 0, 0);
        if pps.deblocking_filter_control_present {
            disable = r.ue_max(2, "disable_deblocking_filter_idc")?;
            if disable != 1 {
                alpha = r.se()?;
                beta = r.se()?;
            }
        }
        let bits = 8 + r.position();
        Ok((
            Self {
                nal_ref_idc,
                idr,
                first_mb_in_slice,
                slice_type,
                pps_id,
                colour_plane_id,
                frame_num,
                idr_pic_id,
                pic_order_cnt_lsb,
                delta_pic_order_cnt_bottom,
                delta_pic_order_cnt,
                redundant_pic_cnt,
                direct_spatial_mv_pred,
                num_ref_idx_override,
                ref_modification_l0,
                ref_modification_l1,
                pred_weights,
                ref_marking,
                cabac_init_idc,
                slice_qp_delta,
                disable_deblocking_filter_idc: disable,
                slice_alpha_c0_offset_div2: alpha,
                slice_beta_offset_div2: beta,
            },
            bits,
        ))
    }

    /// The NAL header byte and the header's bits, unescaped and not byte aligned: VA-API's
    /// packed slice header, whose driver appends the slice data and inserts emulation bytes.
    pub fn write(&self, sps: &Sps, pps: &Pps) -> BitWriter {
        let mut w = BitWriter::new();
        let unit_type = if self.idr {
            IDR
        } else {
            crate::nal::h264::SLICE
        };
        w.bits(
            u32::from(crate::nal::h264::header(self.nal_ref_idc, unit_type)),
            8,
        );
        let kind = self.kind();
        w.ue(self.first_mb_in_slice);
        w.ue(self.slice_type);
        w.ue(self.pps_id);
        if sps.chroma.is_some_and(|c| c.separate_colour_plane) {
            w.bits(u32::from(self.colour_plane_id), 2);
        }
        w.bits(self.frame_num, sps.log2_max_frame_num() as u8);
        if self.idr {
            w.ue(self.idr_pic_id);
        }
        match &sps.poc {
            PocType::Zero {
                log2_max_pic_order_cnt_lsb_minus4,
            } => {
                w.bits(
                    self.pic_order_cnt_lsb,
                    *log2_max_pic_order_cnt_lsb_minus4 as u8 + 4,
                );
                if pps.bottom_field_pic_order_in_frame_present {
                    w.se(self.delta_pic_order_cnt_bottom);
                }
            }
            PocType::One {
                delta_pic_order_always_zero: false,
                ..
            } => {
                w.se(self.delta_pic_order_cnt[0]);
                if pps.bottom_field_pic_order_in_frame_present {
                    w.se(self.delta_pic_order_cnt[1]);
                }
            }
            _ => {}
        }
        if pps.redundant_pic_cnt_present {
            w.ue(self.redundant_pic_cnt);
        }
        if kind == SliceType::B {
            w.bit(self.direct_spatial_mv_pred);
        }
        if matches!(kind, SliceType::P | SliceType::Sp | SliceType::B) {
            w.bit(self.num_ref_idx_override.is_some());
            if let Some((l0, l1)) = self.num_ref_idx_override {
                w.ue(l0);
                if kind == SliceType::B {
                    w.ue(l1);
                }
            }
        }
        if !matches!(kind, SliceType::I | SliceType::Si) {
            write_modification(&mut w, self.ref_modification_l0.as_deref());
        }
        if kind == SliceType::B {
            write_modification(&mut w, self.ref_modification_l1.as_deref());
        }
        if weighted(pps, kind) {
            let (l0, l1) = active_counts(self.num_ref_idx_override, pps, kind);
            let table = self
                .pred_weights
                .clone()
                .unwrap_or_else(|| PredWeightTable {
                    l0: vec![Default::default(); l0 as usize],
                    l1: vec![Default::default(); l1 as usize],
                    ..Default::default()
                });
            table.write_h264(&mut w, sps.chroma_format_idc() != 0);
        }
        if self.nal_ref_idc != 0 {
            write_marking(&mut w, &self.ref_marking, self.idr);
        }
        if pps.entropy_coding_mode && !matches!(kind, SliceType::I | SliceType::Si) {
            w.ue(self.cabac_init_idc);
        }
        w.se(self.slice_qp_delta);
        if pps.deblocking_filter_control_present {
            w.ue(self.disable_deblocking_filter_idc);
            if self.disable_deblocking_filter_idc != 1 {
                w.se(self.slice_alpha_c0_offset_div2);
                w.se(self.slice_beta_offset_div2);
            }
        }
        w
    }
}

fn weighted(pps: &Pps, kind: SliceType) -> bool {
    (pps.weighted_pred && matches!(kind, SliceType::P | SliceType::Sp))
        || (pps.weighted_bipred_idc == 1 && kind == SliceType::B)
}

/// The active reference counts of lists 0 and 1.
fn active_counts(over: Option<(u32, u32)>, pps: &Pps, kind: SliceType) -> (u32, u32) {
    let (l0, l1) = over.unwrap_or((
        pps.num_ref_idx_l0_default_active_minus1,
        pps.num_ref_idx_l1_default_active_minus1,
    ));
    (l0 + 1, if kind == SliceType::B { l1 + 1 } else { 0 })
}

fn read_modification(
    r: &mut BitReader<'_>,
) -> Result<Option<Vec<RefModification>>, BitstreamError> {
    if !r.flag()? {
        return Ok(None);
    }
    let mut list = Vec::new();
    loop {
        let entry = match r.ue_max(5, "modification_of_pic_nums_idc")? {
            0 => RefModification::Subtract {
                abs_diff_pic_num_minus1: r.ue()?,
            },
            1 => RefModification::Add {
                abs_diff_pic_num_minus1: r.ue()?,
            },
            2 => RefModification::LongTerm {
                long_term_pic_num: r.ue()?,
            },
            3 => return Ok(Some(list)),
            _ => return Err(BitstreamError::Unsupported("MVC list modification")),
        };
        if list.len() == 32 {
            return Err(BitstreamError::Invalid("too many list modifications"));
        }
        list.push(entry);
    }
}

fn write_modification(w: &mut BitWriter, list: Option<&[RefModification]>) {
    w.bit(list.is_some());
    let Some(list) = list else { return };
    for entry in list {
        match *entry {
            RefModification::Subtract {
                abs_diff_pic_num_minus1,
            } => {
                w.ue(0);
                w.ue(abs_diff_pic_num_minus1);
            }
            RefModification::Add {
                abs_diff_pic_num_minus1,
            } => {
                w.ue(1);
                w.ue(abs_diff_pic_num_minus1);
            }
            RefModification::LongTerm { long_term_pic_num } => {
                w.ue(2);
                w.ue(long_term_pic_num);
            }
        }
    }
    w.ue(3);
}

fn read_marking(r: &mut BitReader<'_>, idr: bool) -> Result<RefMarking, BitstreamError> {
    if idr {
        return Ok(RefMarking::Idr {
            no_output_of_prior_pics: r.flag()?,
            long_term_reference: r.flag()?,
        });
    }
    if !r.flag()? {
        return Ok(RefMarking::SlidingWindow);
    }
    let mut ops = Vec::new();
    loop {
        let op = match r.ue_max(6, "memory_management_control_operation")? {
            0 => return Ok(RefMarking::Adaptive(ops)),
            1 => MemoryOp::ShortTermUnused {
                difference_of_pic_nums_minus1: r.ue()?,
            },
            2 => MemoryOp::LongTermUnused {
                long_term_pic_num: r.ue()?,
            },
            3 => MemoryOp::ShortTermToLong {
                difference_of_pic_nums_minus1: r.ue()?,
                long_term_frame_idx: r.ue()?,
            },
            4 => MemoryOp::MaxLongTermIdx {
                max_long_term_frame_idx_plus1: r.ue()?,
            },
            5 => MemoryOp::AllUnused,
            _ => MemoryOp::CurrentToLong {
                long_term_frame_idx: r.ue()?,
            },
        };
        if ops.len() == 66 {
            return Err(BitstreamError::Invalid("too many memory operations"));
        }
        ops.push(op);
    }
}

fn write_marking(w: &mut BitWriter, marking: &RefMarking, idr: bool) {
    match marking {
        RefMarking::Idr {
            no_output_of_prior_pics,
            long_term_reference,
        } if idr => {
            w.bit(*no_output_of_prior_pics);
            w.bit(*long_term_reference);
        }
        _ if idr => {
            w.bit(false);
            w.bit(false);
        }
        RefMarking::Adaptive(ops) => {
            w.bit(true);
            for op in ops {
                match *op {
                    MemoryOp::ShortTermUnused {
                        difference_of_pic_nums_minus1,
                    } => {
                        w.ue(1);
                        w.ue(difference_of_pic_nums_minus1);
                    }
                    MemoryOp::LongTermUnused { long_term_pic_num } => {
                        w.ue(2);
                        w.ue(long_term_pic_num);
                    }
                    MemoryOp::ShortTermToLong {
                        difference_of_pic_nums_minus1,
                        long_term_frame_idx,
                    } => {
                        w.ue(3);
                        w.ue(difference_of_pic_nums_minus1);
                        w.ue(long_term_frame_idx);
                    }
                    MemoryOp::MaxLongTermIdx {
                        max_long_term_frame_idx_plus1,
                    } => {
                        w.ue(4);
                        w.ue(max_long_term_frame_idx_plus1);
                    }
                    MemoryOp::AllUnused => w.ue(5),
                    MemoryOp::CurrentToLong {
                        long_term_frame_idx,
                    } => {
                        w.ue(6);
                        w.ue(long_term_frame_idx);
                    }
                }
            }
            w.ue(0);
        }
        _ => w.bit(false),
    }
}

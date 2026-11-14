// SPDX-License-Identifier: Apache-2.0
//! `pic_parameter_set_rbsp()` (H.264 §7.3.2.2), one slice group, no scaling matrices.
use crate::nal::h264::{PPS, header};
use crate::{BitReader, BitWriter, BitstreamError, nal_unit, rbsp_of};

/// The trailing fields High-profile PPSs carry.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PpsHigh {
    pub transform_8x8_mode: bool,
    pub second_chroma_qp_index_offset: i32,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Pps {
    pub id: u32,
    pub sps_id: u32,
    /// CABAC when true, CAVLC otherwise.
    pub entropy_coding_mode: bool,
    pub bottom_field_pic_order_in_frame_present: bool,
    pub num_ref_idx_l0_default_active_minus1: u32,
    pub num_ref_idx_l1_default_active_minus1: u32,
    pub weighted_pred: bool,
    pub weighted_bipred_idc: u8,
    pub pic_init_qp_minus26: i32,
    pub pic_init_qs_minus26: i32,
    pub chroma_qp_index_offset: i32,
    pub deblocking_filter_control_present: bool,
    pub constrained_intra_pred: bool,
    pub redundant_pic_cnt_present: bool,
    pub high: Option<PpsHigh>,
}

impl Pps {
    /// The PPS ace's encoders use: one reference, deblocking control, CABAC except Baseline.
    pub fn simple(cabac: bool, transform_8x8: bool, init_qp: i32) -> Self {
        Self {
            id: 0,
            sps_id: 0,
            entropy_coding_mode: cabac,
            bottom_field_pic_order_in_frame_present: false,
            num_ref_idx_l0_default_active_minus1: 0,
            num_ref_idx_l1_default_active_minus1: 0,
            weighted_pred: false,
            weighted_bipred_idc: 0,
            pic_init_qp_minus26: init_qp - 26,
            pic_init_qs_minus26: 0,
            chroma_qp_index_offset: 0,
            deblocking_filter_control_present: true,
            constrained_intra_pred: false,
            redundant_pic_cnt_present: false,
            high: transform_8x8.then_some(PpsHigh {
                transform_8x8_mode: true,
                second_chroma_qp_index_offset: 0,
            }),
        }
    }

    pub fn parse(nal: &[u8]) -> Result<Self, BitstreamError> {
        if crate::nal::h264::unit_type(nal) != Some(PPS) {
            return Err(BitstreamError::Invalid("not a PPS"));
        }
        let rbsp = rbsp_of(nal, 1)?;
        let r = &mut BitReader::new(&rbsp);
        let id = r.ue_max(255, "pic_parameter_set_id")?;
        let sps_id = r.ue_max(31, "seq_parameter_set_id")?;
        let entropy_coding_mode = r.flag()?;
        let bottom_field_pic_order_in_frame_present = r.flag()?;
        if r.ue()? != 0 {
            return Err(BitstreamError::Unsupported("slice groups"));
        }
        let pps = Self {
            id,
            sps_id,
            entropy_coding_mode,
            bottom_field_pic_order_in_frame_present,
            num_ref_idx_l0_default_active_minus1: r.ue_max(31, "num_ref_idx_l0")?,
            num_ref_idx_l1_default_active_minus1: r.ue_max(31, "num_ref_idx_l1")?,
            weighted_pred: r.flag()?,
            weighted_bipred_idc: r.u8(2)?,
            pic_init_qp_minus26: r.se()?,
            pic_init_qs_minus26: r.se()?,
            chroma_qp_index_offset: r.se()?,
            deblocking_filter_control_present: r.flag()?,
            constrained_intra_pred: r.flag()?,
            redundant_pic_cnt_present: r.flag()?,
            high: None,
        };
        let high = if r.more_rbsp_data() {
            let transform_8x8_mode = r.flag()?;
            if r.flag()? {
                return Err(BitstreamError::Unsupported("PPS scaling matrices"));
            }
            Some(PpsHigh {
                transform_8x8_mode,
                second_chroma_qp_index_offset: r.se()?,
            })
        } else {
            None
        };
        r.trailing()?;
        Ok(Self { high, ..pps })
    }

    pub fn rbsp(&self) -> Vec<u8> {
        let mut w = BitWriter::new();
        w.ue(self.id);
        w.ue(self.sps_id);
        w.bit(self.entropy_coding_mode);
        w.bit(self.bottom_field_pic_order_in_frame_present);
        w.ue(0); // num_slice_groups_minus1
        w.ue(self.num_ref_idx_l0_default_active_minus1);
        w.ue(self.num_ref_idx_l1_default_active_minus1);
        w.bit(self.weighted_pred);
        w.bits(u32::from(self.weighted_bipred_idc), 2);
        w.se(self.pic_init_qp_minus26);
        w.se(self.pic_init_qs_minus26);
        w.se(self.chroma_qp_index_offset);
        w.bit(self.deblocking_filter_control_present);
        w.bit(self.constrained_intra_pred);
        w.bit(self.redundant_pic_cnt_present);
        if let Some(h) = self.high {
            w.bit(h.transform_8x8_mode);
            w.bit(false); // pic_scaling_matrix_present_flag
            w.se(h.second_chroma_qp_index_offset);
        }
        w.trailing();
        w.into_bytes()
    }

    pub fn to_nal(&self) -> Vec<u8> {
        nal_unit(&[header(3, PPS)], &self.rbsp())
    }
}

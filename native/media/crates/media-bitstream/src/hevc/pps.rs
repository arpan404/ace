// SPDX-License-Identifier: Apache-2.0
//! `pic_parameter_set_rbsp()` (H.265 §7.3.2.3.1) without tiles, scaling lists or extensions.
use crate::nal::hevc::{PPS, header};
use crate::{BitReader, BitWriter, BitstreamError, nal_unit, rbsp_of};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Pps {
    pub id: u32,
    pub sps_id: u32,
    pub dependent_slice_segments_enabled: bool,
    pub output_flag_present: bool,
    pub num_extra_slice_header_bits: u8,
    pub sign_data_hiding_enabled: bool,
    pub cabac_init_present: bool,
    pub num_ref_idx_l0_default_active_minus1: u32,
    pub num_ref_idx_l1_default_active_minus1: u32,
    pub init_qp_minus26: i32,
    pub constrained_intra_pred: bool,
    pub transform_skip_enabled: bool,
    /// `diff_cu_qp_delta_depth` when `cu_qp_delta_enabled_flag` is set.
    pub cu_qp_delta_depth: Option<u32>,
    pub cb_qp_offset: i32,
    pub cr_qp_offset: i32,
    pub slice_chroma_qp_offsets_present: bool,
    pub weighted_pred: bool,
    pub weighted_bipred: bool,
    pub transquant_bypass_enabled: bool,
    pub entropy_coding_sync_enabled: bool,
    pub loop_filter_across_slices_enabled: bool,
    /// `(override_enabled, disabled, beta_offset_div2, tc_offset_div2)` when
    /// `deblocking_filter_control_present_flag` is set.
    pub deblocking: Option<(bool, bool, i32, i32)>,
    pub lists_modification_present: bool,
    pub log2_parallel_merge_level_minus2: u32,
    pub slice_segment_header_extension_present: bool,
    pub extension_present: bool,
}

impl Pps {
    /// The PPS ace's encoders use: one reference, CU QP deltas for rate control.
    pub fn simple(init_qp: i32) -> Self {
        Self {
            id: 0,
            sps_id: 0,
            dependent_slice_segments_enabled: false,
            output_flag_present: false,
            num_extra_slice_header_bits: 0,
            sign_data_hiding_enabled: false,
            cabac_init_present: false,
            num_ref_idx_l0_default_active_minus1: 0,
            num_ref_idx_l1_default_active_minus1: 0,
            init_qp_minus26: init_qp - 26,
            constrained_intra_pred: false,
            transform_skip_enabled: false,
            cu_qp_delta_depth: Some(0),
            cb_qp_offset: 0,
            cr_qp_offset: 0,
            slice_chroma_qp_offsets_present: false,
            weighted_pred: false,
            weighted_bipred: false,
            transquant_bypass_enabled: false,
            entropy_coding_sync_enabled: false,
            loop_filter_across_slices_enabled: false,
            deblocking: None,
            lists_modification_present: false,
            log2_parallel_merge_level_minus2: 0,
            slice_segment_header_extension_present: false,
            extension_present: false,
        }
    }

    pub fn parse(nal: &[u8]) -> Result<Self, BitstreamError> {
        if crate::nal::hevc::unit_type(nal) != Some(PPS) {
            return Err(BitstreamError::Invalid("not a PPS"));
        }
        let rbsp = rbsp_of(nal, 2)?;
        let r = &mut BitReader::new(&rbsp);
        let id = r.ue_max(63, "pps_pic_parameter_set_id")?;
        let sps_id = r.ue_max(15, "pps_seq_parameter_set_id")?;
        let dependent_slice_segments_enabled = r.flag()?;
        let output_flag_present = r.flag()?;
        let num_extra_slice_header_bits = r.u8(3)?;
        let sign_data_hiding_enabled = r.flag()?;
        let cabac_init_present = r.flag()?;
        let num_ref_idx_l0_default_active_minus1 = r.ue_max(14, "num_ref_idx_l0")?;
        let num_ref_idx_l1_default_active_minus1 = r.ue_max(14, "num_ref_idx_l1")?;
        let init_qp_minus26 = r.se()?;
        let constrained_intra_pred = r.flag()?;
        let transform_skip_enabled = r.flag()?;
        let cu_qp_delta_depth = if r.flag()? {
            Some(r.ue_max(3, "diff_cu_qp_delta_depth")?)
        } else {
            None
        };
        let cb_qp_offset = r.se()?;
        let cr_qp_offset = r.se()?;
        let slice_chroma_qp_offsets_present = r.flag()?;
        let weighted_pred = r.flag()?;
        let weighted_bipred = r.flag()?;
        let transquant_bypass_enabled = r.flag()?;
        if r.flag()? {
            return Err(BitstreamError::Unsupported("tiles"));
        }
        let entropy_coding_sync_enabled = r.flag()?;
        let loop_filter_across_slices_enabled = r.flag()?;
        let deblocking = if r.flag()? {
            let override_enabled = r.flag()?;
            let disabled = r.flag()?;
            let (beta, tc) = if disabled { (0, 0) } else { (r.se()?, r.se()?) };
            Some((override_enabled, disabled, beta, tc))
        } else {
            None
        };
        if r.flag()? {
            return Err(BitstreamError::Unsupported("PPS scaling lists"));
        }
        let lists_modification_present = r.flag()?;
        let log2_parallel_merge_level_minus2 = r.ue_max(4, "log2_parallel_merge_level")?;
        let slice_segment_header_extension_present = r.flag()?;
        let extension_present = r.flag()?;
        if extension_present && r.bits(8)? != 0 {
            return Err(BitstreamError::Unsupported("PPS extensions"));
        }
        r.trailing()?;
        Ok(Self {
            id,
            sps_id,
            dependent_slice_segments_enabled,
            output_flag_present,
            num_extra_slice_header_bits,
            sign_data_hiding_enabled,
            cabac_init_present,
            num_ref_idx_l0_default_active_minus1,
            num_ref_idx_l1_default_active_minus1,
            init_qp_minus26,
            constrained_intra_pred,
            transform_skip_enabled,
            cu_qp_delta_depth,
            cb_qp_offset,
            cr_qp_offset,
            slice_chroma_qp_offsets_present,
            weighted_pred,
            weighted_bipred,
            transquant_bypass_enabled,
            entropy_coding_sync_enabled,
            loop_filter_across_slices_enabled,
            deblocking,
            lists_modification_present,
            log2_parallel_merge_level_minus2,
            slice_segment_header_extension_present,
            extension_present,
        })
    }

    pub fn rbsp(&self) -> Vec<u8> {
        let mut w = BitWriter::new();
        w.ue(self.id);
        w.ue(self.sps_id);
        w.bit(self.dependent_slice_segments_enabled);
        w.bit(self.output_flag_present);
        w.bits(u32::from(self.num_extra_slice_header_bits), 3);
        w.bit(self.sign_data_hiding_enabled);
        w.bit(self.cabac_init_present);
        w.ue(self.num_ref_idx_l0_default_active_minus1);
        w.ue(self.num_ref_idx_l1_default_active_minus1);
        w.se(self.init_qp_minus26);
        w.bit(self.constrained_intra_pred);
        w.bit(self.transform_skip_enabled);
        w.bit(self.cu_qp_delta_depth.is_some());
        if let Some(depth) = self.cu_qp_delta_depth {
            w.ue(depth);
        }
        w.se(self.cb_qp_offset);
        w.se(self.cr_qp_offset);
        w.bit(self.slice_chroma_qp_offsets_present);
        w.bit(self.weighted_pred);
        w.bit(self.weighted_bipred);
        w.bit(self.transquant_bypass_enabled);
        w.bit(false); // tiles_enabled_flag
        w.bit(self.entropy_coding_sync_enabled);
        w.bit(self.loop_filter_across_slices_enabled);
        w.bit(self.deblocking.is_some());
        if let Some((override_enabled, disabled, beta, tc)) = self.deblocking {
            w.bit(override_enabled);
            w.bit(disabled);
            if !disabled {
                w.se(beta);
                w.se(tc);
            }
        }
        w.bit(false); // pps_scaling_list_data_present_flag
        w.bit(self.lists_modification_present);
        w.ue(self.log2_parallel_merge_level_minus2);
        w.bit(self.slice_segment_header_extension_present);
        w.bit(self.extension_present);
        if self.extension_present {
            w.bits(0, 8);
        }
        w.trailing();
        w.into_bytes()
    }

    pub fn to_nal(&self) -> Vec<u8> {
        nal_unit(&header(PPS, 0), &self.rbsp())
    }
}

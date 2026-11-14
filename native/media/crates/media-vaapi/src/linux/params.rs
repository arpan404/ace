// SPDX-License-Identifier: Apache-2.0
//! VA encode parameter buffers filled from the parameter sets in [`crate::plan`], so the
//! driver codes exactly what the packed headers say.
use super::ffi::*;
use crate::plan::{Frame, H264Plan, HevcPlan};
use media_bitstream::h264::PocType;
use media_bitstream::nal;

/// The surfaces a picture codes into and refers to.
#[derive(Clone, Copy, Debug)]
pub struct Targets {
    pub reconstructed: VASurfaceID,
    pub reference: Option<VASurfaceID>,
    pub coded: VABufferID,
}

/// Rate settings for the sequence buffer.
#[derive(Clone, Copy, Debug)]
pub struct Rate {
    pub bits_per_second: u32,
    pub intra_period: u32,
}

pub fn h264_sequence(plan: &H264Plan, rate: Rate) -> VAEncSequenceParameterBufferH264 {
    use h264_seq as s;
    use h264_vui as v;
    let sps = &plan.sps;
    let mut p: VAEncSequenceParameterBufferH264 = zeroed();
    p.seq_parameter_set_id = sps.id as u8;
    p.level_idc = sps.level_idc;
    p.intra_period = rate.intra_period;
    p.intra_idr_period = rate.intra_period;
    p.ip_period = 1;
    p.bits_per_second = rate.bits_per_second;
    p.max_num_ref_frames = sps.max_num_ref_frames;
    p.picture_width_in_mbs = (sps.pic_width_in_mbs_minus1 + 1) as u16;
    p.picture_height_in_mbs = (sps.pic_height_in_map_units_minus1 + 1) as u16;
    let (poc_type, lsb) = match sps.poc {
        PocType::Zero {
            log2_max_pic_order_cnt_lsb_minus4,
        } => (0, log2_max_pic_order_cnt_lsb_minus4),
        PocType::One { .. } => (1, 0),
        PocType::Two => (2, 0),
    };
    p.seq_fields = pack(
        s::LAYOUT,
        &[
            (s::CHROMA_FORMAT_IDC, sps.chroma_format_idc()),
            (s::FRAME_MBS_ONLY_FLAG, u32::from(sps.frame_mbs_only)),
            (
                s::DIRECT_8X8_INFERENCE_FLAG,
                u32::from(sps.direct_8x8_inference),
            ),
            (s::LOG2_MAX_FRAME_NUM_MINUS4, sps.log2_max_frame_num_minus4),
            (s::PIC_ORDER_CNT_TYPE, poc_type),
            (s::LOG2_MAX_PIC_ORDER_CNT_LSB_MINUS4, lsb),
        ],
    );
    if let Some(c) = sps.crop {
        p.frame_cropping_flag = 1;
        p.frame_crop_left_offset = c.left;
        p.frame_crop_right_offset = c.right;
        p.frame_crop_top_offset = c.top;
        p.frame_crop_bottom_offset = c.bottom;
    }
    if let Some(vui) = &sps.vui {
        p.vui_parameters_present_flag = 1;
        let r = vui.restriction;
        p.vui_fields = pack(
            v::LAYOUT,
            &[
                (v::TIMING_INFO_PRESENT_FLAG, u32::from(vui.timing.is_some())),
                (v::BITSTREAM_RESTRICTION_FLAG, u32::from(r.is_some())),
                (
                    v::LOG2_MAX_MV_LENGTH_HORIZONTAL,
                    r.map_or(15, |r| r.log2_max_mv_length_horizontal),
                ),
                (
                    v::LOG2_MAX_MV_LENGTH_VERTICAL,
                    r.map_or(15, |r| r.log2_max_mv_length_vertical),
                ),
                (
                    v::FIXED_FRAME_RATE_FLAG,
                    u32::from(vui.timing.is_some_and(|t| t.fixed_frame_rate)),
                ),
                (
                    v::MOTION_VECTORS_OVER_PIC_BOUNDARIES_FLAG,
                    u32::from(r.is_some_and(|r| r.motion_vectors_over_pic_boundaries)),
                ),
            ],
        );
        if let Some(t) = vui.timing {
            p.num_units_in_tick = t.num_units_in_tick;
            p.time_scale = t.time_scale;
        }
    }
    p
}

fn h264_picture(surface: VASurfaceID, frame_num: u32, poc: i32, reference: bool) -> VAPictureH264 {
    VAPictureH264 {
        picture_id: surface,
        frame_idx: frame_num,
        flags: if reference {
            VA_PICTURE_H264_SHORT_TERM_REFERENCE
        } else {
            0
        },
        TopFieldOrderCnt: poc,
        BottomFieldOrderCnt: poc,
        va_reserved: [0; 4],
    }
}

/// H.264 POC type 2 counts two per frame.
fn h264_poc(index: u32) -> i32 {
    (index.saturating_mul(2)).min(i32::MAX as u32) as i32
}

pub fn h264_picture_params(
    plan: &H264Plan,
    frame: Frame,
    targets: Targets,
    max_frame_num: u32,
) -> VAEncPictureParameterBufferH264 {
    use h264_pic as f;
    let pps = &plan.pps;
    let mut p: VAEncPictureParameterBufferH264 = zeroed();
    p.CurrPic = h264_picture(
        targets.reconstructed,
        frame.frame_num,
        h264_poc(frame.index),
        false,
    );
    p.ReferenceFrames = [VAPictureH264::invalid(); 16];
    if let (false, Some(reference)) = (frame.idr, targets.reference) {
        let prev = frame.index - 1;
        p.ReferenceFrames[0] = h264_picture(reference, prev % max_frame_num, h264_poc(prev), true);
    }
    p.coded_buf = targets.coded;
    p.pic_parameter_set_id = pps.id as u8;
    p.seq_parameter_set_id = pps.sps_id as u8;
    p.frame_num = frame.frame_num as u16;
    p.pic_init_qp = (pps.pic_init_qp_minus26 + 26) as u8;
    p.num_ref_idx_l0_active_minus1 = pps.num_ref_idx_l0_default_active_minus1 as u8;
    p.chroma_qp_index_offset = pps.chroma_qp_index_offset as i8;
    p.second_chroma_qp_index_offset = pps.high.map_or(pps.chroma_qp_index_offset, |h| {
        h.second_chroma_qp_index_offset
    }) as i8;
    p.pic_fields = pack(
        f::LAYOUT,
        &[
            (f::IDR_PIC_FLAG, u32::from(frame.idr)),
            (f::REFERENCE_PIC_FLAG, 1),
            (
                f::ENTROPY_CODING_MODE_FLAG,
                u32::from(pps.entropy_coding_mode),
            ),
            (
                f::TRANSFORM_8X8_MODE_FLAG,
                u32::from(pps.high.is_some_and(|h| h.transform_8x8_mode)),
            ),
            (
                f::DEBLOCKING_FILTER_CONTROL_PRESENT_FLAG,
                u32::from(pps.deblocking_filter_control_present),
            ),
        ],
    );
    p
}

pub fn h264_slice(
    plan: &H264Plan,
    frame: Frame,
    targets: Targets,
    max_frame_num: u32,
    qp: u8,
) -> VAEncSliceParameterBufferH264 {
    let sps = &plan.sps;
    let mut p: VAEncSliceParameterBufferH264 = zeroed();
    p.num_macroblocks =
        (sps.pic_width_in_mbs_minus1 + 1) * (sps.pic_height_in_map_units_minus1 + 1);
    p.macroblock_info = VA_INVALID_ID;
    // VA's slice_type is H.264's modulo 5: P 0, I 2.
    p.slice_type = if frame.idr { 2 } else { 0 };
    p.pic_parameter_set_id = plan.pps.id as u8;
    p.idr_pic_id = frame.idr_pic_id as u16;
    p.RefPicList0 = [VAPictureH264::invalid(); 32];
    p.RefPicList1 = [VAPictureH264::invalid(); 32];
    if let (false, Some(reference)) = (frame.idr, targets.reference) {
        let prev = frame.index - 1;
        p.RefPicList0[0] = h264_picture(reference, prev % max_frame_num, h264_poc(prev), true);
    }
    p.slice_qp_delta = (i32::from(qp) - (plan.pps.pic_init_qp_minus26 + 26)) as i8;
    p
}

pub fn hevc_sequence(plan: &HevcPlan, rate: Rate) -> VAEncSequenceParameterBufferHEVC {
    use hevc_seq as s;
    use hevc_vui as v;
    let sps = &plan.sps;
    let mut p: VAEncSequenceParameterBufferHEVC = zeroed();
    p.general_profile_idc = sps.ptl.profile_idc;
    p.general_level_idc = sps.ptl.level_idc;
    p.general_tier_flag = u8::from(sps.ptl.tier);
    p.intra_period = rate.intra_period;
    p.intra_idr_period = rate.intra_period;
    p.ip_period = 1;
    p.bits_per_second = rate.bits_per_second;
    p.pic_width_in_luma_samples = sps.pic_width_in_luma_samples as u16;
    p.pic_height_in_luma_samples = sps.pic_height_in_luma_samples as u16;
    p.seq_fields = pack(
        s::LAYOUT,
        &[
            (s::CHROMA_FORMAT_IDC, sps.chroma_format_idc),
            (s::BIT_DEPTH_LUMA_MINUS8, sps.bit_depth_luma_minus8),
            (s::BIT_DEPTH_CHROMA_MINUS8, sps.bit_depth_chroma_minus8),
            (
                s::SCALING_LIST_ENABLED_FLAG,
                u32::from(sps.scaling_list_enabled),
            ),
            (
                s::STRONG_INTRA_SMOOTHING_ENABLED_FLAG,
                u32::from(sps.strong_intra_smoothing_enabled),
            ),
            (s::AMP_ENABLED_FLAG, u32::from(sps.amp_enabled)),
            (
                s::SAMPLE_ADAPTIVE_OFFSET_ENABLED_FLAG,
                u32::from(sps.sample_adaptive_offset_enabled),
            ),
            (
                s::SPS_TEMPORAL_MVP_ENABLED_FLAG,
                u32::from(sps.temporal_mvp_enabled),
            ),
            (s::LOW_DELAY_SEQ, 1),
        ],
    );
    p.log2_min_luma_coding_block_size_minus3 = sps.log2_min_luma_coding_block_size_minus3 as u8;
    p.log2_diff_max_min_luma_coding_block_size = sps.log2_diff_max_min_luma_coding_block_size as u8;
    p.log2_min_transform_block_size_minus2 = sps.log2_min_luma_transform_block_size_minus2 as u8;
    p.log2_diff_max_min_transform_block_size =
        sps.log2_diff_max_min_luma_transform_block_size as u8;
    p.max_transform_hierarchy_depth_inter = sps.max_transform_hierarchy_depth_inter as u8;
    p.max_transform_hierarchy_depth_intra = sps.max_transform_hierarchy_depth_intra as u8;
    if let Some(vui) = &sps.vui {
        p.vui_parameters_present_flag = 1;
        p.vui_fields = pack(
            v::LAYOUT,
            &[
                (
                    v::VUI_TIMING_INFO_PRESENT_FLAG,
                    u32::from(vui.timing.is_some()),
                ),
                (
                    v::BITSTREAM_RESTRICTION_FLAG,
                    u32::from(vui.restriction.is_some()),
                ),
                (v::LOG2_MAX_MV_LENGTH_HORIZONTAL, 15),
                (v::LOG2_MAX_MV_LENGTH_VERTICAL, 15),
            ],
        );
        if let Some(t) = vui.timing {
            p.vui_num_units_in_tick = t.num_units_in_tick;
            p.vui_time_scale = t.time_scale;
        }
    }
    p
}

fn hevc_picture(surface: VASurfaceID, poc: u32, flags: u32) -> VAPictureHEVC {
    VAPictureHEVC {
        picture_id: surface,
        pic_order_cnt: poc.min(i32::MAX as u32) as i32,
        flags,
        va_reserved: [0; 4],
    }
}

pub fn hevc_picture_params(
    plan: &HevcPlan,
    frame: Frame,
    targets: Targets,
) -> VAEncPictureParameterBufferHEVC {
    use hevc_pic as f;
    let pps = &plan.pps;
    let mut p: VAEncPictureParameterBufferHEVC = zeroed();
    p.decoded_curr_pic = hevc_picture(targets.reconstructed, frame.index, 0);
    p.reference_frames = [VAPictureHEVC::invalid(); 15];
    if let (false, Some(reference)) = (frame.idr, targets.reference) {
        p.reference_frames[0] = hevc_picture(reference, frame.index - 1, 0);
    }
    p.coded_buf = targets.coded;
    p.collocated_ref_pic_index = 0xff;
    p.pic_init_qp = (pps.init_qp_minus26 + 26) as u8;
    p.diff_cu_qp_delta_depth = pps.cu_qp_delta_depth.unwrap_or(0) as u8;
    p.pps_cb_qp_offset = pps.cb_qp_offset as i8;
    p.pps_cr_qp_offset = pps.cr_qp_offset as i8;
    p.log2_parallel_merge_level_minus2 = pps.log2_parallel_merge_level_minus2 as u8;
    p.num_ref_idx_l0_default_active_minus1 = pps.num_ref_idx_l0_default_active_minus1 as u8;
    p.num_ref_idx_l1_default_active_minus1 = pps.num_ref_idx_l1_default_active_minus1 as u8;
    p.slice_pic_parameter_set_id = pps.id as u8;
    p.nal_unit_type = if frame.idr {
        nal::hevc::IDR_W_RADL
    } else {
        nal::hevc::TRAIL_R
    };
    p.pic_fields = pack(
        f::LAYOUT,
        &[
            (f::IDR_PIC_FLAG, u32::from(frame.idr)),
            // coding_type: 1 I, 2 P.
            (f::CODING_TYPE, if frame.idr { 1 } else { 2 }),
            (f::REFERENCE_PIC_FLAG, 1),
            (
                f::CU_QP_DELTA_ENABLED_FLAG,
                u32::from(pps.cu_qp_delta_depth.is_some()),
            ),
            (
                f::PPS_LOOP_FILTER_ACROSS_SLICES_ENABLED_FLAG,
                u32::from(pps.loop_filter_across_slices_enabled),
            ),
        ],
    );
    p
}

pub fn hevc_slice(
    plan: &HevcPlan,
    frame: Frame,
    targets: Targets,
    qp: u8,
) -> VAEncSliceParameterBufferHEVC {
    use hevc_slice as f;
    let mut p: VAEncSliceParameterBufferHEVC = zeroed();
    p.num_ctu_in_slice = plan.sps.ctb_count();
    // HEVC slice_type: P 1, I 2.
    p.slice_type = if frame.idr { 2 } else { 1 };
    p.slice_pic_parameter_set_id = plan.pps.id as u8;
    p.ref_pic_list0 = [VAPictureHEVC::invalid(); 15];
    p.ref_pic_list1 = [VAPictureHEVC::invalid(); 15];
    if let (false, Some(reference)) = (frame.idr, targets.reference) {
        p.ref_pic_list0[0] = hevc_picture(reference, frame.index - 1, 0);
    }
    p.max_num_merge_cand = 5;
    p.slice_qp_delta = (i32::from(qp) - (plan.pps.init_qp_minus26 + 26)) as i8;
    p.slice_fields = pack(
        f::LAYOUT,
        &[
            (f::LAST_SLICE_OF_PIC_FLAG, 1),
            (
                f::SLICE_LOOP_FILTER_ACROSS_SLICES_ENABLED_FLAG,
                u32::from(plan.pps.loop_filter_across_slices_enabled),
            ),
            (f::COLLOCATED_FROM_L0_FLAG, 1),
        ],
    );
    p
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;
    use crate::plan::{Gop, h264_plan, hevc_plan};
    use crate::select::profile;
    use media_codec::{Codec, EncodeSpec, RateControl, Size};

    fn spec(codec: Codec) -> EncodeSpec {
        EncodeSpec {
            codec,
            size: Size {
                width: 1206,
                height: 2622,
            },
            fps: 60,
            rate: RateControl::Quantizer(30),
        }
    }

    const TARGETS: Targets = Targets {
        reconstructed: 7,
        reference: Some(6),
        coded: 40,
    };

    #[test]
    fn the_h264_sequence_buffer_matches_the_sps() {
        let plan = h264_plan(&spec(Codec::H264), profile::H264_HIGH).unwrap();
        let rate = Rate {
            bits_per_second: 0,
            intra_period: 1200,
        };
        let seq = h264_sequence(&plan, rate);
        assert_eq!(
            (seq.picture_width_in_mbs, seq.picture_height_in_mbs),
            (76, 164)
        );
        assert_eq!(seq.frame_cropping_flag, 1);
        assert_eq!(
            (seq.frame_crop_right_offset, seq.frame_crop_bottom_offset),
            (5, 1)
        );
        assert_eq!(seq.level_idc, 51);
        // chroma 4:2:0, frame_mbs_only, direct_8x8, log2_max_frame_num_minus4 4, POC type 2.
        assert_eq!(seq.seq_fields, 1 | 4 | 32 | (4 << 6) | (2 << 10));
        assert_eq!(seq.time_scale, 120);
    }

    #[test]
    fn a_p_picture_refers_to_the_previous_reconstruction() {
        let plan = h264_plan(&spec(Codec::H264), profile::H264_HIGH).unwrap();
        let mut gop = Gop::new(1200, 8);
        let idr = gop.next(false);
        let pic = h264_picture_params(&plan, idr, TARGETS, 256);
        assert_eq!(pic.pic_fields & 1, 1);
        assert_eq!(pic.ReferenceFrames[0].picture_id, VA_INVALID_SURFACE);
        let p = gop.next(false);
        let pic = h264_picture_params(&plan, p, TARGETS, 256);
        assert_eq!(pic.pic_fields & 1, 0);
        assert_eq!(pic.ReferenceFrames[0].picture_id, 6);
        assert_eq!(pic.CurrPic.TopFieldOrderCnt, 2);
        let slice = h264_slice(&plan, p, TARGETS, 256, 34);
        assert_eq!(slice.slice_type, 0);
        assert_eq!(slice.RefPicList0[0].picture_id, 6);
        assert_eq!(slice.slice_qp_delta, 4);
        assert_eq!(slice.num_macroblocks, 76 * 164);
    }

    #[test]
    fn hevc_buffers_match_the_parameter_sets() {
        let plan = hevc_plan(&spec(Codec::Hevc)).unwrap();
        let seq = hevc_sequence(
            &plan,
            Rate {
                bits_per_second: 0,
                intra_period: 1200,
            },
        );
        assert_eq!(
            (
                seq.pic_width_in_luma_samples,
                seq.pic_height_in_luma_samples
            ),
            (1216, 2624)
        );
        assert_eq!(seq.log2_diff_max_min_luma_coding_block_size, 3);
        let mut gop = Gop::new(1200, 8);
        gop.next(false);
        let p = gop.next(false);
        let pic = hevc_picture_params(&plan, p, TARGETS);
        assert_eq!(pic.nal_unit_type, nal::hevc::TRAIL_R);
        assert_eq!(pic.reference_frames[0].pic_order_cnt, 0);
        let slice = hevc_slice(&plan, p, TARGETS, 30);
        assert_eq!(slice.num_ctu_in_slice, 19 * 41);
        assert_eq!(slice.slice_type, 1);
    }
}

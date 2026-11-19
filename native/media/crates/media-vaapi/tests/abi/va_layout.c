/* SPDX-License-Identifier: Apache-2.0
 * Prints the sizes, field offsets and bitfield positions media-vaapi's FFI types must match,
 * as the rows of `layout_matches_va_h` in src/linux/ffi.rs. Uses the installed libva headers only; nothing
 * is linked:
 *   cc va_layout.c -o va_layout && ./va_layout
 */
#include <stddef.h>
#include <stdio.h>
#include <va/va.h>
#include <va/va_drmcommon.h>
#include <va/va_enc_h264.h>
#include <va/va_enc_hevc.h>
#include <va/va_enc_jpeg.h>
#include <va/va_dec_jpeg.h>
#include <va/va_vpp.h>

#define S(t) printf("            (\"%s\", size_of::<%s>(), %zu),\n", #t, #t, sizeof(t))
#define O(t, f) printf("            (\"%s.%s\", offset_of!(%s, %s), %zu),\n", #t, #f, #t, #f, offsetof(t, f))

int main(void) {
    printf("            // VA-API %d.%d\n", VA_MAJOR_VERSION, VA_MINOR_VERSION);
    S(VAConfigAttrib);
    S(VASurfaceAttrib);
    S(VADRMPRIMESurfaceDescriptor);
    S(VAImage);
    S(VAImageFormat);
    S(VACodedBufferSegment);
    S(VAEncPackedHeaderParameterBuffer);
    S(VAEncMiscParameterRateControl);
    S(VAEncMiscParameterFrameRate);
    S(VAEncMiscParameterHRD);
    S(VAPictureH264);
    S(VAEncSequenceParameterBufferH264);
    S(VAEncPictureParameterBufferH264);
    S(VAEncSliceParameterBufferH264);
    S(VAPictureHEVC);
    S(VAEncSequenceParameterBufferHEVC);
    S(VAEncPictureParameterBufferHEVC);
    S(VAEncSliceParameterBufferHEVC);
    S(VARectangle);
    S(VAProcColorProperties);
    S(VAProcPipelineParameterBuffer);
    S(VAPictureParameterBufferJPEGBaseline);
    S(VAIQMatrixBufferJPEGBaseline);
    S(VAHuffmanTableBufferJPEGBaseline);
    S(VASliceParameterBufferJPEGBaseline);
    S(VAEncPictureParameterBufferJPEG);
    S(VAEncSliceParameterBufferJPEG);
    S(VAQMatrixBufferJPEG);
    O(VAImage, format);
    O(VAImage, buf);
    O(VAImage, width);
    O(VAImage, data_size);
    O(VAImage, num_planes);
    O(VAImage, pitches);
    O(VAImage, offsets);
    O(VADRMPRIMESurfaceDescriptor, num_objects);
    O(VADRMPRIMESurfaceDescriptor, objects);
    O(VADRMPRIMESurfaceDescriptor, num_layers);
    O(VADRMPRIMESurfaceDescriptor, layers);
    O(VAEncPackedHeaderParameterBuffer, bit_length);
    O(VAEncPackedHeaderParameterBuffer, has_emulation_bytes);
    O(VAEncMiscParameterRateControl, initial_qp);
    O(VAEncMiscParameterRateControl, min_qp);
    O(VAEncMiscParameterRateControl, rc_flags);
    O(VAEncMiscParameterRateControl, max_qp);
    O(VAEncMiscParameterRateControl, target_frame_size);
    O(VAEncSequenceParameterBufferH264, level_idc);
    O(VAEncSequenceParameterBufferH264, intra_period);
    O(VAEncSequenceParameterBufferH264, intra_idr_period);
    O(VAEncSequenceParameterBufferH264, ip_period);
    O(VAEncSequenceParameterBufferH264, bits_per_second);
    O(VAEncSequenceParameterBufferH264, max_num_ref_frames);
    O(VAEncSequenceParameterBufferH264, picture_width_in_mbs);
    O(VAEncSequenceParameterBufferH264, picture_height_in_mbs);
    O(VAEncSequenceParameterBufferH264, seq_fields);
    O(VAEncSequenceParameterBufferH264, bit_depth_luma_minus8);
    O(VAEncSequenceParameterBufferH264, num_ref_frames_in_pic_order_cnt_cycle);
    O(VAEncSequenceParameterBufferH264, offset_for_non_ref_pic);
    O(VAEncSequenceParameterBufferH264, offset_for_ref_frame);
    O(VAEncSequenceParameterBufferH264, frame_cropping_flag);
    O(VAEncSequenceParameterBufferH264, frame_crop_left_offset);
    O(VAEncSequenceParameterBufferH264, frame_crop_bottom_offset);
    O(VAEncSequenceParameterBufferH264, vui_parameters_present_flag);
    O(VAEncSequenceParameterBufferH264, vui_fields);
    O(VAEncSequenceParameterBufferH264, aspect_ratio_idc);
    O(VAEncSequenceParameterBufferH264, sar_width);
    O(VAEncSequenceParameterBufferH264, num_units_in_tick);
    O(VAEncSequenceParameterBufferH264, time_scale);
    O(VAEncPictureParameterBufferH264, ReferenceFrames);
    O(VAEncPictureParameterBufferH264, coded_buf);
    O(VAEncPictureParameterBufferH264, pic_parameter_set_id);
    O(VAEncPictureParameterBufferH264, last_picture);
    O(VAEncPictureParameterBufferH264, frame_num);
    O(VAEncPictureParameterBufferH264, pic_init_qp);
    O(VAEncPictureParameterBufferH264, num_ref_idx_l0_active_minus1);
    O(VAEncPictureParameterBufferH264, chroma_qp_index_offset);
    O(VAEncPictureParameterBufferH264, second_chroma_qp_index_offset);
    O(VAEncPictureParameterBufferH264, pic_fields);
    O(VAEncSliceParameterBufferH264, num_macroblocks);
    O(VAEncSliceParameterBufferH264, macroblock_info);
    O(VAEncSliceParameterBufferH264, slice_type);
    O(VAEncSliceParameterBufferH264, pic_parameter_set_id);
    O(VAEncSliceParameterBufferH264, idr_pic_id);
    O(VAEncSliceParameterBufferH264, pic_order_cnt_lsb);
    O(VAEncSliceParameterBufferH264, delta_pic_order_cnt_bottom);
    O(VAEncSliceParameterBufferH264, delta_pic_order_cnt);
    O(VAEncSliceParameterBufferH264, direct_spatial_mv_pred_flag);
    O(VAEncSliceParameterBufferH264, num_ref_idx_active_override_flag);
    O(VAEncSliceParameterBufferH264, num_ref_idx_l0_active_minus1);
    O(VAEncSliceParameterBufferH264, RefPicList0);
    O(VAEncSliceParameterBufferH264, RefPicList1);
    O(VAEncSliceParameterBufferH264, luma_log2_weight_denom);
    O(VAEncSliceParameterBufferH264, luma_weight_l0);
    O(VAEncSliceParameterBufferH264, chroma_weight_l0_flag);
    O(VAEncSliceParameterBufferH264, luma_weight_l1_flag);
    O(VAEncSliceParameterBufferH264, cabac_init_idc);
    O(VAEncSliceParameterBufferH264, slice_qp_delta);
    O(VAEncSliceParameterBufferH264, disable_deblocking_filter_idc);
    O(VAEncSliceParameterBufferH264, slice_beta_offset_div2);
    O(VAEncSequenceParameterBufferHEVC, general_level_idc);
    O(VAEncSequenceParameterBufferHEVC, general_tier_flag);
    O(VAEncSequenceParameterBufferHEVC, intra_period);
    O(VAEncSequenceParameterBufferHEVC, ip_period);
    O(VAEncSequenceParameterBufferHEVC, bits_per_second);
    O(VAEncSequenceParameterBufferHEVC, pic_width_in_luma_samples);
    O(VAEncSequenceParameterBufferHEVC, pic_height_in_luma_samples);
    O(VAEncSequenceParameterBufferHEVC, seq_fields);
    O(VAEncSequenceParameterBufferHEVC, log2_min_luma_coding_block_size_minus3);
    O(VAEncSequenceParameterBufferHEVC, max_transform_hierarchy_depth_intra);
    O(VAEncSequenceParameterBufferHEVC, pcm_sample_bit_depth_luma_minus1);
    O(VAEncSequenceParameterBufferHEVC, log2_max_pcm_luma_coding_block_size_minus3);
    O(VAEncSequenceParameterBufferHEVC, vui_parameters_present_flag);
    O(VAEncSequenceParameterBufferHEVC, vui_fields);
    O(VAEncSequenceParameterBufferHEVC, aspect_ratio_idc);
    O(VAEncSequenceParameterBufferHEVC, sar_width);
    O(VAEncSequenceParameterBufferHEVC, vui_num_units_in_tick);
    O(VAEncSequenceParameterBufferHEVC, vui_time_scale);
    O(VAEncSequenceParameterBufferHEVC, min_spatial_segmentation_idc);
    O(VAEncSequenceParameterBufferHEVC, max_bytes_per_pic_denom);
    O(VAEncSequenceParameterBufferHEVC, max_bits_per_min_cu_denom);
    O(VAEncSequenceParameterBufferHEVC, scc_fields);
    O(VAEncPictureParameterBufferHEVC, reference_frames);
    O(VAEncPictureParameterBufferHEVC, coded_buf);
    O(VAEncPictureParameterBufferHEVC, collocated_ref_pic_index);
    O(VAEncPictureParameterBufferHEVC, last_picture);
    O(VAEncPictureParameterBufferHEVC, pic_init_qp);
    O(VAEncPictureParameterBufferHEVC, diff_cu_qp_delta_depth);
    O(VAEncPictureParameterBufferHEVC, pps_cb_qp_offset);
    O(VAEncPictureParameterBufferHEVC, num_tile_columns_minus1);
    O(VAEncPictureParameterBufferHEVC, column_width_minus1);
    O(VAEncPictureParameterBufferHEVC, row_height_minus1);
    O(VAEncPictureParameterBufferHEVC, log2_parallel_merge_level_minus2);
    O(VAEncPictureParameterBufferHEVC, ctu_max_bitsize_allowed);
    O(VAEncPictureParameterBufferHEVC, num_ref_idx_l0_default_active_minus1);
    O(VAEncPictureParameterBufferHEVC, slice_pic_parameter_set_id);
    O(VAEncPictureParameterBufferHEVC, nal_unit_type);
    O(VAEncPictureParameterBufferHEVC, pic_fields);
    O(VAEncPictureParameterBufferHEVC, hierarchical_level_plus1);
    O(VAEncPictureParameterBufferHEVC, scc_fields);
    O(VAEncSliceParameterBufferHEVC, num_ctu_in_slice);
    O(VAEncSliceParameterBufferHEVC, slice_type);
    O(VAEncSliceParameterBufferHEVC, slice_pic_parameter_set_id);
    O(VAEncSliceParameterBufferHEVC, num_ref_idx_l0_active_minus1);
    O(VAEncSliceParameterBufferHEVC, num_ref_idx_l1_active_minus1);
    O(VAEncSliceParameterBufferHEVC, ref_pic_list0);
    O(VAEncSliceParameterBufferHEVC, ref_pic_list1);
    O(VAEncSliceParameterBufferHEVC, luma_log2_weight_denom);
    O(VAEncSliceParameterBufferHEVC, delta_chroma_log2_weight_denom);
    O(VAEncSliceParameterBufferHEVC, delta_luma_weight_l0);
    O(VAEncSliceParameterBufferHEVC, chroma_offset_l1);
    O(VAEncSliceParameterBufferHEVC, max_num_merge_cand);
    O(VAEncSliceParameterBufferHEVC, slice_qp_delta);
    O(VAEncSliceParameterBufferHEVC, slice_tc_offset_div2);
    O(VAEncSliceParameterBufferHEVC, slice_fields);
    O(VAEncSliceParameterBufferHEVC, pred_weight_table_bit_offset);
    O(VAProcPipelineParameterBuffer, surface_region);
    O(VAProcPipelineParameterBuffer, surface_color_standard);
    O(VAProcPipelineParameterBuffer, output_region);
    O(VAProcPipelineParameterBuffer, output_background_color);
    O(VAProcPipelineParameterBuffer, output_color_standard);
    O(VAProcPipelineParameterBuffer, pipeline_flags);
    O(VAProcPipelineParameterBuffer, filter_flags);
    O(VAProcPipelineParameterBuffer, filters);
    O(VAProcPipelineParameterBuffer, num_filters);
    O(VAProcPipelineParameterBuffer, forward_references);
    O(VAProcPipelineParameterBuffer, rotation_state);
    O(VAProcPipelineParameterBuffer, blend_state);
    O(VAProcPipelineParameterBuffer, mirror_state);
    O(VAProcPipelineParameterBuffer, additional_outputs);
    O(VAProcPipelineParameterBuffer, input_surface_flag);
    O(VAProcPipelineParameterBuffer, output_surface_flag);
    O(VAProcPipelineParameterBuffer, input_color_properties);
    O(VAProcPipelineParameterBuffer, output_color_properties);
    O(VAProcPipelineParameterBuffer, processing_mode);
    O(VAProcPipelineParameterBuffer, output_hdr_metadata);
    O(VAPictureParameterBufferJPEGBaseline, components);
    O(VAPictureParameterBufferJPEGBaseline, num_components);
    O(VAPictureParameterBufferJPEGBaseline, color_space);
    O(VAPictureParameterBufferJPEGBaseline, rotation);
    O(VAIQMatrixBufferJPEGBaseline, quantiser_table);
    O(VAHuffmanTableBufferJPEGBaseline, huffman_table);
    O(VASliceParameterBufferJPEGBaseline, slice_data_offset);
    O(VASliceParameterBufferJPEGBaseline, slice_data_flag);
    O(VASliceParameterBufferJPEGBaseline, slice_horizontal_position);
    O(VASliceParameterBufferJPEGBaseline, components);
    O(VASliceParameterBufferJPEGBaseline, num_components);
    O(VASliceParameterBufferJPEGBaseline, restart_interval);
    O(VASliceParameterBufferJPEGBaseline, num_mcus);
    O(VAEncPictureParameterBufferJPEG, picture_width);
    O(VAEncPictureParameterBufferJPEG, coded_buf);
    O(VAEncPictureParameterBufferJPEG, pic_flags);
    O(VAEncPictureParameterBufferJPEG, sample_bit_depth);
    O(VAEncPictureParameterBufferJPEG, num_scan);
    O(VAEncPictureParameterBufferJPEG, num_components);
    O(VAEncPictureParameterBufferJPEG, component_id);
    O(VAEncPictureParameterBufferJPEG, quantiser_table_selector);
    O(VAEncPictureParameterBufferJPEG, quality);
    O(VAEncSliceParameterBufferJPEG, num_components);
    O(VAEncSliceParameterBufferJPEG, components);
    O(VAQMatrixBufferJPEG, load_chroma_quantiser_matrix);
    O(VAQMatrixBufferJPEG, lum_quantiser_matrix);
    O(VAQMatrixBufferJPEG, chroma_quantiser_matrix);

    /* Bitfields: each field set to 1 alone, read back as the union value. */
    { VAEncSequenceParameterBufferH264 x = {0}; x.seq_fields.bits.chroma_format_idc = 1; printf("            (\"H264_SEQ_FIELDS.chroma_format_idc\", pack(h264_seq::LAYOUT, &[(h264_seq::CHROMA_FORMAT_IDC, 1)]), %u),\n", x.seq_fields.value); }
    { VAEncSequenceParameterBufferH264 x = {0}; x.seq_fields.bits.frame_mbs_only_flag = 1; printf("            (\"H264_SEQ_FIELDS.frame_mbs_only_flag\", pack(h264_seq::LAYOUT, &[(h264_seq::FRAME_MBS_ONLY_FLAG, 1)]), %u),\n", x.seq_fields.value); }
    { VAEncSequenceParameterBufferH264 x = {0}; x.seq_fields.bits.mb_adaptive_frame_field_flag = 1; printf("            (\"H264_SEQ_FIELDS.mb_adaptive_frame_field_flag\", pack(h264_seq::LAYOUT, &[(h264_seq::MB_ADAPTIVE_FRAME_FIELD_FLAG, 1)]), %u),\n", x.seq_fields.value); }
    { VAEncSequenceParameterBufferH264 x = {0}; x.seq_fields.bits.seq_scaling_matrix_present_flag = 1; printf("            (\"H264_SEQ_FIELDS.seq_scaling_matrix_present_flag\", pack(h264_seq::LAYOUT, &[(h264_seq::SEQ_SCALING_MATRIX_PRESENT_FLAG, 1)]), %u),\n", x.seq_fields.value); }
    { VAEncSequenceParameterBufferH264 x = {0}; x.seq_fields.bits.direct_8x8_inference_flag = 1; printf("            (\"H264_SEQ_FIELDS.direct_8x8_inference_flag\", pack(h264_seq::LAYOUT, &[(h264_seq::DIRECT_8X8_INFERENCE_FLAG, 1)]), %u),\n", x.seq_fields.value); }
    { VAEncSequenceParameterBufferH264 x = {0}; x.seq_fields.bits.log2_max_frame_num_minus4 = 1; printf("            (\"H264_SEQ_FIELDS.log2_max_frame_num_minus4\", pack(h264_seq::LAYOUT, &[(h264_seq::LOG2_MAX_FRAME_NUM_MINUS4, 1)]), %u),\n", x.seq_fields.value); }
    { VAEncSequenceParameterBufferH264 x = {0}; x.seq_fields.bits.pic_order_cnt_type = 1; printf("            (\"H264_SEQ_FIELDS.pic_order_cnt_type\", pack(h264_seq::LAYOUT, &[(h264_seq::PIC_ORDER_CNT_TYPE, 1)]), %u),\n", x.seq_fields.value); }
    { VAEncSequenceParameterBufferH264 x = {0}; x.seq_fields.bits.log2_max_pic_order_cnt_lsb_minus4 = 1; printf("            (\"H264_SEQ_FIELDS.log2_max_pic_order_cnt_lsb_minus4\", pack(h264_seq::LAYOUT, &[(h264_seq::LOG2_MAX_PIC_ORDER_CNT_LSB_MINUS4, 1)]), %u),\n", x.seq_fields.value); }
    { VAEncSequenceParameterBufferH264 x = {0}; x.seq_fields.bits.delta_pic_order_always_zero_flag = 1; printf("            (\"H264_SEQ_FIELDS.delta_pic_order_always_zero_flag\", pack(h264_seq::LAYOUT, &[(h264_seq::DELTA_PIC_ORDER_ALWAYS_ZERO_FLAG, 1)]), %u),\n", x.seq_fields.value); }
    { VAEncSequenceParameterBufferH264 x = {0}; x.vui_fields.bits.aspect_ratio_info_present_flag = 1; printf("            (\"H264_VUI_FIELDS.aspect_ratio_info_present_flag\", pack(h264_vui::LAYOUT, &[(h264_vui::ASPECT_RATIO_INFO_PRESENT_FLAG, 1)]), %u),\n", x.vui_fields.value); }
    { VAEncSequenceParameterBufferH264 x = {0}; x.vui_fields.bits.timing_info_present_flag = 1; printf("            (\"H264_VUI_FIELDS.timing_info_present_flag\", pack(h264_vui::LAYOUT, &[(h264_vui::TIMING_INFO_PRESENT_FLAG, 1)]), %u),\n", x.vui_fields.value); }
    { VAEncSequenceParameterBufferH264 x = {0}; x.vui_fields.bits.bitstream_restriction_flag = 1; printf("            (\"H264_VUI_FIELDS.bitstream_restriction_flag\", pack(h264_vui::LAYOUT, &[(h264_vui::BITSTREAM_RESTRICTION_FLAG, 1)]), %u),\n", x.vui_fields.value); }
    { VAEncSequenceParameterBufferH264 x = {0}; x.vui_fields.bits.log2_max_mv_length_horizontal = 1; printf("            (\"H264_VUI_FIELDS.log2_max_mv_length_horizontal\", pack(h264_vui::LAYOUT, &[(h264_vui::LOG2_MAX_MV_LENGTH_HORIZONTAL, 1)]), %u),\n", x.vui_fields.value); }
    { VAEncSequenceParameterBufferH264 x = {0}; x.vui_fields.bits.log2_max_mv_length_vertical = 1; printf("            (\"H264_VUI_FIELDS.log2_max_mv_length_vertical\", pack(h264_vui::LAYOUT, &[(h264_vui::LOG2_MAX_MV_LENGTH_VERTICAL, 1)]), %u),\n", x.vui_fields.value); }
    { VAEncSequenceParameterBufferH264 x = {0}; x.vui_fields.bits.fixed_frame_rate_flag = 1; printf("            (\"H264_VUI_FIELDS.fixed_frame_rate_flag\", pack(h264_vui::LAYOUT, &[(h264_vui::FIXED_FRAME_RATE_FLAG, 1)]), %u),\n", x.vui_fields.value); }
    { VAEncSequenceParameterBufferH264 x = {0}; x.vui_fields.bits.low_delay_hrd_flag = 1; printf("            (\"H264_VUI_FIELDS.low_delay_hrd_flag\", pack(h264_vui::LAYOUT, &[(h264_vui::LOW_DELAY_HRD_FLAG, 1)]), %u),\n", x.vui_fields.value); }
    { VAEncSequenceParameterBufferH264 x = {0}; x.vui_fields.bits.motion_vectors_over_pic_boundaries_flag = 1; printf("            (\"H264_VUI_FIELDS.motion_vectors_over_pic_boundaries_flag\", pack(h264_vui::LAYOUT, &[(h264_vui::MOTION_VECTORS_OVER_PIC_BOUNDARIES_FLAG, 1)]), %u),\n", x.vui_fields.value); }
    { VAEncPictureParameterBufferH264 x = {0}; x.pic_fields.bits.idr_pic_flag = 1; printf("            (\"H264_PIC_FIELDS.idr_pic_flag\", pack(h264_pic::LAYOUT, &[(h264_pic::IDR_PIC_FLAG, 1)]), %u),\n", x.pic_fields.value); }
    { VAEncPictureParameterBufferH264 x = {0}; x.pic_fields.bits.reference_pic_flag = 1; printf("            (\"H264_PIC_FIELDS.reference_pic_flag\", pack(h264_pic::LAYOUT, &[(h264_pic::REFERENCE_PIC_FLAG, 1)]), %u),\n", x.pic_fields.value); }
    { VAEncPictureParameterBufferH264 x = {0}; x.pic_fields.bits.entropy_coding_mode_flag = 1; printf("            (\"H264_PIC_FIELDS.entropy_coding_mode_flag\", pack(h264_pic::LAYOUT, &[(h264_pic::ENTROPY_CODING_MODE_FLAG, 1)]), %u),\n", x.pic_fields.value); }
    { VAEncPictureParameterBufferH264 x = {0}; x.pic_fields.bits.weighted_pred_flag = 1; printf("            (\"H264_PIC_FIELDS.weighted_pred_flag\", pack(h264_pic::LAYOUT, &[(h264_pic::WEIGHTED_PRED_FLAG, 1)]), %u),\n", x.pic_fields.value); }
    { VAEncPictureParameterBufferH264 x = {0}; x.pic_fields.bits.weighted_bipred_idc = 1; printf("            (\"H264_PIC_FIELDS.weighted_bipred_idc\", pack(h264_pic::LAYOUT, &[(h264_pic::WEIGHTED_BIPRED_IDC, 1)]), %u),\n", x.pic_fields.value); }
    { VAEncPictureParameterBufferH264 x = {0}; x.pic_fields.bits.constrained_intra_pred_flag = 1; printf("            (\"H264_PIC_FIELDS.constrained_intra_pred_flag\", pack(h264_pic::LAYOUT, &[(h264_pic::CONSTRAINED_INTRA_PRED_FLAG, 1)]), %u),\n", x.pic_fields.value); }
    { VAEncPictureParameterBufferH264 x = {0}; x.pic_fields.bits.transform_8x8_mode_flag = 1; printf("            (\"H264_PIC_FIELDS.transform_8x8_mode_flag\", pack(h264_pic::LAYOUT, &[(h264_pic::TRANSFORM_8X8_MODE_FLAG, 1)]), %u),\n", x.pic_fields.value); }
    { VAEncPictureParameterBufferH264 x = {0}; x.pic_fields.bits.deblocking_filter_control_present_flag = 1; printf("            (\"H264_PIC_FIELDS.deblocking_filter_control_present_flag\", pack(h264_pic::LAYOUT, &[(h264_pic::DEBLOCKING_FILTER_CONTROL_PRESENT_FLAG, 1)]), %u),\n", x.pic_fields.value); }
    { VAEncPictureParameterBufferH264 x = {0}; x.pic_fields.bits.redundant_pic_cnt_present_flag = 1; printf("            (\"H264_PIC_FIELDS.redundant_pic_cnt_present_flag\", pack(h264_pic::LAYOUT, &[(h264_pic::REDUNDANT_PIC_CNT_PRESENT_FLAG, 1)]), %u),\n", x.pic_fields.value); }
    { VAEncPictureParameterBufferH264 x = {0}; x.pic_fields.bits.pic_order_present_flag = 1; printf("            (\"H264_PIC_FIELDS.pic_order_present_flag\", pack(h264_pic::LAYOUT, &[(h264_pic::PIC_ORDER_PRESENT_FLAG, 1)]), %u),\n", x.pic_fields.value); }
    { VAEncPictureParameterBufferH264 x = {0}; x.pic_fields.bits.pic_scaling_matrix_present_flag = 1; printf("            (\"H264_PIC_FIELDS.pic_scaling_matrix_present_flag\", pack(h264_pic::LAYOUT, &[(h264_pic::PIC_SCALING_MATRIX_PRESENT_FLAG, 1)]), %u),\n", x.pic_fields.value); }
    { VAEncSequenceParameterBufferHEVC x = {0}; x.seq_fields.bits.chroma_format_idc = 1; printf("            (\"HEVC_SEQ_FIELDS.chroma_format_idc\", pack(hevc_seq::LAYOUT, &[(hevc_seq::CHROMA_FORMAT_IDC, 1)]), %u),\n", x.seq_fields.value); }
    { VAEncSequenceParameterBufferHEVC x = {0}; x.seq_fields.bits.separate_colour_plane_flag = 1; printf("            (\"HEVC_SEQ_FIELDS.separate_colour_plane_flag\", pack(hevc_seq::LAYOUT, &[(hevc_seq::SEPARATE_COLOUR_PLANE_FLAG, 1)]), %u),\n", x.seq_fields.value); }
    { VAEncSequenceParameterBufferHEVC x = {0}; x.seq_fields.bits.bit_depth_luma_minus8 = 1; printf("            (\"HEVC_SEQ_FIELDS.bit_depth_luma_minus8\", pack(hevc_seq::LAYOUT, &[(hevc_seq::BIT_DEPTH_LUMA_MINUS8, 1)]), %u),\n", x.seq_fields.value); }
    { VAEncSequenceParameterBufferHEVC x = {0}; x.seq_fields.bits.bit_depth_chroma_minus8 = 1; printf("            (\"HEVC_SEQ_FIELDS.bit_depth_chroma_minus8\", pack(hevc_seq::LAYOUT, &[(hevc_seq::BIT_DEPTH_CHROMA_MINUS8, 1)]), %u),\n", x.seq_fields.value); }
    { VAEncSequenceParameterBufferHEVC x = {0}; x.seq_fields.bits.scaling_list_enabled_flag = 1; printf("            (\"HEVC_SEQ_FIELDS.scaling_list_enabled_flag\", pack(hevc_seq::LAYOUT, &[(hevc_seq::SCALING_LIST_ENABLED_FLAG, 1)]), %u),\n", x.seq_fields.value); }
    { VAEncSequenceParameterBufferHEVC x = {0}; x.seq_fields.bits.strong_intra_smoothing_enabled_flag = 1; printf("            (\"HEVC_SEQ_FIELDS.strong_intra_smoothing_enabled_flag\", pack(hevc_seq::LAYOUT, &[(hevc_seq::STRONG_INTRA_SMOOTHING_ENABLED_FLAG, 1)]), %u),\n", x.seq_fields.value); }
    { VAEncSequenceParameterBufferHEVC x = {0}; x.seq_fields.bits.amp_enabled_flag = 1; printf("            (\"HEVC_SEQ_FIELDS.amp_enabled_flag\", pack(hevc_seq::LAYOUT, &[(hevc_seq::AMP_ENABLED_FLAG, 1)]), %u),\n", x.seq_fields.value); }
    { VAEncSequenceParameterBufferHEVC x = {0}; x.seq_fields.bits.sample_adaptive_offset_enabled_flag = 1; printf("            (\"HEVC_SEQ_FIELDS.sample_adaptive_offset_enabled_flag\", pack(hevc_seq::LAYOUT, &[(hevc_seq::SAMPLE_ADAPTIVE_OFFSET_ENABLED_FLAG, 1)]), %u),\n", x.seq_fields.value); }
    { VAEncSequenceParameterBufferHEVC x = {0}; x.seq_fields.bits.pcm_enabled_flag = 1; printf("            (\"HEVC_SEQ_FIELDS.pcm_enabled_flag\", pack(hevc_seq::LAYOUT, &[(hevc_seq::PCM_ENABLED_FLAG, 1)]), %u),\n", x.seq_fields.value); }
    { VAEncSequenceParameterBufferHEVC x = {0}; x.seq_fields.bits.pcm_loop_filter_disabled_flag = 1; printf("            (\"HEVC_SEQ_FIELDS.pcm_loop_filter_disabled_flag\", pack(hevc_seq::LAYOUT, &[(hevc_seq::PCM_LOOP_FILTER_DISABLED_FLAG, 1)]), %u),\n", x.seq_fields.value); }
    { VAEncSequenceParameterBufferHEVC x = {0}; x.seq_fields.bits.sps_temporal_mvp_enabled_flag = 1; printf("            (\"HEVC_SEQ_FIELDS.sps_temporal_mvp_enabled_flag\", pack(hevc_seq::LAYOUT, &[(hevc_seq::SPS_TEMPORAL_MVP_ENABLED_FLAG, 1)]), %u),\n", x.seq_fields.value); }
    { VAEncSequenceParameterBufferHEVC x = {0}; x.seq_fields.bits.low_delay_seq = 1; printf("            (\"HEVC_SEQ_FIELDS.low_delay_seq\", pack(hevc_seq::LAYOUT, &[(hevc_seq::LOW_DELAY_SEQ, 1)]), %u),\n", x.seq_fields.value); }
    { VAEncSequenceParameterBufferHEVC x = {0}; x.seq_fields.bits.hierachical_flag = 1; printf("            (\"HEVC_SEQ_FIELDS.hierachical_flag\", pack(hevc_seq::LAYOUT, &[(hevc_seq::HIERACHICAL_FLAG, 1)]), %u),\n", x.seq_fields.value); }
    { VAEncSequenceParameterBufferHEVC x = {0}; x.vui_fields.bits.aspect_ratio_info_present_flag = 1; printf("            (\"HEVC_VUI_FIELDS.aspect_ratio_info_present_flag\", pack(hevc_vui::LAYOUT, &[(hevc_vui::ASPECT_RATIO_INFO_PRESENT_FLAG, 1)]), %u),\n", x.vui_fields.value); }
    { VAEncSequenceParameterBufferHEVC x = {0}; x.vui_fields.bits.neutral_chroma_indication_flag = 1; printf("            (\"HEVC_VUI_FIELDS.neutral_chroma_indication_flag\", pack(hevc_vui::LAYOUT, &[(hevc_vui::NEUTRAL_CHROMA_INDICATION_FLAG, 1)]), %u),\n", x.vui_fields.value); }
    { VAEncSequenceParameterBufferHEVC x = {0}; x.vui_fields.bits.field_seq_flag = 1; printf("            (\"HEVC_VUI_FIELDS.field_seq_flag\", pack(hevc_vui::LAYOUT, &[(hevc_vui::FIELD_SEQ_FLAG, 1)]), %u),\n", x.vui_fields.value); }
    { VAEncSequenceParameterBufferHEVC x = {0}; x.vui_fields.bits.vui_timing_info_present_flag = 1; printf("            (\"HEVC_VUI_FIELDS.vui_timing_info_present_flag\", pack(hevc_vui::LAYOUT, &[(hevc_vui::VUI_TIMING_INFO_PRESENT_FLAG, 1)]), %u),\n", x.vui_fields.value); }
    { VAEncSequenceParameterBufferHEVC x = {0}; x.vui_fields.bits.bitstream_restriction_flag = 1; printf("            (\"HEVC_VUI_FIELDS.bitstream_restriction_flag\", pack(hevc_vui::LAYOUT, &[(hevc_vui::BITSTREAM_RESTRICTION_FLAG, 1)]), %u),\n", x.vui_fields.value); }
    { VAEncSequenceParameterBufferHEVC x = {0}; x.vui_fields.bits.tiles_fixed_structure_flag = 1; printf("            (\"HEVC_VUI_FIELDS.tiles_fixed_structure_flag\", pack(hevc_vui::LAYOUT, &[(hevc_vui::TILES_FIXED_STRUCTURE_FLAG, 1)]), %u),\n", x.vui_fields.value); }
    { VAEncSequenceParameterBufferHEVC x = {0}; x.vui_fields.bits.motion_vectors_over_pic_boundaries_flag = 1; printf("            (\"HEVC_VUI_FIELDS.motion_vectors_over_pic_boundaries_flag\", pack(hevc_vui::LAYOUT, &[(hevc_vui::MOTION_VECTORS_OVER_PIC_BOUNDARIES_FLAG, 1)]), %u),\n", x.vui_fields.value); }
    { VAEncSequenceParameterBufferHEVC x = {0}; x.vui_fields.bits.restricted_ref_pic_lists_flag = 1; printf("            (\"HEVC_VUI_FIELDS.restricted_ref_pic_lists_flag\", pack(hevc_vui::LAYOUT, &[(hevc_vui::RESTRICTED_REF_PIC_LISTS_FLAG, 1)]), %u),\n", x.vui_fields.value); }
    { VAEncSequenceParameterBufferHEVC x = {0}; x.vui_fields.bits.log2_max_mv_length_horizontal = 1; printf("            (\"HEVC_VUI_FIELDS.log2_max_mv_length_horizontal\", pack(hevc_vui::LAYOUT, &[(hevc_vui::LOG2_MAX_MV_LENGTH_HORIZONTAL, 1)]), %u),\n", x.vui_fields.value); }
    { VAEncSequenceParameterBufferHEVC x = {0}; x.vui_fields.bits.log2_max_mv_length_vertical = 1; printf("            (\"HEVC_VUI_FIELDS.log2_max_mv_length_vertical\", pack(hevc_vui::LAYOUT, &[(hevc_vui::LOG2_MAX_MV_LENGTH_VERTICAL, 1)]), %u),\n", x.vui_fields.value); }
    { VAEncPictureParameterBufferHEVC x = {0}; x.pic_fields.bits.idr_pic_flag = 1; printf("            (\"HEVC_PIC_FIELDS.idr_pic_flag\", pack(hevc_pic::LAYOUT, &[(hevc_pic::IDR_PIC_FLAG, 1)]), %u),\n", x.pic_fields.value); }
    { VAEncPictureParameterBufferHEVC x = {0}; x.pic_fields.bits.coding_type = 1; printf("            (\"HEVC_PIC_FIELDS.coding_type\", pack(hevc_pic::LAYOUT, &[(hevc_pic::CODING_TYPE, 1)]), %u),\n", x.pic_fields.value); }
    { VAEncPictureParameterBufferHEVC x = {0}; x.pic_fields.bits.reference_pic_flag = 1; printf("            (\"HEVC_PIC_FIELDS.reference_pic_flag\", pack(hevc_pic::LAYOUT, &[(hevc_pic::REFERENCE_PIC_FLAG, 1)]), %u),\n", x.pic_fields.value); }
    { VAEncPictureParameterBufferHEVC x = {0}; x.pic_fields.bits.dependent_slice_segments_enabled_flag = 1; printf("            (\"HEVC_PIC_FIELDS.dependent_slice_segments_enabled_flag\", pack(hevc_pic::LAYOUT, &[(hevc_pic::DEPENDENT_SLICE_SEGMENTS_ENABLED_FLAG, 1)]), %u),\n", x.pic_fields.value); }
    { VAEncPictureParameterBufferHEVC x = {0}; x.pic_fields.bits.sign_data_hiding_enabled_flag = 1; printf("            (\"HEVC_PIC_FIELDS.sign_data_hiding_enabled_flag\", pack(hevc_pic::LAYOUT, &[(hevc_pic::SIGN_DATA_HIDING_ENABLED_FLAG, 1)]), %u),\n", x.pic_fields.value); }
    { VAEncPictureParameterBufferHEVC x = {0}; x.pic_fields.bits.constrained_intra_pred_flag = 1; printf("            (\"HEVC_PIC_FIELDS.constrained_intra_pred_flag\", pack(hevc_pic::LAYOUT, &[(hevc_pic::CONSTRAINED_INTRA_PRED_FLAG, 1)]), %u),\n", x.pic_fields.value); }
    { VAEncPictureParameterBufferHEVC x = {0}; x.pic_fields.bits.transform_skip_enabled_flag = 1; printf("            (\"HEVC_PIC_FIELDS.transform_skip_enabled_flag\", pack(hevc_pic::LAYOUT, &[(hevc_pic::TRANSFORM_SKIP_ENABLED_FLAG, 1)]), %u),\n", x.pic_fields.value); }
    { VAEncPictureParameterBufferHEVC x = {0}; x.pic_fields.bits.cu_qp_delta_enabled_flag = 1; printf("            (\"HEVC_PIC_FIELDS.cu_qp_delta_enabled_flag\", pack(hevc_pic::LAYOUT, &[(hevc_pic::CU_QP_DELTA_ENABLED_FLAG, 1)]), %u),\n", x.pic_fields.value); }
    { VAEncPictureParameterBufferHEVC x = {0}; x.pic_fields.bits.weighted_pred_flag = 1; printf("            (\"HEVC_PIC_FIELDS.weighted_pred_flag\", pack(hevc_pic::LAYOUT, &[(hevc_pic::WEIGHTED_PRED_FLAG, 1)]), %u),\n", x.pic_fields.value); }
    { VAEncPictureParameterBufferHEVC x = {0}; x.pic_fields.bits.weighted_bipred_flag = 1; printf("            (\"HEVC_PIC_FIELDS.weighted_bipred_flag\", pack(hevc_pic::LAYOUT, &[(hevc_pic::WEIGHTED_BIPRED_FLAG, 1)]), %u),\n", x.pic_fields.value); }
    { VAEncPictureParameterBufferHEVC x = {0}; x.pic_fields.bits.transquant_bypass_enabled_flag = 1; printf("            (\"HEVC_PIC_FIELDS.transquant_bypass_enabled_flag\", pack(hevc_pic::LAYOUT, &[(hevc_pic::TRANSQUANT_BYPASS_ENABLED_FLAG, 1)]), %u),\n", x.pic_fields.value); }
    { VAEncPictureParameterBufferHEVC x = {0}; x.pic_fields.bits.tiles_enabled_flag = 1; printf("            (\"HEVC_PIC_FIELDS.tiles_enabled_flag\", pack(hevc_pic::LAYOUT, &[(hevc_pic::TILES_ENABLED_FLAG, 1)]), %u),\n", x.pic_fields.value); }
    { VAEncPictureParameterBufferHEVC x = {0}; x.pic_fields.bits.entropy_coding_sync_enabled_flag = 1; printf("            (\"HEVC_PIC_FIELDS.entropy_coding_sync_enabled_flag\", pack(hevc_pic::LAYOUT, &[(hevc_pic::ENTROPY_CODING_SYNC_ENABLED_FLAG, 1)]), %u),\n", x.pic_fields.value); }
    { VAEncPictureParameterBufferHEVC x = {0}; x.pic_fields.bits.loop_filter_across_tiles_enabled_flag = 1; printf("            (\"HEVC_PIC_FIELDS.loop_filter_across_tiles_enabled_flag\", pack(hevc_pic::LAYOUT, &[(hevc_pic::LOOP_FILTER_ACROSS_TILES_ENABLED_FLAG, 1)]), %u),\n", x.pic_fields.value); }
    { VAEncPictureParameterBufferHEVC x = {0}; x.pic_fields.bits.pps_loop_filter_across_slices_enabled_flag = 1; printf("            (\"HEVC_PIC_FIELDS.pps_loop_filter_across_slices_enabled_flag\", pack(hevc_pic::LAYOUT, &[(hevc_pic::PPS_LOOP_FILTER_ACROSS_SLICES_ENABLED_FLAG, 1)]), %u),\n", x.pic_fields.value); }
    { VAEncPictureParameterBufferHEVC x = {0}; x.pic_fields.bits.scaling_list_data_present_flag = 1; printf("            (\"HEVC_PIC_FIELDS.scaling_list_data_present_flag\", pack(hevc_pic::LAYOUT, &[(hevc_pic::SCALING_LIST_DATA_PRESENT_FLAG, 1)]), %u),\n", x.pic_fields.value); }
    { VAEncPictureParameterBufferHEVC x = {0}; x.pic_fields.bits.screen_content_flag = 1; printf("            (\"HEVC_PIC_FIELDS.screen_content_flag\", pack(hevc_pic::LAYOUT, &[(hevc_pic::SCREEN_CONTENT_FLAG, 1)]), %u),\n", x.pic_fields.value); }
    { VAEncPictureParameterBufferHEVC x = {0}; x.pic_fields.bits.enable_gpu_weighted_prediction = 1; printf("            (\"HEVC_PIC_FIELDS.enable_gpu_weighted_prediction\", pack(hevc_pic::LAYOUT, &[(hevc_pic::ENABLE_GPU_WEIGHTED_PREDICTION, 1)]), %u),\n", x.pic_fields.value); }
    { VAEncPictureParameterBufferHEVC x = {0}; x.pic_fields.bits.no_output_of_prior_pics_flag = 1; printf("            (\"HEVC_PIC_FIELDS.no_output_of_prior_pics_flag\", pack(hevc_pic::LAYOUT, &[(hevc_pic::NO_OUTPUT_OF_PRIOR_PICS_FLAG, 1)]), %u),\n", x.pic_fields.value); }
    { VAEncSliceParameterBufferHEVC x = {0}; x.slice_fields.bits.last_slice_of_pic_flag = 1; printf("            (\"HEVC_SLICE_FIELDS.last_slice_of_pic_flag\", pack(hevc_slice::LAYOUT, &[(hevc_slice::LAST_SLICE_OF_PIC_FLAG, 1)]), %u),\n", x.slice_fields.value); }
    { VAEncSliceParameterBufferHEVC x = {0}; x.slice_fields.bits.dependent_slice_segment_flag = 1; printf("            (\"HEVC_SLICE_FIELDS.dependent_slice_segment_flag\", pack(hevc_slice::LAYOUT, &[(hevc_slice::DEPENDENT_SLICE_SEGMENT_FLAG, 1)]), %u),\n", x.slice_fields.value); }
    { VAEncSliceParameterBufferHEVC x = {0}; x.slice_fields.bits.colour_plane_id = 1; printf("            (\"HEVC_SLICE_FIELDS.colour_plane_id\", pack(hevc_slice::LAYOUT, &[(hevc_slice::COLOUR_PLANE_ID, 1)]), %u),\n", x.slice_fields.value); }
    { VAEncSliceParameterBufferHEVC x = {0}; x.slice_fields.bits.slice_temporal_mvp_enabled_flag = 1; printf("            (\"HEVC_SLICE_FIELDS.slice_temporal_mvp_enabled_flag\", pack(hevc_slice::LAYOUT, &[(hevc_slice::SLICE_TEMPORAL_MVP_ENABLED_FLAG, 1)]), %u),\n", x.slice_fields.value); }
    { VAEncSliceParameterBufferHEVC x = {0}; x.slice_fields.bits.slice_sao_luma_flag = 1; printf("            (\"HEVC_SLICE_FIELDS.slice_sao_luma_flag\", pack(hevc_slice::LAYOUT, &[(hevc_slice::SLICE_SAO_LUMA_FLAG, 1)]), %u),\n", x.slice_fields.value); }
    { VAEncSliceParameterBufferHEVC x = {0}; x.slice_fields.bits.slice_sao_chroma_flag = 1; printf("            (\"HEVC_SLICE_FIELDS.slice_sao_chroma_flag\", pack(hevc_slice::LAYOUT, &[(hevc_slice::SLICE_SAO_CHROMA_FLAG, 1)]), %u),\n", x.slice_fields.value); }
    { VAEncSliceParameterBufferHEVC x = {0}; x.slice_fields.bits.num_ref_idx_active_override_flag = 1; printf("            (\"HEVC_SLICE_FIELDS.num_ref_idx_active_override_flag\", pack(hevc_slice::LAYOUT, &[(hevc_slice::NUM_REF_IDX_ACTIVE_OVERRIDE_FLAG, 1)]), %u),\n", x.slice_fields.value); }
    { VAEncSliceParameterBufferHEVC x = {0}; x.slice_fields.bits.mvd_l1_zero_flag = 1; printf("            (\"HEVC_SLICE_FIELDS.mvd_l1_zero_flag\", pack(hevc_slice::LAYOUT, &[(hevc_slice::MVD_L1_ZERO_FLAG, 1)]), %u),\n", x.slice_fields.value); }
    { VAEncSliceParameterBufferHEVC x = {0}; x.slice_fields.bits.cabac_init_flag = 1; printf("            (\"HEVC_SLICE_FIELDS.cabac_init_flag\", pack(hevc_slice::LAYOUT, &[(hevc_slice::CABAC_INIT_FLAG, 1)]), %u),\n", x.slice_fields.value); }
    { VAEncSliceParameterBufferHEVC x = {0}; x.slice_fields.bits.slice_deblocking_filter_disabled_flag = 1; printf("            (\"HEVC_SLICE_FIELDS.slice_deblocking_filter_disabled_flag\", pack(hevc_slice::LAYOUT, &[(hevc_slice::SLICE_DEBLOCKING_FILTER_DISABLED_FLAG, 1)]), %u),\n", x.slice_fields.value); }
    { VAEncSliceParameterBufferHEVC x = {0}; x.slice_fields.bits.slice_loop_filter_across_slices_enabled_flag = 1; printf("            (\"HEVC_SLICE_FIELDS.slice_loop_filter_across_slices_enabled_flag\", pack(hevc_slice::LAYOUT, &[(hevc_slice::SLICE_LOOP_FILTER_ACROSS_SLICES_ENABLED_FLAG, 1)]), %u),\n", x.slice_fields.value); }
    { VAEncSliceParameterBufferHEVC x = {0}; x.slice_fields.bits.collocated_from_l0_flag = 1; printf("            (\"HEVC_SLICE_FIELDS.collocated_from_l0_flag\", pack(hevc_slice::LAYOUT, &[(hevc_slice::COLLOCATED_FROM_L0_FLAG, 1)]), %u),\n", x.slice_fields.value); }
    { VAEncPictureParameterBufferJPEG x = {0}; x.pic_flags.bits.profile = 1; printf("            (\"JPEG_PIC_FLAGS.profile\", pack(jpeg_pic::LAYOUT, &[(jpeg_pic::PROFILE, 1)]), %u),\n", x.pic_flags.value); }
    { VAEncPictureParameterBufferJPEG x = {0}; x.pic_flags.bits.progressive = 1; printf("            (\"JPEG_PIC_FLAGS.progressive\", pack(jpeg_pic::LAYOUT, &[(jpeg_pic::PROGRESSIVE, 1)]), %u),\n", x.pic_flags.value); }
    { VAEncPictureParameterBufferJPEG x = {0}; x.pic_flags.bits.huffman = 1; printf("            (\"JPEG_PIC_FLAGS.huffman\", pack(jpeg_pic::LAYOUT, &[(jpeg_pic::HUFFMAN, 1)]), %u),\n", x.pic_flags.value); }
    { VAEncPictureParameterBufferJPEG x = {0}; x.pic_flags.bits.interleaved = 1; printf("            (\"JPEG_PIC_FLAGS.interleaved\", pack(jpeg_pic::LAYOUT, &[(jpeg_pic::INTERLEAVED, 1)]), %u),\n", x.pic_flags.value); }
    { VAEncPictureParameterBufferJPEG x = {0}; x.pic_flags.bits.differential = 1; printf("            (\"JPEG_PIC_FLAGS.differential\", pack(jpeg_pic::LAYOUT, &[(jpeg_pic::DIFFERENTIAL, 1)]), %u),\n", x.pic_flags.value); }

    /* Constants. */
#define K(name) printf("            (\"%s\", %s as u64, %llu),\n", #name, #name, (unsigned long long)(name))
    K(VA_CODED_BUF_STATUS_SLICE_OVERFLOW_MASK);
    K(VA_STATUS_ERROR_TIMEDOUT);
    K(VA_STATUS_ERROR_UNIMPLEMENTED);
    K(VA_SURFACE_ATTRIB_MEM_TYPE_DRM_PRIME_2);
    K(VA_FILTER_SCALING_HQ);
    return 0;
}

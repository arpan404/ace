// SPDX-License-Identifier: Apache-2.0
//! VA-API types and constants, written from `va.h` and its codec headers (libva 2.x, MIT).
//! Layouts are checked against the C headers by `layout_matches_va_h` below: its rows are the
//! output of `tests/abi/va_layout.c` built against libva 2.17 (identical on x86_64 and aarch64).
#![allow(non_camel_case_types, non_snake_case, dead_code)]
use std::ffi::{c_int, c_uint, c_void};

pub type VADisplay = *mut c_void;
pub type VAStatus = c_int;
pub type VAGenericID = c_uint;
pub type VAConfigID = VAGenericID;
pub type VAContextID = VAGenericID;
pub type VASurfaceID = VAGenericID;
pub type VABufferID = VAGenericID;
pub type VAImageID = VAGenericID;
pub type VAProfile = c_int;
pub type VAEntrypoint = c_int;
pub type VABufferType = c_int;

pub const VA_STATUS_SUCCESS: VAStatus = 0;
pub const VA_INVALID_ID: u32 = 0xffff_ffff;
pub const VA_INVALID_SURFACE: u32 = 0xffff_ffff;

/// `VAConfigAttribType`.
pub mod attrib {
    pub const RT_FORMAT: i32 = 0;
    pub const RATE_CONTROL: i32 = 5;
    pub const ENC_PACKED_HEADERS: i32 = 10;
    pub const ENC_MAX_REF_FRAMES: i32 = 13;
    pub const MAX_PICTURE_WIDTH: i32 = 18;
    pub const MAX_PICTURE_HEIGHT: i32 = 19;
    pub const ENC_JPEG: i32 = 20;
}

/// `VABufferType`.
pub mod buffer {
    pub const PICTURE_PARAMETER: i32 = 0;
    pub const IQ_MATRIX: i32 = 1;
    pub const SLICE_PARAMETER: i32 = 4;
    pub const SLICE_DATA: i32 = 5;
    pub const IMAGE: i32 = 9;
    pub const Q_MATRIX: i32 = 11;
    pub const HUFFMAN_TABLE: i32 = 12;
    pub const ENC_CODED: i32 = 21;
    pub const ENC_SEQUENCE_PARAMETER: i32 = 22;
    pub const ENC_PICTURE_PARAMETER: i32 = 23;
    pub const ENC_SLICE_PARAMETER: i32 = 24;
    pub const ENC_PACKED_HEADER_PARAMETER: i32 = 25;
    pub const ENC_PACKED_HEADER_DATA: i32 = 26;
    pub const ENC_MISC_PARAMETER: i32 = 27;
    pub const PROC_PIPELINE_PARAMETER: i32 = 41;
}

/// `VAEncPackedHeaderType`.
pub mod packed_type {
    pub const SEQUENCE: u32 = 1;
    pub const PICTURE: u32 = 2;
    pub const SLICE: u32 = 3;
    pub const RAW_DATA: u32 = 4;
}

/// `VAEncMiscParameterType`.
pub mod misc {
    pub const FRAME_RATE: u32 = 0;
    pub const RATE_CONTROL: u32 = 1;
    pub const HRD: u32 = 5;
}

/// `VASurfaceAttribType`.
pub mod surface_attrib {
    pub const PIXEL_FORMAT: i32 = 1;
    pub const MIN_WIDTH: i32 = 2;
    pub const MAX_WIDTH: i32 = 3;
    pub const MIN_HEIGHT: i32 = 4;
    pub const MAX_HEIGHT: i32 = 5;
    pub const MEMORY_TYPE: i32 = 6;
    pub const EXTERNAL_BUFFER_DESCRIPTOR: i32 = 7;
    pub const USAGE_HINT: i32 = 8;
}

pub const VA_SURFACE_ATTRIB_SETTABLE: u32 = 2;
pub const VA_SURFACE_ATTRIB_MEM_TYPE_DRM_PRIME_2: u32 = 0x4000_0000;
pub const VA_GENERIC_VALUE_TYPE_INTEGER: i32 = 1;
pub const VA_GENERIC_VALUE_TYPE_POINTER: i32 = 3;
pub const VA_PROGRESSIVE: c_int = 0x1;
pub const VA_SLICE_DATA_FLAG_ALL: u32 = 0;
pub const VA_LSB_FIRST: u32 = 1;

pub const VA_PICTURE_H264_INVALID: u32 = 0x1;
pub const VA_PICTURE_H264_SHORT_TERM_REFERENCE: u32 = 0x8;
pub const VA_PICTURE_HEVC_INVALID: u32 = 0x1;
pub const VA_PICTURE_HEVC_RPS_ST_CURR_BEFORE: u32 = 0x10;

/// `VAProcColorStandardType`.
pub const VA_PROC_COLOR_STANDARD_BT601: i32 = 1;
pub const VA_PROC_COLOR_STANDARD_BT709: i32 = 2;
pub const VA_PROC_COLOR_STANDARD_SRGB: i32 = 8;
pub const VA_FILTER_SCALING_HQ: u32 = 0x200;
pub const VA_SOURCE_RANGE_REDUCED: u8 = 1;
pub const VA_SOURCE_RANGE_FULL: u8 = 2;

#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct VAConfigAttrib {
    pub type_: c_int,
    pub value: u32,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub union VAGenericValueUnion {
    pub i: i32,
    pub f: f32,
    pub p: *mut c_void,
    pub func: Option<unsafe extern "C" fn()>,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct VAGenericValue {
    pub type_: c_int,
    pub value: VAGenericValueUnion,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct VASurfaceAttrib {
    pub type_: c_int,
    pub flags: u32,
    pub value: VAGenericValue,
}

impl VASurfaceAttrib {
    pub fn int(type_: c_int, value: i32) -> Self {
        Self {
            type_,
            flags: VA_SURFACE_ATTRIB_SETTABLE,
            value: VAGenericValue {
                type_: VA_GENERIC_VALUE_TYPE_INTEGER,
                value: VAGenericValueUnion { i: value },
            },
        }
    }
    pub fn pointer(type_: c_int, value: *mut c_void) -> Self {
        Self {
            type_,
            flags: VA_SURFACE_ATTRIB_SETTABLE,
            value: VAGenericValue {
                type_: VA_GENERIC_VALUE_TYPE_POINTER,
                value: VAGenericValueUnion { p: value },
            },
        }
    }
    pub fn empty() -> Self {
        Self::int(0, 0)
    }
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct VADRMPRIMEObject {
    pub fd: c_int,
    pub size: u32,
    pub drm_format_modifier: u64,
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct VADRMPRIMELayer {
    pub drm_format: u32,
    pub num_planes: u32,
    pub object_index: [u32; 4],
    pub offset: [u32; 4],
    pub pitch: [u32; 4],
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct VADRMPRIMESurfaceDescriptor {
    pub fourcc: u32,
    pub width: u32,
    pub height: u32,
    pub num_objects: u32,
    pub objects: [VADRMPRIMEObject; 4],
    pub num_layers: u32,
    pub layers: [VADRMPRIMELayer; 4],
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct VAImageFormat {
    pub fourcc: u32,
    pub byte_order: u32,
    pub bits_per_pixel: u32,
    pub depth: u32,
    pub red_mask: u32,
    pub green_mask: u32,
    pub blue_mask: u32,
    pub alpha_mask: u32,
    pub va_reserved: [u32; 4],
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct VAImage {
    pub image_id: VAImageID,
    pub format: VAImageFormat,
    pub buf: VABufferID,
    pub width: u16,
    pub height: u16,
    pub data_size: u32,
    pub num_planes: u32,
    pub pitches: [u32; 3],
    pub offsets: [u32; 3],
    pub num_palette_entries: i32,
    pub entry_bytes: i32,
    pub component_order: [i8; 4],
    pub va_reserved: [u32; 4],
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct VACodedBufferSegment {
    pub size: u32,
    pub bit_offset: u32,
    pub status: u32,
    pub reserved: u32,
    pub buf: *mut c_void,
    pub next: *mut c_void,
    pub va_reserved: [u32; 4],
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct VAEncPackedHeaderParameterBuffer {
    pub type_: u32,
    pub bit_length: u32,
    pub has_emulation_bytes: u8,
    pub va_reserved: [u32; 4],
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct VAEncMiscParameterRateControl {
    pub bits_per_second: u32,
    pub target_percentage: u32,
    pub window_size: u32,
    pub initial_qp: u32,
    pub min_qp: u32,
    pub basic_unit_size: u32,
    pub rc_flags: u32,
    pub ICQ_quality_factor: u32,
    pub max_qp: u32,
    pub quality_factor: u32,
    pub target_frame_size: u32,
    pub va_reserved: [u32; 4],
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct VAEncMiscParameterFrameRate {
    pub framerate: u32,
    pub framerate_flags: u32,
    pub va_reserved: [u32; 4],
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct VAEncMiscParameterHRD {
    pub initial_buffer_fullness: u32,
    pub buffer_size: u32,
    pub va_reserved: [u32; 4],
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct VAPictureH264 {
    pub picture_id: VASurfaceID,
    pub frame_idx: u32,
    pub flags: u32,
    pub TopFieldOrderCnt: i32,
    pub BottomFieldOrderCnt: i32,
    pub va_reserved: [u32; 4],
}

impl VAPictureH264 {
    pub fn invalid() -> Self {
        Self {
            picture_id: VA_INVALID_SURFACE,
            flags: VA_PICTURE_H264_INVALID,
            ..Default::default()
        }
    }
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct VAEncSequenceParameterBufferH264 {
    pub seq_parameter_set_id: u8,
    pub level_idc: u8,
    pub intra_period: u32,
    pub intra_idr_period: u32,
    pub ip_period: u32,
    pub bits_per_second: u32,
    pub max_num_ref_frames: u32,
    pub picture_width_in_mbs: u16,
    pub picture_height_in_mbs: u16,
    pub seq_fields: u32,
    pub bit_depth_luma_minus8: u8,
    pub bit_depth_chroma_minus8: u8,
    pub num_ref_frames_in_pic_order_cnt_cycle: u8,
    pub offset_for_non_ref_pic: i32,
    pub offset_for_top_to_bottom_field: i32,
    pub offset_for_ref_frame: [i32; 256],
    pub frame_cropping_flag: u8,
    pub frame_crop_left_offset: u32,
    pub frame_crop_right_offset: u32,
    pub frame_crop_top_offset: u32,
    pub frame_crop_bottom_offset: u32,
    pub vui_parameters_present_flag: u8,
    pub vui_fields: u32,
    pub aspect_ratio_idc: u8,
    pub sar_width: u32,
    pub sar_height: u32,
    pub num_units_in_tick: u32,
    pub time_scale: u32,
    pub va_reserved: [u32; 4],
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct VAEncPictureParameterBufferH264 {
    pub CurrPic: VAPictureH264,
    pub ReferenceFrames: [VAPictureH264; 16],
    pub coded_buf: VABufferID,
    pub pic_parameter_set_id: u8,
    pub seq_parameter_set_id: u8,
    pub last_picture: u8,
    pub frame_num: u16,
    pub pic_init_qp: u8,
    pub num_ref_idx_l0_active_minus1: u8,
    pub num_ref_idx_l1_active_minus1: u8,
    pub chroma_qp_index_offset: i8,
    pub second_chroma_qp_index_offset: i8,
    pub pic_fields: u32,
    pub va_reserved: [u32; 4],
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct VAEncSliceParameterBufferH264 {
    pub macroblock_address: u32,
    pub num_macroblocks: u32,
    pub macroblock_info: VABufferID,
    pub slice_type: u8,
    pub pic_parameter_set_id: u8,
    pub idr_pic_id: u16,
    pub pic_order_cnt_lsb: u16,
    pub delta_pic_order_cnt_bottom: i32,
    pub delta_pic_order_cnt: [i32; 2],
    pub direct_spatial_mv_pred_flag: u8,
    pub num_ref_idx_active_override_flag: u8,
    pub num_ref_idx_l0_active_minus1: u8,
    pub num_ref_idx_l1_active_minus1: u8,
    pub RefPicList0: [VAPictureH264; 32],
    pub RefPicList1: [VAPictureH264; 32],
    pub luma_log2_weight_denom: u8,
    pub chroma_log2_weight_denom: u8,
    pub luma_weight_l0_flag: u8,
    pub luma_weight_l0: [i16; 32],
    pub luma_offset_l0: [i16; 32],
    pub chroma_weight_l0_flag: u8,
    pub chroma_weight_l0: [[i16; 2]; 32],
    pub chroma_offset_l0: [[i16; 2]; 32],
    pub luma_weight_l1_flag: u8,
    pub luma_weight_l1: [i16; 32],
    pub luma_offset_l1: [i16; 32],
    pub chroma_weight_l1_flag: u8,
    pub chroma_weight_l1: [[i16; 2]; 32],
    pub chroma_offset_l1: [[i16; 2]; 32],
    pub cabac_init_idc: u8,
    pub slice_qp_delta: i8,
    pub disable_deblocking_filter_idc: u8,
    pub slice_alpha_c0_offset_div2: i8,
    pub slice_beta_offset_div2: i8,
    pub va_reserved: [u32; 4],
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct VAPictureHEVC {
    pub picture_id: VASurfaceID,
    pub pic_order_cnt: i32,
    pub flags: u32,
    pub va_reserved: [u32; 4],
}

impl VAPictureHEVC {
    pub fn invalid() -> Self {
        Self {
            picture_id: VA_INVALID_SURFACE,
            flags: VA_PICTURE_HEVC_INVALID,
            ..Default::default()
        }
    }
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct VAEncSequenceParameterBufferHEVC {
    pub general_profile_idc: u8,
    pub general_level_idc: u8,
    pub general_tier_flag: u8,
    pub intra_period: u32,
    pub intra_idr_period: u32,
    pub ip_period: u32,
    pub bits_per_second: u32,
    pub pic_width_in_luma_samples: u16,
    pub pic_height_in_luma_samples: u16,
    pub seq_fields: u32,
    pub log2_min_luma_coding_block_size_minus3: u8,
    pub log2_diff_max_min_luma_coding_block_size: u8,
    pub log2_min_transform_block_size_minus2: u8,
    pub log2_diff_max_min_transform_block_size: u8,
    pub max_transform_hierarchy_depth_inter: u8,
    pub max_transform_hierarchy_depth_intra: u8,
    pub pcm_sample_bit_depth_luma_minus1: u32,
    pub pcm_sample_bit_depth_chroma_minus1: u32,
    pub log2_min_pcm_luma_coding_block_size_minus3: u32,
    pub log2_max_pcm_luma_coding_block_size_minus3: u32,
    pub vui_parameters_present_flag: u8,
    pub vui_fields: u32,
    pub aspect_ratio_idc: u8,
    pub sar_width: u32,
    pub sar_height: u32,
    pub vui_num_units_in_tick: u32,
    pub vui_time_scale: u32,
    pub min_spatial_segmentation_idc: u16,
    pub max_bytes_per_pic_denom: u8,
    pub max_bits_per_min_cu_denom: u8,
    pub scc_fields: u32,
    pub va_reserved: [u32; 7],
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct VAEncPictureParameterBufferHEVC {
    pub decoded_curr_pic: VAPictureHEVC,
    pub reference_frames: [VAPictureHEVC; 15],
    pub coded_buf: VABufferID,
    pub collocated_ref_pic_index: u8,
    pub last_picture: u8,
    pub pic_init_qp: u8,
    pub diff_cu_qp_delta_depth: u8,
    pub pps_cb_qp_offset: i8,
    pub pps_cr_qp_offset: i8,
    pub num_tile_columns_minus1: u8,
    pub num_tile_rows_minus1: u8,
    pub column_width_minus1: [u8; 19],
    pub row_height_minus1: [u8; 21],
    pub log2_parallel_merge_level_minus2: u8,
    pub ctu_max_bitsize_allowed: u8,
    pub num_ref_idx_l0_default_active_minus1: u8,
    pub num_ref_idx_l1_default_active_minus1: u8,
    pub slice_pic_parameter_set_id: u8,
    pub nal_unit_type: u8,
    pub pic_fields: u32,
    pub hierarchical_level_plus1: u8,
    pub va_byte_reserved: u8,
    pub scc_fields: u16,
    pub va_reserved: [u32; 15],
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct VAEncSliceParameterBufferHEVC {
    pub slice_segment_address: u32,
    pub num_ctu_in_slice: u32,
    pub slice_type: u8,
    pub slice_pic_parameter_set_id: u8,
    pub num_ref_idx_l0_active_minus1: u8,
    pub num_ref_idx_l1_active_minus1: u8,
    pub ref_pic_list0: [VAPictureHEVC; 15],
    pub ref_pic_list1: [VAPictureHEVC; 15],
    pub luma_log2_weight_denom: u8,
    pub delta_chroma_log2_weight_denom: i8,
    pub delta_luma_weight_l0: [i8; 15],
    pub luma_offset_l0: [i8; 15],
    pub delta_chroma_weight_l0: [[i8; 2]; 15],
    pub chroma_offset_l0: [[i8; 2]; 15],
    pub delta_luma_weight_l1: [i8; 15],
    pub luma_offset_l1: [i8; 15],
    pub delta_chroma_weight_l1: [[i8; 2]; 15],
    pub chroma_offset_l1: [[i8; 2]; 15],
    pub max_num_merge_cand: u8,
    pub slice_qp_delta: i8,
    pub slice_cb_qp_offset: i8,
    pub slice_cr_qp_offset: i8,
    pub slice_beta_offset_div2: i8,
    pub slice_tc_offset_div2: i8,
    pub slice_fields: u32,
    pub pred_weight_table_bit_offset: u32,
    pub pred_weight_table_bit_length: u32,
    pub va_reserved: [u32; 6],
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct VARectangle {
    pub x: i16,
    pub y: i16,
    pub width: u16,
    pub height: u16,
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct VAProcColorProperties {
    pub chroma_sample_location: u8,
    pub color_range: u8,
    pub colour_primaries: u8,
    pub transfer_characteristics: u8,
    pub matrix_coefficients: u8,
    pub reserved: [u8; 3],
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct VAProcPipelineParameterBuffer {
    pub surface: VASurfaceID,
    pub surface_region: *const VARectangle,
    pub surface_color_standard: c_int,
    pub output_region: *const VARectangle,
    pub output_background_color: u32,
    pub output_color_standard: c_int,
    pub pipeline_flags: u32,
    pub filter_flags: u32,
    pub filters: *mut VABufferID,
    pub num_filters: u32,
    pub forward_references: *mut VASurfaceID,
    pub num_forward_references: u32,
    pub backward_references: *mut VASurfaceID,
    pub num_backward_references: u32,
    pub rotation_state: u32,
    pub blend_state: *const c_void,
    pub mirror_state: u32,
    pub additional_outputs: *mut VASurfaceID,
    pub num_additional_outputs: u32,
    pub input_surface_flag: u32,
    pub output_surface_flag: u32,
    pub input_color_properties: VAProcColorProperties,
    pub output_color_properties: VAProcColorProperties,
    pub processing_mode: c_int,
    pub output_hdr_metadata: *mut c_void,
    #[cfg(target_pointer_width = "64")]
    pub va_reserved: [u32; 16],
    #[cfg(not(target_pointer_width = "64"))]
    pub va_reserved: [u32; 19],
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct JPEGComponent {
    pub component_id: u8,
    pub h_sampling_factor: u8,
    pub v_sampling_factor: u8,
    pub quantiser_table_selector: u8,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct VAPictureParameterBufferJPEGBaseline {
    pub picture_width: u16,
    pub picture_height: u16,
    pub components: [JPEGComponent; 255],
    pub num_components: u8,
    pub color_space: u8,
    pub rotation: u32,
    pub va_reserved: [u32; 7],
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct VAIQMatrixBufferJPEGBaseline {
    pub load_quantiser_table: [u8; 4],
    pub quantiser_table: [[u8; 64]; 4],
    pub va_reserved: [u32; 4],
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct JPEGHuffmanTable {
    pub num_dc_codes: [u8; 16],
    pub dc_values: [u8; 12],
    pub num_ac_codes: [u8; 16],
    pub ac_values: [u8; 162],
    pub pad: [u8; 2],
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct VAHuffmanTableBufferJPEGBaseline {
    pub load_huffman_table: [u8; 2],
    pub huffman_table: [JPEGHuffmanTable; 2],
    pub va_reserved: [u32; 4],
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct JPEGScanComponent {
    pub component_selector: u8,
    pub dc_table_selector: u8,
    pub ac_table_selector: u8,
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct VASliceParameterBufferJPEGBaseline {
    pub slice_data_size: u32,
    pub slice_data_offset: u32,
    pub slice_data_flag: u32,
    pub slice_horizontal_position: u32,
    pub slice_vertical_position: u32,
    pub components: [JPEGScanComponent; 4],
    pub num_components: u8,
    pub restart_interval: u16,
    pub num_mcus: u32,
    pub va_reserved: [u32; 4],
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct VAEncPictureParameterBufferJPEG {
    pub reconstructed_picture: VASurfaceID,
    pub picture_width: u16,
    pub picture_height: u16,
    pub coded_buf: VABufferID,
    pub pic_flags: u32,
    pub sample_bit_depth: u8,
    pub num_scan: u8,
    pub num_components: u16,
    pub component_id: [u8; 4],
    pub quantiser_table_selector: [u8; 4],
    pub quality: u8,
    pub va_reserved: [u32; 4],
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct VAEncSliceParameterBufferJPEG {
    pub restart_interval: u16,
    pub num_components: u16,
    pub components: [JPEGScanComponent; 4],
    pub va_reserved: [u32; 4],
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct VAQMatrixBufferJPEG {
    pub load_lum_quantiser_matrix: i32,
    pub load_chroma_quantiser_matrix: i32,
    pub lum_quantiser_matrix: [u8; 64],
    pub chroma_quantiser_matrix: [u8; 64],
    pub va_reserved: [u32; 4],
}

/// Packs C bitfields LSB first, as GCC and Clang lay them out on little-endian Linux:
/// `(value, width)` pairs in declaration order.
pub fn bitfields(fields: &[(u32, u32)]) -> u32 {
    let mut out = 0u32;
    let mut shift = 0;
    for &(value, width) in fields {
        let mask = if width >= 32 {
            u32::MAX
        } else {
            (1 << width) - 1
        };
        out |= (value & mask) << shift;
        shift += width;
    }
    out
}

/// A plain-data VA struct, zeroed: every field is an integer, array or nullable pointer.
pub fn zeroed<T: Copy>() -> T {
    // SAFETY: only used with the `repr(C)` structs above, for which all-zero bytes are
    // valid (integers, arrays of integers, raw pointers, `Option` of function pointers).
    #[allow(unsafe_code)]
    unsafe {
        std::mem::zeroed()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::mem::{offset_of, size_of};

    #[test]
    fn bitfields_pack_from_the_low_bit() {
        assert_eq!(bitfields(&[(1, 2), (1, 1), (0, 1), (1, 1)]), 0b10101);
        assert_eq!(bitfields(&[(0xff, 4), (1, 1)]), 0b11111);
    }

    /// Sizes and offsets printed by `tests/abi/va_layout.c` against libva 2.17's headers
    /// (LP64). A wrong layout here corrupts every driver call.
    #[cfg(target_pointer_width = "64")]
    #[test]
    #[rustfmt::skip]
    fn layout_matches_va_h() {
        let checks: &[(&str, usize, usize)] = &[
            // VA-API 1.17
            ("VAConfigAttrib", size_of::<VAConfigAttrib>(), 8),
            ("VASurfaceAttrib", size_of::<VASurfaceAttrib>(), 24),
            ("VADRMPRIMESurfaceDescriptor", size_of::<VADRMPRIMESurfaceDescriptor>(), 312),
            ("VAImage", size_of::<VAImage>(), 120),
            ("VAImageFormat", size_of::<VAImageFormat>(), 48),
            ("VACodedBufferSegment", size_of::<VACodedBufferSegment>(), 48),
            ("VAEncPackedHeaderParameterBuffer", size_of::<VAEncPackedHeaderParameterBuffer>(), 28),
            ("VAEncMiscParameterRateControl", size_of::<VAEncMiscParameterRateControl>(), 60),
            ("VAEncMiscParameterFrameRate", size_of::<VAEncMiscParameterFrameRate>(), 24),
            ("VAEncMiscParameterHRD", size_of::<VAEncMiscParameterHRD>(), 24),
            ("VAPictureH264", size_of::<VAPictureH264>(), 36),
            ("VAEncSequenceParameterBufferH264", size_of::<VAEncSequenceParameterBufferH264>(), 1132),
            ("VAEncPictureParameterBufferH264", size_of::<VAEncPictureParameterBufferH264>(), 648),
            ("VAEncSliceParameterBufferH264", size_of::<VAEncSliceParameterBufferH264>(), 3140),
            ("VAPictureHEVC", size_of::<VAPictureHEVC>(), 28),
            ("VAEncSequenceParameterBufferHEVC", size_of::<VAEncSequenceParameterBufferHEVC>(), 116),
            ("VAEncPictureParameterBufferHEVC", size_of::<VAEncPictureParameterBufferHEVC>(), 576),
            ("VAEncSliceParameterBufferHEVC", size_of::<VAEncSliceParameterBufferHEVC>(), 1076),
            ("VARectangle", size_of::<VARectangle>(), 8),
            ("VAProcColorProperties", size_of::<VAProcColorProperties>(), 8),
            ("VAProcPipelineParameterBuffer", size_of::<VAProcPipelineParameterBuffer>(), 224),
            ("VAPictureParameterBufferJPEGBaseline", size_of::<VAPictureParameterBufferJPEGBaseline>(), 1060),
            ("VAIQMatrixBufferJPEGBaseline", size_of::<VAIQMatrixBufferJPEGBaseline>(), 276),
            ("VAHuffmanTableBufferJPEGBaseline", size_of::<VAHuffmanTableBufferJPEGBaseline>(), 436),
            ("VASliceParameterBufferJPEGBaseline", size_of::<VASliceParameterBufferJPEGBaseline>(), 56),
            ("VAEncPictureParameterBufferJPEG", size_of::<VAEncPictureParameterBufferJPEG>(), 48),
            ("VAEncSliceParameterBufferJPEG", size_of::<VAEncSliceParameterBufferJPEG>(), 32),
            ("VAQMatrixBufferJPEG", size_of::<VAQMatrixBufferJPEG>(), 152),
            ("VAImage.format", offset_of!(VAImage, format), 4),
            ("VAImage.buf", offset_of!(VAImage, buf), 52),
            ("VAImage.width", offset_of!(VAImage, width), 56),
            ("VAImage.data_size", offset_of!(VAImage, data_size), 60),
            ("VAImage.num_planes", offset_of!(VAImage, num_planes), 64),
            ("VAImage.pitches", offset_of!(VAImage, pitches), 68),
            ("VAImage.offsets", offset_of!(VAImage, offsets), 80),
            ("VADRMPRIMESurfaceDescriptor.num_objects", offset_of!(VADRMPRIMESurfaceDescriptor, num_objects), 12),
            ("VADRMPRIMESurfaceDescriptor.objects", offset_of!(VADRMPRIMESurfaceDescriptor, objects), 16),
            ("VADRMPRIMESurfaceDescriptor.num_layers", offset_of!(VADRMPRIMESurfaceDescriptor, num_layers), 80),
            ("VADRMPRIMESurfaceDescriptor.layers", offset_of!(VADRMPRIMESurfaceDescriptor, layers), 84),
            ("VAEncPackedHeaderParameterBuffer.bit_length", offset_of!(VAEncPackedHeaderParameterBuffer, bit_length), 4),
            ("VAEncPackedHeaderParameterBuffer.has_emulation_bytes", offset_of!(VAEncPackedHeaderParameterBuffer, has_emulation_bytes), 8),
            ("VAEncMiscParameterRateControl.initial_qp", offset_of!(VAEncMiscParameterRateControl, initial_qp), 12),
            ("VAEncMiscParameterRateControl.min_qp", offset_of!(VAEncMiscParameterRateControl, min_qp), 16),
            ("VAEncMiscParameterRateControl.rc_flags", offset_of!(VAEncMiscParameterRateControl, rc_flags), 24),
            ("VAEncMiscParameterRateControl.max_qp", offset_of!(VAEncMiscParameterRateControl, max_qp), 32),
            ("VAEncMiscParameterRateControl.target_frame_size", offset_of!(VAEncMiscParameterRateControl, target_frame_size), 40),
            ("VAEncSequenceParameterBufferH264.level_idc", offset_of!(VAEncSequenceParameterBufferH264, level_idc), 1),
            ("VAEncSequenceParameterBufferH264.intra_period", offset_of!(VAEncSequenceParameterBufferH264, intra_period), 4),
            ("VAEncSequenceParameterBufferH264.intra_idr_period", offset_of!(VAEncSequenceParameterBufferH264, intra_idr_period), 8),
            ("VAEncSequenceParameterBufferH264.ip_period", offset_of!(VAEncSequenceParameterBufferH264, ip_period), 12),
            ("VAEncSequenceParameterBufferH264.bits_per_second", offset_of!(VAEncSequenceParameterBufferH264, bits_per_second), 16),
            ("VAEncSequenceParameterBufferH264.max_num_ref_frames", offset_of!(VAEncSequenceParameterBufferH264, max_num_ref_frames), 20),
            ("VAEncSequenceParameterBufferH264.picture_width_in_mbs", offset_of!(VAEncSequenceParameterBufferH264, picture_width_in_mbs), 24),
            ("VAEncSequenceParameterBufferH264.picture_height_in_mbs", offset_of!(VAEncSequenceParameterBufferH264, picture_height_in_mbs), 26),
            ("VAEncSequenceParameterBufferH264.seq_fields", offset_of!(VAEncSequenceParameterBufferH264, seq_fields), 28),
            ("VAEncSequenceParameterBufferH264.bit_depth_luma_minus8", offset_of!(VAEncSequenceParameterBufferH264, bit_depth_luma_minus8), 32),
            ("VAEncSequenceParameterBufferH264.num_ref_frames_in_pic_order_cnt_cycle", offset_of!(VAEncSequenceParameterBufferH264, num_ref_frames_in_pic_order_cnt_cycle), 34),
            ("VAEncSequenceParameterBufferH264.offset_for_non_ref_pic", offset_of!(VAEncSequenceParameterBufferH264, offset_for_non_ref_pic), 36),
            ("VAEncSequenceParameterBufferH264.offset_for_ref_frame", offset_of!(VAEncSequenceParameterBufferH264, offset_for_ref_frame), 44),
            ("VAEncSequenceParameterBufferH264.frame_cropping_flag", offset_of!(VAEncSequenceParameterBufferH264, frame_cropping_flag), 1068),
            ("VAEncSequenceParameterBufferH264.frame_crop_left_offset", offset_of!(VAEncSequenceParameterBufferH264, frame_crop_left_offset), 1072),
            ("VAEncSequenceParameterBufferH264.frame_crop_bottom_offset", offset_of!(VAEncSequenceParameterBufferH264, frame_crop_bottom_offset), 1084),
            ("VAEncSequenceParameterBufferH264.vui_parameters_present_flag", offset_of!(VAEncSequenceParameterBufferH264, vui_parameters_present_flag), 1088),
            ("VAEncSequenceParameterBufferH264.vui_fields", offset_of!(VAEncSequenceParameterBufferH264, vui_fields), 1092),
            ("VAEncSequenceParameterBufferH264.aspect_ratio_idc", offset_of!(VAEncSequenceParameterBufferH264, aspect_ratio_idc), 1096),
            ("VAEncSequenceParameterBufferH264.sar_width", offset_of!(VAEncSequenceParameterBufferH264, sar_width), 1100),
            ("VAEncSequenceParameterBufferH264.num_units_in_tick", offset_of!(VAEncSequenceParameterBufferH264, num_units_in_tick), 1108),
            ("VAEncSequenceParameterBufferH264.time_scale", offset_of!(VAEncSequenceParameterBufferH264, time_scale), 1112),
            ("VAEncPictureParameterBufferH264.ReferenceFrames", offset_of!(VAEncPictureParameterBufferH264, ReferenceFrames), 36),
            ("VAEncPictureParameterBufferH264.coded_buf", offset_of!(VAEncPictureParameterBufferH264, coded_buf), 612),
            ("VAEncPictureParameterBufferH264.pic_parameter_set_id", offset_of!(VAEncPictureParameterBufferH264, pic_parameter_set_id), 616),
            ("VAEncPictureParameterBufferH264.last_picture", offset_of!(VAEncPictureParameterBufferH264, last_picture), 618),
            ("VAEncPictureParameterBufferH264.frame_num", offset_of!(VAEncPictureParameterBufferH264, frame_num), 620),
            ("VAEncPictureParameterBufferH264.pic_init_qp", offset_of!(VAEncPictureParameterBufferH264, pic_init_qp), 622),
            ("VAEncPictureParameterBufferH264.num_ref_idx_l0_active_minus1", offset_of!(VAEncPictureParameterBufferH264, num_ref_idx_l0_active_minus1), 623),
            ("VAEncPictureParameterBufferH264.chroma_qp_index_offset", offset_of!(VAEncPictureParameterBufferH264, chroma_qp_index_offset), 625),
            ("VAEncPictureParameterBufferH264.second_chroma_qp_index_offset", offset_of!(VAEncPictureParameterBufferH264, second_chroma_qp_index_offset), 626),
            ("VAEncPictureParameterBufferH264.pic_fields", offset_of!(VAEncPictureParameterBufferH264, pic_fields), 628),
            ("VAEncSliceParameterBufferH264.num_macroblocks", offset_of!(VAEncSliceParameterBufferH264, num_macroblocks), 4),
            ("VAEncSliceParameterBufferH264.macroblock_info", offset_of!(VAEncSliceParameterBufferH264, macroblock_info), 8),
            ("VAEncSliceParameterBufferH264.slice_type", offset_of!(VAEncSliceParameterBufferH264, slice_type), 12),
            ("VAEncSliceParameterBufferH264.pic_parameter_set_id", offset_of!(VAEncSliceParameterBufferH264, pic_parameter_set_id), 13),
            ("VAEncSliceParameterBufferH264.idr_pic_id", offset_of!(VAEncSliceParameterBufferH264, idr_pic_id), 14),
            ("VAEncSliceParameterBufferH264.pic_order_cnt_lsb", offset_of!(VAEncSliceParameterBufferH264, pic_order_cnt_lsb), 16),
            ("VAEncSliceParameterBufferH264.delta_pic_order_cnt_bottom", offset_of!(VAEncSliceParameterBufferH264, delta_pic_order_cnt_bottom), 20),
            ("VAEncSliceParameterBufferH264.delta_pic_order_cnt", offset_of!(VAEncSliceParameterBufferH264, delta_pic_order_cnt), 24),
            ("VAEncSliceParameterBufferH264.direct_spatial_mv_pred_flag", offset_of!(VAEncSliceParameterBufferH264, direct_spatial_mv_pred_flag), 32),
            ("VAEncSliceParameterBufferH264.num_ref_idx_active_override_flag", offset_of!(VAEncSliceParameterBufferH264, num_ref_idx_active_override_flag), 33),
            ("VAEncSliceParameterBufferH264.num_ref_idx_l0_active_minus1", offset_of!(VAEncSliceParameterBufferH264, num_ref_idx_l0_active_minus1), 34),
            ("VAEncSliceParameterBufferH264.RefPicList0", offset_of!(VAEncSliceParameterBufferH264, RefPicList0), 36),
            ("VAEncSliceParameterBufferH264.RefPicList1", offset_of!(VAEncSliceParameterBufferH264, RefPicList1), 1188),
            ("VAEncSliceParameterBufferH264.luma_log2_weight_denom", offset_of!(VAEncSliceParameterBufferH264, luma_log2_weight_denom), 2340),
            ("VAEncSliceParameterBufferH264.luma_weight_l0", offset_of!(VAEncSliceParameterBufferH264, luma_weight_l0), 2344),
            ("VAEncSliceParameterBufferH264.chroma_weight_l0_flag", offset_of!(VAEncSliceParameterBufferH264, chroma_weight_l0_flag), 2472),
            ("VAEncSliceParameterBufferH264.luma_weight_l1_flag", offset_of!(VAEncSliceParameterBufferH264, luma_weight_l1_flag), 2730),
            ("VAEncSliceParameterBufferH264.cabac_init_idc", offset_of!(VAEncSliceParameterBufferH264, cabac_init_idc), 3118),
            ("VAEncSliceParameterBufferH264.slice_qp_delta", offset_of!(VAEncSliceParameterBufferH264, slice_qp_delta), 3119),
            ("VAEncSliceParameterBufferH264.disable_deblocking_filter_idc", offset_of!(VAEncSliceParameterBufferH264, disable_deblocking_filter_idc), 3120),
            ("VAEncSliceParameterBufferH264.slice_beta_offset_div2", offset_of!(VAEncSliceParameterBufferH264, slice_beta_offset_div2), 3122),
            ("VAEncSequenceParameterBufferHEVC.general_level_idc", offset_of!(VAEncSequenceParameterBufferHEVC, general_level_idc), 1),
            ("VAEncSequenceParameterBufferHEVC.general_tier_flag", offset_of!(VAEncSequenceParameterBufferHEVC, general_tier_flag), 2),
            ("VAEncSequenceParameterBufferHEVC.intra_period", offset_of!(VAEncSequenceParameterBufferHEVC, intra_period), 4),
            ("VAEncSequenceParameterBufferHEVC.ip_period", offset_of!(VAEncSequenceParameterBufferHEVC, ip_period), 12),
            ("VAEncSequenceParameterBufferHEVC.bits_per_second", offset_of!(VAEncSequenceParameterBufferHEVC, bits_per_second), 16),
            ("VAEncSequenceParameterBufferHEVC.pic_width_in_luma_samples", offset_of!(VAEncSequenceParameterBufferHEVC, pic_width_in_luma_samples), 20),
            ("VAEncSequenceParameterBufferHEVC.pic_height_in_luma_samples", offset_of!(VAEncSequenceParameterBufferHEVC, pic_height_in_luma_samples), 22),
            ("VAEncSequenceParameterBufferHEVC.seq_fields", offset_of!(VAEncSequenceParameterBufferHEVC, seq_fields), 24),
            ("VAEncSequenceParameterBufferHEVC.log2_min_luma_coding_block_size_minus3", offset_of!(VAEncSequenceParameterBufferHEVC, log2_min_luma_coding_block_size_minus3), 28),
            ("VAEncSequenceParameterBufferHEVC.max_transform_hierarchy_depth_intra", offset_of!(VAEncSequenceParameterBufferHEVC, max_transform_hierarchy_depth_intra), 33),
            ("VAEncSequenceParameterBufferHEVC.pcm_sample_bit_depth_luma_minus1", offset_of!(VAEncSequenceParameterBufferHEVC, pcm_sample_bit_depth_luma_minus1), 36),
            ("VAEncSequenceParameterBufferHEVC.log2_max_pcm_luma_coding_block_size_minus3", offset_of!(VAEncSequenceParameterBufferHEVC, log2_max_pcm_luma_coding_block_size_minus3), 48),
            ("VAEncSequenceParameterBufferHEVC.vui_parameters_present_flag", offset_of!(VAEncSequenceParameterBufferHEVC, vui_parameters_present_flag), 52),
            ("VAEncSequenceParameterBufferHEVC.vui_fields", offset_of!(VAEncSequenceParameterBufferHEVC, vui_fields), 56),
            ("VAEncSequenceParameterBufferHEVC.aspect_ratio_idc", offset_of!(VAEncSequenceParameterBufferHEVC, aspect_ratio_idc), 60),
            ("VAEncSequenceParameterBufferHEVC.sar_width", offset_of!(VAEncSequenceParameterBufferHEVC, sar_width), 64),
            ("VAEncSequenceParameterBufferHEVC.vui_num_units_in_tick", offset_of!(VAEncSequenceParameterBufferHEVC, vui_num_units_in_tick), 72),
            ("VAEncSequenceParameterBufferHEVC.vui_time_scale", offset_of!(VAEncSequenceParameterBufferHEVC, vui_time_scale), 76),
            ("VAEncSequenceParameterBufferHEVC.min_spatial_segmentation_idc", offset_of!(VAEncSequenceParameterBufferHEVC, min_spatial_segmentation_idc), 80),
            ("VAEncSequenceParameterBufferHEVC.max_bytes_per_pic_denom", offset_of!(VAEncSequenceParameterBufferHEVC, max_bytes_per_pic_denom), 82),
            ("VAEncSequenceParameterBufferHEVC.max_bits_per_min_cu_denom", offset_of!(VAEncSequenceParameterBufferHEVC, max_bits_per_min_cu_denom), 83),
            ("VAEncSequenceParameterBufferHEVC.scc_fields", offset_of!(VAEncSequenceParameterBufferHEVC, scc_fields), 84),
            ("VAEncPictureParameterBufferHEVC.reference_frames", offset_of!(VAEncPictureParameterBufferHEVC, reference_frames), 28),
            ("VAEncPictureParameterBufferHEVC.coded_buf", offset_of!(VAEncPictureParameterBufferHEVC, coded_buf), 448),
            ("VAEncPictureParameterBufferHEVC.collocated_ref_pic_index", offset_of!(VAEncPictureParameterBufferHEVC, collocated_ref_pic_index), 452),
            ("VAEncPictureParameterBufferHEVC.last_picture", offset_of!(VAEncPictureParameterBufferHEVC, last_picture), 453),
            ("VAEncPictureParameterBufferHEVC.pic_init_qp", offset_of!(VAEncPictureParameterBufferHEVC, pic_init_qp), 454),
            ("VAEncPictureParameterBufferHEVC.diff_cu_qp_delta_depth", offset_of!(VAEncPictureParameterBufferHEVC, diff_cu_qp_delta_depth), 455),
            ("VAEncPictureParameterBufferHEVC.pps_cb_qp_offset", offset_of!(VAEncPictureParameterBufferHEVC, pps_cb_qp_offset), 456),
            ("VAEncPictureParameterBufferHEVC.num_tile_columns_minus1", offset_of!(VAEncPictureParameterBufferHEVC, num_tile_columns_minus1), 458),
            ("VAEncPictureParameterBufferHEVC.column_width_minus1", offset_of!(VAEncPictureParameterBufferHEVC, column_width_minus1), 460),
            ("VAEncPictureParameterBufferHEVC.row_height_minus1", offset_of!(VAEncPictureParameterBufferHEVC, row_height_minus1), 479),
            ("VAEncPictureParameterBufferHEVC.log2_parallel_merge_level_minus2", offset_of!(VAEncPictureParameterBufferHEVC, log2_parallel_merge_level_minus2), 500),
            ("VAEncPictureParameterBufferHEVC.ctu_max_bitsize_allowed", offset_of!(VAEncPictureParameterBufferHEVC, ctu_max_bitsize_allowed), 501),
            ("VAEncPictureParameterBufferHEVC.num_ref_idx_l0_default_active_minus1", offset_of!(VAEncPictureParameterBufferHEVC, num_ref_idx_l0_default_active_minus1), 502),
            ("VAEncPictureParameterBufferHEVC.slice_pic_parameter_set_id", offset_of!(VAEncPictureParameterBufferHEVC, slice_pic_parameter_set_id), 504),
            ("VAEncPictureParameterBufferHEVC.nal_unit_type", offset_of!(VAEncPictureParameterBufferHEVC, nal_unit_type), 505),
            ("VAEncPictureParameterBufferHEVC.pic_fields", offset_of!(VAEncPictureParameterBufferHEVC, pic_fields), 508),
            ("VAEncPictureParameterBufferHEVC.hierarchical_level_plus1", offset_of!(VAEncPictureParameterBufferHEVC, hierarchical_level_plus1), 512),
            ("VAEncPictureParameterBufferHEVC.scc_fields", offset_of!(VAEncPictureParameterBufferHEVC, scc_fields), 514),
            ("VAEncSliceParameterBufferHEVC.num_ctu_in_slice", offset_of!(VAEncSliceParameterBufferHEVC, num_ctu_in_slice), 4),
            ("VAEncSliceParameterBufferHEVC.slice_type", offset_of!(VAEncSliceParameterBufferHEVC, slice_type), 8),
            ("VAEncSliceParameterBufferHEVC.slice_pic_parameter_set_id", offset_of!(VAEncSliceParameterBufferHEVC, slice_pic_parameter_set_id), 9),
            ("VAEncSliceParameterBufferHEVC.num_ref_idx_l0_active_minus1", offset_of!(VAEncSliceParameterBufferHEVC, num_ref_idx_l0_active_minus1), 10),
            ("VAEncSliceParameterBufferHEVC.num_ref_idx_l1_active_minus1", offset_of!(VAEncSliceParameterBufferHEVC, num_ref_idx_l1_active_minus1), 11),
            ("VAEncSliceParameterBufferHEVC.ref_pic_list0", offset_of!(VAEncSliceParameterBufferHEVC, ref_pic_list0), 12),
            ("VAEncSliceParameterBufferHEVC.ref_pic_list1", offset_of!(VAEncSliceParameterBufferHEVC, ref_pic_list1), 432),
            ("VAEncSliceParameterBufferHEVC.luma_log2_weight_denom", offset_of!(VAEncSliceParameterBufferHEVC, luma_log2_weight_denom), 852),
            ("VAEncSliceParameterBufferHEVC.delta_chroma_log2_weight_denom", offset_of!(VAEncSliceParameterBufferHEVC, delta_chroma_log2_weight_denom), 853),
            ("VAEncSliceParameterBufferHEVC.delta_luma_weight_l0", offset_of!(VAEncSliceParameterBufferHEVC, delta_luma_weight_l0), 854),
            ("VAEncSliceParameterBufferHEVC.chroma_offset_l1", offset_of!(VAEncSliceParameterBufferHEVC, chroma_offset_l1), 1004),
            ("VAEncSliceParameterBufferHEVC.max_num_merge_cand", offset_of!(VAEncSliceParameterBufferHEVC, max_num_merge_cand), 1034),
            ("VAEncSliceParameterBufferHEVC.slice_qp_delta", offset_of!(VAEncSliceParameterBufferHEVC, slice_qp_delta), 1035),
            ("VAEncSliceParameterBufferHEVC.slice_tc_offset_div2", offset_of!(VAEncSliceParameterBufferHEVC, slice_tc_offset_div2), 1039),
            ("VAEncSliceParameterBufferHEVC.slice_fields", offset_of!(VAEncSliceParameterBufferHEVC, slice_fields), 1040),
            ("VAEncSliceParameterBufferHEVC.pred_weight_table_bit_offset", offset_of!(VAEncSliceParameterBufferHEVC, pred_weight_table_bit_offset), 1044),
            ("VAProcPipelineParameterBuffer.surface_region", offset_of!(VAProcPipelineParameterBuffer, surface_region), 8),
            ("VAProcPipelineParameterBuffer.surface_color_standard", offset_of!(VAProcPipelineParameterBuffer, surface_color_standard), 16),
            ("VAProcPipelineParameterBuffer.output_region", offset_of!(VAProcPipelineParameterBuffer, output_region), 24),
            ("VAProcPipelineParameterBuffer.output_background_color", offset_of!(VAProcPipelineParameterBuffer, output_background_color), 32),
            ("VAProcPipelineParameterBuffer.output_color_standard", offset_of!(VAProcPipelineParameterBuffer, output_color_standard), 36),
            ("VAProcPipelineParameterBuffer.pipeline_flags", offset_of!(VAProcPipelineParameterBuffer, pipeline_flags), 40),
            ("VAProcPipelineParameterBuffer.filter_flags", offset_of!(VAProcPipelineParameterBuffer, filter_flags), 44),
            ("VAProcPipelineParameterBuffer.filters", offset_of!(VAProcPipelineParameterBuffer, filters), 48),
            ("VAProcPipelineParameterBuffer.num_filters", offset_of!(VAProcPipelineParameterBuffer, num_filters), 56),
            ("VAProcPipelineParameterBuffer.forward_references", offset_of!(VAProcPipelineParameterBuffer, forward_references), 64),
            ("VAProcPipelineParameterBuffer.rotation_state", offset_of!(VAProcPipelineParameterBuffer, rotation_state), 92),
            ("VAProcPipelineParameterBuffer.blend_state", offset_of!(VAProcPipelineParameterBuffer, blend_state), 96),
            ("VAProcPipelineParameterBuffer.mirror_state", offset_of!(VAProcPipelineParameterBuffer, mirror_state), 104),
            ("VAProcPipelineParameterBuffer.additional_outputs", offset_of!(VAProcPipelineParameterBuffer, additional_outputs), 112),
            ("VAProcPipelineParameterBuffer.input_surface_flag", offset_of!(VAProcPipelineParameterBuffer, input_surface_flag), 124),
            ("VAProcPipelineParameterBuffer.output_surface_flag", offset_of!(VAProcPipelineParameterBuffer, output_surface_flag), 128),
            ("VAProcPipelineParameterBuffer.input_color_properties", offset_of!(VAProcPipelineParameterBuffer, input_color_properties), 132),
            ("VAProcPipelineParameterBuffer.output_color_properties", offset_of!(VAProcPipelineParameterBuffer, output_color_properties), 140),
            ("VAProcPipelineParameterBuffer.processing_mode", offset_of!(VAProcPipelineParameterBuffer, processing_mode), 148),
            ("VAProcPipelineParameterBuffer.output_hdr_metadata", offset_of!(VAProcPipelineParameterBuffer, output_hdr_metadata), 152),
            ("VAPictureParameterBufferJPEGBaseline.components", offset_of!(VAPictureParameterBufferJPEGBaseline, components), 4),
            ("VAPictureParameterBufferJPEGBaseline.num_components", offset_of!(VAPictureParameterBufferJPEGBaseline, num_components), 1024),
            ("VAPictureParameterBufferJPEGBaseline.color_space", offset_of!(VAPictureParameterBufferJPEGBaseline, color_space), 1025),
            ("VAPictureParameterBufferJPEGBaseline.rotation", offset_of!(VAPictureParameterBufferJPEGBaseline, rotation), 1028),
            ("VAIQMatrixBufferJPEGBaseline.quantiser_table", offset_of!(VAIQMatrixBufferJPEGBaseline, quantiser_table), 4),
            ("VAHuffmanTableBufferJPEGBaseline.huffman_table", offset_of!(VAHuffmanTableBufferJPEGBaseline, huffman_table), 2),
            ("VASliceParameterBufferJPEGBaseline.slice_data_offset", offset_of!(VASliceParameterBufferJPEGBaseline, slice_data_offset), 4),
            ("VASliceParameterBufferJPEGBaseline.slice_data_flag", offset_of!(VASliceParameterBufferJPEGBaseline, slice_data_flag), 8),
            ("VASliceParameterBufferJPEGBaseline.slice_horizontal_position", offset_of!(VASliceParameterBufferJPEGBaseline, slice_horizontal_position), 12),
            ("VASliceParameterBufferJPEGBaseline.components", offset_of!(VASliceParameterBufferJPEGBaseline, components), 20),
            ("VASliceParameterBufferJPEGBaseline.num_components", offset_of!(VASliceParameterBufferJPEGBaseline, num_components), 32),
            ("VASliceParameterBufferJPEGBaseline.restart_interval", offset_of!(VASliceParameterBufferJPEGBaseline, restart_interval), 34),
            ("VASliceParameterBufferJPEGBaseline.num_mcus", offset_of!(VASliceParameterBufferJPEGBaseline, num_mcus), 36),
            ("VAEncPictureParameterBufferJPEG.picture_width", offset_of!(VAEncPictureParameterBufferJPEG, picture_width), 4),
            ("VAEncPictureParameterBufferJPEG.coded_buf", offset_of!(VAEncPictureParameterBufferJPEG, coded_buf), 8),
            ("VAEncPictureParameterBufferJPEG.pic_flags", offset_of!(VAEncPictureParameterBufferJPEG, pic_flags), 12),
            ("VAEncPictureParameterBufferJPEG.sample_bit_depth", offset_of!(VAEncPictureParameterBufferJPEG, sample_bit_depth), 16),
            ("VAEncPictureParameterBufferJPEG.num_scan", offset_of!(VAEncPictureParameterBufferJPEG, num_scan), 17),
            ("VAEncPictureParameterBufferJPEG.num_components", offset_of!(VAEncPictureParameterBufferJPEG, num_components), 18),
            ("VAEncPictureParameterBufferJPEG.component_id", offset_of!(VAEncPictureParameterBufferJPEG, component_id), 20),
            ("VAEncPictureParameterBufferJPEG.quantiser_table_selector", offset_of!(VAEncPictureParameterBufferJPEG, quantiser_table_selector), 24),
            ("VAEncPictureParameterBufferJPEG.quality", offset_of!(VAEncPictureParameterBufferJPEG, quality), 28),
            ("VAEncSliceParameterBufferJPEG.num_components", offset_of!(VAEncSliceParameterBufferJPEG, num_components), 2),
            ("VAEncSliceParameterBufferJPEG.components", offset_of!(VAEncSliceParameterBufferJPEG, components), 4),
            ("VAQMatrixBufferJPEG.load_chroma_quantiser_matrix", offset_of!(VAQMatrixBufferJPEG, load_chroma_quantiser_matrix), 4),
            ("VAQMatrixBufferJPEG.lum_quantiser_matrix", offset_of!(VAQMatrixBufferJPEG, lum_quantiser_matrix), 8),
            ("VAQMatrixBufferJPEG.chroma_quantiser_matrix", offset_of!(VAQMatrixBufferJPEG, chroma_quantiser_matrix), 72),
        ];
        let wrong: Vec<String> = checks
            .iter()
            .filter(|(_, rust, c)| rust != c)
            .map(|(name, rust, c)| format!("{name}: Rust {rust}, C {c}"))
            .collect();
        assert!(wrong.is_empty(), "{wrong:#?}");
    }
}

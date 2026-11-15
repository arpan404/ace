// SPDX-License-Identifier: Apache-2.0
//! Our own declaration of the parts of the CUDA driver API and NVDEC (`nvcuvid`) that ace
//! calls, written from NVIDIA's public CUDA driver API reference and NVDEC programming guide
//! (ADR 0148 §3). Members ace never touches are reserved tails that stay zero. `c_ulong`
//! follows the platform's C `unsigned long`, as the interface does (8 bytes on Linux, 4 on
//! Windows).
use std::ffi::{c_int, c_short, c_uint, c_ulong, c_void};

pub type CuResult = c_int;

pub type CuContext = *mut c_void;
pub type CuDevice = c_int;
pub type CuDevicePtr = u64;

pub const MEMORY_HOST: c_uint = 1;
pub const MEMORY_DEVICE: c_uint = 2;

/// `CUDA_MEMCPY2D`.
#[repr(C)]
#[derive(Clone, Copy)]
pub struct Memcpy2d {
    pub src_x_in_bytes: usize,
    pub src_y: usize,
    pub src_memory_type: c_uint,
    pub src_host: *const c_void,
    pub src_device: CuDevicePtr,
    pub src_array: *mut c_void,
    pub src_pitch: usize,
    pub dst_x_in_bytes: usize,
    pub dst_y: usize,
    pub dst_memory_type: c_uint,
    pub dst_host: *mut c_void,
    pub dst_device: CuDevicePtr,
    pub dst_array: *mut c_void,
    pub dst_pitch: usize,
    pub width_in_bytes: usize,
    pub height: usize,
}

pub const CUVID_H264: c_int = 4;
pub const CUVID_HEVC: c_int = 8;
pub const CHROMA_420: c_int = 1;
pub const SURFACE_NV12: c_int = 0;
pub const DEINTERLACE_WEAVE: c_int = 0;
pub const DEINTERLACE_ADAPTIVE: c_int = 2;
pub const CREATE_PREFER_CUVID: c_ulong = 4;

pub const PKT_TIMESTAMP: c_ulong = 0x02;
pub const PKT_ENDOFPICTURE: c_ulong = 0x08;

/// `CUVIDDECODECAPS`.
#[repr(C)]
#[derive(Clone, Copy)]
pub struct DecodeCaps {
    pub codec: c_int,
    pub chroma_format: c_int,
    pub bit_depth_minus8: c_uint,
    pub reserved1: [c_uint; 3],
    pub is_supported: u8,
    pub num_nvdecs: u8,
    pub output_format_mask: u16,
    pub max_width: c_uint,
    pub max_height: c_uint,
    pub max_mb_count: c_uint,
    pub min_width: u16,
    pub min_height: u16,
    pub reserved3: [c_uint; 11],
}

/// `CUVIDEOFORMAT`, as the parser hands it to the sequence callback.
#[repr(C)]
#[derive(Clone, Copy)]
pub struct VideoFormat {
    pub codec: c_int,
    pub frame_rate: [c_uint; 2],
    pub progressive_sequence: u8,
    pub bit_depth_luma_minus8: u8,
    pub bit_depth_chroma_minus8: u8,
    pub min_num_decode_surfaces: u8,
    pub coded_width: c_uint,
    pub coded_height: c_uint,
    /// left, top, right, bottom
    pub display_area: [c_int; 4],
    pub chroma_format: c_int,
    pub bitrate: c_uint,
    pub display_aspect_ratio: [c_int; 2],
    pub video_signal_description: [u8; 4],
    pub seqhdr_data_length: c_uint,
}

/// `CUVIDDECODECREATEINFO`.
#[repr(C)]
#[derive(Clone, Copy)]
pub struct DecodeCreateInfo {
    pub width: c_ulong,
    pub height: c_ulong,
    pub num_decode_surfaces: c_ulong,
    pub codec: c_int,
    pub chroma_format: c_int,
    pub creation_flags: c_ulong,
    pub bit_depth_minus8: c_ulong,
    pub intra_decode_only: c_ulong,
    pub max_width: c_ulong,
    pub max_height: c_ulong,
    pub reserved1: c_ulong,
    /// left, top, right, bottom
    pub display_area: [c_short; 4],
    pub output_format: c_int,
    pub deinterlace_mode: c_int,
    pub target_width: c_ulong,
    pub target_height: c_ulong,
    pub num_output_surfaces: c_ulong,
    pub vid_lock: *mut c_void,
    /// left, top, right, bottom
    pub target_rect: [c_short; 4],
    pub reserved2: [c_ulong; 5],
}

/// `CUVIDPARSERDISPINFO`.
#[repr(C)]
#[derive(Clone, Copy)]
pub struct DisplayInfo {
    pub picture_index: c_int,
    pub progressive_frame: c_int,
    pub top_field_first: c_int,
    pub repeat_first_field: c_int,
    pub timestamp: i64,
}

/// `CUVIDPROCPARAMS`: the members before the reserved tail.
#[repr(C)]
#[derive(Clone, Copy)]
pub struct ProcParams {
    pub progressive_frame: c_int,
    pub second_field: c_int,
    pub top_field_first: c_int,
    pub unpaired_field: c_int,
    pub reserved_flags: c_uint,
    pub reserved_zero: c_uint,
    pub raw_input_dptr: u64,
    pub raw_input_pitch: c_uint,
    pub raw_input_format: c_uint,
    pub raw_output_dptr: u64,
    pub raw_output_pitch: c_uint,
    pub reserved1: c_uint,
    pub output_stream: *mut c_void,
    pub reserved: [c_uint; 46],
    pub reserved2: [*mut c_void; 2],
}

/// `CUVIDSOURCEDATAPACKET`.
#[repr(C)]
#[derive(Clone, Copy)]
pub struct SourcePacket {
    pub flags: c_ulong,
    pub payload_size: c_ulong,
    pub payload: *const u8,
    pub timestamp: i64,
}

pub type SequenceCallback = unsafe extern "system" fn(*mut c_void, *mut VideoFormat) -> c_int;
pub type DecodeCallback = unsafe extern "system" fn(*mut c_void, *mut c_void) -> c_int;
pub type DisplayCallback = unsafe extern "system" fn(*mut c_void, *mut DisplayInfo) -> c_int;

/// `CUVIDPARSERPARAMS`.
#[repr(C)]
#[derive(Clone, Copy)]
pub struct ParserParams {
    pub codec: c_int,
    pub max_num_decode_surfaces: c_uint,
    pub clock_rate: c_uint,
    pub error_threshold: c_uint,
    pub max_display_delay: c_uint,
    pub flags: c_uint,
    pub reserved1: [c_uint; 4],
    pub user_data: *mut c_void,
    pub sequence: Option<SequenceCallback>,
    pub decode: Option<DecodeCallback>,
    pub display: Option<DisplayCallback>,
    pub reserved2: [*mut c_void; 7],
    pub ext_video_info: *mut c_void,
}

pod!(
    Memcpy2d,
    DecodeCaps,
    VideoFormat,
    DecodeCreateInfo,
    DisplayInfo,
    ProcParams,
    SourcePacket,
    ParserParams,
);

type H = *mut c_void;

/// The CUDA driver entry points ace calls (`libcuda.so.1`, `nvcuda.dll`).
#[derive(Clone, Copy)]
pub struct CudaFns {
    pub init: unsafe extern "system" fn(c_uint) -> CuResult,
    pub device_get: unsafe extern "system" fn(*mut CuDevice, c_int) -> CuResult,
    pub ctx_create: unsafe extern "system" fn(*mut CuContext, c_uint, CuDevice) -> CuResult,
    pub ctx_destroy: unsafe extern "system" fn(CuContext) -> CuResult,
    pub ctx_push: unsafe extern "system" fn(CuContext) -> CuResult,
    pub ctx_pop: unsafe extern "system" fn(*mut CuContext) -> CuResult,
    pub memcpy_2d: unsafe extern "system" fn(*const Memcpy2d) -> CuResult,
}

/// The NVDEC entry points ace calls (`libnvcuvid.so.1`, `nvcuvid.dll`).
#[derive(Clone, Copy)]
pub struct CuvidFns {
    pub get_decoder_caps: unsafe extern "system" fn(*mut DecodeCaps) -> CuResult,
    pub create_decoder: unsafe extern "system" fn(*mut H, *mut DecodeCreateInfo) -> CuResult,
    pub destroy_decoder: unsafe extern "system" fn(H) -> CuResult,
    pub decode_picture: unsafe extern "system" fn(H, *mut c_void) -> CuResult,
    pub create_parser: unsafe extern "system" fn(*mut H, *mut ParserParams) -> CuResult,
    pub parse_data: unsafe extern "system" fn(H, *mut SourcePacket) -> CuResult,
    pub destroy_parser: unsafe extern "system" fn(H) -> CuResult,
    pub map_frame:
        unsafe extern "system" fn(H, c_int, *mut u64, *mut c_uint, *mut ProcParams) -> CuResult,
    pub unmap_frame: unsafe extern "system" fn(H, u64) -> CuResult,
}

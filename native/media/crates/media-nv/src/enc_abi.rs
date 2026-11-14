// SPDX-License-Identifier: Apache-2.0
//! Our own declaration of the NVENC interface, pinned to API 12.0 (ADR 0148 §3).
//!
//! Written from NVIDIA's public NVENC programming guide on docs.nvidia.com: the call sequence,
//! member names and the version scheme. Only the members ace sets or reads are named; the rest
//! of each structure is a reserved tail that stays zero. Nothing here is copied or generated
//! from the Video Codec SDK or any copy of its headers. A developer who has the SDK under their
//! own licence can compare these layouts with `ACE_NV_HEADERS` (see `tests/headers.rs`).
use std::ffi::{c_char, c_void};

pub const API_MAJOR: u32 = 12;
pub const API_MINOR: u32 = 0;
/// What `NvEncodeAPIGetMaxSupportedVersion` must report at least: major in the high nibble.
pub const MAX_SUPPORTED_AT_LEAST: u32 = (API_MAJOR << 4) | API_MINOR;
/// The session's `apiVersion`: major in the low byte, minor in the high byte.
pub const API_VERSION: u32 = API_MAJOR | (API_MINOR << 24);

/// A structure's `version` member: the API version, the structure's own revision in bits
/// 16–23 and the constant 7 in bits 28–30.
pub const fn struct_version(revision: u32) -> u32 {
    API_VERSION | (revision << 16) | (0x7 << 28)
}
/// Structures that grew pointer-sized members carry bit 31 as well.
const WIDE: u32 = 1 << 31;

pub const FUNCTION_LIST_VER: u32 = struct_version(2);
pub const OPEN_SESSION_VER: u32 = struct_version(1);
pub const CAPS_PARAM_VER: u32 = struct_version(1);
pub const RC_PARAMS_VER: u32 = struct_version(1);
pub const CONFIG_VER: u32 = struct_version(8) | WIDE;
pub const PRESET_CONFIG_VER: u32 = struct_version(4) | WIDE;
pub const INITIALIZE_VER: u32 = struct_version(5) | WIDE;
pub const RECONFIGURE_VER: u32 = struct_version(1) | WIDE;
pub const PIC_PARAMS_VER: u32 = struct_version(6) | WIDE;
pub const CREATE_INPUT_VER: u32 = struct_version(1);
pub const LOCK_INPUT_VER: u32 = struct_version(1);
pub const CREATE_BITSTREAM_VER: u32 = struct_version(1);
pub const LOCK_BITSTREAM_VER: u32 = struct_version(1);
pub const REGISTER_VER: u32 = struct_version(4);
pub const MAP_VER: u32 = struct_version(4);

pub type Status = i32;

pub const DEVICE_DIRECTX: u32 = 0;
pub const DEVICE_CUDA: u32 = 1;
pub const DEVICE_OPENGL: u32 = 2;

pub const RESOURCE_DIRECTX: u32 = 0;
pub const RESOURCE_OPENGL_TEX: u32 = 3;
pub const USAGE_INPUT_IMAGE: u32 = 0;

pub const FORMAT_NV12: u32 = 0x1;
/// 32-bit words read as A8R8G8B8: bytes B, G, R, A in memory.
pub const FORMAT_ARGB: u32 = 0x0100_0000;
/// 32-bit words read as A8B8G8R8: bytes R, G, B, A in memory.
pub const FORMAT_ABGR: u32 = 0x1000_0000;

pub const RC_CONSTQP: u32 = 0;
pub const RC_CBR: u32 = 2;

pub const TUNING_ULTRA_LOW_LATENCY: u32 = 3;

pub const PIC_FLAG_FORCEIDR: u32 = 0x2;
pub const PIC_FLAG_OUTPUT_SPSPPS: u32 = 0x4;
pub const PIC_FLAG_EOS: u32 = 0x8;
pub const PIC_STRUCT_FRAME: u32 = 1;
pub const PIC_TYPE_IDR: u32 = 3;

pub const CAPS_WIDTH_MAX: u32 = 16;
pub const CAPS_HEIGHT_MAX: u32 = 17;

pub const INFINITE_GOP: u32 = u32::MAX;

/// Marks the plain-data structures below: integers, raw pointers and optional function
/// pointers only.
///
/// # Safety
/// Every bit pattern of zero bytes must be a valid value of the type.
#[allow(unsafe_code)]
pub unsafe trait Pod: Sized {}

pub fn zeroed<T: Pod>() -> T {
    // SAFETY: `Pod` guarantees all-zero bytes form a valid `T`.
    #[allow(unsafe_code)]
    unsafe {
        std::mem::zeroed()
    }
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Guid {
    pub data1: u32,
    pub data2: u16,
    pub data3: u16,
    pub data4: [u8; 8],
}

const fn guid(data1: u32, data2: u16, data3: u16, data4: [u8; 8]) -> Guid {
    Guid {
        data1,
        data2,
        data3,
        data4,
    }
}

pub const CODEC_H264: Guid = guid(
    0x6BC8_2762,
    0x4E63,
    0x4CA4,
    [0xAA, 0x85, 0x1E, 0x50, 0xF3, 0x21, 0xF6, 0xBF],
);
pub const CODEC_HEVC: Guid = guid(
    0x790C_DC88,
    0x4522,
    0x4D7B,
    [0x94, 0x25, 0xBD, 0xA9, 0x97, 0x5F, 0x76, 0x03],
);
/// P1 (fastest) through P7 (slowest). The older named presets are gone from current drivers.
pub const PRESETS: [Guid; 7] = [
    guid(
        0xFC0A_8D3E,
        0x45F8,
        0x4CF8,
        [0x80, 0xC7, 0x29, 0x88, 0x71, 0x59, 0x0E, 0xBF],
    ),
    guid(
        0xF581_CFB8,
        0x88D6,
        0x4381,
        [0x93, 0xF0, 0xDF, 0x13, 0xF9, 0xC2, 0x7D, 0xAB],
    ),
    guid(
        0x3685_0110,
        0x3A07,
        0x441F,
        [0x94, 0xD5, 0x36, 0x70, 0x63, 0x1F, 0x91, 0xCF],
    ),
    guid(
        0x90A7_B826,
        0xDF06,
        0x4862,
        [0xB9, 0xD2, 0xCD, 0x6D, 0x73, 0xA0, 0x86, 0x81],
    ),
    guid(
        0x21C6_E6B4,
        0x297A,
        0x4CBA,
        [0x99, 0x8F, 0xB6, 0xCB, 0xDE, 0x72, 0xAD, 0xE3],
    ),
    guid(
        0x8E75_C279,
        0x6299,
        0x4AB6,
        [0x83, 0x02, 0x0B, 0x21, 0x5A, 0x33, 0x5C, 0xF5],
    ),
    guid(
        0x8484_8C12,
        0x6F71,
        0x4C13,
        [0x93, 0x1B, 0x53, 0xE2, 0x83, 0xF5, 0x79, 0x74],
    ),
];

#[repr(C)]
#[derive(Clone, Copy)]
pub struct OpenSessionParams {
    pub version: u32,
    pub device_type: u32,
    pub device: *mut c_void,
    pub reserved: *mut c_void,
    pub api_version: u32,
    pub reserved1: [u32; 253],
    pub reserved2: [*mut c_void; 64],
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct CapsParam {
    pub version: u32,
    pub caps_to_query: u32,
    pub reserved: [u32; 62],
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Qp {
    pub inter_p: u32,
    pub inter_b: u32,
    pub intra: u32,
}

/// Rate control: the members ace sets lead the structure; the rest stays as the preset left it.
#[repr(C)]
#[derive(Clone, Copy)]
pub struct RcParams {
    pub version: u32,
    pub mode: u32,
    pub const_qp: Qp,
    pub average_bit_rate: u32,
    pub max_bit_rate: u32,
    pub vbv_buffer_size: u32,
    pub vbv_initial_delay: u32,
    pub flags: u32,
    pub min_qp: Qp,
    pub max_qp: Qp,
    pub initial_qp: Qp,
    pub rest: [u32; 13],
}

/// The per-codec union. `idrPeriod` is word 2 for H.264 and word 5 for HEVC.
#[repr(C, align(8))]
#[derive(Clone, Copy)]
pub struct CodecConfig {
    pub words: [u32; 320],
}
pub const H264_IDR_PERIOD_WORD: usize = 2;
pub const HEVC_IDR_PERIOD_WORD: usize = 5;

#[repr(C)]
#[derive(Clone, Copy)]
pub struct EncConfig {
    pub version: u32,
    pub profile: Guid,
    pub gop_length: u32,
    pub frame_interval_p: i32,
    pub monochrome: u32,
    pub frame_field_mode: u32,
    pub mv_precision: u32,
    pub rc: RcParams,
    pub codec: CodecConfig,
    pub reserved: [u32; 278],
    pub reserved2: [*mut c_void; 64],
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct PresetConfig {
    pub version: u32,
    pub reserved: u32,
    pub config: EncConfig,
    pub reserved1: [u32; 255],
    pub reserved2: [*mut c_void; 64],
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct InitParams {
    pub version: u32,
    pub encode_guid: Guid,
    pub preset_guid: Guid,
    pub encode_width: u32,
    pub encode_height: u32,
    pub dar_width: u32,
    pub dar_height: u32,
    pub frame_rate_num: u32,
    pub frame_rate_den: u32,
    pub enable_encode_async: u32,
    pub enable_ptd: u32,
    pub flags: u32,
    pub priv_data_size: u32,
    pub priv_data: *mut c_void,
    pub encode_config: *mut EncConfig,
    pub max_encode_width: u32,
    pub max_encode_height: u32,
    pub me_hint_counts: [u32; 8],
    pub tuning_info: u32,
    pub buffer_format: u32,
    pub reserved: [u32; 287],
    pub reserved2: [*mut c_void; 64],
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct ReconfigureParams {
    pub version: u32,
    pub reserved: u32,
    pub init: InitParams,
    pub flags: u32,
    pub reserved1: [u32; 255],
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct PicParams {
    pub version: u32,
    pub input_width: u32,
    pub input_height: u32,
    pub input_pitch: u32,
    pub flags: u32,
    pub frame_idx: u32,
    pub input_timestamp: u64,
    pub input_duration: u64,
    pub input_buffer: *mut c_void,
    pub output_bitstream: *mut c_void,
    pub completion_event: *mut c_void,
    pub buffer_format: u32,
    pub picture_struct: u32,
    pub picture_type: u32,
    pub codec_pic: [u64; 128],
    pub rest: [u64; 400],
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct CreateInputBuffer {
    pub version: u32,
    pub width: u32,
    pub height: u32,
    pub memory_heap: u32,
    pub buffer_format: u32,
    pub reserved: u32,
    pub input_buffer: *mut c_void,
    pub sys_mem_buffer: *mut c_void,
    pub reserved1: [u32; 57],
    pub reserved2: [*mut c_void; 63],
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct LockInputBuffer {
    pub version: u32,
    pub flags: u32,
    pub input_buffer: *mut c_void,
    pub data: *mut c_void,
    pub pitch: u32,
    pub reserved1: [u32; 251],
    pub reserved2: [*mut c_void; 64],
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct CreateBitstreamBuffer {
    pub version: u32,
    pub size: u32,
    pub memory_heap: u32,
    pub reserved: u32,
    pub bitstream_buffer: *mut c_void,
    pub bitstream_buffer_ptr: *mut c_void,
    pub reserved1: [u32; 58],
    pub reserved2: [*mut c_void; 64],
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct LockBitstream {
    pub version: u32,
    pub flags: u32,
    pub output_bitstream: *mut c_void,
    pub slice_offsets: *mut u32,
    pub frame_idx: u32,
    pub hw_encode_status: u32,
    pub num_slices: u32,
    pub bitstream_size: u32,
    pub output_timestamp: u64,
    pub output_duration: u64,
    pub bitstream_ptr: *mut c_void,
    pub picture_type: u32,
    pub picture_struct: u32,
    pub frame_avg_qp: u32,
    pub rest: [u32; 237],
    pub reserved2: [*mut c_void; 64],
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct RegisterResource {
    pub version: u32,
    pub resource_type: u32,
    pub width: u32,
    pub height: u32,
    pub pitch: u32,
    pub sub_resource_index: u32,
    pub resource: *mut c_void,
    pub registered: *mut c_void,
    pub buffer_format: u32,
    pub buffer_usage: u32,
    pub input_fence: *mut c_void,
    pub output_fence: *mut c_void,
    pub reserved1: [u32; 247],
    pub reserved2: [*mut c_void; 60],
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct MapInputResource {
    pub version: u32,
    pub sub_resource_index: u32,
    pub input_resource: *mut c_void,
    pub registered: *mut c_void,
    pub mapped: *mut c_void,
    pub mapped_format: u32,
    pub reserved1: [u32; 251],
    pub reserved2: [*mut c_void; 63],
}

/// What `resource` points at for an OpenGL texture.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct GlTexResource {
    pub texture: u32,
    pub target: u32,
}

pod!(
    OpenSessionParams,
    CapsParam,
    RcParams,
    EncConfig,
    PresetConfig,
    InitParams,
    ReconfigureParams,
    PicParams,
    CreateInputBuffer,
    LockInputBuffer,
    CreateBitstreamBuffer,
    LockBitstream,
    RegisterResource,
    MapInputResource,
    FunctionList,
);

type H = *mut c_void;
type Slot<F> = Option<F>;
type Unused = Option<unsafe extern "system" fn()>;

/// The table `NvEncodeAPICreateInstance` fills, in the documented order. Slots ace never calls
/// are typed as bare function pointers so the layout is right without naming their arguments.
#[repr(C)]
#[derive(Clone, Copy)]
pub struct FunctionList {
    pub version: u32,
    pub reserved: u32,
    pub open_encode_session: Unused,
    pub get_encode_guid_count: Slot<unsafe extern "system" fn(H, *mut u32) -> Status>,
    pub get_encode_profile_guid_count: Unused,
    pub get_encode_profile_guids: Unused,
    pub get_encode_guids: Slot<unsafe extern "system" fn(H, *mut Guid, u32, *mut u32) -> Status>,
    pub get_input_format_count: Unused,
    pub get_input_formats: Unused,
    pub get_encode_caps:
        Slot<unsafe extern "system" fn(H, Guid, *mut CapsParam, *mut i32) -> Status>,
    pub get_encode_preset_count: Unused,
    pub get_encode_preset_guids: Unused,
    pub get_encode_preset_config: Unused,
    pub initialize_encoder: Slot<unsafe extern "system" fn(H, *mut InitParams) -> Status>,
    pub create_input_buffer: Slot<unsafe extern "system" fn(H, *mut CreateInputBuffer) -> Status>,
    pub destroy_input_buffer: Slot<unsafe extern "system" fn(H, H) -> Status>,
    pub create_bitstream_buffer:
        Slot<unsafe extern "system" fn(H, *mut CreateBitstreamBuffer) -> Status>,
    pub destroy_bitstream_buffer: Slot<unsafe extern "system" fn(H, H) -> Status>,
    pub encode_picture: Slot<unsafe extern "system" fn(H, *mut PicParams) -> Status>,
    pub lock_bitstream: Slot<unsafe extern "system" fn(H, *mut LockBitstream) -> Status>,
    pub unlock_bitstream: Slot<unsafe extern "system" fn(H, H) -> Status>,
    pub lock_input_buffer: Slot<unsafe extern "system" fn(H, *mut LockInputBuffer) -> Status>,
    pub unlock_input_buffer: Slot<unsafe extern "system" fn(H, H) -> Status>,
    pub get_encode_stats: Unused,
    pub get_sequence_params: Unused,
    pub register_async_event: Unused,
    pub unregister_async_event: Unused,
    pub map_input_resource: Slot<unsafe extern "system" fn(H, *mut MapInputResource) -> Status>,
    pub unmap_input_resource: Slot<unsafe extern "system" fn(H, H) -> Status>,
    pub destroy_encoder: Slot<unsafe extern "system" fn(H) -> Status>,
    pub invalidate_ref_frames: Unused,
    pub open_encode_session_ex:
        Slot<unsafe extern "system" fn(*mut OpenSessionParams, *mut H) -> Status>,
    pub register_resource: Slot<unsafe extern "system" fn(H, *mut RegisterResource) -> Status>,
    pub unregister_resource: Slot<unsafe extern "system" fn(H, H) -> Status>,
    pub reconfigure_encoder: Slot<unsafe extern "system" fn(H, *mut ReconfigureParams) -> Status>,
    pub reserved1: H,
    pub create_mv_buffer: Unused,
    pub destroy_mv_buffer: Unused,
    pub run_motion_estimation_only: Unused,
    pub get_last_error_string: Slot<unsafe extern "system" fn(H) -> *const c_char>,
    pub set_io_cuda_streams: Unused,
    pub get_encode_preset_config_ex:
        Slot<unsafe extern "system" fn(H, Guid, Guid, u32, *mut PresetConfig) -> Status>,
    pub get_sequence_param_ex: Unused,
    pub reserved2: [H; 279],
}

pub type CreateInstance = unsafe extern "system" fn(*mut FunctionList) -> Status;
pub type MaxSupportedVersion = unsafe extern "system" fn(*mut u32) -> Status;

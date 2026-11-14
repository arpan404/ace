// SPDX-License-Identifier: Apache-2.0
//! A fake NVIDIA driver at the C boundary: function tables of `extern "system"` functions that
//! check each structure's version as a driver would, record the call sequence, and keep the
//! handles they hand out countable. Per test thread.
#![allow(unsafe_code, clippy::unwrap_used)]
use crate::dec_abi::*;
use crate::enc_abi::*;
use crate::load::{CudaApi, CuvidApi, EncodeApi, NvRuntime};
use std::cell::RefCell;
use std::ffi::{c_int, c_uint, c_void};
use std::sync::Arc;

const INVALID_VERSION: Status = 15;
const INVALID_PARAM: Status = 8;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Init {
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub codec: Guid,
    pub preset: Guid,
    pub tuning: u32,
    pub gop: u32,
    pub p_interval: i32,
    pub idr_period: u32,
    pub rc_mode: u32,
    pub bitrate: u32,
    pub vbv: u32,
    pub qp: Qp,
    pub ptd: u32,
}

#[derive(Default)]
pub struct Enc {
    pub calls: Vec<&'static str>,
    /// The next call of this name returns this status instead.
    pub fail: Option<(&'static str, Status)>,
    pub guids: Vec<Guid>,
    pub max: (i32, i32),
    pub init: Option<Init>,
    pub reconfigured: Vec<Init>,
    pub pic_flags: Vec<u32>,
    pub pic_formats: Vec<u32>,
    pub registered: Vec<(u32, u32, u32)>, // (resource type, format, GL texture id)
    pub live: Live,
    pub input: Vec<u8>,
    pub input_pitch: u32,
    output: Vec<u8>,
    pending: Option<(u32, u64)>,
    preset_codec: Guid,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Live {
    pub sessions: i32,
    pub bitstreams: i32,
    pub inputs: i32,
    pub registrations: i32,
    pub mapped: i32,
}

thread_local! {
    static ENC: RefCell<Enc> = RefCell::new(Enc::default());
    static DEC: RefCell<Dec> = RefCell::new(Dec::default());
}

pub fn enc<T>(f: impl FnOnce(&mut Enc) -> T) -> T {
    ENC.with(|e| f(&mut e.borrow_mut()))
}

fn take_fail(e: &mut Enc, name: &'static str) -> Option<Status> {
    e.calls.push(name);
    match e.fail {
        Some((n, status)) if n == name => {
            e.fail = None;
            Some(status)
        }
        _ => None,
    }
}

macro_rules! guard {
    ($e:expr, $name:literal, $ok:expr) => {{
        if let Some(status) = take_fail($e, $name) {
            return status;
        }
        if !$ok {
            return INVALID_VERSION;
        }
    }};
}

fn snapshot(init: &InitParams) -> Init {
    // SAFETY: the encoder points `encode_config` at its live preset storage.
    let config = unsafe { &*init.encode_config };
    let word = if init.encode_guid == CODEC_HEVC {
        HEVC_IDR_PERIOD_WORD
    } else {
        H264_IDR_PERIOD_WORD
    };
    Init {
        width: init.encode_width,
        height: init.encode_height,
        fps: init.frame_rate_num,
        codec: init.encode_guid,
        preset: init.preset_guid,
        tuning: init.tuning_info,
        gop: config.gop_length,
        p_interval: config.frame_interval_p,
        idr_period: config.codec.words[word],
        rc_mode: config.rc.mode,
        bitrate: config.rc.average_bit_rate,
        vbv: config.rc.vbv_buffer_size,
        qp: config.rc.const_qp,
        ptd: init.enable_ptd,
    }
}

type H = *mut c_void;

extern "system" fn open_ex(p: *mut OpenSessionParams, h: *mut H) -> Status {
    let p = unsafe { &*p };
    enc(|e| {
        guard!(
            e,
            "open",
            p.version == OPEN_SESSION_VER && p.api_version == API_VERSION
        );
        e.live.sessions += 1;
        unsafe { *h = 0x1000 as H };
        0
    })
}
extern "system" fn guid_count(_: H, n: *mut u32) -> Status {
    enc(|e| {
        guard!(e, "guid_count", true);
        unsafe { *n = e.guids.len() as u32 };
        0
    })
}
extern "system" fn guids(_: H, out: *mut Guid, size: u32, n: *mut u32) -> Status {
    enc(|e| {
        guard!(e, "guids", true);
        let count = e.guids.len().min(size as usize);
        for (i, g) in e.guids.iter().take(count).enumerate() {
            unsafe { *out.add(i) = *g };
        }
        unsafe { *n = count as u32 };
        0
    })
}
extern "system" fn caps(_: H, _: Guid, p: *mut CapsParam, v: *mut i32) -> Status {
    let p = unsafe { &*p };
    enc(|e| {
        guard!(e, "caps", p.version == CAPS_PARAM_VER);
        let value = match p.caps_to_query {
            CAPS_WIDTH_MAX => e.max.0,
            CAPS_HEIGHT_MAX => e.max.1,
            _ => 0,
        };
        unsafe { *v = value };
        0
    })
}
extern "system" fn preset_ex(_: H, codec: Guid, _: Guid, _: u32, p: *mut PresetConfig) -> Status {
    let p = unsafe { &mut *p };
    enc(|e| {
        guard!(
            e,
            "preset_config",
            p.version == PRESET_CONFIG_VER && p.config.version == CONFIG_VER
        );
        // What a driver's preset might hold: periodic IDRs and B-frames, VBR.
        p.config.gop_length = 250;
        p.config.frame_interval_p = 3;
        p.config.codec.words[H264_IDR_PERIOD_WORD] = 250;
        p.config.codec.words[HEVC_IDR_PERIOD_WORD] = 250;
        p.config.rc.mode = 1;
        e.preset_codec = codec;
        0
    })
}
extern "system" fn initialize(_: H, p: *mut InitParams) -> Status {
    let p = unsafe { &*p };
    enc(|e| {
        guard!(e, "initialize", p.version == INITIALIZE_VER);
        if p.encode_config.is_null() || unsafe { (*p.encode_config).version } != CONFIG_VER {
            return INVALID_PARAM;
        }
        e.init = Some(snapshot(p));
        0
    })
}
extern "system" fn reconfigure(_: H, p: *mut ReconfigureParams) -> Status {
    let p = unsafe { &*p };
    enc(|e| {
        guard!(
            e,
            "reconfigure",
            p.version == RECONFIGURE_VER && p.init.version == INITIALIZE_VER
        );
        e.reconfigured.push(snapshot(&p.init));
        0
    })
}
extern "system" fn create_bitstream(_: H, p: *mut CreateBitstreamBuffer) -> Status {
    let p = unsafe { &mut *p };
    enc(|e| {
        guard!(e, "create_bitstream", p.version == CREATE_BITSTREAM_VER);
        e.live.bitstreams += 1;
        p.bitstream_buffer = 0x2000 as H;
        0
    })
}
extern "system" fn destroy_bitstream(_: H, _: H) -> Status {
    enc(|e| {
        guard!(e, "destroy_bitstream", true);
        e.live.bitstreams -= 1;
        0
    })
}
extern "system" fn create_input(_: H, p: *mut CreateInputBuffer) -> Status {
    let p = unsafe { &mut *p };
    enc(|e| {
        guard!(e, "create_input", p.version == CREATE_INPUT_VER);
        let row = if p.buffer_format == FORMAT_NV12 {
            p.width
        } else {
            p.width * 4
        };
        let rows = if p.buffer_format == FORMAT_NV12 {
            p.height * 3 / 2
        } else {
            p.height
        };
        e.input_pitch = row.div_ceil(256) * 256;
        e.input = vec![0; (e.input_pitch * rows) as usize];
        e.live.inputs += 1;
        p.input_buffer = 0x3000 as H;
        0
    })
}
extern "system" fn lock_input(_: H, p: *mut LockInputBuffer) -> Status {
    let p = unsafe { &mut *p };
    enc(|e| {
        guard!(e, "lock_input", p.version == LOCK_INPUT_VER);
        p.data = e.input.as_mut_ptr().cast();
        p.pitch = e.input_pitch;
        0
    })
}
extern "system" fn unlock_input(_: H, _: H) -> Status {
    enc(|e| {
        guard!(e, "unlock_input", true);
        0
    })
}
extern "system" fn destroy_input(_: H, _: H) -> Status {
    enc(|e| {
        guard!(e, "destroy_input", true);
        e.live.inputs -= 1;
        0
    })
}
extern "system" fn register(_: H, p: *mut RegisterResource) -> Status {
    let p = unsafe { &mut *p };
    enc(|e| {
        guard!(e, "register", p.version == REGISTER_VER);
        let texture = if p.resource_type == RESOURCE_OPENGL_TEX {
            unsafe { (*p.resource.cast::<GlTexResource>()).texture }
        } else {
            0
        };
        e.registered
            .push((p.resource_type, p.buffer_format, texture));
        e.live.registrations += 1;
        p.registered = (0x4000 + e.registered.len()) as H;
        0
    })
}
extern "system" fn unregister(_: H, _: H) -> Status {
    enc(|e| {
        guard!(e, "unregister", true);
        e.live.registrations -= 1;
        0
    })
}
extern "system" fn map(_: H, p: *mut MapInputResource) -> Status {
    let p = unsafe { &mut *p };
    enc(|e| {
        guard!(e, "map", p.version == MAP_VER);
        let index = p.registered as usize - 0x4001;
        p.mapped = 0x5000 as H;
        p.mapped_format = e.registered[index].1;
        e.live.mapped += 1;
        0
    })
}
extern "system" fn unmap(_: H, _: H) -> Status {
    enc(|e| {
        guard!(e, "unmap", true);
        e.live.mapped -= 1;
        0
    })
}
extern "system" fn encode_picture(_: H, p: *mut PicParams) -> Status {
    let p = unsafe { &*p };
    enc(|e| {
        if p.flags & PIC_FLAG_EOS != 0 {
            e.calls.push("eos");
            return 0;
        }
        guard!(e, "encode", p.version == PIC_PARAMS_VER);
        if p.input_buffer.is_null() || p.output_bitstream.is_null() {
            return INVALID_PARAM;
        }
        e.pic_flags.push(p.flags);
        e.pic_formats.push(p.buffer_format);
        let kind = if p.flags & PIC_FLAG_FORCEIDR != 0 {
            PIC_TYPE_IDR
        } else {
            0
        };
        e.pending = Some((kind, p.input_timestamp));
        0
    })
}
extern "system" fn lock_bitstream(_: H, p: *mut LockBitstream) -> Status {
    let p = unsafe { &mut *p };
    enc(|e| {
        guard!(e, "lock_bitstream", p.version == LOCK_BITSTREAM_VER);
        let Some((kind, pts)) = e.pending.take() else {
            return INVALID_PARAM;
        };
        let nal = if kind == PIC_TYPE_IDR { 0x65 } else { 0x41 };
        e.output = vec![0, 0, 0, 1, nal, 0xAA, 0xBB];
        p.bitstream_ptr = e.output.as_mut_ptr().cast();
        p.bitstream_size = e.output.len() as u32;
        p.picture_type = kind;
        p.output_timestamp = pts;
        0
    })
}
extern "system" fn unlock_bitstream(_: H, _: H) -> Status {
    enc(|e| {
        guard!(e, "unlock_bitstream", true);
        0
    })
}
extern "system" fn destroy_encoder(_: H) -> Status {
    enc(|e| {
        e.calls.push("destroy");
        e.live.sessions -= 1;
        0
    })
}

/// Resets this thread's fake encoder: H.264 and HEVC, up to 4096×4096.
pub fn encode_api() -> Arc<EncodeApi> {
    enc(|e| {
        *e = Enc::default();
        e.guids = vec![CODEC_H264, CODEC_HEVC];
        e.max = (4096, 4096);
    });
    let mut list: FunctionList = zeroed();
    list.version = FUNCTION_LIST_VER;
    list.open_encode_session_ex = Some(open_ex);
    list.get_encode_guid_count = Some(guid_count);
    list.get_encode_guids = Some(guids);
    list.get_encode_caps = Some(caps);
    list.get_encode_preset_config_ex = Some(preset_ex);
    list.initialize_encoder = Some(initialize);
    list.reconfigure_encoder = Some(reconfigure);
    list.create_bitstream_buffer = Some(create_bitstream);
    list.destroy_bitstream_buffer = Some(destroy_bitstream);
    list.create_input_buffer = Some(create_input);
    list.lock_input_buffer = Some(lock_input);
    list.unlock_input_buffer = Some(unlock_input);
    list.destroy_input_buffer = Some(destroy_input);
    list.register_resource = Some(register);
    list.unregister_resource = Some(unregister);
    list.map_input_resource = Some(map);
    list.unmap_input_resource = Some(unmap);
    list.encode_picture = Some(encode_picture);
    list.lock_bitstream = Some(lock_bitstream);
    list.unlock_bitstream = Some(unlock_bitstream);
    list.destroy_encoder = Some(destroy_encoder);
    Arc::new(EncodeApi::from_list(list))
}

// ---- CUDA and NVDEC ----

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Created {
    pub coded: (u64, u64),
    pub target: (u64, u64),
    pub surfaces: u64,
    pub output_format: c_int,
    pub deinterlace: c_int,
    pub creation_flags: u64,
}

#[derive(Default)]
pub struct Dec {
    pub calls: Vec<&'static str>,
    pub supported: bool,
    pub format: Option<VideoFormat>,
    pub created: Vec<Created>,
    pub contexts: i32,
    pub depth: i32,
    pub depth_at_parse: Vec<i32>,
    pub decoders: i32,
    pub parsers: i32,
    pub mapped: i32,
    pub copies: usize,
    parser: Option<ParserParams>,
    surface: Vec<u8>,
    pitch: u32,
    sequenced: bool,
}

pub fn dec<T>(f: impl FnOnce(&mut Dec) -> T) -> T {
    DEC.with(|d| f(&mut d.borrow_mut()))
}

/// A progressive 8-bit 4:2:0 1280×720 stream.
pub fn stream_format(codec: c_int) -> VideoFormat {
    let mut f: VideoFormat = zeroed();
    f.codec = codec;
    f.progressive_sequence = 1;
    f.min_num_decode_surfaces = 4;
    f.coded_width = 1280;
    f.coded_height = 736;
    f.display_area = [0, 0, 1280, 720];
    f.chroma_format = CHROMA_420;
    f
}

extern "system" fn cu_init(_: c_uint) -> CuResult {
    dec(|d| d.calls.push("cuInit"));
    0
}
extern "system" fn cu_device_get(dev: *mut CuDevice, _: c_int) -> CuResult {
    unsafe { *dev = 0 };
    0
}
extern "system" fn cu_ctx_create(ctx: *mut CuContext, _: c_uint, _: CuDevice) -> CuResult {
    dec(|d| {
        d.contexts += 1;
        d.depth += 1;
    });
    unsafe { *ctx = 0x10 as CuContext };
    0
}
extern "system" fn cu_ctx_destroy(_: CuContext) -> CuResult {
    dec(|d| d.contexts -= 1);
    0
}
extern "system" fn cu_ctx_push(_: CuContext) -> CuResult {
    dec(|d| d.depth += 1);
    0
}
extern "system" fn cu_ctx_pop(_: *mut CuContext) -> CuResult {
    dec(|d| d.depth -= 1);
    0
}
extern "system" fn cu_memcpy_2d(c: *const Memcpy2d) -> CuResult {
    let c = unsafe { &*c };
    if c.src_memory_type != MEMORY_DEVICE || c.dst_memory_type != MEMORY_HOST {
        return 1;
    }
    // The fake's "device" pointers are host addresses of its surface.
    for row in 0..c.height {
        unsafe {
            std::ptr::copy_nonoverlapping(
                (c.src_device as usize + row * c.src_pitch) as *const u8,
                c.dst_host.cast::<u8>().add(row * c.dst_pitch),
                c.width_in_bytes,
            );
        }
    }
    dec(|d| d.copies += 1);
    0
}
extern "system" fn get_caps(caps: *mut DecodeCaps) -> CuResult {
    let caps = unsafe { &mut *caps };
    dec(|d| {
        d.calls.push("caps");
        caps.is_supported = u8::from(d.supported);
        caps.max_width = 4096;
        caps.max_height = 4096;
    });
    0
}
#[allow(clippy::unnecessary_cast)] // `c_ulong` is 32-bit on Windows
extern "system" fn create_decoder(h: *mut H, info: *mut DecodeCreateInfo) -> CuResult {
    let info = unsafe { &*info };
    dec(|d| {
        d.calls.push("create_decoder");
        d.created.push(Created {
            coded: (info.width as u64, info.height as u64),
            target: (info.target_width as u64, info.target_height as u64),
            surfaces: info.num_decode_surfaces as u64,
            output_format: info.output_format,
            deinterlace: info.deinterlace_mode,
            creation_flags: info.creation_flags as u64,
        });
        // An output surface: luma rows of 0x11, then chroma rows of 0x22, at a wide pitch.
        let (w, h) = (info.target_width as u32, info.target_height as u32);
        d.pitch = w.div_ceil(512) * 512;
        let luma = (d.pitch * h) as usize;
        d.surface = vec![0x11; luma];
        d.surface.extend(std::iter::repeat_n(0x22, luma / 2));
        d.decoders += 1;
    });
    unsafe { *h = 0x20 as H };
    0
}
extern "system" fn destroy_decoder(_: H) -> CuResult {
    dec(|d| {
        d.calls.push("destroy_decoder");
        d.decoders -= 1;
    });
    0
}
extern "system" fn decode_picture(_: H, _: *mut c_void) -> CuResult {
    dec(|d| d.calls.push("decode_picture"));
    0
}
extern "system" fn create_parser(h: *mut H, p: *mut ParserParams) -> CuResult {
    let p = unsafe { *p };
    dec(|d| {
        d.parsers += 1;
        d.parser = Some(p);
        d.sequenced = false;
    });
    unsafe { *h = 0x30 as H };
    0
}
extern "system" fn parse(_: H, packet: *mut SourcePacket) -> CuResult {
    let packet = unsafe { *packet };
    // Take what the callbacks need, then call them without holding the state.
    let (params, format, sequenced) = dec(|d| {
        d.calls.push("parse");
        d.depth_at_parse.push(d.depth);
        let sequenced = d.sequenced;
        d.sequenced = true;
        (d.parser.unwrap(), d.format.unwrap(), sequenced)
    });
    let user = params.user_data;
    unsafe {
        if !sequenced {
            let mut format = format;
            if (params.sequence.unwrap())(user, &mut format) == 0 {
                return 0;
            }
        }
        if (params.decode.unwrap())(user, 0x40 as *mut c_void) == 0 {
            return 0;
        }
        let mut info = DisplayInfo {
            picture_index: 0,
            progressive_frame: 1,
            top_field_first: 0,
            repeat_first_field: 0,
            timestamp: packet.timestamp,
        };
        (params.display.unwrap())(user, &mut info);
    }
    0
}
extern "system" fn destroy_parser(_: H) -> CuResult {
    dec(|d| {
        d.calls.push("destroy_parser");
        d.parsers -= 1;
    });
    0
}
extern "system" fn map_frame(
    _: H,
    _: c_int,
    ptr: *mut u64,
    pitch: *mut c_uint,
    _: *mut ProcParams,
) -> CuResult {
    dec(|d| {
        d.mapped += 1;
        unsafe {
            *ptr = d.surface.as_ptr() as u64;
            *pitch = d.pitch;
        }
    });
    0
}
extern "system" fn unmap_frame(_: H, _: u64) -> CuResult {
    dec(|d| d.mapped -= 1);
    0
}

pub fn cuda_api() -> Arc<CudaApi> {
    Arc::new(CudaApi::from_fns(CudaFns {
        init: cu_init,
        device_get: cu_device_get,
        ctx_create: cu_ctx_create,
        ctx_destroy: cu_ctx_destroy,
        ctx_push: cu_ctx_push,
        ctx_pop: cu_ctx_pop,
        memcpy_2d: cu_memcpy_2d,
    }))
}

/// Resets this thread's fake decoder: supported, a 1280×720 stream of `codec`.
pub fn cuvid_api(codec: c_int) -> Arc<CuvidApi> {
    dec(|d| {
        *d = Dec::default();
        d.supported = true;
        d.format = Some(stream_format(codec));
    });
    Arc::new(CuvidApi::from_fns(CuvidFns {
        get_decoder_caps: get_caps,
        create_decoder,
        destroy_decoder,
        decode_picture,
        create_parser,
        parse_data: parse,
        destroy_parser,
        map_frame,
        unmap_frame,
    }))
}

/// A runtime of all three fakes.
pub fn runtime() -> NvRuntime {
    NvRuntime {
        encode: Some(encode_api()),
        cuda: Some(cuda_api()),
        cuvid: Some(cuvid_api(CUVID_H264)),
        missing: Vec::new(),
    }
}

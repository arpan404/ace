// SPDX-License-Identifier: Apache-2.0
//! One NVENC session: the documented call sequence from open to destroy, in synchronous mode
//! (no completion events; Linux has none). Every handle it creates is released in `Drop`, in
//! the order the programming guide gives.
#![allow(unsafe_code)]
use crate::enc_abi::*;
use crate::error::{missing, nvenc};
use crate::load::EncodeApi;
use crate::surface::{D3d11Texture, GlTexture};
use media_codec::{Codec, CodecError, CpuPicture, EncodeSpec, Picture, PixelFormat, Size};
use std::ffi::c_void;
use std::ptr::null_mut;
use std::sync::Arc;

/// Calls one slot of the function table, mapping a missing slot and a failed status.
macro_rules! call {
    ($api:expr, $slot:ident ( $($arg:expr),* $(,)? )) => {{
        let f = $api.list.$slot.ok_or_else(|| missing(stringify!($slot)))?;
        // SAFETY: the slot came from the driver (or the fake) for this table's version, and
        // every argument is a live structure of ours with its version set, or a handle this
        // session owns.
        nvenc(stringify!($slot), unsafe { f($($arg),*) })
    }};
}

/// Registered textures kept per session: a capture ring is a handful of textures.
const REGISTERED_MAX: usize = 8;
const NEED_MORE_INPUT: Status = 17;

/// What the session encodes on.
#[derive(Clone, Copy)]
pub enum DeviceKind {
    /// The GL context current on the calling thread.
    OpenGl,
    /// An `ID3D11Device*`.
    D3d11(*mut c_void),
    /// A CUDA context, for driver-allocated input buffers.
    Cuda(*mut c_void),
}

impl DeviceKind {
    fn split(self) -> (u32, *mut c_void) {
        match self {
            Self::OpenGl => (DEVICE_OPENGL, null_mut()),
            Self::D3d11(device) => (DEVICE_DIRECTX, device),
            Self::Cuda(context) => (DEVICE_CUDA, context),
        }
    }
}

/// The preset configuration the driver fills, with room past our declared size in case a
/// driver writes more than this layout names.
#[repr(C)]
#[derive(Clone, Copy)]
pub struct PresetStorage {
    pub preset: PresetConfig,
    guard: [u8; 4096],
}

/// The bitstream lock, with the same allowance.
#[repr(C)]
struct LockStorage {
    lock: LockBitstream,
    guard: [u8; 4096],
}

struct InputBuffer {
    handle: *mut c_void,
    format: u32,
}

struct Registered {
    key: (usize, u32),
    format: u32,
    pitch: u32,
    handle: *mut c_void,
    /// What `resource` pointed at for GL; kept while registered.
    _gl: Option<Box<GlTexResource>>,
}

/// One encoded picture as NVENC returned it.
pub struct Output {
    pub data: Vec<u8>,
    pub key: bool,
    pub pts_us: u64,
}

pub struct Session {
    api: Arc<EncodeApi>,
    handle: *mut c_void,
    initialized: bool,
    pub codec: Codec,
    pub size: Size,
    pub max: Size,
    codec_guid: Guid,
    preset: Box<PresetStorage>,
    init: Box<InitParams>,
    bitstream: *mut c_void,
    input: Option<InputBuffer>,
    registered: Vec<Registered>,
    frame_idx: u32,
}

pub fn codec_guid(codec: Codec) -> Result<Guid, CodecError> {
    match codec {
        Codec::H264 => Ok(CODEC_H264),
        Codec::Hevc => Ok(CODEC_HEVC),
        other => Err(CodecError::Unsupported(format!(
            "NVENC does not encode {other:?}"
        ))),
    }
}

impl Session {
    pub fn open(
        api: Arc<EncodeApi>,
        device: DeviceKind,
        spec: &EncodeSpec,
        preset_guid: Guid,
    ) -> Result<Self, CodecError> {
        let codec_guid = codec_guid(spec.codec)?;
        let (device_type, device) = device.split();
        let mut params: OpenSessionParams = zeroed();
        params.version = OPEN_SESSION_VER;
        params.device_type = device_type;
        params.device = device;
        params.api_version = API_VERSION;
        let mut handle = null_mut();
        let open = api
            .list
            .open_encode_session_ex
            .ok_or_else(|| missing("open_encode_session_ex"))?;
        // SAFETY: documented signature; `params` is ours with its version set.
        let status = unsafe { open(&mut params, &mut handle) };
        let mut session = Self {
            api,
            handle,
            initialized: false,
            codec: spec.codec,
            size: spec.size,
            max: spec.size,
            codec_guid,
            preset: Box::new(zeroed_preset()),
            init: Box::new(zeroed()),
            bitstream: null_mut(),
            input: None,
            registered: Vec::new(),
            frame_idx: 0,
        };
        nvenc("open_encode_session_ex", status)?;
        if session.handle.is_null() {
            return Err(CodecError::Backend("NVENC returned no session".into()));
        }
        session.require_codec()?;
        session.max = Size {
            width: session.cap(CAPS_WIDTH_MAX)?,
            height: session.cap(CAPS_HEIGHT_MAX)?,
        };
        if spec.size.width > session.max.width || spec.size.height > session.max.height {
            return Err(CodecError::Unsupported(format!(
                "NVENC encodes at most {}x{}",
                session.max.width, session.max.height
            )));
        }
        session.preset.preset.version = PRESET_CONFIG_VER;
        session.preset.preset.config.version = CONFIG_VER;
        call!(
            session.api,
            get_encode_preset_config_ex(
                session.handle,
                codec_guid,
                preset_guid,
                TUNING_ULTRA_LOW_LATENCY,
                &mut session.preset.preset,
            )
        )?;
        let config = &mut session.preset.preset.config;
        crate::encoder::tune_low_latency(config, spec.codec);
        crate::encoder::apply_rate(config, spec);
        let init = &mut *session.init;
        init.version = INITIALIZE_VER;
        init.encode_guid = codec_guid;
        init.preset_guid = preset_guid;
        init.encode_width = spec.size.width;
        init.encode_height = spec.size.height;
        init.dar_width = spec.size.width;
        init.dar_height = spec.size.height;
        init.frame_rate_num = spec.fps;
        init.frame_rate_den = 1;
        init.enable_ptd = 1;
        init.max_encode_width = spec.size.width;
        init.max_encode_height = spec.size.height;
        init.tuning_info = TUNING_ULTRA_LOW_LATENCY;
        init.encode_config = &mut session.preset.preset.config;
        call!(
            session.api,
            initialize_encoder(session.handle, &mut *session.init)
        )?;
        session.initialized = true;
        let mut create: CreateBitstreamBuffer = zeroed();
        create.version = CREATE_BITSTREAM_VER;
        call!(
            session.api,
            create_bitstream_buffer(session.handle, &mut create)
        )?;
        session.bitstream = create.bitstream_buffer;
        Ok(session)
    }

    fn require_codec(&mut self) -> Result<(), CodecError> {
        let mut count = 0u32;
        call!(self.api, get_encode_guid_count(self.handle, &mut count))?;
        let mut guids = vec![Guid::default(); count as usize];
        let mut written = 0u32;
        call!(
            self.api,
            get_encode_guids(self.handle, guids.as_mut_ptr(), count, &mut written)
        )?;
        guids.truncate(written.min(count) as usize);
        if guids.contains(&self.codec_guid) {
            Ok(())
        } else {
            Err(CodecError::Unsupported(format!(
                "this GPU's NVENC has no {:?}",
                self.codec
            )))
        }
    }

    fn cap(&mut self, which: u32) -> Result<u32, CodecError> {
        let mut param: CapsParam = zeroed();
        param.version = CAPS_PARAM_VER;
        param.caps_to_query = which;
        let mut value = 0i32;
        call!(
            self.api,
            get_encode_caps(self.handle, self.codec_guid, &mut param, &mut value)
        )?;
        u32::try_from(value)
            .ok()
            .filter(|v| *v > 0)
            .ok_or_else(|| CodecError::Backend(format!("NVENC capability {which} = {value}")))
    }

    /// A rate or frame-rate change on the running session: no new stream, no keyframe. On
    /// failure the session keeps its previous configuration.
    pub fn reconfigure(&mut self, spec: &EncodeSpec) -> Result<(), CodecError> {
        let mut preset = Box::new(*self.preset);
        crate::encoder::apply_rate(&mut preset.preset.config, spec);
        let mut params = Box::new(zeroed::<ReconfigureParams>());
        params.version = RECONFIGURE_VER;
        params.init = *self.init;
        params.init.frame_rate_num = spec.fps;
        params.init.encode_config = &mut preset.preset.config;
        call!(self.api, reconfigure_encoder(self.handle, &mut *params))?;
        self.preset = preset;
        *self.init = params.init;
        self.init.encode_config = &mut self.preset.preset.config;
        Ok(())
    }

    /// Encodes one picture synchronously. `None` when NVENC wants more input first, which
    /// can't happen without B-frames but is handled as documented.
    pub fn encode(
        &mut self,
        picture: Picture,
        flags: u32,
        duration_us: u64,
    ) -> Result<Option<Output>, CodecError> {
        let pts = picture.pts_us();
        match picture {
            Picture::Cpu(cpu) => {
                let (input, format, pitch) = self.upload(&cpu)?;
                self.submit(input, format, pitch, flags, pts, duration_us)
            }
            Picture::Platform(platform) => {
                let format = rgb_format(platform.format)?;
                let surface = platform.surface.as_any();
                let index = if let Some(gl) = surface.downcast_ref::<GlTexture>() {
                    self.register_gl(gl, format)?
                } else if let Some(d3d) = surface.downcast_ref::<D3d11Texture>() {
                    self.register_d3d11(d3d, format)?
                } else {
                    return Err(CodecError::Unsupported(
                        "NVENC takes GL or D3D11 textures".into(),
                    ));
                };
                let registered = self.registered[index].handle;
                let pitch = self.registered[index].pitch;
                let mut map: MapInputResource = zeroed();
                map.version = MAP_VER;
                map.registered = registered;
                call!(self.api, map_input_resource(self.handle, &mut map))?;
                let result = self.submit(
                    map.mapped,
                    map.mapped_format,
                    pitch,
                    flags,
                    pts,
                    duration_us,
                );
                let unmapped = call!(self.api, unmap_input_resource(self.handle, map.mapped));
                let output = result?;
                unmapped?;
                Ok(output)
            }
        }
    }

    fn submit(
        &mut self,
        input: *mut c_void,
        format: u32,
        pitch: u32,
        flags: u32,
        pts_us: u64,
        duration_us: u64,
    ) -> Result<Option<Output>, CodecError> {
        let mut pic = Box::new(zeroed::<PicParams>());
        pic.version = PIC_PARAMS_VER;
        pic.input_width = self.size.width;
        pic.input_height = self.size.height;
        pic.input_pitch = pitch;
        pic.flags = flags;
        pic.frame_idx = self.frame_idx;
        pic.input_timestamp = pts_us;
        pic.input_duration = duration_us;
        pic.input_buffer = input;
        pic.output_bitstream = self.bitstream;
        pic.buffer_format = format;
        pic.picture_struct = PIC_STRUCT_FRAME;
        let f = self
            .api
            .list
            .encode_picture
            .ok_or_else(|| missing("encode_picture"))?;
        // SAFETY: documented signature; `pic` is ours, `input` is mapped or locked-and-released
        // input of this session, `bitstream` is this session's buffer.
        let status = unsafe { f(self.handle, &mut *pic) };
        self.frame_idx = self.frame_idx.wrapping_add(1);
        if status == NEED_MORE_INPUT {
            return Ok(None);
        }
        nvenc("encode_picture", status)?;
        let mut lock = Box::new(LockStorage {
            lock: zeroed(),
            guard: [0; 4096],
        });
        lock.lock.version = LOCK_BITSTREAM_VER;
        lock.lock.output_bitstream = self.bitstream;
        call!(self.api, lock_bitstream(self.handle, &mut lock.lock))?;
        let data = if lock.lock.bitstream_ptr.is_null() {
            Vec::new()
        } else {
            // SAFETY: while locked, the driver's buffer holds `bitstream_size` bytes.
            unsafe {
                std::slice::from_raw_parts(
                    lock.lock.bitstream_ptr.cast::<u8>(),
                    lock.lock.bitstream_size as usize,
                )
            }
            .to_vec()
        };
        call!(self.api, unlock_bitstream(self.handle, self.bitstream))?;
        if data.is_empty() {
            return Err(CodecError::Backend(
                "NVENC returned an empty picture".into(),
            ));
        }
        Ok(Some(Output {
            data,
            key: lock.lock.picture_type == PIC_TYPE_IDR,
            pts_us: lock.lock.output_timestamp,
        }))
    }

    /// Copies a CPU picture into the driver-allocated input buffer: the one upload of the
    /// CPU path.
    fn upload(&mut self, picture: &CpuPicture) -> Result<(*mut c_void, u32, u32), CodecError> {
        let format = match picture.format() {
            PixelFormat::Nv12 => FORMAT_NV12,
            other => rgb_format(other)?,
        };
        if self.input.as_ref().is_none_or(|i| i.format != format) {
            self.release_input();
            let mut create: CreateInputBuffer = zeroed();
            create.version = CREATE_INPUT_VER;
            create.width = self.size.width;
            create.height = self.size.height;
            create.buffer_format = format;
            call!(self.api, create_input_buffer(self.handle, &mut create))?;
            self.input = Some(InputBuffer {
                handle: create.input_buffer,
                format,
            });
        }
        let handle = self.input.as_ref().map_or(null_mut(), |i| i.handle);
        let mut lock: LockInputBuffer = zeroed();
        lock.version = LOCK_INPUT_VER;
        lock.input_buffer = handle;
        call!(self.api, lock_input_buffer(self.handle, &mut lock))?;
        let copied = copy_into(picture, lock.data.cast::<u8>(), lock.pitch as usize);
        let unlocked = call!(self.api, unlock_input_buffer(self.handle, handle));
        copied?;
        unlocked?;
        Ok((handle, format, lock.pitch))
    }

    fn register_gl(&mut self, gl: &GlTexture, format: u32) -> Result<usize, CodecError> {
        let key = (gl.texture as usize, gl.target);
        if let Some(i) = self.find(key, format) {
            return Ok(i);
        }
        let mut resource = Box::new(GlTexResource {
            texture: gl.texture,
            target: gl.target,
        });
        let pitch = self.size.width * 4;
        let handle = self.register(
            RESOURCE_OPENGL_TEX,
            (&mut *resource as *mut GlTexResource).cast(),
            format,
            pitch,
        )?;
        Ok(self.remember(Registered {
            key,
            format,
            pitch,
            handle,
            _gl: Some(resource),
        }))
    }

    fn register_d3d11(&mut self, d3d: &D3d11Texture, format: u32) -> Result<usize, CodecError> {
        let key = (d3d.texture as usize, 0);
        if let Some(i) = self.find(key, format) {
            return Ok(i);
        }
        let handle = self.register(RESOURCE_DIRECTX, d3d.texture, format, 0)?;
        Ok(self.remember(Registered {
            key,
            format,
            pitch: 0,
            handle,
            _gl: None,
        }))
    }

    fn find(&self, key: (usize, u32), format: u32) -> Option<usize> {
        self.registered
            .iter()
            .position(|r| r.key == key && r.format == format)
    }

    fn register(
        &mut self,
        kind: u32,
        resource: *mut c_void,
        format: u32,
        pitch: u32,
    ) -> Result<*mut c_void, CodecError> {
        if self.registered.len() >= REGISTERED_MAX {
            let oldest = self.registered.remove(0);
            call!(self.api, unregister_resource(self.handle, oldest.handle))?;
        }
        let mut register: RegisterResource = zeroed();
        register.version = REGISTER_VER;
        register.resource_type = kind;
        register.width = self.size.width;
        register.height = self.size.height;
        register.pitch = pitch;
        register.resource = resource;
        register.buffer_format = format;
        register.buffer_usage = USAGE_INPUT_IMAGE;
        call!(self.api, register_resource(self.handle, &mut register))?;
        Ok(register.registered)
    }

    fn remember(&mut self, registered: Registered) -> usize {
        self.registered.push(registered);
        self.registered.len() - 1
    }

    fn release_input(&mut self) {
        if let Some(input) = self.input.take()
            && let Some(f) = self.api.list.destroy_input_buffer
        {
            // SAFETY: the buffer is this session's and no longer locked.
            unsafe { f(self.handle, input.handle) };
        }
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        if self.handle.is_null() {
            return;
        }
        let list = self.api.list;
        // SAFETY (whole block): every handle below was created by this session and is released
        // once, in the documented order: end of stream, buffers, registrations, the session.
        unsafe {
            if self.initialized
                && let Some(f) = list.encode_picture
            {
                let mut eos = Box::new(zeroed::<PicParams>());
                eos.version = PIC_PARAMS_VER;
                eos.flags = PIC_FLAG_EOS;
                f(self.handle, &mut *eos);
            }
            self.release_input();
            if !self.bitstream.is_null()
                && let Some(f) = list.destroy_bitstream_buffer
            {
                f(self.handle, self.bitstream);
            }
            if let Some(f) = list.unregister_resource {
                for registered in self.registered.drain(..) {
                    f(self.handle, registered.handle);
                }
            }
            if let Some(f) = list.destroy_encoder {
                f(self.handle);
            }
        }
    }
}

fn zeroed_preset() -> PresetStorage {
    PresetStorage {
        preset: zeroed(),
        guard: [0; 4096],
    }
}

fn rgb_format(format: PixelFormat) -> Result<u32, CodecError> {
    match format {
        PixelFormat::Bgra8 => Ok(FORMAT_ARGB),
        PixelFormat::Rgba8 => Ok(FORMAT_ABGR),
        other => Err(CodecError::Unsupported(format!(
            "NVENC input must be 32-bit RGB or NV12, not {other:?}"
        ))),
    }
}

/// Rows of `picture` into a locked buffer of `pitch` bytes per row; NV12's chroma follows the
/// luma rows directly.
fn copy_into(picture: &CpuPicture, base: *mut u8, pitch: usize) -> Result<(), CodecError> {
    let size = picture.size();
    let (w, h) = (size.width as usize, size.height as usize);
    let (row, plane_rows): (usize, &[usize]) = match picture.format() {
        PixelFormat::Nv12 => (w, &[h, h / 2]),
        _ => (w * 4, &[h]),
    };
    let rows: usize = plane_rows.iter().sum();
    if base.is_null() || pitch < row {
        return Err(CodecError::Backend("NVENC input buffer too small".into()));
    }
    // SAFETY: a locked input buffer of this session's size and format holds `rows` rows of
    // `pitch` bytes.
    let out = unsafe { std::slice::from_raw_parts_mut(base, pitch * rows) };
    let mut dst_row = 0;
    for (plane, &count) in picture.planes().iter().zip(plane_rows) {
        for r in 0..count {
            let src = &plane.data[r * plane.stride..r * plane.stride + row];
            let dst = (dst_row + r) * pitch;
            out[dst..dst + row].copy_from_slice(src);
        }
        dst_row += count;
    }
    Ok(())
}

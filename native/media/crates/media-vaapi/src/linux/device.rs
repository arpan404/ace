// SPDX-License-Identifier: Apache-2.0
//! One VA display on a DRM render node, with safe wrappers for every call this backend makes.
//! Calls on one display are serialized; resources (configs, contexts, buffers, surfaces) are
//! owned values that release themselves.
use super::api::{Api, LoadError};
use super::ffi::*;
use crate::formats::SurfaceFormat;
use crate::select;
use media_codec::{CodecError, Size};
use std::ffi::{CStr, c_int, c_uint, c_void};
use std::os::fd::{AsRawFd, OwnedFd};
use std::sync::{Arc, Mutex, MutexGuard};

pub struct Device {
    api: Api,
    display: VADisplay,
    lock: Mutex<()>,
    vendor: String,
    node: String,
    /// The render node; closed after `vaTerminate`.
    _fd: Option<OwnedFd>,
}

// SAFETY: the display pointer is only used through `call`, which holds `lock`; libva
// displays may be used from any thread when calls are serialized.
unsafe impl Send for Device {}
// SAFETY: as above.
unsafe impl Sync for Device {}

/// Why no device opened.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum OpenError {
    /// libva isn't installed, or there is no render node: this machine has no VA backend.
    Absent(String),
    /// libva and a node exist, but no driver initialised on any node.
    Failed(String),
}

impl From<OpenError> for CodecError {
    fn from(e: OpenError) -> Self {
        match e {
            OpenError::Absent(m) => CodecError::Unsupported(format!("no VA-API: {m}")),
            OpenError::Failed(m) => CodecError::Backend(format!("VA-API: {m}")),
        }
    }
}

const RENDER_NODES: std::ops::RangeInclusive<u32> = 128..=191;

impl Device {
    /// The first render node whose driver lists a VA encoder, else the first that
    /// initialises at all.
    pub fn open() -> Result<Arc<Self>, OpenError> {
        let mut first = None;
        let mut errors = Vec::new();
        let mut nodes = 0;
        for n in RENDER_NODES {
            let node = format!("/dev/dri/renderD{n}");
            let Ok(file) = std::fs::OpenOptions::new()
                .read(true)
                .write(true)
                .open(&node)
            else {
                continue;
            };
            nodes += 1;
            let api = Api::load().map_err(|e| match e {
                LoadError::Missing(m) => OpenError::Absent(m),
                LoadError::Symbol(m) => OpenError::Failed(m),
            })?;
            match Self::with_api(api, OwnedFd::from(file), node) {
                Ok(device) => {
                    if device.has_encoder() {
                        return Ok(device);
                    }
                    first.get_or_insert(device);
                }
                Err(e) => errors.push(e.to_string()),
            }
        }
        if let Some(device) = first {
            return Ok(device);
        }
        if nodes == 0 {
            return Err(OpenError::Absent("no DRM render node".into()));
        }
        Err(OpenError::Failed(errors.join("; ")))
    }

    /// Initialises a display on an open render node with the given entry points.
    pub fn with_api(api: Api, fd: OwnedFd, node: String) -> Result<Arc<Self>, CodecError> {
        // SAFETY: `fd` is an open render node that outlives the display (it is stored in
        // the device and closed after `vaTerminate`).
        let display = unsafe { (api.get_display_drm)(fd.as_raw_fd()) };
        if display.is_null() {
            return Err(CodecError::Backend(format!(
                "{node}: vaGetDisplayDRM failed"
            )));
        }
        let (mut major, mut minor) = (0, 0);
        // SAFETY: a fresh display and two out-parameters.
        let status = unsafe { (api.initialize)(display, &mut major, &mut minor) };
        if status != VA_STATUS_SUCCESS {
            let text = status_text(&api, status);
            // SAFETY: vaTerminate releases a display after a failed vaInitialize too.
            unsafe { (api.terminate)(display) };
            return Err(CodecError::Backend(format!("{node}: vaInitialize: {text}")));
        }
        // SAFETY: an initialised display; the string is owned by libva and copied here.
        let vendor = unsafe {
            let p = (api.query_vendor_string)(display);
            if p.is_null() {
                String::new()
            } else {
                CStr::from_ptr(p).to_string_lossy().into_owned()
            }
        };
        Ok(Arc::new(Self {
            api,
            display,
            lock: Mutex::new(()),
            vendor,
            node,
            _fd: Some(fd),
        }))
    }

    pub fn vendor(&self) -> &str {
        &self.vendor
    }

    pub fn node(&self) -> &str {
        &self.node
    }

    fn guard(&self) -> MutexGuard<'_, ()> {
        self.lock.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn check(&self, status: VAStatus, what: &str) -> Result<(), CodecError> {
        if status == VA_STATUS_SUCCESS {
            Ok(())
        } else {
            Err(CodecError::Backend(format!(
                "{what}: {}",
                status_text(&self.api, status)
            )))
        }
    }

    /// Every profile with its entrypoints, `VAProfileNone` (video processing) included.
    pub fn profiles(&self) -> Result<Vec<(i32, Vec<i32>)>, CodecError> {
        let _g = self.guard();
        let a = &self.api;
        // SAFETY: an initialised display; buffers sized by vaMaxNum* as va.h requires.
        unsafe {
            let max = (a.max_num_profiles)(self.display).max(0) as usize;
            let mut profiles = vec![0; max];
            let mut count = 0;
            self.check(
                (a.query_config_profiles)(self.display, profiles.as_mut_ptr(), &mut count),
                "vaQueryConfigProfiles",
            )?;
            profiles.truncate((count.max(0) as usize).min(max));
            let max_e = (a.max_num_entrypoints)(self.display).max(0) as usize;
            let mut out = Vec::with_capacity(profiles.len());
            // Video processing is listed under VAProfileNone.
            for p in profiles {
                let mut entrypoints = vec![0; max_e];
                let mut n = 0;
                let status =
                    (a.query_config_entrypoints)(self.display, p, entrypoints.as_mut_ptr(), &mut n);
                if status == VA_STATUS_SUCCESS {
                    entrypoints.truncate((n.max(0) as usize).min(max_e));
                    out.push((p, entrypoints));
                }
            }
            Ok(out)
        }
    }

    fn has_encoder(&self) -> bool {
        self.profiles().is_ok_and(|listed| {
            [media_codec::Codec::H264, media_codec::Codec::Hevc]
                .iter()
                .any(|c| !select::encode_candidates(*c, &listed).is_empty())
        })
    }

    /// Attribute values for `types`; [`select::ATTRIB_NOT_SUPPORTED`] where absent.
    pub fn attributes(
        &self,
        profile: i32,
        entrypoint: i32,
        types: &[i32],
    ) -> Result<Vec<u32>, CodecError> {
        let mut attribs: Vec<VAConfigAttrib> = types
            .iter()
            .map(|t| VAConfigAttrib {
                type_: *t,
                value: 0,
            })
            .collect();
        let _g = self.guard();
        // SAFETY: an initialised display and an array of `len` attributes.
        let status = unsafe {
            (self.api.get_config_attributes)(
                self.display,
                profile,
                entrypoint,
                attribs.as_mut_ptr(),
                attribs.len() as c_int,
            )
        };
        self.check(status, "vaGetConfigAttributes")?;
        Ok(attribs.iter().map(|a| a.value).collect())
    }

    pub fn create_config(
        self: &Arc<Self>,
        profile: i32,
        entrypoint: i32,
        attribs: &[(i32, u32)],
    ) -> Result<Config, CodecError> {
        let mut list: Vec<VAConfigAttrib> = attribs
            .iter()
            .map(|(t, v)| VAConfigAttrib {
                type_: *t,
                value: *v,
            })
            .collect();
        let mut id = VA_INVALID_ID;
        let _g = self.guard();
        // SAFETY: an initialised display, an attribute array and an out-parameter.
        let status = unsafe {
            (self.api.create_config)(
                self.display,
                profile,
                entrypoint,
                list.as_mut_ptr(),
                list.len() as c_int,
                &mut id,
            )
        };
        self.check(status, "vaCreateConfig")?;
        Ok(Config {
            device: Arc::clone(self),
            id,
        })
    }

    /// The surface attributes a config accepts (formats, sizes, memory types).
    pub fn surface_attributes(&self, config: &Config) -> Result<Vec<VASurfaceAttrib>, CodecError> {
        let _g = self.guard();
        let mut count: c_uint = 0;
        // SAFETY: the two-call protocol of vaQuerySurfaceAttributes: count first, then fill.
        unsafe {
            self.check(
                (self.api.query_surface_attributes)(
                    self.display,
                    config.id,
                    std::ptr::null_mut(),
                    &mut count,
                ),
                "vaQuerySurfaceAttributes",
            )?;
            let mut list = vec![VASurfaceAttrib::empty(); count as usize];
            self.check(
                (self.api.query_surface_attributes)(
                    self.display,
                    config.id,
                    list.as_mut_ptr(),
                    &mut count,
                ),
                "vaQuerySurfaceAttributes",
            )?;
            list.truncate(count as usize);
            Ok(list)
        }
    }

    /// Creates `count` surfaces. `attribs` beyond the pixel format (an external buffer, for
    /// DMA-BUF import) are passed as given.
    pub(crate) fn create_surfaces(
        &self,
        format: SurfaceFormat,
        size: Size,
        count: usize,
        attribs: &mut Vec<VASurfaceAttrib>,
    ) -> Result<Vec<VASurfaceID>, CodecError> {
        attribs.push(VASurfaceAttrib::int(
            surface_attrib::PIXEL_FORMAT,
            format.va_fourcc as i32,
        ));
        let mut ids = vec![VA_INVALID_SURFACE; count];
        let _g = self.guard();
        // SAFETY: an initialised display, an out-array of `count` ids and an attribute
        // array whose pointers (if any) outlive the call.
        let status = unsafe {
            (self.api.create_surfaces)(
                self.display,
                format.rt_format,
                size.width,
                size.height,
                ids.as_mut_ptr(),
                count as c_uint,
                attribs.as_mut_ptr(),
                attribs.len() as c_uint,
            )
        };
        self.check(status, "vaCreateSurfaces")?;
        Ok(ids)
    }

    pub(crate) fn destroy_surface(&self, mut id: VASurfaceID) {
        let _g = self.guard();
        // SAFETY: a surface this device created and nothing else references.
        unsafe { (self.api.destroy_surfaces)(self.display, &mut id, 1) };
    }

    pub fn create_context(
        self: &Arc<Self>,
        config: &Config,
        size: Size,
        targets: &mut [VASurfaceID],
    ) -> Result<Context, CodecError> {
        let mut id = VA_INVALID_ID;
        let _g = self.guard();
        // SAFETY: an initialised display, a config of this display and its surfaces.
        let status = unsafe {
            (self.api.create_context)(
                self.display,
                config.id,
                size.width as c_int,
                size.height as c_int,
                VA_PROGRESSIVE,
                if targets.is_empty() {
                    std::ptr::null_mut()
                } else {
                    targets.as_mut_ptr()
                },
                targets.len() as c_int,
                &mut id,
            )
        };
        self.check(status, "vaCreateContext")?;
        Ok(Context {
            device: Arc::clone(self),
            id,
        })
    }

    /// A buffer holding one `T` (a VA parameter struct).
    pub fn param<T: Copy>(
        self: &Arc<Self>,
        context: &Context,
        kind: i32,
        value: &T,
    ) -> Result<Buffer, CodecError> {
        self.buffer(
            context,
            kind,
            std::mem::size_of::<T>(),
            1,
            (value as *const T).cast_mut().cast(),
        )
    }

    /// A buffer holding `bytes` (packed header data, JPEG scan data).
    pub fn data(
        self: &Arc<Self>,
        context: &Context,
        kind: i32,
        bytes: &[u8],
    ) -> Result<Buffer, CodecError> {
        self.buffer(
            context,
            kind,
            bytes.len(),
            1,
            bytes.as_ptr().cast_mut().cast(),
        )
    }

    /// An uninitialised buffer of `size` bytes (the coded buffer).
    pub fn empty(
        self: &Arc<Self>,
        context: &Context,
        kind: i32,
        size: usize,
    ) -> Result<Buffer, CodecError> {
        self.buffer(context, kind, size, 1, std::ptr::null_mut())
    }

    /// A misc parameter buffer: `VAEncMiscParameterBuffer`'s type word followed by `T`.
    pub fn misc<T: Copy>(
        self: &Arc<Self>,
        context: &Context,
        misc_type: u32,
        value: &T,
    ) -> Result<Buffer, CodecError> {
        let size = 4 + std::mem::size_of::<T>();
        let buffer = self.empty(context, buffer::ENC_MISC_PARAMETER, size)?;
        let p = self.map(&buffer)?;
        // SAFETY: the mapping is `size` bytes; the type word is followed by the payload,
        // both written unaligned-safe.
        unsafe {
            std::ptr::write_unaligned(p.cast::<u32>(), misc_type);
            std::ptr::write_unaligned(p.cast::<u8>().add(4).cast::<T>(), *value);
        }
        self.unmap(&buffer)?;
        Ok(buffer)
    }

    fn buffer(
        self: &Arc<Self>,
        context: &Context,
        kind: i32,
        size: usize,
        count: usize,
        data: *mut c_void,
    ) -> Result<Buffer, CodecError> {
        let mut id = VA_INVALID_ID;
        let _g = self.guard();
        // SAFETY: `data` is null or points at `size` readable bytes for the call.
        let status = unsafe {
            (self.api.create_buffer)(
                self.display,
                context.id,
                kind,
                size as c_uint,
                count as c_uint,
                data,
                &mut id,
            )
        };
        self.check(status, "vaCreateBuffer")?;
        Ok(Buffer {
            device: Arc::clone(self),
            id,
        })
    }

    pub(crate) fn map(&self, buffer: &Buffer) -> Result<*mut c_void, CodecError> {
        self.map_id(buffer.id)
    }

    pub(crate) fn map_id(&self, id: VABufferID) -> Result<*mut c_void, CodecError> {
        let mut p = std::ptr::null_mut();
        let _g = self.guard();
        // SAFETY: a buffer of this display and an out-pointer.
        let status = unsafe { (self.api.map_buffer)(self.display, id, &mut p) };
        self.check(status, "vaMapBuffer")?;
        if p.is_null() {
            return Err(CodecError::Backend("vaMapBuffer gave no memory".into()));
        }
        Ok(p)
    }

    pub(crate) fn unmap(&self, buffer: &Buffer) -> Result<(), CodecError> {
        self.unmap_id(buffer.id)
    }

    pub(crate) fn unmap_id(&self, id: VABufferID) -> Result<(), CodecError> {
        let _g = self.guard();
        // SAFETY: a mapped buffer of this display.
        let status = unsafe { (self.api.unmap_buffer)(self.display, id) };
        self.check(status, "vaUnmapBuffer")
    }

    /// `vaBeginPicture`, `vaRenderPicture` with `buffers`, `vaEndPicture`.
    pub fn submit(
        &self,
        context: &Context,
        target: VASurfaceID,
        buffers: &[&Buffer],
    ) -> Result<(), CodecError> {
        let mut ids: Vec<VABufferID> = buffers.iter().map(|b| b.id).collect();
        let _g = self.guard();
        let a = &self.api;
        // SAFETY: a context and surface of this display, and buffer ids that stay alive
        // (borrowed) until after vaEndPicture.
        unsafe {
            self.check(
                (a.begin_picture)(self.display, context.id, target),
                "vaBeginPicture",
            )?;
            let rendered = self.check(
                (a.render_picture)(
                    self.display,
                    context.id,
                    ids.as_mut_ptr(),
                    ids.len() as c_int,
                ),
                "vaRenderPicture",
            );
            let ended = self.check((a.end_picture)(self.display, context.id), "vaEndPicture");
            rendered.and(ended)
        }
    }

    pub fn sync(&self, surface: VASurfaceID) -> Result<(), CodecError> {
        let _g = self.guard();
        // SAFETY: a surface of this display.
        let status = unsafe { (self.api.sync_surface)(self.display, surface) };
        self.check(status, "vaSyncSurface")
    }

    /// Copies a coded buffer's segments into `out`.
    pub fn read_coded(&self, buffer: &Buffer, out: &mut Vec<u8>) -> Result<(), CodecError> {
        let first = self.map(buffer)?;
        let mut segment = first.cast::<VACodedBufferSegment>();
        let mut guard_count = 0;
        // SAFETY: a mapped coded buffer is a linked list of segments, each pointing at
        // `size` bytes, valid until unmapped.
        let copied = unsafe {
            while !segment.is_null() && guard_count < 64 {
                let s = std::ptr::read_unaligned(segment);
                if !s.buf.is_null() && s.size > 0 {
                    out.extend_from_slice(std::slice::from_raw_parts(
                        s.buf.cast::<u8>(),
                        s.size as usize,
                    ));
                }
                segment = s.next.cast();
                guard_count += 1;
            }
            Ok(())
        };
        self.unmap(buffer)?;
        copied
    }

    pub(crate) fn create_image(
        &self,
        format: &VAImageFormat,
        size: Size,
    ) -> Result<VAImage, CodecError> {
        let mut f = *format;
        let mut image = VAImage::default();
        let _g = self.guard();
        // SAFETY: an image format and an out-parameter.
        let status = unsafe {
            (self.api.create_image)(
                self.display,
                &mut f,
                size.width as c_int,
                size.height as c_int,
                &mut image,
            )
        };
        self.check(status, "vaCreateImage")?;
        Ok(image)
    }

    pub(crate) fn destroy_image(&self, image: &VAImage) {
        let _g = self.guard();
        // SAFETY: an image this device created.
        unsafe { (self.api.destroy_image)(self.display, image.image_id) };
    }

    pub(crate) fn put_image(
        &self,
        surface: VASurfaceID,
        image: &VAImage,
        size: Size,
    ) -> Result<(), CodecError> {
        let (w, h) = (size.width, size.height);
        let _g = self.guard();
        // SAFETY: a surface and an image of this display, both at least `size`.
        let status = unsafe {
            (self.api.put_image)(
                self.display,
                surface,
                image.image_id,
                0,
                0,
                w,
                h,
                0,
                0,
                w,
                h,
            )
        };
        self.check(status, "vaPutImage")
    }

    pub(crate) fn get_image(
        &self,
        surface: VASurfaceID,
        image: &VAImage,
        size: Size,
    ) -> Result<(), CodecError> {
        let _g = self.guard();
        // SAFETY: a surface and an image of this display, both at least `size`.
        let status = unsafe {
            (self.api.get_image)(
                self.display,
                surface,
                0,
                0,
                size.width,
                size.height,
                image.image_id,
            )
        };
        self.check(status, "vaGetImage")
    }

    fn destroy_buffer(&self, id: VABufferID) {
        let _g = self.guard();
        // SAFETY: a buffer this device created.
        unsafe { (self.api.destroy_buffer)(self.display, id) };
    }

    fn destroy_context(&self, id: VAContextID) {
        let _g = self.guard();
        // SAFETY: a context this device created.
        unsafe { (self.api.destroy_context)(self.display, id) };
    }

    fn destroy_config(&self, id: VAConfigID) {
        let _g = self.guard();
        // SAFETY: a config this device created.
        unsafe { (self.api.destroy_config)(self.display, id) };
    }
}

impl Drop for Device {
    fn drop(&mut self) {
        // SAFETY: every resource holds an Arc to this device, so none outlives the display.
        unsafe { (self.api.terminate)(self.display) };
    }
}

fn status_text(api: &Api, status: VAStatus) -> String {
    // SAFETY: vaErrorStr returns a static string for any status.
    let text = unsafe {
        let p = (api.error_str)(status);
        if p.is_null() {
            String::new()
        } else {
            CStr::from_ptr(p).to_string_lossy().into_owned()
        }
    };
    format!("{text} ({status:#x})")
}

pub struct Config {
    device: Arc<Device>,
    pub(crate) id: VAConfigID,
}

impl Drop for Config {
    fn drop(&mut self) {
        self.device.destroy_config(self.id);
    }
}

pub struct Context {
    device: Arc<Device>,
    pub(crate) id: VAContextID,
}

impl Drop for Context {
    fn drop(&mut self) {
        self.device.destroy_context(self.id);
    }
}

pub struct Buffer {
    device: Arc<Device>,
    pub(crate) id: VABufferID,
}

impl Drop for Buffer {
    fn drop(&mut self) {
        self.device.destroy_buffer(self.id);
    }
}

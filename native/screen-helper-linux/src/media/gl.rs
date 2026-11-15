//! NVIDIA's path into NVENC (docs/media/plan.md, "Helper changes > Linux" item 6): a surfaceless
//! OpenGL context on the NVIDIA EGL device, PipeWire's DMA-BUF imported as an `EGLImage`
//! (`EGL_EXT_image_dma_buf_import`) and bound to a texture, and one framebuffer blit that crops
//! and scales it into the texture NVENC encodes. A shared-memory picture is uploaded once
//! instead. Written from the EGL 1.5 specification and the `EGL_EXT_device_enumeration`,
//! `EGL_EXT_platform_device`, `EGL_KHR_surfaceless_context`, `EGL_KHR_no_config_context`,
//! `EGL_EXT_image_dma_buf_import(_modifiers)` and `GL_OES_EGL_image` extensions.
//!
//! `libEGL.so.1` is opened at run time; every GL entry point comes from `eglGetProcAddress`.
//! The context is current on the thread that made it, which is the capture thread: every call
//! here, and NVENC's, runs there.
#![allow(unsafe_code)]
use media_codec::{CodecError, CpuPicture, PixelFormat, Plane, Size};
use std::ffi::{CStr, c_char, c_void};
use std::os::fd::{AsRawFd, BorrowedFd};

type Display = *mut c_void;
type Context = *mut c_void;
type Image = *mut c_void;
type Attrib = isize;

const EGL_NONE: i32 = 0x3038;
const EGL_VENDOR: i32 = 0x3053;
const EGL_EXTENSIONS: i32 = 0x3055;
const EGL_OPENGL_API: u32 = 0x30A2;
const EGL_PLATFORM_DEVICE: u32 = 0x313F;
const EGL_CONTEXT_MAJOR_VERSION: i32 = 0x3098;
const EGL_CONTEXT_MINOR_VERSION: i32 = 0x30FB;
const EGL_LINUX_DMA_BUF: u32 = 0x3270;
const EGL_WIDTH: i32 = 0x3057;
const EGL_HEIGHT: i32 = 0x3056;
const EGL_LINUX_DRM_FOURCC: i32 = 0x3271;
const EGL_PLANE0_FD: i32 = 0x3272;
const EGL_PLANE0_OFFSET: i32 = 0x3273;
const EGL_PLANE0_PITCH: i32 = 0x3274;
const EGL_PLANE0_MODIFIER_LO: i32 = 0x3443;
const EGL_PLANE0_MODIFIER_HI: i32 = 0x3444;

pub const GL_TEXTURE_2D: u32 = 0x0DE1;
const GL_TEXTURE_MIN_FILTER: u32 = 0x2801;
const GL_TEXTURE_MAG_FILTER: u32 = 0x2800;
const GL_LINEAR: i32 = 0x2601;
const GL_RGBA8: i32 = 0x8058;
const GL_RGBA: u32 = 0x1908;
const GL_BGRA: u32 = 0x80E1;
const GL_UNSIGNED_BYTE: u32 = 0x1401;
const GL_READ_FRAMEBUFFER: u32 = 0x8CA8;
const GL_DRAW_FRAMEBUFFER: u32 = 0x8CA9;
const GL_COLOR_ATTACHMENT0: u32 = 0x8CE0;
const GL_FRAMEBUFFER_COMPLETE: u32 = 0x8CD5;
const GL_COLOR_BUFFER_BIT: u32 = 0x4000;
const GL_UNPACK_ROW_LENGTH: u32 = 0x0CF2;
const GL_PACK_ROW_LENGTH: u32 = 0x0D02;

macro_rules! table {
    ($name:ident { $($field:ident: fn($($arg:ty),*) $(-> $ret:ty)? = $sym:literal,)* }) => {
        struct $name { $($field: unsafe extern "C" fn($($arg),*) $(-> $ret)?,)* }
        impl $name {
            /// Every entry point, from `eglGetProcAddress`; `None` if one is missing.
            fn resolve(get: unsafe extern "C" fn(*const c_char) -> *mut c_void) -> Option<Self> {
                Some(Self { $($field: {
                    // SAFETY: `eglGetProcAddress` takes a NUL-terminated name.
                    let p = unsafe { get(concat!($sym, "\0").as_ptr().cast()) };
                    if p.is_null() { return None; }
                    // SAFETY: the symbol is the Khronos entry point with exactly this signature.
                    unsafe { std::mem::transmute::<*mut c_void, unsafe extern "C" fn($($arg),*) $(-> $ret)?>(p) }
                },)* })
            }
        }
    };
}

table!(Egl {
    query_devices: fn(i32, *mut *mut c_void, *mut i32) -> u32 = "eglQueryDevicesEXT",
    platform_display: fn(u32, *mut c_void, *const Attrib) -> Display = "eglGetPlatformDisplay",
    initialize: fn(Display, *mut i32, *mut i32) -> u32 = "eglInitialize",
    terminate: fn(Display) -> u32 = "eglTerminate",
    query_string: fn(Display, i32) -> *const c_char = "eglQueryString",
    bind_api: fn(u32) -> u32 = "eglBindAPI",
    create_context: fn(Display, *mut c_void, Context, *const i32) -> Context = "eglCreateContext",
    destroy_context: fn(Display, Context) -> u32 = "eglDestroyContext",
    make_current: fn(Display, *mut c_void, *mut c_void, Context) -> u32 = "eglMakeCurrent",
    create_image: fn(Display, Context, u32, *mut c_void, *const Attrib) -> Image = "eglCreateImage",
    destroy_image: fn(Display, Image) -> u32 = "eglDestroyImage",
});

table!(Gl {
    gen_textures: fn(i32, *mut u32) = "glGenTextures",
    delete_textures: fn(i32, *const u32) = "glDeleteTextures",
    bind_texture: fn(u32, u32) = "glBindTexture",
    tex_parameter: fn(u32, u32, i32) = "glTexParameteri",
    tex_image: fn(u32, i32, i32, i32, i32, i32, u32, u32, *const c_void) = "glTexImage2D",
    tex_sub_image: fn(u32, i32, i32, i32, i32, i32, u32, u32, *const c_void) = "glTexSubImage2D",
    image_target: fn(u32, Image) = "glEGLImageTargetTexture2DOES",
    gen_framebuffers: fn(i32, *mut u32) = "glGenFramebuffers",
    delete_framebuffers: fn(i32, *const u32) = "glDeleteFramebuffers",
    bind_framebuffer: fn(u32, u32) = "glBindFramebuffer",
    framebuffer_texture: fn(u32, u32, u32, u32, i32) = "glFramebufferTexture2D",
    check_framebuffer: fn(u32) -> u32 = "glCheckFramebufferStatus",
    blit: fn(i32, i32, i32, i32, i32, i32, i32, i32, u32, u32) = "glBlitFramebuffer",
    pixel_store: fn(u32, i32) = "glPixelStorei",
    read_pixels: fn(i32, i32, i32, i32, u32, u32, *mut c_void) = "glReadPixels",
    finish: fn() = "glFinish",
});

/// A texture this context made; deleted with it.
struct Texture {
    id: u32,
    size: Size,
}

/// The context, its framebuffers and the texture NVENC reads.
pub struct GlImporter {
    _library: libloading::Library,
    egl: Egl,
    gl: Gl,
    display: Display,
    context: Context,
    read: u32,
    draw: u32,
    /// A shared-memory picture's upload target, at the buffer's size.
    upload: Option<Texture>,
    /// What NVENC encodes, at the encode size.
    output: Option<Texture>,
}

fn failed(what: &str) -> CodecError {
    CodecError::Backend(format!("GL: {what}"))
}

/// A DMA-BUF's one plane, as PipeWire handed it over.
pub struct DmaPlane<'fd> {
    pub fd: BorrowedFd<'fd>,
    pub offset: u32,
    pub stride: u32,
    pub drm_format: u32,
    pub modifier: u64,
}

impl GlImporter {
    /// A context on the first EGL device whose vendor is NVIDIA. `Unsupported` anywhere else.
    pub fn open() -> Result<Self, CodecError> {
        // SAFETY: loading runs libEGL's initialisers, which only set up its own state.
        let library = unsafe { libloading::Library::new("libEGL.so.1") }
            .map_err(|e| CodecError::Unsupported(format!("no libEGL: {e}")))?;
        // SAFETY: `eglGetProcAddress` has this signature in EGL 1.5.
        let get: unsafe extern "C" fn(*const c_char) -> *mut c_void =
            *unsafe { library.get(b"eglGetProcAddress\0") }
                .map_err(|_| failed("no eglGetProcAddress"))?;
        let egl = Egl::resolve(get)
            .ok_or_else(|| CodecError::Unsupported("EGL lacks device or dma-buf import".into()))?;
        let gl = Gl::resolve(get).ok_or_else(|| failed("missing GL entry points"))?;
        let mut devices = [std::ptr::null_mut(); 8];
        let mut count = 0;
        // SAFETY: the array holds 8 entries.
        if unsafe { (egl.query_devices)(8, devices.as_mut_ptr(), &mut count) } == 0 {
            return Err(CodecError::Unsupported("no EGL devices".into()));
        }
        for device in devices.iter().take(count.max(0) as usize) {
            let none = [EGL_NONE as Attrib];
            // SAFETY: a device from eglQueryDevicesEXT and an empty attribute list.
            let display =
                unsafe { (egl.platform_display)(EGL_PLATFORM_DEVICE, *device, none.as_ptr()) };
            if display.is_null() {
                continue;
            }
            let (mut major, mut minor) = (0, 0);
            // SAFETY: a display from eglGetPlatformDisplay.
            if unsafe { (egl.initialize)(display, &mut major, &mut minor) } == 0 {
                continue;
            }
            let text = |name| {
                // SAFETY: eglQueryString returns a static NUL-terminated string or null.
                let p = unsafe { (egl.query_string)(display, name) };
                (!p.is_null()).then(|| unsafe { CStr::from_ptr(p) }.to_string_lossy().into_owned())
            };
            let nvidia = text(EGL_VENDOR).is_some_and(|v| v.contains("NVIDIA"));
            let extensions = text(EGL_EXTENSIONS).unwrap_or_default();
            if !nvidia
                || !extensions.contains("EGL_EXT_image_dma_buf_import")
                || !extensions.contains("EGL_KHR_surfaceless_context")
            {
                // SAFETY: initialised above.
                unsafe { (egl.terminate)(display) };
                continue;
            }
            return Self::on(library, egl, gl, display);
        }
        Err(CodecError::Unsupported("no NVIDIA EGL device".into()))
    }

    fn on(
        library: libloading::Library,
        egl: Egl,
        gl: Gl,
        display: Display,
    ) -> Result<Self, CodecError> {
        let attributes = [
            EGL_CONTEXT_MAJOR_VERSION,
            3,
            EGL_CONTEXT_MINOR_VERSION,
            3,
            EGL_NONE,
        ];
        // SAFETY: an initialised display; no config (EGL_KHR_no_config_context), no share.
        let context = unsafe {
            (egl.bind_api)(EGL_OPENGL_API);
            (egl.create_context)(
                display,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                attributes.as_ptr(),
            )
        };
        // SAFETY: surfaceless current context (EGL_KHR_surfaceless_context).
        if context.is_null()
            || unsafe {
                (egl.make_current)(display, std::ptr::null_mut(), std::ptr::null_mut(), context)
            } == 0
        {
            // SAFETY: initialised above.
            unsafe { (egl.terminate)(display) };
            return Err(failed("no OpenGL context"));
        }
        let mut fbs = [0u32; 2];
        // SAFETY: the context is current; two names are written.
        unsafe { (gl.gen_framebuffers)(2, fbs.as_mut_ptr()) };
        Ok(Self {
            _library: library,
            egl,
            gl,
            display,
            context,
            read: fbs[0],
            draw: fbs[1],
            upload: None,
            output: None,
        })
    }

    fn texture(&self, size: Size) -> Texture {
        let mut id = 0;
        // SAFETY: the context is current; the storage is allocated by GL, nothing is read.
        unsafe {
            (self.gl.gen_textures)(1, &mut id);
            (self.gl.bind_texture)(GL_TEXTURE_2D, id);
            (self.gl.tex_parameter)(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
            (self.gl.tex_parameter)(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
            (self.gl.tex_image)(
                GL_TEXTURE_2D,
                0,
                GL_RGBA8,
                size.width as i32,
                size.height as i32,
                0,
                GL_RGBA,
                GL_UNSIGNED_BYTE,
                std::ptr::null(),
            );
        }
        Texture { id, size }
    }

    fn drop_texture(&self, texture: Texture) {
        // SAFETY: a texture this context made.
        unsafe { (self.gl.delete_textures)(1, &texture.id) };
    }

    /// The output texture at `size`, made or remade.
    fn output(&mut self, size: Size) -> u32 {
        if self.output.as_ref().is_none_or(|t| t.size != size) {
            if let Some(old) = self.output.take() {
                self.drop_texture(old);
            }
            self.output = Some(self.texture(size));
        }
        self.output.as_ref().map_or(0, |t| t.id)
    }

    /// Crops `region` of `source` and scales it into the output texture, which it returns.
    fn blit(
        &mut self,
        source: u32,
        region: (u32, u32, u32, u32),
        size: Size,
    ) -> Result<u32, CodecError> {
        let output = self.output(size);
        let (left, top, width, height) = region;
        // SAFETY: the context is current; both textures are complete RGBA textures of it.
        unsafe {
            (self.gl.bind_framebuffer)(GL_READ_FRAMEBUFFER, self.read);
            (self.gl.framebuffer_texture)(
                GL_READ_FRAMEBUFFER,
                GL_COLOR_ATTACHMENT0,
                GL_TEXTURE_2D,
                source,
                0,
            );
            (self.gl.bind_framebuffer)(GL_DRAW_FRAMEBUFFER, self.draw);
            (self.gl.framebuffer_texture)(
                GL_DRAW_FRAMEBUFFER,
                GL_COLOR_ATTACHMENT0,
                GL_TEXTURE_2D,
                output,
                0,
            );
            if (self.gl.check_framebuffer)(GL_READ_FRAMEBUFFER) != GL_FRAMEBUFFER_COMPLETE
                || (self.gl.check_framebuffer)(GL_DRAW_FRAMEBUFFER) != GL_FRAMEBUFFER_COMPLETE
            {
                return Err(failed("incomplete framebuffer"));
            }
            // Rows keep their memory order (row 0 first), so nothing is flipped.
            (self.gl.blit)(
                left as i32,
                top as i32,
                (left + width) as i32,
                (top + height) as i32,
                0,
                0,
                size.width as i32,
                size.height as i32,
                GL_COLOR_BUFFER_BIT,
                GL_LINEAR as u32,
            );
            (self.gl.finish)();
        }
        Ok(output)
    }

    /// A DMA-BUF's region scaled into the output texture: no CPU copy.
    pub fn import(
        &mut self,
        plane: &DmaPlane<'_>,
        buffer: Size,
        region: (u32, u32, u32, u32),
        size: Size,
    ) -> Result<u32, CodecError> {
        let attributes: [Attrib; 17] = [
            EGL_WIDTH as Attrib,
            buffer.width as Attrib,
            EGL_HEIGHT as Attrib,
            buffer.height as Attrib,
            EGL_LINUX_DRM_FOURCC as Attrib,
            plane.drm_format as Attrib,
            EGL_PLANE0_FD as Attrib,
            plane.fd.as_raw_fd() as Attrib,
            EGL_PLANE0_OFFSET as Attrib,
            plane.offset as Attrib,
            EGL_PLANE0_PITCH as Attrib,
            plane.stride as Attrib,
            EGL_PLANE0_MODIFIER_LO as Attrib,
            (plane.modifier & 0xffff_ffff) as Attrib,
            EGL_PLANE0_MODIFIER_HI as Attrib,
            (plane.modifier >> 32) as Attrib,
            EGL_NONE as Attrib,
        ];
        // SAFETY: a current display; the fd is open for the call (EGL dups what it keeps).
        let image = unsafe {
            (self.egl.create_image)(
                self.display,
                std::ptr::null_mut(),
                EGL_LINUX_DMA_BUF,
                std::ptr::null_mut(),
                attributes.as_ptr(),
            )
        };
        if image.is_null() {
            return Err(failed("the DMA-BUF didn't import"));
        }
        let source = Texture {
            id: 0,
            size: buffer,
        };
        let mut id = 0;
        // SAFETY: the image is valid until destroyed below; the texture is bound to it.
        unsafe {
            (self.gl.gen_textures)(1, &mut id);
            (self.gl.bind_texture)(GL_TEXTURE_2D, id);
            (self.gl.image_target)(GL_TEXTURE_2D, image);
        }
        let result = self.blit(id, region, size);
        self.drop_texture(Texture { id, ..source });
        // SAFETY: made above; the blit finished (glFinish), so nothing reads it any more.
        unsafe { (self.egl.destroy_image)(self.display, image) };
        result
    }

    /// A shared-memory region uploaded once, then scaled into the output texture.
    pub fn upload(
        &mut self,
        bytes: &[u8],
        stride: usize,
        format: PixelFormat,
        buffer: Size,
        region: (u32, u32, u32, u32),
        size: Size,
    ) -> Result<u32, CodecError> {
        let layout = match format {
            PixelFormat::Bgra8 => GL_BGRA,
            PixelFormat::Rgba8 => GL_RGBA,
            _ => return Err(CodecError::Unsupported("GL upload of this format".into())),
        };
        if bytes.len() < stride * buffer.height as usize || stride < buffer.width as usize * 4 {
            return Err(CodecError::InvalidInput(
                "buffer smaller than its size".into(),
            ));
        }
        if self.upload.as_ref().is_none_or(|t| t.size != buffer) {
            if let Some(old) = self.upload.take() {
                self.drop_texture(old);
            }
            self.upload = Some(self.texture(buffer));
        }
        let id = self.upload.as_ref().map_or(0, |t| t.id);
        // SAFETY: `bytes` holds `stride × height`, checked above; the row length is in pixels.
        unsafe {
            (self.gl.bind_texture)(GL_TEXTURE_2D, id);
            (self.gl.pixel_store)(GL_UNPACK_ROW_LENGTH, (stride / 4) as i32);
            (self.gl.tex_sub_image)(
                GL_TEXTURE_2D,
                0,
                0,
                0,
                buffer.width as i32,
                buffer.height as i32,
                layout,
                GL_UNSIGNED_BYTE,
                bytes.as_ptr().cast(),
            );
            (self.gl.pixel_store)(GL_UNPACK_ROW_LENGTH, 0);
        }
        self.blit(id, region, size)
    }

    /// The output texture read back once, for a still: BGRA.
    pub fn read_output(&self) -> Result<CpuPicture, CodecError> {
        let output = self
            .output
            .as_ref()
            .ok_or_else(|| failed("nothing encoded yet"))?;
        let size = output.size;
        let mut data = vec![0u8; size.width as usize * size.height as usize * 4];
        // SAFETY: the buffer holds width × height BGRA pixels.
        unsafe {
            (self.gl.bind_framebuffer)(GL_READ_FRAMEBUFFER, self.draw);
            (self.gl.pixel_store)(GL_PACK_ROW_LENGTH, 0);
            (self.gl.read_pixels)(
                0,
                0,
                size.width as i32,
                size.height as i32,
                GL_BGRA,
                GL_UNSIGNED_BYTE,
                data.as_mut_ptr().cast(),
            );
        }
        CpuPicture::new(
            size,
            PixelFormat::Bgra8,
            [Plane {
                data,
                stride: size.width as usize * 4,
            }],
            0,
        )
    }
}

impl Drop for GlImporter {
    fn drop(&mut self) {
        for texture in [self.upload.take(), self.output.take()]
            .into_iter()
            .flatten()
        {
            self.drop_texture(texture);
        }
        // SAFETY: everything below was made by this context, which is still current here.
        unsafe {
            let fbs = [self.read, self.draw];
            (self.gl.delete_framebuffers)(2, fbs.as_ptr());
            (self.egl.make_current)(
                self.display,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            );
            (self.egl.destroy_context)(self.display, self.context);
            (self.egl.terminate)(self.display);
        }
    }
}

//! One screen's H.264 encoder: VA-API, NVENC on GL textures, or the last-resort Chrome encoder,
//! fed straight from the PipeWire callback. DMA-BUFs go to the GPU untouched; shared memory is
//! uploaded once (VA-API, NVENC) or scaled on the CPU (the last resort). Its output is the
//! Annex B the daemon's viewers take.
use super::gl::{DmaPlane, GL_TEXTURE_2D, GlImporter};
use super::pixels::{drm_format, pixel_format, region_picture};
use super::select::{Capture, DmaBufUse, dmabuf_use};
use super::stream::{StreamSettings, annex_b, encode_size, encode_spec};
use media_bitstream::avcc::AvcConfig;
use media_codec::{CodecError, EncodeSpec, Encoder, Picture, PlatformPicture, Scaler, Size};
use media_wire::capability::Backend;
use std::os::fd::BorrowedFd;
use std::sync::Arc;

/// A visible region of a buffer: left, top, width, height.
pub type Region = (u32, u32, u32, u32);

/// One picture as the callback has it, valid for the call only.
pub enum Input<'a> {
    Shared {
        bytes: &'a [u8],
        stride: usize,
    },
    DmaBuf {
        fd: BorrowedFd<'a>,
        offset: u32,
        stride: u32,
        modifier: u64,
    },
}

pub struct Captured<'a> {
    pub input: Input<'a>,
    /// `SPA_VIDEO_FORMAT_*`.
    pub format: u32,
    pub width: u32,
    pub height: u32,
    pub region: Region,
    pub pts_us: u64,
}

impl Captured<'_> {
    pub fn capture(&self) -> Capture {
        match self.input {
            Input::Shared { .. } => Capture::SharedMemory,
            Input::DmaBuf { .. } => Capture::DmaBuf,
        }
    }
}

/// One unit out: Annex B bytes, keyframe, codec string on keyframes, its picture's time and
/// coded size.
pub struct Output {
    pub data: Vec<u8>,
    pub key: bool,
    pub codec: Option<String>,
    pub pts_us: u64,
    pub size: Size,
}

// One engine per encoder, never moved: their sizes don't matter.
#[allow(clippy::large_enum_variant)]
enum Engine {
    Va {
        device: Arc<media_vaapi::Device>,
        encoder: media_vaapi::VaEncoder,
    },
    Nv {
        // Field order is drop order: the session goes before its GL context.
        encoder: Option<media_nv::NvEncoder>,
        gl: GlImporter,
        runtime: media_nv::NvRuntime,
    },
    Chrome {
        encoder: media_chrome::ChromeEncoder,
        scaler: media_codec::CpuScaler,
    },
}

pub struct ScreenEncoder {
    engine: Engine,
    spec: Option<EncodeSpec>,
    record: Option<AvcConfig>,
    backend: Backend,
}

impl ScreenEncoder {
    /// Opens `backend`'s encoder. Chrome needs the options its trial found.
    pub fn open(
        backend: Backend,
        chrome: Option<media_chrome::ChromeOptions>,
    ) -> Result<Self, CodecError> {
        let engine = match backend {
            Backend::Vaapi => {
                let device = media_vaapi::Device::open().map_err(CodecError::from)?;
                let encoder = media_vaapi::VaEncoder::new(&device)?;
                Engine::Va { device, encoder }
            }
            Backend::Nv => {
                let runtime = media_nv::NvRuntime::load()?;
                // The GL context is made current on this (the capture) thread.
                let gl = GlImporter::open()?;
                Engine::Nv {
                    encoder: None,
                    gl,
                    runtime,
                }
            }
            Backend::Chrome => {
                let options = chrome.ok_or_else(|| CodecError::Unsupported("no Chrome".into()))?;
                Engine::Chrome {
                    encoder: media_chrome::ChromeEncoder::new(options),
                    scaler: media_codec::CpuScaler::default(),
                }
            }
            _ => return Err(CodecError::Unsupported("not a screen encoder".into())),
        };
        Ok(Self {
            engine,
            spec: None,
            record: None,
            backend,
        })
    }

    pub fn backend(&self) -> Backend {
        self.backend
    }

    /// Whether this encoder takes DMA-BUFs (offered to PipeWire first when it does).
    pub fn imports_dmabuf(&self) -> bool {
        !matches!(self.engine, Engine::Chrome { .. })
    }

    fn configure(&mut self, spec: EncodeSpec) -> Result<(), CodecError> {
        if self.spec.as_ref() == Some(&spec) {
            return Ok(());
        }
        match &mut self.engine {
            Engine::Va { encoder, .. } => encoder.configure(&spec)?,
            Engine::Chrome { encoder, .. } => encoder.configure(&spec)?,
            Engine::Nv {
                encoder, runtime, ..
            } => {
                if encoder.is_none() {
                    *encoder = Some(media_nv::NvEncoder::open_gl(runtime, media_nv::Preset::P1)?);
                }
                if let Some(encoder) = encoder {
                    encoder.configure(&spec)?;
                }
            }
        }
        self.spec = Some(spec);
        Ok(())
    }

    /// Encodes one picture at the view's settings. `Backpressure` means it was skipped.
    pub fn encode(
        &mut self,
        picture: &Captured<'_>,
        settings: &StreamSettings,
        key: bool,
    ) -> Result<(), CodecError> {
        let (_, _, rw, rh) = picture.region;
        let size = encode_size(rw, rh, settings);
        self.configure(encode_spec(size, settings))?;
        let buffer = Size {
            width: picture.width,
            height: picture.height,
        };
        match (&mut self.engine, &picture.input) {
            (
                Engine::Va { device, encoder },
                Input::DmaBuf {
                    fd,
                    offset,
                    stride,
                    modifier,
                },
            ) => {
                // VPP is given the whole surface: a buffer with a crop would send what lies
                // outside the shared region. The capture moves such a stream to shared memory.
                if dmabuf_use(
                    Backend::Vaapi,
                    (picture.width, picture.height),
                    picture.region,
                ) != DmaBufUse::Encode
                {
                    return Err(CodecError::Unsupported(
                        "a cropped DMA-BUF on VA-API".into(),
                    ));
                }
                let drm = drm_format(picture.format)
                    .ok_or_else(|| CodecError::Unsupported("pixel format".into()))?;
                let surface = media_vaapi::Surface::import(
                    device,
                    &media_vaapi::DmaBuf {
                        size: buffer,
                        drm_format: drm,
                        objects: vec![media_vaapi::DmaBufObject {
                            fd: *fd,
                            size: 0,
                            modifier: *modifier,
                        }],
                        planes: vec![media_vaapi::DmaBufPlane {
                            object: 0,
                            offset: *offset,
                            pitch: *stride,
                        }],
                    },
                )?;
                encoder.encode(surface.into_picture(picture.pts_us), key)
            }
            (Engine::Va { encoder, .. }, Input::Shared { bytes, stride }) => {
                let cpu = region_picture(
                    bytes,
                    *stride,
                    picture.format,
                    picture.region,
                    picture.pts_us,
                )?;
                // One upload; VPP scales and converts it.
                encoder.encode(Picture::Cpu(cpu), key)
            }
            (Engine::Chrome { encoder, scaler }, Input::Shared { bytes, stride }) => {
                let cpu = region_picture(
                    bytes,
                    *stride,
                    picture.format,
                    picture.region,
                    picture.pts_us,
                )?;
                let mut scaled = scaler.scale(&Picture::Cpu(cpu), size.width, size.height)?;
                set_pts(&mut scaled, picture.pts_us);
                encoder.encode(scaled, key)
            }
            (Engine::Chrome { .. }, Input::DmaBuf { .. }) => Err(CodecError::Unsupported(
                "the last-resort encoder takes shared memory".into(),
            )),
            (Engine::Nv { encoder, gl, .. }, input) => {
                let texture = match input {
                    Input::DmaBuf {
                        fd,
                        offset,
                        stride,
                        modifier,
                    } => {
                        let drm = drm_format(picture.format)
                            .ok_or_else(|| CodecError::Unsupported("pixel format".into()))?;
                        gl.import(
                            &DmaPlane {
                                fd: *fd,
                                offset: *offset,
                                stride: *stride,
                                drm_format: drm,
                                modifier: *modifier,
                            },
                            buffer,
                            picture.region,
                            size,
                        )?
                    }
                    Input::Shared { bytes, stride } => {
                        let format = pixel_format(picture.format)
                            .ok_or_else(|| CodecError::Unsupported("pixel format".into()))?;
                        gl.upload(bytes, *stride, format, buffer, picture.region, size)?
                    }
                };
                let encoder = encoder.as_mut().ok_or(CodecError::NotConfigured)?;
                let surface = media_nv::GlTexture::new(texture, GL_TEXTURE_2D, Box::new(()));
                encoder.encode(
                    Picture::Platform(PlatformPicture {
                        size,
                        format: media_codec::PixelFormat::Rgba8,
                        pts_us: picture.pts_us,
                        surface: Box::new(surface),
                    }),
                    key,
                )
            }
        }
    }

    /// The next unit out, as Annex B. Units that can't be read are skipped.
    pub fn poll(&mut self) -> Result<Option<Output>, CodecError> {
        loop {
            let unit = match &mut self.engine {
                Engine::Va { encoder, .. } => encoder.poll_result()?,
                Engine::Chrome { encoder, .. } => encoder.poll_result()?,
                Engine::Nv { encoder, .. } => match encoder {
                    Some(encoder) => encoder.poll_result()?,
                    None => None,
                },
            };
            let Some(unit) = unit else { return Ok(None) };
            if let Some((data, codec)) = annex_b(&unit, &mut self.record) {
                return Ok(Some(Output {
                    data,
                    key: unit.key,
                    codec,
                    pts_us: unit.pts_us,
                    size: unit.size,
                }));
            }
        }
    }

    /// Whether units are still to come back (the last-resort encoder answers later).
    pub fn asynchronous(&self) -> bool {
        matches!(self.engine, Engine::Chrome { .. })
    }

    /// A still from a DMA-BUF capture: one readback, and whether it is already cropped to the
    /// picture's region. `None` where the encoder can't read one.
    pub fn read_back(&mut self, picture: &Captured<'_>) -> Option<(media_codec::CpuPicture, bool)> {
        let Input::DmaBuf {
            fd,
            offset,
            stride,
            modifier,
        } = &picture.input
        else {
            return None;
        };
        let drm = drm_format(picture.format)?;
        let buffer = Size {
            width: picture.width,
            height: picture.height,
        };
        match &mut self.engine {
            Engine::Va { device, .. } => {
                let surface = media_vaapi::Surface::import(
                    device,
                    &media_vaapi::DmaBuf {
                        size: buffer,
                        drm_format: drm,
                        objects: vec![media_vaapi::DmaBufObject {
                            fd: *fd,
                            size: 0,
                            modifier: *modifier,
                        }],
                        planes: vec![media_vaapi::DmaBufPlane {
                            object: 0,
                            offset: *offset,
                            pitch: *stride,
                        }],
                    },
                )
                .ok()?;
                Some((surface.read(picture.pts_us).ok()?, false))
            }
            Engine::Nv { gl, .. } => {
                let (_, _, w, h) = picture.region;
                let plane = DmaPlane {
                    fd: *fd,
                    offset: *offset,
                    stride: *stride,
                    drm_format: drm,
                    modifier: *modifier,
                };
                gl.import(
                    &plane,
                    buffer,
                    picture.region,
                    Size {
                        width: w / 2 * 2,
                        height: h / 2 * 2,
                    },
                )
                .ok()?;
                Some((gl.read_output().ok()?, true))
            }
            Engine::Chrome { .. } => None,
        }
    }

    /// Ends the stream; NVENC's GL session must be released on this thread.
    pub fn close(self) {
        if let Engine::Nv {
            encoder: Some(encoder),
            gl,
            runtime,
        } = self.engine
        {
            encoder.close();
            drop(gl);
            drop(runtime);
        }
    }
}

fn set_pts(picture: &mut Picture, pts: u64) {
    match picture {
        Picture::Cpu(p) => p.pts_us = pts,
        Picture::Platform(p) => p.pts_us = pts,
    }
}

// SPDX-License-Identifier: Apache-2.0
//! JPEG through WIC, on the CPU. Decode scales with WIC's scaler (which uses the JPEG
//! decoder's own DCT scaling where it can); encode writes into a reused buffer sized by
//! `jpeg_capacity`. Not hardware: the probe reports it as such.
use super::com::{Ctx, enter};
use super::surface::{MfSurface, Staging, read_back_with};
use crate::Copies;
use crate::color::to_bgr24;
use media_codec::*;
use windows::Win32::Foundation::HGLOBAL;
use windows::Win32::Graphics::Imaging::*;
use windows::Win32::System::Com::StructuredStorage::{
    CreateStreamOnHGlobal, IPropertyBag2, PROPBAG2,
};
use windows::Win32::System::Com::{
    CLSCTX_INPROC_SERVER, CoCreateInstance, STREAM_SEEK_CUR, STREAM_SEEK_SET,
};
use windows_core::{GUID, PWSTR};

pub struct WicJpeg {
    factory: IWICImagingFactory,
    bgr: Vec<u8>,
    staging: Staging,
    copies: Copies,
}
// SAFETY: The WIC factory and the objects made here are free-threaded in the MTA (`com.rs`).
unsafe impl Send for WicJpeg {}

impl WicJpeg {
    pub fn new() -> Result<Self, CodecError> {
        enter();
        // SAFETY: In-process WIC factory.
        let factory =
            unsafe { CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER) }
                .ctx("WIC factory")?;
        Ok(Self {
            factory,
            bgr: Vec::new(),
            staging: Staging::default(),
            copies: Copies::default(),
        })
    }

    pub fn last_copies(&self) -> Copies {
        self.copies
    }

    /// Decodes into BGRA at `target`, or at full size.
    fn decode_bgra(&mut self, jpeg: &[u8], target: Option<Size>) -> Result<CpuPicture, CodecError> {
        enter();
        if jpeg.len() > u32::MAX as usize {
            return Err(CodecError::InvalidInput("JPEG too large".into()));
        }
        // SAFETY: The stream reads `jpeg`, which outlives every WIC object made here.
        unsafe {
            let stream = self.factory.CreateStream().ctx("CreateStream")?;
            stream
                .InitializeFromMemory(jpeg)
                .ctx("InitializeFromMemory")?;
            let decoder = self
                .factory
                .CreateDecoderFromStream(&stream, std::ptr::null(), WICDecodeMetadataCacheOnDemand)
                .map_err(|e| CodecError::InvalidInput(format!("JPEG decode: {e}")))?;
            let frame = decoder
                .GetFrame(0)
                .map_err(|e| CodecError::InvalidInput(format!("JPEG frame: {e}")))?;
            let (mut w, mut h) = (0, 0);
            frame.GetSize(&mut w, &mut h).ctx("GetSize")?;
            Size {
                width: w,
                height: h,
            }
            .validate()?;
            let size = target.unwrap_or(Size {
                width: w,
                height: h,
            });
            size.validate()?;
            let source: IWICBitmapSource = if size.width != w || size.height != h {
                let scaler = self
                    .factory
                    .CreateBitmapScaler()
                    .ctx("CreateBitmapScaler")?;
                scaler
                    .Initialize(
                        &frame,
                        size.width,
                        size.height,
                        WICBitmapInterpolationModeFant,
                    )
                    .ctx("scaler")?;
                windows_core::Interface::cast(&scaler).ctx("scaler source")?
            } else {
                windows_core::Interface::cast(&frame).ctx("frame source")?
            };
            let converter = self
                .factory
                .CreateFormatConverter()
                .ctx("CreateFormatConverter")?;
            converter
                .Initialize(
                    &source,
                    &GUID_WICPixelFormat32bppBGRA,
                    WICBitmapDitherTypeNone,
                    None,
                    0.0,
                    WICBitmapPaletteTypeCustom,
                )
                .ctx("converter")?;
            let stride = size.width as usize * 4;
            let mut data = vec![0u8; stride * size.height as usize];
            converter
                .CopyPixels(std::ptr::null(), stride as u32, &mut data)
                .map_err(|e| CodecError::InvalidInput(format!("JPEG pixels: {e}")))?;
            CpuPicture::new(size, PixelFormat::Bgra8, [Plane { data, stride }], 0)
        }
    }

    fn encode_into(
        &mut self,
        picture: &CpuPicture,
        quality: u8,
        out: &mut Vec<u8>,
    ) -> Result<(), CodecError> {
        enter();
        if !(1..=100).contains(&quality) {
            return Err(CodecError::InvalidInput("quality outside 1..100".into()));
        }
        let size = picture.size();
        let stride = to_bgr24(picture, &mut self.bgr)?;
        // SAFETY: WIC writes into a COM memory stream it owns; the bytes are read back
        // into `out` below. The property bag gets one VT_R4 value under a NUL-terminated name.
        unsafe {
            let stream =
                CreateStreamOnHGlobal(HGLOBAL::default(), true).ctx("CreateStreamOnHGlobal")?;
            let encoder = self
                .factory
                .CreateEncoder(&GUID_ContainerFormatJpeg, std::ptr::null())
                .ctx("CreateEncoder")?;
            encoder
                .Initialize(&stream, WICBitmapEncoderNoCache)
                .ctx("encoder")?;
            let mut frame = None;
            let mut options: Option<IPropertyBag2> = None;
            encoder
                .CreateNewFrame(&mut frame, &mut options)
                .ctx("CreateNewFrame")?;
            let frame = frame.ok_or_else(|| CodecError::Backend("no frame".into()))?;
            if let Some(options) = &options {
                let mut name: Vec<u16> = "ImageQuality\0".encode_utf16().collect();
                let bag = PROPBAG2 {
                    pstrName: PWSTR(name.as_mut_ptr()),
                    ..Default::default()
                };
                let value = super::variant::f32(f32::from(quality) / 100.0);
                options.Write(1, &bag, &value).ctx("ImageQuality")?;
            }
            frame.Initialize(options.as_ref()).ctx("frame")?;
            frame.SetSize(size.width, size.height).ctx("SetSize")?;
            let mut format: GUID = GUID_WICPixelFormat24bppBGR;
            frame.SetPixelFormat(&mut format).ctx("SetPixelFormat")?;
            if format != GUID_WICPixelFormat24bppBGR {
                return Err(CodecError::Unsupported(
                    "WIC JPEG refused 24-bit BGR".into(),
                ));
            }
            frame
                .WritePixels(size.height, stride as u32, &self.bgr)
                .ctx("WritePixels")?;
            frame.Commit().ctx("frame commit")?;
            encoder.Commit().ctx("encoder commit")?;
            let mut written = 0u64;
            stream
                .Seek(0, STREAM_SEEK_CUR, Some(&mut written))
                .ctx("Seek")?;
            if written as usize > jpeg_capacity(size).max(1 << 16) {
                return Err(CodecError::Backend("JPEG larger than its bound".into()));
            }
            stream.Seek(0, STREAM_SEEK_SET, None).ctx("Seek")?;
            out.clear();
            out.resize(written as usize, 0);
            let mut read = 0u32;
            stream
                .Read(out.as_mut_ptr().cast(), written as u32, Some(&mut read))
                .ok()
                .ctx("Read")?;
            out.truncate(read as usize);
        }
        Ok(())
    }

    fn cpu_of(&mut self, picture: &Picture) -> Result<CpuPicture, CodecError> {
        match picture {
            Picture::Cpu(cpu) => Ok(cpu.clone()),
            Picture::Platform(_) => {
                let surface = MfSurface::of(picture).ok_or_else(|| {
                    CodecError::InvalidInput("surface from another backend".into())
                })?;
                let cpu = read_back_with(&mut self.staging, surface, picture.pts_us())?;
                self.copies.readbacks += 1;
                Ok(cpu)
            }
        }
    }
}

impl JpegCodec for WicJpeg {
    fn decode(&mut self, jpeg: &[u8], width: u32, height: u32) -> Result<Picture, CodecError> {
        self.copies = Copies::default();
        Ok(Picture::Cpu(
            self.decode_bgra(jpeg, Some(Size { width, height }))?,
        ))
    }
    fn encode(&mut self, picture: &Picture, quality: u8) -> Result<Vec<u8>, CodecError> {
        self.copies = Copies::default();
        let cpu = self.cpu_of(picture)?;
        let mut out = Vec::new();
        self.encode_into(&cpu, quality, &mut out)?;
        Ok(out)
    }
}

impl StillCodec for WicJpeg {
    fn transcode_into(
        &mut self,
        jpeg: &[u8],
        target: Size,
        quality: u8,
        output: &mut Vec<u8>,
    ) -> Result<(), CodecError> {
        let scaled = self.decode_bgra(jpeg, Some(target))?;
        self.encode_into(&scaled, quality, output)
    }
    fn decode(&mut self, jpeg: &[u8]) -> Result<CpuPicture, CodecError> {
        self.decode_bgra(jpeg, None)
    }
    fn encode(&mut self, picture: &CpuPicture, quality: u8) -> Result<Vec<u8>, CodecError> {
        let mut out = Vec::new();
        self.encode_into(picture, quality, &mut out)?;
        Ok(out)
    }
}

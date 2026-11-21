// SPDX-License-Identifier: Apache-2.0
//! HEIC through WIC, which decodes it only where Windows has the HEIF and HEVC extensions
//! installed; without them WIC finds no decoder and the image is `unsupported`. Audited
//! boundary: every COM object is owned and local to a call, the stream reads the caller's bytes
//! in place while they are borrowed, and only a decoder WIC itself says is HEIF is read.
#![allow(unsafe_code)]
use crate::error::{Failed, Result};
use crate::raster::Raster;
use windows::Win32::Graphics::Imaging::{
    CLSID_WICImagingFactory, GUID_ContainerFormatHeif, GUID_WICPixelFormat32bppRGBA,
    IWICBitmapFrameDecode, IWICImagingFactory, WICBitmapDitherTypeNone,
    WICBitmapPaletteTypeCustom, WICDecodeMetadataCacheOnDemand,
};
use windows::Win32::System::Com::StructuredStorage::{PROPVARIANT, PropVariantClear};
use windows::Win32::System::Com::{
    CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED, CoCreateInstance, CoInitializeEx, CoUninitialize,
};
use windows::Win32::System::Variant::VT_UI2;
use windows::core::w;

fn none() -> Failed {
    Failed::new(
        crate::ImageFailure::Unsupported,
        "Windows has no HEIC decoder here: the HEIF Image Extensions aren't installed.",
    )
}

/// `f` with COM started on this thread, and stopped again if this call started it.
fn with_com<T>(f: impl FnOnce() -> Result<T>) -> Result<T> {
    // SAFETY: paired with CoUninitialize below only when it succeeded; image threads are ace's
    // own, so none of them is a single-threaded apartment.
    let started = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }.is_ok();
    let result = f();
    if started {
        // SAFETY: balances the successful CoInitializeEx above, after every COM object made in
        // `f` was dropped.
        unsafe { CoUninitialize() };
    }
    result
}

/// The first frame of `bytes` as WIC's HEIF decoder reads it, with the factory that made it.
fn frame(bytes: &[u8]) -> Result<(IWICImagingFactory, IWICBitmapFrameDecode)> {
    // SAFETY: COM is started; each call's out-values are owned interfaces. The stream reads
    // `bytes` in place, and every object holding it is dropped before `bytes` is released.
    unsafe {
        let factory: IWICImagingFactory =
            CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER)
                .map_err(|_| none())?;
        let stream = factory.CreateStream().map_err(|_| none())?;
        stream.InitializeFromMemory(bytes).map_err(|_| none())?;
        let decoder = factory
            .CreateDecoderFromStream(&stream, std::ptr::null(), WICDecodeMetadataCacheOnDemand)
            .map_err(|_| none())?;
        if decoder.GetContainerFormat().ok() != Some(GUID_ContainerFormatHeif) {
            return Err(none());
        }
        let frame = decoder
            .GetFrame(0)
            .map_err(|e| Failed::decode("HEIC", e.message()))?;
        Ok((factory, frame))
    }
}

/// `System.Photo.Orientation`, where the decoder reports it.
fn orientation(frame: &IWICBitmapFrameDecode) -> u8 {
    // SAFETY: an owned query reader; the PROPVARIANT is read only as the type it says it holds
    // and cleared after.
    unsafe {
        let Ok(reader) = frame.GetMetadataQueryReader() else {
            return 1;
        };
        let mut value = PROPVARIANT::default();
        if reader
            .GetMetadataByName(w!("System.Photo.Orientation"), &mut value)
            .is_err()
        {
            return 1;
        }
        let inner = &value.Anonymous.Anonymous;
        let orientation = if inner.vt == VT_UI2 {
            inner.Anonymous.uiVal
        } else {
            1
        };
        let _ = PropVariantClear(&mut value);
        u8::try_from(orientation)
            .ok()
            .filter(|o| (1..=8).contains(o))
            .unwrap_or(1)
    }
}

pub fn header(bytes: &[u8]) -> Result<(u32, u32, u8)> {
    with_com(|| {
        let (_, frame) = frame(bytes)?;
        let (mut width, mut height) = (0, 0);
        // SAFETY: a valid frame; both out-pointers are live locals.
        unsafe { frame.GetSize(&mut width, &mut height) }
            .map_err(|e| Failed::decode("HEIC", e.message()))?;
        if width == 0 || height == 0 {
            return Err(Failed::decode("HEIC", "it has no pixels"));
        }
        Ok((width, height, orientation(&frame)))
    })
}

/// The first frame converted to straight RGBA, at the size its header gave.
pub fn decode(bytes: &[u8], (width, height): (u32, u32)) -> Result<Raster> {
    with_com(|| {
        let (factory, frame) = frame(bytes)?;
        let failed = |e: windows::core::Error| Failed::decode("HEIC", e.message());
        let mut data = vec![0u8; width as usize * height as usize * 4];
        // SAFETY: valid interfaces; `data` is exactly one frame of 32-bit RGBA at `width`
        // × `height`, which the size check guarantees the converter writes.
        unsafe {
            let (mut w, mut h) = (0, 0);
            frame.GetSize(&mut w, &mut h).map_err(failed)?;
            if (w, h) != (width, height) {
                return Err(Failed::decode(
                    "HEIC",
                    "it decodes to a size other than its header's",
                ));
            }
            let converter = factory.CreateFormatConverter().map_err(failed)?;
            converter
                .Initialize(
                    &frame,
                    &GUID_WICPixelFormat32bppRGBA,
                    WICBitmapDitherTypeNone,
                    None,
                    0.0,
                    WICBitmapPaletteTypeCustom,
                )
                .map_err(failed)?;
            converter
                .CopyPixels(std::ptr::null(), width * 4, &mut data)
                .map_err(failed)?;
        }
        Raster::new(width, height, data)
    })
}

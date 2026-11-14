// SPDX-License-Identifier: Apache-2.0
//! Opening a decoder MFT, and turning its output samples into pictures.
use super::{DecodeOutput, MfDecoder, Open};
use crate::win::com::Ctx;
use crate::win::device::MfDevice;
use crate::win::mft::{Listed, Transform, unpack, video_type};
use crate::win::session::{Settings, subtype};
use crate::win::surface::{MfSurface, read_back_with, upload_into};
use media_codec::*;
use windows::Win32::Graphics::Direct3D11::{D3D11_BOX, ID3D11Texture2D};
use windows::Win32::Media::MediaFoundation::*;
use windows_core::Interface;

impl MfDecoder {
    /// The picture in `sample`. A texture target comes from the slot reserved before the
    /// input was given, so a picture is never lost to a full pool.
    pub(super) fn picture(&mut self, sample: &IMFSample) -> Result<Picture, CodecError> {
        let Some(open) = &self.open else {
            return Err(CodecError::NotConfigured);
        };
        let (size, mft_hardware) = (open.size, open.transform.hardware);
        // SAFETY: Reads of a sample the MFT returned.
        let (time, buffer) = unsafe {
            (
                sample.GetSampleTime().unwrap_or(0),
                sample.GetBufferByIndex(0).ctx("buffer")?,
            )
        };
        let pts = (time.max(0) / 10) as u64;
        let device = self.device.clone();
        if let (Ok(dxgi), Some(device)) = (buffer.cast::<IMFDXGIBuffer>(), &device) {
            self.hardware = mft_hardware || !device.adapter().software;
            let mut raw = std::ptr::null_mut();
            // SAFETY: Documented way to reach the decoder's texture and slice.
            let texture = unsafe {
                dxgi.GetResource(&ID3D11Texture2D::IID, &mut raw)
                    .ctx("GetResource")?;
                ID3D11Texture2D::from_raw(raw)
            };
            let slice = unsafe { dxgi.GetSubresourceIndex() }.ctx("GetSubresourceIndex")?;
            let target = self.target()?;
            // The decoder recycles its texture array: copy the picture out on the GPU.
            copy_out(device, &target, &texture, slice, size);
            return match self.output {
                DecodeOutput::Surface => Ok(target.into_picture(pts)),
                DecodeOutput::Cpu => {
                    let cpu = read_back_with(&mut self.staging, &target, pts)?;
                    self.copies.readbacks += 1;
                    Ok(Picture::Cpu(cpu))
                }
            };
        }
        self.hardware = mft_hardware;
        let cpu = self.memory_picture(&buffer, pts)?;
        match (self.output, device) {
            (DecodeOutput::Surface, Some(_)) => {
                let target = self.target()?;
                upload_into(&mut self.staging, &cpu, &target)?;
                self.copies.uploads += 1;
                Ok(target.into_picture(pts))
            }
            _ => Ok(Picture::Cpu(cpu)),
        }
    }

    fn target(&mut self) -> Result<MfSurface, CodecError> {
        match self.reserved.take() {
            Some(slot) => Ok(slot),
            None => Err(CodecError::Backend(
                "decoded a picture without a reserved slot".into(),
            )),
        }
    }

    /// NV12 out of a system-memory buffer, cropped to the stream's size.
    fn memory_picture(
        &mut self,
        buffer: &IMFMediaBuffer,
        pts: u64,
    ) -> Result<CpuPicture, CodecError> {
        let Some(open) = &self.open else {
            return Err(CodecError::NotConfigured);
        };
        let (size, coded) = (open.size, open.coded);
        let (w, h) = (size.width as usize, size.height as usize);
        let mut y = vec![0u8; w * h];
        let mut uv = vec![0u8; w * h / 2];
        // SAFETY: The buffer is locked and read inside its reported length.
        unsafe {
            let mut data = std::ptr::null_mut();
            let mut len = 0u32;
            buffer.Lock(&mut data, None, Some(&mut len)).ctx("Lock")?;
            let stride = open.stride.max(w);
            let needed = stride * (coded.height as usize + h / 2 - 1) + w;
            if data.is_null() || (len as usize) < needed {
                let _ = buffer.Unlock();
                return Err(CodecError::Backend("decoded buffer is too small".into()));
            }
            let bytes = std::slice::from_raw_parts(data, len as usize);
            for row in 0..h {
                y[row * w..(row + 1) * w].copy_from_slice(&bytes[row * stride..row * stride + w]);
            }
            let base = stride * coded.height as usize;
            for row in 0..h / 2 {
                let at = base + row * stride;
                uv[row * w..(row + 1) * w].copy_from_slice(&bytes[at..at + w]);
            }
            buffer.Unlock().ctx("Unlock")?;
        }
        CpuPicture::new(
            size,
            PixelFormat::Nv12,
            [
                Plane { data: y, stride: w },
                Plane {
                    data: uv,
                    stride: w,
                },
            ],
            pts,
        )
    }
}

fn copy_out(
    device: &MfDevice,
    target: &MfSurface,
    texture: &ID3D11Texture2D,
    slice: u32,
    size: Size,
) {
    let area = D3D11_BOX {
        left: 0,
        top: 0,
        front: 0,
        right: size.width,
        bottom: size.height,
        back: 1,
    };
    let _lock = device.lock();
    // SAFETY: Same-format NV12 resources on one device; the box is inside both.
    unsafe {
        device.0.context.CopySubresourceRegion(
            &target.texture,
            0,
            0,
            0,
            0,
            texture,
            slice,
            Some(&area),
        );
    }
}

pub(super) fn open_one(
    listed: &Listed,
    codec: Codec,
    size: Size,
    device: Option<&MfDevice>,
) -> Result<Open, CodecError> {
    let mut transform = Transform::open(listed, device, true)?;
    Settings::of(&transform).low_latency();
    // SAFETY: Type negotiation on the MFT we just opened.
    unsafe {
        let input = video_type(subtype(codec)?, size, 0)?;
        transform
            .mft
            .SetInputType(0, &input, 0)
            .ctx("SetInputType")?;
    }
    let (coded, stride) = choose_nv12(&transform, size)?;
    transform.start()?;
    Ok(Open {
        transform,
        codec,
        size,
        coded,
        stride,
    })
}

/// Selects the decoder's NV12 output type; returns its frame size and row stride.
pub(super) fn choose_nv12(transform: &Transform, size: Size) -> Result<(Size, usize), CodecError> {
    for index in 0..64 {
        // SAFETY: Enumerates offered types until the MFT runs out.
        let Ok(offered) = (unsafe { transform.mft.GetOutputAvailableType(0, index) }) else {
            break;
        };
        if unsafe { offered.GetGUID(&MF_MT_SUBTYPE) }.is_ok_and(|s| s == MFVideoFormat_NV12) {
            unsafe { transform.mft.SetOutputType(0, &offered, 0) }.ctx("SetOutputType")?;
            let (width, height) = unsafe { offered.GetUINT64(&MF_MT_FRAME_SIZE) }
                .map(unpack)
                .unwrap_or((size.width, size.height));
            let stride = unsafe { offered.GetUINT32(&MF_MT_DEFAULT_STRIDE) }
                .map(|s| s as i32 as isize)
                .unwrap_or(width as isize)
                .unsigned_abs();
            let coded = Size {
                width: width.max(size.width),
                height: height.max(size.height),
            };
            return Ok((coded, stride.max(coded.width as usize)));
        }
    }
    Err(CodecError::Unsupported(
        "decoder offers no NV12 output".into(),
    ))
}

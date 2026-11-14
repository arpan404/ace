// SPDX-License-Identifier: Apache-2.0
//! Turning a picture into the encoder MFT's input sample, counting copies.
use super::{IN_FLIGHT, MfEncoder};
use crate::win::com::Ctx;
use crate::win::device::MfDevice;
use crate::win::samples::{memory_buffer, timed_sample};
use crate::win::surface::{MfFormat, MfSurface, Ring, read_back_with, upload_into};
use crate::win::vp::MfScaler;
use media_codec::*;
use windows::Win32::Graphics::Direct3D11::ID3D11Texture2D;
use windows::Win32::Media::MediaFoundation::{
    IMFMediaBuffer, IMFSample, MFCreateDXGISurfaceBuffer,
};
use windows_core::Interface;

/// One input: the sample, its buffer (to track when the MFT lets go) and the texture, if any.
pub(super) struct Input {
    pub sample: IMFSample,
    pub buffer: IMFMediaBuffer,
    pub surface: Option<MfSurface>,
}

impl MfEncoder {
    pub(super) fn input(&mut self, picture: Picture) -> Result<Input, CodecError> {
        let Some(session) = &self.session else {
            return Err(CodecError::NotConfigured);
        };
        let spec = session.spec.clone();
        let d3d = session.transform.d3d;
        let pts = picture.pts_us();
        let duration = 1_000_000 / u64::from(spec.fps);
        let device = self.device.clone();
        // A texture in the wrong size or format goes through the video processor.
        let surface = match (MfSurface::of(&picture), &device) {
            (Some(s), Some(device)) if !s.device.same(device) => {
                return Err(CodecError::InvalidInput(
                    "surface from another device".into(),
                ));
            }
            (Some(s), _) if s.size == spec.size && s.format == MfFormat::Nv12 => Some(s.share()),
            (Some(s), Some(device)) => Some(self.scaler(device)?.convert(s, spec.size)?),
            (Some(_), None) => {
                return Err(CodecError::InvalidInput("surface without a device".into()));
            }
            (None, _) => None,
        };
        let cpu = match picture {
            Picture::Cpu(cpu) => Some(cpu),
            Picture::Platform(_) => None,
        };
        match (surface, cpu, d3d) {
            (Some(surface), _, true) => texture_input(surface, pts, duration),
            (Some(surface), _, false) => {
                let cpu = read_back_with(&mut self.staging, &surface, pts)?;
                self.copies.readbacks += 1;
                self.cpu_input(&cpu, duration)
            }
            (None, Some(cpu), true) => {
                let device = device.ok_or(CodecError::NotConfigured)?;
                let surface = if cpu.size() == spec.size && cpu.format() == PixelFormat::Nv12 {
                    let ring = self.uploads.get_or_insert_with(|| {
                        Ring::new(&device, spec.size, MfFormat::Nv12, IN_FLIGHT)
                    });
                    if !ring.fits(spec.size, MfFormat::Nv12) {
                        *ring = Ring::new(&device, spec.size, MfFormat::Nv12, IN_FLIGHT);
                    }
                    let target = ring.acquire()?;
                    upload_into(&mut self.staging, &cpu, &target)?;
                    target
                } else {
                    let picture = Picture::Cpu(cpu);
                    let out =
                        self.scaler(&device)?
                            .scale(&picture, spec.size.width, spec.size.height)?;
                    MfSurface::of(&out)
                        .ok_or(CodecError::NotConfigured)?
                        .share()
                };
                self.copies.uploads += 1;
                texture_input(surface, pts, duration)
            }
            (None, Some(cpu), false) => {
                if cpu.size() != spec.size || cpu.format() != PixelFormat::Nv12 {
                    return Err(CodecError::InvalidInput(
                        "the software MFT takes NV12 at the encode size".into(),
                    ));
                }
                self.cpu_input(&cpu, duration)
            }
            (None, None, _) => Err(CodecError::InvalidInput(
                "surface from another backend".into(),
            )),
        }
    }

    fn scaler(&mut self, device: &MfDevice) -> Result<&mut MfScaler, CodecError> {
        if self.scaler.is_none() {
            self.scaler = Some(MfScaler::new(device, MfFormat::Nv12)?);
        }
        self.scaler.as_mut().ok_or(CodecError::NotConfigured)
    }

    fn cpu_input(&mut self, cpu: &CpuPicture, duration: u64) -> Result<Input, CodecError> {
        let size = cpu.size();
        let (w, h) = (size.width as usize, size.height as usize);
        self.sample.clear();
        for (plane, rows) in cpu.planes().iter().zip([h, h / 2]) {
            for y in 0..rows {
                self.sample
                    .extend_from_slice(&plane.data[y * plane.stride..y * plane.stride + w]);
            }
        }
        let buffer = memory_buffer(&self.sample)?;
        let sample = timed_sample(&buffer, cpu.pts_us, duration)?;
        Ok(Input {
            sample,
            buffer,
            surface: None,
        })
    }
}

fn texture_input(surface: MfSurface, pts: u64, duration: u64) -> Result<Input, CodecError> {
    // SAFETY: The texture is live, and the returned `Input` keeps it (and its ring lease)
    // until the MFT has released the buffer.
    let buffer = unsafe {
        MFCreateDXGISurfaceBuffer(
            &ID3D11Texture2D::IID,
            &surface.texture,
            surface.subresource,
            false,
        )
    }
    .ctx("MFCreateDXGISurfaceBuffer")?;
    let sample = timed_sample(&buffer, pts, duration)?;
    Ok(Input {
        sample,
        buffer,
        surface: Some(surface),
    })
}

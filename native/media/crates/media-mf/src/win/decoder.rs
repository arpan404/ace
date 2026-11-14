// SPDX-License-Identifier: Apache-2.0
//! `Decoder` over an H.264/HEVC decoder MFT. Given a device, a D3D11-aware decoder (DXVA)
//! writes textures; `hardware` is true only when it did, on an adapter that isn't software.
use super::com::{Ctx, enter};
use super::device::MfDevice;
use super::mft::{Listed, Output, Transform, list, memory_sample, unpack, video_type};
use super::session::{Settings, subtype};
use super::surface::{MfFormat, Ring, Staging, read_back_with, upload_into};
use crate::Copies;
use crate::nal::{ParameterSets, annexb_with_sets, sample_to_annexb, sets_from_record};
use media_codec::*;
use windows::Win32::Graphics::Direct3D11::ID3D11Texture2D;
use windows::Win32::Media::MediaFoundation::*;
use windows_core::Interface;

/// Where decoded pictures go.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum DecodeOutput {
    /// CPU NV12; a texture from DXVA costs one counted readback.
    Cpu,
    /// D3D11 NV12 textures; system-memory output costs one counted upload.
    #[default]
    Surface,
}

struct Open {
    transform: Transform,
    codec: Codec,
    size: Size,
    /// The output type's frame size (it may be padded, e.g. 1088 rows for 1080).
    coded: Size,
    stride: usize,
}

pub struct MfDecoder {
    device: Option<MfDevice>,
    output: DecodeOutput,
    open: Option<Open>,
    sets: ParameterSets,
    input: Vec<u8>,
    scratch: Vec<u8>,
    ring: Option<Ring>,
    staging: Staging,
    copies: Copies,
    hardware: bool,
    name: Option<String>,
}

// SAFETY: As for `MfEncoder`: free-threaded MF and D3D11 objects, one owner.
unsafe impl Send for MfDecoder {}

impl MfDecoder {
    pub fn new(device: Option<MfDevice>, output: DecodeOutput) -> Self {
        Self {
            device,
            output,
            open: None,
            sets: ParameterSets::default(),
            input: Vec::new(),
            scratch: Vec::new(),
            ring: None,
            staging: Staging::default(),
            copies: Copies::default(),
            hardware: false,
            name: None,
        }
    }

    /// The last picture came from a hardware decoder: an MFT listed as hardware, or DXVA
    /// output on an adapter that is not software.
    pub fn hardware(&self) -> bool {
        self.hardware
    }

    /// The MFT that decoded the last stream.
    pub fn name(&self) -> Option<&str> {
        self.name.as_deref()
    }

    pub fn last_copies(&self) -> Copies {
        self.copies
    }

    fn open(&mut self, codec: Codec, size: Size) -> Result<(), CodecError> {
        let listed = list(
            MFT_CATEGORY_VIDEO_DECODER,
            subtype(codec)?,
            MFVideoFormat_NV12,
        );
        let mut last = CodecError::Unsupported(format!("no {codec:?} decoder MFT"));
        for candidate in &listed {
            match open_one(candidate, codec, size, self.device.as_ref()) {
                Ok(open) => {
                    self.name = Some(open.transform.name.clone());
                    self.open = Some(open);
                    return Ok(());
                }
                Err(e) => last = e,
            }
        }
        Err(last)
    }

    fn picture(&mut self, sample: &IMFSample) -> Result<Picture, CodecError> {
        let Some(open) = &self.open else {
            return Err(CodecError::NotConfigured);
        };
        let size = open.size;
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
            self.hardware = open.transform.hardware || !device.adapter().software;
            let mut raw = std::ptr::null_mut();
            // SAFETY: Documented way to reach the decoder's texture and slice.
            let texture = unsafe {
                dxgi.GetResource(&ID3D11Texture2D::IID, &mut raw)
                    .ctx("GetResource")?;
                ID3D11Texture2D::from_raw(raw)
            };
            let slice = unsafe { dxgi.GetSubresourceIndex() }.ctx("GetSubresourceIndex")?;
            // The decoder recycles its texture array: copy the picture out on the GPU.
            let ring = self
                .ring
                .get_or_insert_with(|| Ring::new(device, size, MfFormat::Nv12, 4));
            if !ring.fits(size, MfFormat::Nv12) {
                *ring = Ring::new(device, size, MfFormat::Nv12, 4);
            }
            let target = ring.acquire()?;
            let area = windows::Win32::Graphics::Direct3D11::D3D11_BOX {
                left: 0,
                top: 0,
                front: 0,
                right: size.width,
                bottom: size.height,
                back: 1,
            };
            // SAFETY: Same-format NV12 resources on one device; the box is inside both.
            unsafe {
                device.0.context.CopySubresourceRegion(
                    &target.texture,
                    0,
                    0,
                    0,
                    0,
                    &texture,
                    slice,
                    Some(&area),
                );
            }
            return match self.output {
                DecodeOutput::Surface => Ok(target.into_picture(pts)),
                DecodeOutput::Cpu => {
                    let cpu = read_back_with(&mut self.staging, &target, pts)?;
                    self.copies.readbacks += 1;
                    Ok(Picture::Cpu(cpu))
                }
            };
        }
        self.hardware = open.transform.hardware;
        let cpu = self.memory_picture(&buffer, pts)?;
        match (self.output, device) {
            (DecodeOutput::Surface, Some(device)) => {
                let ring = self
                    .ring
                    .get_or_insert_with(|| Ring::new(&device, size, MfFormat::Nv12, 4));
                if !ring.fits(size, MfFormat::Nv12) {
                    *ring = Ring::new(&device, size, MfFormat::Nv12, 4);
                }
                let target = ring.acquire()?;
                upload_into(&mut self.staging, &cpu, &target)?;
                self.copies.uploads += 1;
                Ok(target.into_picture(pts))
            }
            _ => Ok(Picture::Cpu(cpu)),
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

fn open_one(
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
fn choose_nv12(transform: &Transform, size: Size) -> Result<(Size, usize), CodecError> {
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

impl Decoder for MfDecoder {
    fn decode(&mut self, unit: &EncodedUnit) -> Result<Option<Picture>, CodecError> {
        enter();
        self.copies = Copies::default();
        unit.size.validate()?;
        let codec = unit.codec;
        if let Some(record) = &unit.description {
            self.sets = sets_from_record(codec, record)
                .ok_or_else(|| CodecError::InvalidInput("malformed codec record".into()))?;
        }
        match unit.format {
            BitstreamFormat::Avcc | BitstreamFormat::Hvcc => {
                let sets = unit.key.then_some(&self.sets);
                sample_to_annexb(&unit.data, sets, &mut self.input).ok_or_else(|| {
                    CodecError::InvalidInput("malformed length-prefixed unit".into())
                })?;
            }
            BitstreamFormat::AnnexB => {
                self.sets.absorb(codec, &unit.data);
                annexb_with_sets(codec, &unit.data, &self.sets, unit.key, &mut self.input);
            }
            BitstreamFormat::Elementary => {
                return Err(CodecError::Unsupported("elementary units".into()));
            }
        }
        if self
            .open
            .as_ref()
            .is_none_or(|o| o.codec != codec || o.size != unit.size)
        {
            if !unit.key {
                return Err(CodecError::InvalidInput(
                    "a new stream must start at a keyframe".into(),
                ));
            }
            self.open = None;
            self.open(codec, unit.size)?;
        }
        std::mem::swap(&mut self.input, &mut self.scratch);
        let sample = memory_sample(&self.scratch, unit.pts_us, unit.duration_us);
        std::mem::swap(&mut self.input, &mut self.scratch);
        let sample = sample?;
        if unit.key {
            // SAFETY: Attribute write on a sample we made.
            let _ = unsafe { sample.SetUINT32(&MFSampleExtension_CleanPoint, 1) };
        }
        let Some(open) = &mut self.open else {
            return Err(CodecError::NotConfigured);
        };
        if !open.transform.input(&sample)? {
            // A full decoder: take one picture out, then feed again.
            let picture = self.next()?;
            let Some(open) = &mut self.open else {
                return Err(CodecError::NotConfigured);
            };
            if !open.transform.input(&sample)? {
                return Err(CodecError::Backpressure);
            }
            return Ok(picture);
        }
        self.next()
    }
}

impl MfDecoder {
    /// Ends the stream and returns the pictures the decoder still held (some decoders keep
    /// one back even in low-latency mode). The next unit must be a keyframe.
    pub fn drain(&mut self) -> Result<Vec<Picture>, CodecError> {
        enter();
        let mut out = Vec::new();
        let Some(open) = &mut self.open else {
            return Ok(out);
        };
        open.transform.drain()?;
        let until = std::time::Instant::now() + std::time::Duration::from_secs(2);
        loop {
            if let Some(picture) = self.next()? {
                out.push(picture);
                continue;
            }
            let Some(open) = &self.open else {
                break;
            };
            if !open.transform.is_async()
                || open.transform.drained()
                || std::time::Instant::now() >= until
            {
                break;
            }
        }
        self.open = None;
        Ok(out)
    }

    fn next(&mut self) -> Result<Option<Picture>, CodecError> {
        for _ in 0..4 {
            let Some(open) = &mut self.open else {
                return Err(CodecError::NotConfigured);
            };
            let capacity = open.coded.width * open.coded.height * 3 / 2;
            match open.transform.output(capacity)? {
                Output::Empty => {
                    if open.transform.is_async() {
                        open.transform.wait(std::time::Duration::from_millis(50))?;
                        continue;
                    }
                    return Ok(None);
                }
                Output::StreamChange => {
                    let size = open.size;
                    let (coded, stride) = choose_nv12(&open.transform, size)?;
                    open.coded = coded;
                    open.stride = stride;
                }
                Output::Sample(sample) => return self.picture(&sample).map(Some),
            }
        }
        Ok(None)
    }
}

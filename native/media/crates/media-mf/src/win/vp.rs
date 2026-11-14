// SPDX-License-Identifier: Apache-2.0
//! Colour conversion and scaling on the GPU: one `VideoProcessorBlt` of the D3D11 video
//! processor turns a BGRA or NV12 texture into an NV12 (or BGRA) texture of the asked size.
//! Colour: RGB is full range; YCbCr is BT.709, studio range, as the encoders are told.
use super::com::Ctx;
use super::device::MfDevice;
use super::surface::{MfFormat, MfSurface, Ring, Staging, upload_into};
use crate::Copies;
use media_codec::{CodecError, Picture, PixelFormat, Scaler, Size};
use windows::Win32::Foundation::RECT;
use windows::Win32::Graphics::Direct3D11::{
    D3D11_TEX2D_VPIV, D3D11_TEX2D_VPOV, D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE,
    D3D11_VIDEO_PROCESSOR_COLOR_SPACE, D3D11_VIDEO_PROCESSOR_CONTENT_DESC,
    D3D11_VIDEO_PROCESSOR_FORMAT_SUPPORT_INPUT, D3D11_VIDEO_PROCESSOR_FORMAT_SUPPORT_OUTPUT,
    D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC, D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC_0,
    D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC, D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC_0,
    D3D11_VIDEO_PROCESSOR_STREAM, D3D11_VIDEO_USAGE_OPTIMAL_SPEED, D3D11_VPIV_DIMENSION_TEXTURE2D,
    D3D11_VPOV_DIMENSION_TEXTURE2D, ID3D11Texture2D, ID3D11VideoProcessor,
    ID3D11VideoProcessorEnumerator, ID3D11VideoProcessorInputView, ID3D11VideoProcessorOutputView,
};
use windows::Win32::Graphics::Dxgi::Common::DXGI_RATIONAL;
use windows_core::Interface;

/// D3D11_VIDEO_PROCESSOR_COLOR_SPACE bits: Usage 0, RGB_Range 1, YCbCr_Matrix 2,
/// YCbCr_xvYCC 3, Nominal_Range 4–5.
fn color_space(format: MfFormat) -> D3D11_VIDEO_PROCESSOR_COLOR_SPACE {
    D3D11_VIDEO_PROCESSOR_COLOR_SPACE {
        _bitfield: match format {
            // Full-range RGB.
            MfFormat::Bgra => 0,
            // BT.709 matrix, 16–235.
            MfFormat::Nv12 => (1 << 2) | (1 << 4),
        },
    }
}

const RING: usize = 4;
const VIEWS: usize = 8;

struct Processor {
    key: (Size, MfFormat, Size),
    enumerator: ID3D11VideoProcessorEnumerator,
    processor: ID3D11VideoProcessor,
}

/// The GPU scaler. Pictures from another device or from the CPU are uploaded first, once,
/// and counted.
pub struct MfScaler {
    device: MfDevice,
    output: MfFormat,
    processor: Option<Processor>,
    ring: Option<Ring>,
    inputs: Vec<(ID3D11Texture2D, u32, ID3D11VideoProcessorInputView)>,
    outputs: Vec<(ID3D11Texture2D, ID3D11VideoProcessorOutputView)>,
    upload_ring: Option<Ring>,
    staging: Staging,
    copies: Copies,
}
// SAFETY: Every member is a D3D11 object of a multithread-protected device (`device.rs`).
unsafe impl Send for MfScaler {}

impl MfScaler {
    pub fn new(device: &MfDevice, output: MfFormat) -> Result<Self, CodecError> {
        if !device.has_video() {
            return Err(CodecError::Unsupported(
                "the D3D11 device has no video processor".into(),
            ));
        }
        Ok(Self {
            device: device.clone(),
            output,
            processor: None,
            ring: None,
            inputs: Vec::new(),
            outputs: Vec::new(),
            upload_ring: None,
            staging: Staging::default(),
            copies: Copies::default(),
        })
    }

    /// Copies made by the last call.
    pub fn last_copies(&self) -> Copies {
        self.copies
    }

    /// Converts and scales one texture into a ring texture of `size`.
    pub fn convert(&mut self, input: &MfSurface, size: Size) -> Result<MfSurface, CodecError> {
        size.validate()?;
        if !input.device.same(&self.device) {
            return Err(CodecError::InvalidInput(
                "surface from another device".into(),
            ));
        }
        if self.output == MfFormat::Nv12
            && (!size.width.is_multiple_of(2) || !size.height.is_multiple_of(2))
        {
            return Err(CodecError::InvalidInput(
                "NV12 needs even dimensions".into(),
            ));
        }
        let Some((video, context)) = &self.device.0.video else {
            return Err(CodecError::Unsupported("no video processor".into()));
        };
        let key = (input.size, input.format, size);
        if self.processor.as_ref().is_none_or(|p| p.key != key) {
            self.processor = None;
            self.inputs.clear();
            let desc = D3D11_VIDEO_PROCESSOR_CONTENT_DESC {
                InputFrameFormat: D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE,
                InputFrameRate: DXGI_RATIONAL {
                    Numerator: 60,
                    Denominator: 1,
                },
                InputWidth: input.size.width,
                InputHeight: input.size.height,
                OutputFrameRate: DXGI_RATIONAL {
                    Numerator: 60,
                    Denominator: 1,
                },
                OutputWidth: size.width,
                OutputHeight: size.height,
                Usage: D3D11_VIDEO_USAGE_OPTIMAL_SPEED,
            };
            // SAFETY: A valid content descriptor on a video device.
            let enumerator = unsafe { video.CreateVideoProcessorEnumerator(&desc) }
                .ctx("CreateVideoProcessorEnumerator")?;
            let input_ok = unsafe { enumerator.CheckVideoProcessorFormat(input.format.dxgi()) }
                .ctx("CheckVideoProcessorFormat")?;
            let output_ok = unsafe { enumerator.CheckVideoProcessorFormat(self.output.dxgi()) }
                .ctx("CheckVideoProcessorFormat")?;
            if input_ok & D3D11_VIDEO_PROCESSOR_FORMAT_SUPPORT_INPUT.0 as u32 == 0
                || output_ok & D3D11_VIDEO_PROCESSOR_FORMAT_SUPPORT_OUTPUT.0 as u32 == 0
            {
                return Err(CodecError::Unsupported("video processor format".into()));
            }
            // SAFETY: Rate conversion index 0 always exists.
            let processor = unsafe { video.CreateVideoProcessor(&enumerator, 0) }
                .ctx("CreateVideoProcessor")?;
            let full_in = rect(input.size);
            let full_out = rect(size);
            // SAFETY: Stream 0 exists on every processor; rectangles are in bounds.
            unsafe {
                context.VideoProcessorSetStreamFrameFormat(
                    &processor,
                    0,
                    D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE,
                );
                context.VideoProcessorSetStreamColorSpace(
                    &processor,
                    0,
                    &color_space(input.format),
                );
                context.VideoProcessorSetOutputColorSpace(&processor, &color_space(self.output));
                context.VideoProcessorSetStreamSourceRect(&processor, 0, true, Some(&full_in));
                context.VideoProcessorSetStreamDestRect(&processor, 0, true, Some(&full_out));
                context.VideoProcessorSetOutputTargetRect(&processor, true, Some(&full_out));
                context.VideoProcessorSetStreamAutoProcessingMode(&processor, 0, false);
            }
            self.processor = Some(Processor {
                key,
                enumerator,
                processor,
            });
        }
        if self
            .ring
            .as_ref()
            .is_none_or(|r| !r.fits(size, self.output))
        {
            self.ring = Some(Ring::new(&self.device, size, self.output, RING));
            self.outputs.clear();
        }
        let (Some(processor), Some(ring)) = (&self.processor, &mut self.ring) else {
            return Err(CodecError::NotConfigured);
        };
        let target = ring.acquire()?;
        let output_view = output_view(&mut self.outputs, video, processor, &target)?;
        let input_view = input_view(&mut self.inputs, video, processor, input)?;
        let stream = D3D11_VIDEO_PROCESSOR_STREAM {
            Enable: true.into(),
            pInputSurface: std::mem::ManuallyDrop::new(Some(input_view)),
            ..Default::default()
        };
        let streams = [stream];
        // SAFETY: Views belong to this processor's enumerator; one enabled stream.
        let result =
            unsafe { context.VideoProcessorBlt(&processor.processor, &output_view, 0, &streams) };
        let [mut stream] = streams;
        // SAFETY: Releases the view reference the stream held; it is not used again.
        unsafe { std::mem::ManuallyDrop::drop(&mut stream.pInputSurface) };
        result.ctx("VideoProcessorBlt")?;
        Ok(target)
    }

    fn upload(&mut self, picture: &media_codec::CpuPicture) -> Result<MfSurface, CodecError> {
        let format = match picture.format() {
            PixelFormat::Nv12 => MfFormat::Nv12,
            PixelFormat::Bgra8 => MfFormat::Bgra,
            other => return Err(CodecError::Unsupported(format!("scale input {other:?}"))),
        };
        if self
            .upload_ring
            .as_ref()
            .is_none_or(|r| !r.fits(picture.size(), format))
        {
            self.upload_ring = Some(Ring::new(&self.device, picture.size(), format, 2));
        }
        let Some(ring) = &mut self.upload_ring else {
            return Err(CodecError::NotConfigured);
        };
        let target = ring.acquire()?;
        upload_into(&mut self.staging, picture, &target)?;
        self.copies.uploads += 1;
        Ok(target)
    }
}

fn rect(size: Size) -> RECT {
    RECT {
        left: 0,
        top: 0,
        right: size.width as i32,
        bottom: size.height as i32,
    }
}

fn input_view(
    cache: &mut Vec<(ID3D11Texture2D, u32, ID3D11VideoProcessorInputView)>,
    video: &windows::Win32::Graphics::Direct3D11::ID3D11VideoDevice,
    processor: &Processor,
    input: &MfSurface,
) -> Result<ID3D11VideoProcessorInputView, CodecError> {
    if let Some((_, _, view)) = cache
        .iter()
        .find(|(t, s, _)| t.as_raw() == input.texture.as_raw() && *s == input.subresource)
    {
        return Ok(view.clone());
    }
    let desc = D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC {
        FourCC: 0,
        ViewDimension: D3D11_VPIV_DIMENSION_TEXTURE2D,
        Anonymous: D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC_0 {
            Texture2D: D3D11_TEX2D_VPIV {
                MipSlice: 0,
                ArraySlice: input.subresource,
            },
        },
    };
    let mut view = None;
    // SAFETY: The texture and enumerator are live; the slice exists.
    unsafe {
        video.CreateVideoProcessorInputView(
            &input.texture,
            &processor.enumerator,
            &desc,
            Some(&mut view),
        )
    }
    .ctx("CreateVideoProcessorInputView")?;
    let view = view.ok_or_else(|| CodecError::Backend("no input view".into()))?;
    if cache.len() >= VIEWS {
        cache.remove(0);
    }
    cache.push((input.texture.clone(), input.subresource, view.clone()));
    Ok(view)
}

fn output_view(
    cache: &mut Vec<(ID3D11Texture2D, ID3D11VideoProcessorOutputView)>,
    video: &windows::Win32::Graphics::Direct3D11::ID3D11VideoDevice,
    processor: &Processor,
    target: &MfSurface,
) -> Result<ID3D11VideoProcessorOutputView, CodecError> {
    if let Some((_, view)) = cache
        .iter()
        .find(|(t, _)| t.as_raw() == target.texture.as_raw())
    {
        return Ok(view.clone());
    }
    let desc = D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC {
        ViewDimension: D3D11_VPOV_DIMENSION_TEXTURE2D,
        Anonymous: D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC_0 {
            Texture2D: D3D11_TEX2D_VPOV { MipSlice: 0 },
        },
    };
    let mut view = None;
    // SAFETY: The ring texture is a render target on this device.
    unsafe {
        video.CreateVideoProcessorOutputView(
            &target.texture,
            &processor.enumerator,
            &desc,
            Some(&mut view),
        )
    }
    .ctx("CreateVideoProcessorOutputView")?;
    let view = view.ok_or_else(|| CodecError::Backend("no output view".into()))?;
    cache.push((target.texture.clone(), view.clone()));
    Ok(view)
}

impl Scaler for MfScaler {
    fn scale(&mut self, picture: &Picture, width: u32, height: u32) -> Result<Picture, CodecError> {
        self.copies = Copies::default();
        let size = Size { width, height };
        let out = match (picture, MfSurface::of(picture)) {
            (_, Some(surface)) if surface.device.same(&self.device) => {
                self.convert(surface, size)?
            }
            (Picture::Cpu(cpu), _) => {
                let uploaded = self.upload(cpu)?;
                self.convert(&uploaded, size)?
            }
            _ => {
                return Err(CodecError::InvalidInput(
                    "surface from another backend".into(),
                ));
            }
        };
        Ok(out.into_picture(picture.pts_us()))
    }
}

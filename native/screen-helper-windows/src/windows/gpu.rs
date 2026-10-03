use crate::{
    coordinates::output_size,
    errors::{Code, Error, Result},
};
use windows::{
    core::Interface,
    Graphics::DirectX::Direct3D11::IDirect3DDevice,
    Win32::{
        Foundation::RECT,
        Graphics::{
            Direct3D::*,
            Direct3D11::*,
            Dxgi::{Common::*, IDXGIDevice},
        },
        System::WinRT::Direct3D11::*,
    },
};
fn require<T>(value: Option<T>) -> Result<T> {
    value.ok_or_else(|| Error::new(Code::Internal, "D3D11 returned no resource"))
}
pub struct Gpu {
    pub device: ID3D11Device,
    pub context: ID3D11DeviceContext,
    pub winrt: IDirect3DDevice,
    scaler: Option<Scaler>,
    rgb: Vec<u8>,
}
struct Scaler {
    input_size: (u32, u32),
    output_size: (u32, u32),
    output: ID3D11Texture2D,
    staging: ID3D11Texture2D,
    enumerator: ID3D11VideoProcessorEnumerator,
    processor: ID3D11VideoProcessor,
    output_view: ID3D11VideoProcessorOutputView,
}
impl Gpu {
    pub fn new() -> Result<Self> {
        unsafe {
            let mut device = None;
            let mut context = None;
            D3D11CreateDevice(
                None,
                D3D_DRIVER_TYPE_HARDWARE,
                None,
                D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                Some(&[D3D_FEATURE_LEVEL_11_1, D3D_FEATURE_LEVEL_11_0]),
                D3D11_SDK_VERSION,
                Some(&mut device),
                None,
                Some(&mut context),
            )?;
            let device = require(device)?;
            let context = require(context)?;
            let dxgi: IDXGIDevice = device.cast()?;
            let winrt = CreateDirect3D11DeviceFromDXGIDevice(&dxgi)?.cast()?;
            Ok(Self {
                device,
                context,
                winrt,
                scaler: None,
                rgb: vec![],
            })
        }
    }
    pub fn read(
        &mut self,
        texture: &ID3D11Texture2D,
        width: u32,
        height: u32,
    ) -> Result<(&[u8], u32, u32)> {
        let size = output_size(width, height)?;
        if self
            .scaler
            .as_ref()
            .is_none_or(|s| s.input_size != (width, height))
        {
            self.scaler = Some(Scaler::new(&self.device, width, height)?);
            self.rgb.resize(size.0 as usize * size.1 as usize * 3, 0);
        }
        let scaler = self
            .scaler
            .as_ref()
            .ok_or_else(|| Error::new(Code::Internal, "Missing scaler"))?;
        unsafe {
            let video: ID3D11VideoDevice = self.device.cast()?;
            let video_context: ID3D11VideoContext = self.context.cast()?;
            let desc = D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC {
                ViewDimension: D3D11_VPIV_DIMENSION_TEXTURE2D,
                Anonymous: D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC_0 {
                    Texture2D: D3D11_TEX2D_VPIV {
                        MipSlice: 0,
                        ArraySlice: 0,
                    },
                },
                ..Default::default()
            };
            let mut input = None;
            video.CreateVideoProcessorInputView(
                texture,
                &scaler.enumerator,
                &desc,
                Some(&mut input),
            )?;
            let input = require(input)?;
            let source = RECT {
                left: 0,
                top: 0,
                right: width as i32,
                bottom: height as i32,
            };
            let dest = RECT {
                left: 0,
                top: 0,
                right: size.0 as i32,
                bottom: size.1 as i32,
            };
            video_context.VideoProcessorSetStreamSourceRect(
                &scaler.processor,
                0,
                true,
                Some(&source),
            );
            video_context.VideoProcessorSetStreamDestRect(&scaler.processor, 0, true, Some(&dest));
            video_context.VideoProcessorSetOutputTargetRect(&scaler.processor, true, Some(&dest));
            video_context.VideoProcessorSetStreamFrameFormat(
                &scaler.processor,
                0,
                D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE,
            );
            video_context.VideoProcessorSetStreamAutoProcessingMode(&scaler.processor, 0, false);
            let mut stream = D3D11_VIDEO_PROCESSOR_STREAM {
                Enable: true.into(),
                pInputSurface: std::mem::ManuallyDrop::new(Some(input)),
                ..Default::default()
            };
            let result = video_context.VideoProcessorBlt(
                &scaler.processor,
                &scaler.output_view,
                0,
                std::slice::from_ref(&stream),
            );
            std::mem::ManuallyDrop::drop(&mut stream.pInputSurface);
            result?;
            self.context.CopyResource(&scaler.staging, &scaler.output);
            let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
            self.context
                .Map(&scaler.staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped))?;
            for y in 0..scaler.output_size.1 as usize {
                let row = std::slice::from_raw_parts(
                    (mapped.pData as *const u8).add(y * mapped.RowPitch as usize),
                    size.0 as usize * 4,
                );
                for x in 0..size.0 as usize {
                    let dst = (y * size.0 as usize + x) * 3;
                    self.rgb[dst..dst + 3].copy_from_slice(&[
                        row[x * 4 + 2],
                        row[x * 4 + 1],
                        row[x * 4],
                    ]);
                }
            }
            self.context.Unmap(&scaler.staging, 0);
        }
        Ok((&self.rgb, size.0, size.1))
    }
}
impl Scaler {
    fn new(device: &ID3D11Device, width: u32, height: u32) -> Result<Self> {
        let size = output_size(width, height)?;
        unsafe {
            let desc = D3D11_TEXTURE2D_DESC {
                Width: size.0,
                Height: size.1,
                MipLevels: 1,
                ArraySize: 1,
                Format: DXGI_FORMAT_B8G8R8A8_UNORM,
                SampleDesc: DXGI_SAMPLE_DESC {
                    Count: 1,
                    Quality: 0,
                },
                Usage: D3D11_USAGE_DEFAULT,
                BindFlags: D3D11_BIND_RENDER_TARGET.0 as u32,
                ..Default::default()
            };
            let mut output = None;
            device.CreateTexture2D(&desc, None, Some(&mut output))?;
            let output = require(output)?;
            let mut staging = None;
            device.CreateTexture2D(
                &D3D11_TEXTURE2D_DESC {
                    Usage: D3D11_USAGE_STAGING,
                    BindFlags: 0,
                    CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
                    ..desc
                },
                None,
                Some(&mut staging),
            )?;
            let video: ID3D11VideoDevice = device.cast()?;
            let enumerator =
                video.CreateVideoProcessorEnumerator(&D3D11_VIDEO_PROCESSOR_CONTENT_DESC {
                    InputFrameFormat: D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE,
                    InputWidth: width,
                    InputHeight: height,
                    OutputWidth: size.0,
                    OutputHeight: size.1,
                    Usage: D3D11_VIDEO_USAGE_PLAYBACK_NORMAL,
                    InputFrameRate: DXGI_RATIONAL {
                        Numerator: 30,
                        Denominator: 1,
                    },
                    OutputFrameRate: DXGI_RATIONAL {
                        Numerator: 30,
                        Denominator: 1,
                    },
                })?;
            let processor = video.CreateVideoProcessor(&enumerator, 0)?;
            let desc = D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC {
                ViewDimension: D3D11_VPOV_DIMENSION_TEXTURE2D,
                Anonymous: D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC_0 {
                    Texture2D: D3D11_TEX2D_VPOV { MipSlice: 0 },
                },
            };
            let mut view = None;
            video.CreateVideoProcessorOutputView(&output, &enumerator, &desc, Some(&mut view))?;
            Ok(Self {
                input_size: (width, height),
                output_size: size,
                output,
                staging: require(staging)?,
                enumerator,
                processor,
                output_view: require(view)?,
            })
        }
    }
}

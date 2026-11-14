// SPDX-License-Identifier: Apache-2.0
//! `Encoder` over NVENC: H.264 and HEVC, ultra-low-latency tuning, no B-frames, an infinite
//! GOP with IDR on request, CBR at the requested rate or constant QP.
#![allow(unsafe_code)]
use crate::cuda::CudaContext;
use crate::enc_abi::*;
use crate::load::{EncodeApi, NvRuntime};
use crate::session::{DeviceKind, Session};
use media_codec::{
    BitstreamFormat, Codec, CodecError, EncodeSpec, EncodedUnit, Encoder, EncoderCaps, Picture,
    RateControl, Size,
};
use std::any::Any;
use std::collections::VecDeque;
use std::ffi::c_void;
use std::sync::Arc;

/// NVENC's P1 (fastest) through P7 (best quality) presets, always with tuning info. The older
/// named presets are not supported by current drivers and are never used.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Preset {
    P1,
    P2,
    #[default]
    P3,
    P4,
    P5,
    P6,
    P7,
}

impl Preset {
    pub(crate) fn guid(self) -> Guid {
        PRESETS[self as usize]
    }
}

/// What the encoder's sessions run on. Declared after the session in `NvEncoder` so the
/// session is gone before its device.
enum Device {
    OpenGl,
    D3d11 {
        device: *mut c_void,
        _owner: Box<dyn Any + Send>,
    },
    Cuda(CudaContext),
}

impl Device {
    fn kind(&self) -> DeviceKind {
        match self {
            Self::OpenGl => DeviceKind::OpenGl,
            Self::D3d11 { device, .. } => DeviceKind::D3d11(*device),
            Self::Cuda(context) => DeviceKind::Cuda(context.context),
        }
    }
}

pub struct NvEncoder {
    session: Option<Session>,
    device: Device,
    api: Arc<EncodeApi>,
    preset: Preset,
    spec: Option<EncodeSpec>,
    key_owed: bool,
    output: VecDeque<EncodedUnit>,
    max: Option<Size>,
}

// SAFETY: an NVENC session and its handles may be used from any thread, one call at a time,
// which `&mut self` guarantees. The D3D11 device is multithread-protected (`open_d3d11`'s
// contract). For GL, the caller makes its context current on whichever thread encodes.
unsafe impl Send for NvEncoder {}

fn encode_api(runtime: &NvRuntime) -> Result<Arc<EncodeApi>, CodecError> {
    runtime
        .encode
        .clone()
        .ok_or_else(|| CodecError::Unsupported("no NVENC on this machine".into()))
}

impl NvEncoder {
    fn new(api: Arc<EncodeApi>, device: Device, preset: Preset) -> Self {
        Self {
            session: None,
            device,
            api,
            preset,
            spec: None,
            key_owed: true,
            output: VecDeque::new(),
            max: None,
        }
    }

    /// Linux: GL textures from the GL context current on the thread that configures and
    /// encodes (`NV_ENC_DEVICE_TYPE_OPENGL`).
    pub fn open_gl(runtime: &NvRuntime, preset: Preset) -> Result<Self, CodecError> {
        Ok(Self::new(encode_api(runtime)?, Device::OpenGl, preset))
    }

    /// Windows: D3D11 textures on `device`.
    ///
    /// # Safety
    /// `device` must be an `ID3D11Device*`, multithread-protected, kept alive by `owner`.
    pub unsafe fn open_d3d11(
        runtime: &NvRuntime,
        device: *mut c_void,
        owner: Box<dyn Any + Send>,
        preset: Preset,
    ) -> Result<Self, CodecError> {
        let device = Device::D3d11 {
            device,
            _owner: owner,
        };
        Ok(Self::new(encode_api(runtime)?, device, preset))
    }

    /// CPU pictures uploaded into driver-allocated buffers on a CUDA context of its own: the
    /// probe's trial, and CPU-sourced pictures where no GL context exists.
    pub fn open_cuda(runtime: &NvRuntime, preset: Preset) -> Result<Self, CodecError> {
        let api = encode_api(runtime)?;
        let cuda = runtime
            .cuda
            .clone()
            .ok_or_else(|| CodecError::Unsupported("no CUDA driver on this machine".into()))?;
        Ok(Self::new(
            api,
            Device::Cuda(CudaContext::create(cuda)?),
            preset,
        ))
    }

    #[cfg(test)]
    pub(crate) fn with_api(api: Arc<EncodeApi>, preset: Preset) -> Self {
        Self::new(api, Device::OpenGl, preset)
    }
}

impl Encoder for NvEncoder {
    fn configure(&mut self, spec: &EncodeSpec) -> Result<(), CodecError> {
        spec.validate()?;
        crate::session::codec_guid(spec.codec)?;
        if let Some(session) = self.session.as_mut()
            && session.codec == spec.codec
            && session.size == spec.size
        {
            session.reconfigure(spec)?;
            self.spec = Some(spec.clone());
            return Ok(());
        }
        let session = Session::open(
            self.api.clone(),
            self.device.kind(),
            spec,
            self.preset.guid(),
        )?;
        self.max = Some(session.max);
        self.session = Some(session);
        self.spec = Some(spec.clone());
        self.key_owed = true;
        Ok(())
    }

    fn encode(&mut self, picture: Picture, force_key: bool) -> Result<(), CodecError> {
        let (Some(spec), Some(session)) = (self.spec.as_ref(), self.session.as_mut()) else {
            return Err(CodecError::NotConfigured);
        };
        if picture.size() != spec.size {
            return Err(CodecError::InvalidInput(
                "picture size differs from encode size".into(),
            ));
        }
        let flags = if force_key || self.key_owed {
            PIC_FLAG_FORCEIDR | PIC_FLAG_OUTPUT_SPSPPS
        } else {
            0
        };
        let duration_us = 1_000_000 / u64::from(spec.fps);
        let Some(out) = session.encode(picture, flags, duration_us)? else {
            return Ok(());
        };
        self.key_owed = false;
        self.output.push_back(EncodedUnit {
            codec: spec.codec,
            size: spec.size,
            format: BitstreamFormat::AnnexB,
            data: out.data,
            key: out.key,
            description: None,
            pts_us: out.pts_us,
            duration_us,
        });
        Ok(())
    }

    fn poll(&mut self) -> Option<EncodedUnit> {
        self.output.pop_front()
    }

    fn caps(&self) -> EncoderCaps {
        EncoderCaps {
            hardware: true,
            codecs: vec![Codec::H264, Codec::Hevc],
            // Until a session has asked the GPU, NVENC's long-standing floor.
            max_size: self.max.unwrap_or(Size {
                width: 4096,
                height: 4096,
            }),
            quantizer: true,
        }
    }
}

/// Ultra-low latency without B-frames: P frames only, one IDR at the start, more on request.
pub(crate) fn tune_low_latency(config: &mut EncConfig, codec: Codec) {
    config.gop_length = INFINITE_GOP;
    config.frame_interval_p = 1;
    let word = match codec {
        Codec::Hevc => HEVC_IDR_PERIOD_WORD,
        _ => H264_IDR_PERIOD_WORD,
    };
    config.codec.words[word] = INFINITE_GOP;
}

/// CBR at the bitrate with a one-frame VBV, or constant QP for ace's quantizer control.
pub(crate) fn apply_rate(config: &mut EncConfig, spec: &EncodeSpec) {
    let rc = &mut config.rc;
    rc.version = RC_PARAMS_VER;
    match spec.rate {
        RateControl::Bitrate(bits) => {
            let frame = (bits / spec.fps).max(1);
            rc.mode = RC_CBR;
            rc.average_bit_rate = bits;
            rc.max_bit_rate = bits;
            rc.vbv_buffer_size = frame;
            rc.vbv_initial_delay = frame;
        }
        RateControl::Quantizer(qp) => {
            let qp = u32::from(qp);
            rc.mode = RC_CONSTQP;
            rc.const_qp = Qp {
                inter_p: qp,
                inter_b: qp,
                intra: qp,
            };
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(rate: RateControl) -> EncodeSpec {
        EncodeSpec {
            codec: Codec::H264,
            size: Size {
                width: 1280,
                height: 720,
            },
            fps: 60,
            rate,
        }
    }

    #[test]
    fn low_latency_means_p_frames_only_and_no_periodic_idr() {
        for (codec, word) in [
            (Codec::H264, H264_IDR_PERIOD_WORD),
            (Codec::Hevc, HEVC_IDR_PERIOD_WORD),
        ] {
            let mut config: EncConfig = zeroed();
            config.gop_length = 250;
            config.frame_interval_p = 3;
            config.codec.words[word] = 250;
            tune_low_latency(&mut config, codec);
            assert_eq!(config.gop_length, INFINITE_GOP);
            assert_eq!(config.frame_interval_p, 1);
            assert_eq!(config.codec.words[word], INFINITE_GOP);
        }
    }

    #[test]
    fn a_bitrate_is_cbr_with_a_one_frame_buffer() {
        let mut config: EncConfig = zeroed();
        apply_rate(&mut config, &spec(RateControl::Bitrate(6_000_000)));
        assert_eq!(config.rc.mode, RC_CBR);
        assert_eq!(config.rc.average_bit_rate, 6_000_000);
        assert_eq!(config.rc.max_bit_rate, 6_000_000);
        assert_eq!(config.rc.vbv_buffer_size, 100_000);
        assert_eq!(config.rc.vbv_initial_delay, 100_000);
    }

    #[test]
    fn a_quantizer_is_constant_qp_on_every_picture_type() {
        let mut config: EncConfig = zeroed();
        apply_rate(&mut config, &spec(RateControl::Quantizer(30)));
        assert_eq!(config.rc.mode, RC_CONSTQP);
        assert_eq!(
            config.rc.const_qp,
            Qp {
                inter_p: 30,
                inter_b: 30,
                intra: 30
            }
        );
    }
}

// SPDX-License-Identifier: Apache-2.0
use crate::{CpuPicture, Picture, Size};
use std::fmt;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CodecError {
    InvalidInput(String),
    Unsupported(String),
    NotConfigured,
    Backpressure,
    DeadlineExceeded,
    Backend(String),
}
impl fmt::Display for CodecError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{self:?}")
    }
}
impl std::error::Error for CodecError {}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Codec {
    H264,
    Hevc,
    Vp9,
    Vp8,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RateControl {
    Bitrate(u32),
    Quantizer(u8),
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EncodeSpec {
    pub codec: Codec,
    pub size: Size,
    pub fps: u32,
    pub rate: RateControl,
}
impl EncodeSpec {
    pub fn validate(&self) -> Result<(), CodecError> {
        self.size.validate()?;
        if !self.size.width.is_multiple_of(2)
            || !self.size.height.is_multiple_of(2)
            || self.fps == 0
        {
            return Err(CodecError::InvalidInput(
                "video needs even dimensions and nonzero fps".into(),
            ));
        }
        match self.rate {
            RateControl::Bitrate(0) => Err(CodecError::InvalidInput("zero bitrate".into())),
            RateControl::Quantizer(q) if !(18..=51).contains(&q) => {
                Err(CodecError::InvalidInput("QP outside 18..51".into()))
            }
            _ => Ok(()),
        }
    }
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EncoderCaps {
    pub hardware: bool,
    pub codecs: Vec<Codec>,
    pub max_size: Size,
    pub quantizer: bool,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BitstreamFormat {
    AnnexB,
    Avcc,
    Hvcc,
    Elementary,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EncodedUnit {
    pub codec: Codec,
    pub size: Size,
    pub format: BitstreamFormat,
    pub data: Vec<u8>,
    pub key: bool,
    /// Codec configuration record, when available or changed.
    pub description: Option<Vec<u8>>,
    pub pts_us: u64,
    pub duration_us: u64,
}

/// Reconfiguration of only the rate keeps the stream and pending output intact.
/// A codec or size change starts a new stream at a keyframe. Errors leave the
/// previous configuration intact. Backpressure means the picture was not accepted.
pub trait Encoder: Send {
    fn configure(&mut self, spec: &EncodeSpec) -> Result<(), CodecError>;
    fn encode(&mut self, picture: Picture, force_key: bool) -> Result<(), CodecError>;
    fn poll(&mut self) -> Option<EncodedUnit>;
    /// Async backends override this to report callback/process failures.
    /// Consumers should use this method rather than `poll`.
    fn poll_result(&mut self) -> Result<Option<EncodedUnit>, CodecError> {
        Ok(self.poll())
    }
    fn caps(&self) -> EncoderCaps;
    /// Finish delayed output. Poll until empty after this succeeds.
    fn flush(&mut self) -> Result<(), CodecError> {
        Ok(())
    }
}
/// `None` means buffered input, never a decoding failure.
pub trait Decoder: Send {
    fn decode(&mut self, unit: &EncodedUnit) -> Result<Option<Picture>, CodecError>;
}
/// Exact output size; policy and aspect fitting are the caller's responsibility.
pub trait Scaler: Send {
    fn scale(&mut self, picture: &Picture, width: u32, height: u32) -> Result<Picture, CodecError>;
}
#[derive(Clone, Copy)]
pub enum StillStage {
    Decoded,
    Scaled,
    Encoded,
}
pub trait StillCodec: Send {
    fn transcode_observed(
        &mut self,
        jpeg: &[u8],
        target: Size,
        quality: u8,
        output: &mut Vec<u8>,
        observer: &mut dyn FnMut(StillStage),
    ) -> Result<(), CodecError> {
        self.transcode_into(jpeg, target, quality, output)?;
        observer(StillStage::Encoded);
        Ok(())
    }
    /// Reusable output path. Implementations override to retain scratch capacity.
    fn transcode_into(
        &mut self,
        jpeg: &[u8],
        target: Size,
        quality: u8,
        output: &mut Vec<u8>,
    ) -> Result<(), CodecError> {
        let encoded = self.transcode(jpeg, target, quality)?;
        output.clear();
        output.extend_from_slice(&encoded);
        Ok(())
    }
    /// Exact-size JPEG transcode; policy supplies the aspect-fitted dimensions.
    fn transcode(&mut self, jpeg: &[u8], target: Size, quality: u8) -> Result<Vec<u8>, CodecError> {
        let decoded = self.decode(jpeg)?;
        let Picture::Cpu(scaled) = crate::CpuScaler::default().scale(
            &Picture::Cpu(decoded),
            target.width,
            target.height,
        )?
        else {
            return Err(CodecError::Unsupported(
                "CPU scaler returned a surface".into(),
            ));
        };
        self.encode(&scaled, quality)
    }
    fn decode(&mut self, jpeg: &[u8]) -> Result<CpuPicture, CodecError>;
    /// Quality is 1 through 100. Alpha is discarded; callers composite if needed.
    fn encode(&mut self, picture: &CpuPicture, quality: u8) -> Result<Vec<u8>, CodecError>;
}

/// JPEG backends may keep pixels in platform storage. Width and height are
/// the requested decoded size, unlike StillCodec's full CPU-picture decode.
pub trait JpegCodec: Send {
    fn decode(&mut self, jpeg: &[u8], width: u32, height: u32) -> Result<Picture, CodecError>;
    fn encode(&mut self, picture: &Picture, quality: u8) -> Result<Vec<u8>, CodecError>;
}

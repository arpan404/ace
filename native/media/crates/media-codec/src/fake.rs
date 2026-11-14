// SPDX-License-Identifier: Apache-2.0
//! Deterministic test codecs. Their payload is not a playable video bitstream.
use crate::*;
use std::collections::VecDeque;

#[derive(Clone, Debug)]
pub enum EncodeStep {
    Bytes(usize),
    Error(CodecError),
}
pub struct FakeEncoder {
    script: VecDeque<EncodeStep>,
    output: VecDeque<EncodedUnit>,
    spec: Option<EncodeSpec>,
    key_owed: bool,
}
impl FakeEncoder {
    /// After the script ends, units use bitrate / fps / 8 bytes (rounded up).
    /// The payload records the active rate so reconfiguration is observable.
    pub fn new(script: impl IntoIterator<Item = EncodeStep>) -> Self {
        Self {
            script: script.into_iter().collect(),
            output: VecDeque::new(),
            spec: None,
            key_owed: true,
        }
    }
}
impl Encoder for FakeEncoder {
    fn configure(&mut self, spec: &EncodeSpec) -> Result<(), CodecError> {
        spec.validate()?;
        if self
            .spec
            .as_ref()
            .is_none_or(|s| s.codec != spec.codec || s.size != spec.size)
        {
            self.key_owed = true;
        }
        self.spec = Some(spec.clone());
        Ok(())
    }
    fn encode(&mut self, picture: Picture, force_key: bool) -> Result<(), CodecError> {
        let spec = self.spec.as_ref().ok_or(CodecError::NotConfigured)?;
        if picture.size() != spec.size {
            return Err(CodecError::InvalidInput(
                "picture size differs from encode size".into(),
            ));
        }
        let rate = match spec.rate {
            RateControl::Bitrate(b) => b,
            RateControl::Quantizer(q) => u32::from(q),
        };
        let bytes = match self.script.pop_front() {
            Some(EncodeStep::Error(e)) => return Err(e),
            Some(EncodeStep::Bytes(n)) => n,
            None => match spec.rate {
                RateControl::Bitrate(b) => u64::from(b).div_ceil(u64::from(spec.fps) * 8) as usize,
                RateControl::Quantizer(q) => usize::from(52 - q) * 16,
            },
        };
        if bytes > 8 * 1024 * 1024 {
            return Err(CodecError::InvalidInput("fake unit exceeds 8 MiB".into()));
        }
        let key = force_key || self.key_owed;
        self.output.push_back(EncodedUnit {
            codec: spec.codec,
            size: spec.size,
            format: BitstreamFormat::Elementary,
            data: (0..bytes).map(|i| rate.to_le_bytes()[i % 4]).collect(),
            key,
            description: key.then(|| b"ace-fake-v1".to_vec()),
            pts_us: picture.pts_us(),
            duration_us: 1_000_000 / u64::from(spec.fps),
        });
        self.key_owed = false;
        Ok(())
    }
    fn poll(&mut self) -> Option<EncodedUnit> {
        self.output.pop_front()
    }
    fn caps(&self) -> EncoderCaps {
        EncoderCaps {
            hardware: false,
            codecs: vec![Codec::H264, Codec::Hevc, Codec::Vp9, Codec::Vp8],
            max_size: Size {
                width: MAX_DIMENSION,
                height: MAX_DIMENSION,
            },
            quantizer: true,
        }
    }
}
#[derive(Default)]
pub struct FakeDecoder {
    next_error: Option<CodecError>,
}
impl FakeDecoder {
    pub fn fail_next(&mut self, error: CodecError) {
        self.next_error = Some(error);
    }
}
impl Decoder for FakeDecoder {
    fn decode(&mut self, unit: &EncodedUnit) -> Result<Option<Picture>, CodecError> {
        if let Some(error) = self.next_error.take() {
            return Err(error);
        }
        unit.size.validate()?;
        let stride = unit.size.width as usize * 3;
        Ok(Some(Picture::Cpu(CpuPicture::new(
            unit.size,
            PixelFormat::Rgb8,
            vec![Plane {
                data: vec![0; stride * unit.size.height as usize],
                stride,
            }],
            unit.pts_us,
        )?)))
    }
}

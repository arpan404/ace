// SPDX-License-Identifier: Apache-2.0
//! The CPU still path: baseline JPEG decodes into planes at the DCT scale
//! nearest the target, each plane is resampled, and the planes are encoded
//! as 4:2:0 without any colour conversion. Every buffer is retained, so a
//! repeated geometry allocates nothing. Streams the baseline decoder does not
//! handle (progressive, arithmetic, CMYK) go through zune-jpeg.
mod color;
mod decode;
mod encode;
mod entropy;
mod header;
use crate::resample::{Layout, Pack, Resampler, SimdKernel};
use crate::*;
pub use decode::dct_scaled_size;
use decode::{BaselineDecoder, Ycc};
use encode::BaselineEncoder;
pub use encode::jpeg_capacity;
use zune_core::{bytestream::ZCursor, colorspace::ColorSpace, options::DecoderOptions};
use zune_jpeg::JpegDecoder;

pub struct CpuJpegCodec {
    decoder: BaselineDecoder,
    encoder: BaselineEncoder,
    kernel: SimdKernel,
    /// Luma and chroma geometry differ, so each keeps its own taps.
    resamplers: [Resampler; 2],
    source: Ycc,
    scaled: Ycc,
}
impl Default for CpuJpegCodec {
    fn default() -> Self {
        Self {
            decoder: BaselineDecoder::default(),
            encoder: BaselineEncoder::default(),
            kernel: SimdKernel::detect(),
            resamplers: Default::default(),
            source: Ycc::default(),
            scaled: Ycc::default(),
        }
    }
}

fn general_decode(jpeg: &[u8], space: ColorSpace) -> Result<(Size, Vec<u8>), CodecError> {
    let options = DecoderOptions::default()
        .set_max_width(MAX_DIMENSION as usize)
        .set_max_height(MAX_DIMENSION as usize)
        .jpeg_set_out_colorspace(space);
    let mut decoder = JpegDecoder::new_with_options(ZCursor::new(jpeg), options);
    decoder
        .decode_headers()
        .map_err(|e| CodecError::InvalidInput(e.to_string()))?;
    let info = decoder
        .info()
        .ok_or_else(|| CodecError::InvalidInput("missing JPEG dimensions".into()))?;
    let size = Size {
        width: u32::from(info.width),
        height: u32::from(info.height),
    };
    size.validate()?;
    let data = decoder
        .decode()
        .map_err(|e| CodecError::InvalidInput(e.to_string()))?;
    Ok((size, data))
}

impl CpuJpegCodec {
    /// The resampling instruction set in use.
    pub fn simd_kernel(&self) -> SimdKernel {
        self.kernel
    }
    /// Encode a packed picture, reusing the caller's output capacity.
    /// Alpha is discarded.
    pub fn encode_into(
        &mut self,
        picture: &CpuPicture,
        quality: u8,
        output: &mut Vec<u8>,
    ) -> Result<(), CodecError> {
        color::pixels_to_ycc420(picture, &mut self.source)?;
        self.encoder.encode(&self.source, quality, output)
    }
    pub fn transcode_into(
        &mut self,
        jpeg: &[u8],
        target: Size,
        quality: u8,
        output: &mut Vec<u8>,
    ) -> Result<(), CodecError> {
        self.process(jpeg, target, quality, output, &mut |_| {})
    }
    pub fn decode(&mut self, jpeg: &[u8]) -> Result<CpuPicture, CodecError> {
        StillCodec::decode(self, jpeg)
    }
    pub fn encode(&mut self, picture: &CpuPicture, quality: u8) -> Result<Vec<u8>, CodecError> {
        StillCodec::encode(self, picture, quality)
    }

    fn process(
        &mut self,
        jpeg: &[u8],
        target: Size,
        quality: u8,
        output: &mut Vec<u8>,
        observer: &mut dyn FnMut(StillStage),
    ) -> Result<(), CodecError> {
        target.validate()?;
        if !(1..=100).contains(&quality) {
            return Err(CodecError::InvalidInput(
                "JPEG quality outside 1..100".into(),
            ));
        }
        match self.decoder.decode(jpeg, target, &mut self.source) {
            Err(CodecError::Unsupported(_)) => {
                let (size, rgb) = general_decode(jpeg, ColorSpace::RGB)?;
                color::packed_to_ycc(
                    &rgb,
                    size.width as usize * 3,
                    size,
                    [0, 1, 2, 3],
                    &mut self.source,
                );
            }
            other => other?,
        }
        observer(StillStage::Decoded);
        self.scale_planes(target)?;
        observer(StillStage::Scaled);
        self.encoder.encode(&self.scaled, quality, output)?;
        observer(StillStage::Encoded);
        Ok(())
    }

    /// Resample source planes to `target` luma and ceil(target/2) chroma.
    fn scale_planes(&mut self, target: Size) -> Result<(), CodecError> {
        self.scaled.count = self.source.count;
        for i in 0..self.source.count {
            let (w, h) = if i == 0 {
                (target.width, target.height)
            } else {
                (target.width.div_ceil(2), target.height.div_ceil(2))
            };
            // Odd luma sizes leave the last chroma sample half outside the
            // picture; stretch the source extent to keep samples co-sited.
            let (ew, eh) = self.source.extents[i];
            let extent = if i == 0 {
                (ew, eh)
            } else {
                (
                    ew * f64::from(w) * 2.0 / f64::from(target.width),
                    eh * f64::from(h) * 2.0 / f64::from(target.height),
                )
            };
            let to = Layout {
                width: w,
                height: h,
                stride: w as usize,
            };
            self.scaled.planes[i].resize(w as usize * h as usize, 0);
            self.scaled.layouts[i] = to;
            self.scaled.extents[i] = (f64::from(w), f64::from(h));
            self.resamplers[usize::from(i > 0)].run(
                self.kernel,
                Pack::Plane,
                &self.source.planes[i],
                self.source.layouts[i],
                extent,
                &mut self.scaled.planes[i],
                to,
            )?;
        }
        Ok(())
    }
}

impl StillCodec for CpuJpegCodec {
    fn transcode_observed(
        &mut self,
        jpeg: &[u8],
        target: Size,
        quality: u8,
        output: &mut Vec<u8>,
        observer: &mut dyn FnMut(StillStage),
    ) -> Result<(), CodecError> {
        self.process(jpeg, target, quality, output, observer)
    }
    fn transcode_into(
        &mut self,
        jpeg: &[u8],
        target: Size,
        quality: u8,
        output: &mut Vec<u8>,
    ) -> Result<(), CodecError> {
        CpuJpegCodec::transcode_into(self, jpeg, target, quality, output)
    }
    fn decode(&mut self, jpeg: &[u8]) -> Result<CpuPicture, CodecError> {
        let (size, data) = general_decode(jpeg, ColorSpace::RGB)?;
        CpuPicture::new(
            size,
            PixelFormat::Rgb8,
            [Plane {
                data,
                stride: size.width as usize * 3,
            }],
            0,
        )
    }
    fn encode(&mut self, picture: &CpuPicture, quality: u8) -> Result<Vec<u8>, CodecError> {
        let mut jpeg = Vec::new();
        self.encode_into(picture, quality, &mut jpeg)?;
        Ok(jpeg)
    }
    fn transcode(&mut self, jpeg: &[u8], target: Size, quality: u8) -> Result<Vec<u8>, CodecError> {
        let mut output = Vec::new();
        self.transcode_into(jpeg, target, quality, &mut output)?;
        Ok(output)
    }
}

/// Read and validate JPEG dimensions without allocating decoded pixels.
pub fn jpeg_size(jpeg: &[u8]) -> Result<Size, CodecError> {
    let mut decoder = JpegDecoder::new(ZCursor::new(jpeg));
    decoder
        .decode_headers()
        .map_err(|e| CodecError::InvalidInput(e.to_string()))?;
    let info = decoder
        .info()
        .ok_or_else(|| CodecError::InvalidInput("missing JPEG size".into()))?;
    let size = Size {
        width: u32::from(info.width),
        height: u32::from(info.height),
    };
    size.validate()?;
    Ok(size)
}

impl JpegCodec for CpuJpegCodec {
    fn decode(&mut self, jpeg: &[u8], width: u32, height: u32) -> Result<Picture, CodecError> {
        let decoded = StillCodec::decode(self, jpeg)?;
        CpuScaler::default().scale(&Picture::Cpu(decoded), width, height)
    }
    fn encode(&mut self, picture: &Picture, quality: u8) -> Result<Vec<u8>, CodecError> {
        let Picture::Cpu(picture) = picture else {
            return Err(CodecError::Unsupported("CPU JPEG needs a readback".into()));
        };
        StillCodec::encode(self, picture, quality)
    }
}

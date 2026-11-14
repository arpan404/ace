// SPDX-License-Identifier: Apache-2.0
use crate::still::rgb;
use crate::*;
use zune_core::{bytestream::ZCursor, colorspace::ColorSpace, options::DecoderOptions};
use zune_jpeg::JpegDecoder;
#[derive(Default)]
pub struct CpuJpegCodec {
    decoded: Vec<u8>,
    scaled: Vec<u8>,
    scaler: CpuScaler,
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
        let options = DecoderOptions::default()
            .set_max_width(MAX_DIMENSION as usize)
            .set_max_height(MAX_DIMENSION as usize)
            .jpeg_set_out_colorspace(ColorSpace::RGB);
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
impl CpuJpegCodec {
    /// Reuses the caller's output capacity. RGBA stays RGBA through the encoder.
    pub fn encode_into(
        &mut self,
        picture: &CpuPicture,
        quality: u8,
        output: &mut Vec<u8>,
    ) -> Result<(), CodecError> {
        if !(1..=100).contains(&quality) {
            return Err(CodecError::InvalidInput(
                "JPEG quality outside 1..100".into(),
            ));
        }
        let (data, format) = if picture.format() == PixelFormat::Rgba8
            && picture.planes()[0].stride == picture.size().width as usize * 4
        {
            (
                std::borrow::Cow::Borrowed(picture.planes()[0].data.as_slice()),
                libjpeg_turbo_rs::PixelFormat::Rgba,
            )
        } else {
            (rgb(picture)?, libjpeg_turbo_rs::PixelFormat::Rgb)
        };
        let capacity = libjpeg_turbo_rs::jpeg_buf_size(
            picture.size().width as usize,
            picture.size().height as usize,
            libjpeg_turbo_rs::Subsampling::S420,
        );
        output.resize(capacity, 0);
        let size = libjpeg_turbo_rs::compress_into(
            output,
            &data,
            picture.size().width as usize,
            picture.size().height as usize,
            format,
            quality,
            libjpeg_turbo_rs::Subsampling::S420,
        )
        .map_err(|e| CodecError::Backend(e.to_string()))?;
        output.truncate(size);
        Ok(())
    }

    /// Full decodes reuse RGBA storage; reduced RGB decodes retain their buffer.
    /// Use a reduced DCT
    /// only when its output is still at least the requested size on both axes.
    pub fn decode_for_resize(
        &mut self,
        jpeg: &[u8],
        target: Size,
        mut buffer: Vec<u8>,
    ) -> Result<CpuPicture, CodecError> {
        target.validate()?;
        let options = DecoderOptions::default()
            .set_max_width(MAX_DIMENSION as usize)
            .set_max_height(MAX_DIMENSION as usize)
            .jpeg_set_out_colorspace(ColorSpace::RGBA);
        let mut decoder = JpegDecoder::new_with_options(ZCursor::new(jpeg), options);
        decoder
            .decode_headers()
            .map_err(|e| CodecError::InvalidInput(e.to_string()))?;
        let info = decoder
            .info()
            .ok_or_else(|| CodecError::InvalidInput("missing JPEG dimensions".into()))?;
        let source = Size {
            width: u32::from(info.width),
            height: u32::from(info.height),
        };
        source.validate()?;
        if target.width <= source.width / 2 && target.height <= source.height / 2 {
            let mut decoder = jpeg_decoder::Decoder::new(std::io::Cursor::new(jpeg));
            let (w, h) = decoder
                .scale(target.width as u16, target.height as u16)
                .map_err(|e| CodecError::InvalidInput(e.to_string()))?;
            let info = decoder
                .info()
                .ok_or_else(|| CodecError::InvalidInput("missing JPEG info".into()))?;
            if matches!(
                info.pixel_format,
                jpeg_decoder::PixelFormat::RGB24 | jpeg_decoder::PixelFormat::L8
            ) {
                let pixels = decoder
                    .decode()
                    .map_err(|e| CodecError::InvalidInput(e.to_string()))?;
                let (format, stride) = if info.pixel_format == jpeg_decoder::PixelFormat::RGB24 {
                    // The reduced decoder owns this packed RGB buffer already.
                    // Do not expand it merely to remove alpha during encoding.
                    (PixelFormat::Rgb8, usize::from(w) * 3)
                } else {
                    buffer.clear();
                    for p in &pixels {
                        buffer.extend_from_slice(&[*p, *p, *p, 255]);
                    }
                    (PixelFormat::Rgba8, usize::from(w) * 4)
                };
                let data = if format == PixelFormat::Rgb8 {
                    pixels
                } else {
                    buffer
                };
                return CpuPicture::new(
                    Size {
                        width: u32::from(w),
                        height: u32::from(h),
                    },
                    format,
                    [Plane { data, stride }],
                    0,
                );
            }
        }
        buffer.resize(source.width as usize * source.height as usize * 4, 0);
        decoder
            .decode_into(&mut buffer)
            .map_err(|e| CodecError::InvalidInput(e.to_string()))?;
        CpuPicture::new(
            source,
            PixelFormat::Rgba8,
            [Plane {
                data: buffer,
                stride: source.width as usize * 4,
            }],
            0,
        )
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
    fn process(
        &mut self,
        jpeg: &[u8],
        target: Size,
        quality: u8,
        output: &mut Vec<u8>,
        observer: &mut dyn FnMut(StillStage),
    ) -> Result<(), CodecError> {
        let buffer = std::mem::take(&mut self.decoded);
        let decoded = Picture::Cpu(self.decode_for_resize(jpeg, target, buffer)?);
        observer(StillStage::Decoded);
        let scaled = self.scaler.scale_reusing(
            &decoded,
            target.width,
            target.height,
            std::mem::take(&mut self.scaled),
        )?;
        observer(StillStage::Scaled);
        if let Picture::Cpu(p) = decoded {
            self.decoded = p.into_packed_plane()?.data;
        }
        let Picture::Cpu(scaled) = scaled else {
            return Err(CodecError::Unsupported("expected CPU resize".into()));
        };
        let result = self.encode_into(&scaled, quality, output);
        self.scaled = scaled.into_packed_plane()?.data;
        if result.is_ok() {
            observer(StillStage::Encoded);
        }
        result
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

impl CpuJpegCodec {
    pub fn decode(&mut self, jpeg: &[u8]) -> Result<CpuPicture, CodecError> {
        StillCodec::decode(self, jpeg)
    }
    pub fn encode(&mut self, picture: &CpuPicture, quality: u8) -> Result<Vec<u8>, CodecError> {
        StillCodec::encode(self, picture, quality)
    }
}
impl JpegCodec for CpuJpegCodec {
    fn decode(&mut self, jpeg: &[u8], width: u32, height: u32) -> Result<Picture, CodecError> {
        let decoded = self.decode_for_resize(jpeg, Size { width, height }, Vec::new())?;
        self.scaler.scale(&Picture::Cpu(decoded), width, height)
    }
    fn encode(&mut self, picture: &Picture, quality: u8) -> Result<Vec<u8>, CodecError> {
        let Picture::Cpu(picture) = picture else {
            return Err(CodecError::Unsupported("CPU JPEG needs a readback".into()));
        };
        StillCodec::encode(self, picture, quality)
    }
}

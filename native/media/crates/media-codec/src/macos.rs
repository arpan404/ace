// SPDX-License-Identifier: Apache-2.0
//! Audited ImageIO boundary. All native objects are owned and local to a call.
#![allow(unsafe_code)]
use crate::*;
use objc2_core_foundation::{
    CFBoolean, CFData, CFDictionary, CFMutableData, CFNumber, CFRetained, CFString, CFType,
};
use objc2_core_graphics::*;
use objc2_image_io::*;

fn failed(operation: &str) -> CodecError {
    CodecError::Backend(format!("ImageIO {operation} failed"))
}
#[derive(Default)]
pub struct MacJpegCodec {
    context: Option<(Size, CFRetained<CGContext>)>,
    output: Option<CFRetained<CFMutableData>>,
}
// SAFETY: The only non-Send field is the private mutable CFData buffer. It
// never escapes or aliases another owner; all use is through &mut self and each
// ImageIO destination is dropped before returning. Moving this exclusively owned
// buffer between threads is safe; concurrent access remains forbidden (!Sync).
unsafe impl Send for MacJpegCodec {}
pub struct NativeJpegPicture {
    image: CFRetained<CGImage>,
}
impl NativeJpegPicture {
    pub fn size(&self) -> Size {
        Size {
            width: CGImage::width(Some(&self.image)) as u32,
            height: CGImage::height(Some(&self.image)) as u32,
        }
    }
}
impl MacJpegCodec {
    /// Decode with a reduced DCT where possible, then resize in native storage.
    pub fn decode_native(
        &mut self,
        jpeg: &[u8],
        target: Size,
    ) -> Result<NativeJpegPicture, CodecError> {
        target.validate()?;
        let source_size = jpeg_size(jpeg)?;
        let factor = [8, 4, 2, 1]
            .into_iter()
            .find(|factor| {
                source_size.width / factor >= target.width
                    && source_size.height / factor >= target.height
            })
            .unwrap_or(1);
        let data = CFData::from_bytes(jpeg);
        let factor = CFNumber::new_i32(factor as i32);
        // SAFETY: The documented subsample value is 1, 2, 4 or 8. ImageIO
        // retains the data. The cached image owns its decoded pixels.
        let image = unsafe {
            let options: CFRetained<CFDictionary<CFString, CFType>> = CFDictionary::from_slices(
                &[
                    kCGImageSourceSubsampleFactor,
                    kCGImageSourceShouldCacheImmediately,
                ],
                &[factor.as_ref(), CFBoolean::new(true).as_ref()],
            );
            let source = CGImageSource::with_data(&data, None).ok_or_else(|| failed("source"))?;
            source
                .image_at_index(0, Some(options.as_opaque()))
                .ok_or_else(|| failed("decode"))?
        };
        Ok(NativeJpegPicture { image })
    }
    pub fn resize_native(
        &mut self,
        picture: NativeJpegPicture,
        target: Size,
    ) -> Result<NativeJpegPicture, CodecError> {
        target.validate()?;
        if picture.size() == target {
            return Ok(picture);
        }
        if self
            .context
            .as_ref()
            .is_none_or(|(size, _)| *size != target)
        {
            let space = CGColorSpace::new_device_rgb().ok_or_else(|| failed("colour space"))?;
            // SAFETY: NULL storage asks CoreGraphics to allocate. Validated
            // dimensions and RGBx layout match the bitmap. Snapshots use COW.
            let context = unsafe {
                CGBitmapContextCreate(
                    std::ptr::null_mut(),
                    target.width as usize,
                    target.height as usize,
                    8,
                    target.width as usize * 4,
                    Some(&space),
                    CGImageAlphaInfo::NoneSkipLast.0,
                )
            }
            .ok_or_else(|| failed("bitmap"))?;
            self.context = Some((target, context));
        }
        let (_, context) = self.context.as_ref().ok_or_else(|| failed("bitmap"))?;
        CGContext::set_interpolation_quality(Some(context), CGInterpolationQuality::Medium);
        CGContext::draw_image(
            Some(context),
            objc2_core_foundation::CGRect {
                origin: objc2_core_foundation::CGPoint { x: 0.0, y: 0.0 },
                size: objc2_core_foundation::CGSize {
                    width: f64::from(target.width),
                    height: f64::from(target.height),
                },
            },
            Some(&picture.image),
        );
        Ok(NativeJpegPicture {
            image: CGBitmapContextCreateImage(Some(context)).ok_or_else(|| failed("snapshot"))?,
        })
    }
    pub fn encode_native(
        &mut self,
        picture: &NativeJpegPicture,
        quality: u8,
    ) -> Result<Vec<u8>, CodecError> {
        if !(1..=100).contains(&quality) {
            return Err(CodecError::InvalidInput(
                "JPEG quality outside 1..100".into(),
            ));
        }
        if self.output.is_none() {
            self.output = Some(CFMutableData::new(None, 0).ok_or_else(|| failed("output buffer"))?);
        }
        let data = self
            .output
            .as_ref()
            .ok_or_else(|| failed("output buffer"))?;
        CFMutableData::set_length(Some(data), 0);
        let jpeg_type = CFString::from_static_str("public.jpeg");
        let value = CFNumber::new_f64(f64::from(quality) / 100.0);
        // SAFETY: The destination retains its owned mutable buffer, which is not
        // read until finalize completes. Image and quality dictionary are valid.
        unsafe {
            let properties: CFRetained<CFDictionary<CFString, CFType>> = CFDictionary::from_slices(
                &[kCGImageDestinationLossyCompressionQuality],
                &[value.as_ref()],
            );
            let dest = CGImageDestination::with_data(data, &jpeg_type, 1, None)
                .ok_or_else(|| failed("destination"))?;
            dest.add_image(&picture.image, Some(properties.as_opaque()));
            if !dest.finalize() {
                return Err(failed("encode"));
            }
        }
        Ok(data.to_vec())
    }
}
impl StillCodec for MacJpegCodec {
    fn decode(&mut self, jpeg: &[u8]) -> Result<CpuPicture, CodecError> {
        CpuJpegCodec::default().decode(jpeg)
    }
    fn encode(&mut self, picture: &CpuPicture, quality: u8) -> Result<Vec<u8>, CodecError> {
        let plane = &picture.planes()[0];
        let (bits, info) = match picture.format() {
            PixelFormat::Rgb8 => (24, CGBitmapInfo(0)),
            PixelFormat::Rgba8 => (32, CGBitmapInfo(CGImageAlphaInfo::NoneSkipLast.0)),
            PixelFormat::Bgra8 => (
                32,
                CGBitmapInfo(CGImageAlphaInfo::NoneSkipFirst.0)
                    | CGBitmapInfo(CGImageByteOrderInfo::Order32Little.0),
            ),
            PixelFormat::Nv12 => {
                return Err(CodecError::Unsupported(
                    "NV12 needs platform conversion".into(),
                ));
            }
        };
        let data = CFData::from_bytes(&plane.data);
        let provider =
            CGDataProvider::with_cf_data(Some(&data)).ok_or_else(|| failed("pixel provider"))?;
        let space = CGColorSpace::new_device_rgb().ok_or_else(|| failed("colour space"))?;
        // SAFETY: CpuPicture validated the layout. Native RGB/BGRx is retained by the
        // provider for the lifetime of the image. No custom decode array is used.
        let image = unsafe {
            CGImage::new(
                picture.size().width as usize,
                picture.size().height as usize,
                8,
                bits,
                plane.stride,
                Some(&space),
                info,
                Some(&provider),
                std::ptr::null(),
                false,
                CGColorRenderingIntent::RenderingIntentDefault,
            )
        }
        .ok_or_else(|| failed("RGB image"))?;
        self.encode_native(&NativeJpegPicture { image }, quality)
    }
    fn transcode(&mut self, jpeg: &[u8], target: Size, quality: u8) -> Result<Vec<u8>, CodecError> {
        let picture = self.decode_native(jpeg, target)?;
        let picture = self.resize_native(picture, target)?;
        self.encode_native(&picture, quality)
    }
}

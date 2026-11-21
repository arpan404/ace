// SPDX-License-Identifier: Apache-2.0
//! HEIC through ImageIO. Audited boundary: every native object is owned and local to a call,
//! and only a source ImageIO itself types as HEIC or HEIF is read, so no other of its formats
//! is reached through here.
#![allow(unsafe_code)]
use crate::error::{Failed, Result};
use crate::raster::Raster;
use objc2_core_foundation::{
    CFBoolean, CFData, CFDictionary, CFNumber, CFRetained, CFString, CFType, CGPoint, CGRect,
    CGSize,
};
use objc2_core_graphics::{
    CGBitmapContextCreate, CGColorSpace, CGContext, CGImage, CGImageAlphaInfo, kCGColorSpaceSRGB,
};
use objc2_image_io::{
    CGImageSource, kCGImagePropertyOrientation, kCGImagePropertyPixelHeight,
    kCGImagePropertyPixelWidth, kCGImageSourceShouldCache, kCGImageSourceTypeIdentifierHint,
};

fn unreadable() -> Failed {
    Failed::decode("HEIC", "ImageIO can't read it")
}

/// The data as a source ImageIO types as HEIC or HEIF, and the primary image's index.
fn source(bytes: &[u8]) -> Result<(CFRetained<CGImageSource>, usize)> {
    let data = CFData::from_bytes(bytes);
    let hint = CFString::from_static_str("public.heic");
    // SAFETY: the keys are ImageIO's own constants, with the value types they document; the
    // source retains the data it reads.
    let source = unsafe {
        let options: CFRetained<CFDictionary<CFString, CFType>> = CFDictionary::from_slices(
            &[kCGImageSourceTypeIdentifierHint, kCGImageSourceShouldCache],
            &[hint.as_ref(), CFBoolean::new(false).as_ref()],
        );
        CGImageSource::with_data(&data, Some(options.as_opaque()))
    }
    .ok_or_else(unreadable)?;
    // SAFETY: a valid source; the type is a CFString ImageIO owns a copy of for us.
    let kind = unsafe { source.r#type() }.map(|t| t.to_string());
    if !matches!(kind.as_deref(), Some("public.heic" | "public.heif")) {
        return Err(Failed::new(
            crate::ImageFailure::Unsupported,
            "ImageIO doesn't read these bytes as a HEIC image.",
        ));
    }
    // SAFETY: a valid source.
    let (count, primary) = unsafe { (source.count(), source.primary_image_index()) };
    if primary >= count {
        return Err(unreadable());
    }
    Ok((source, primary))
}

fn number(properties: &CFDictionary<CFString, CFType>, key: &CFString) -> Option<i64> {
    properties.get(key)?.downcast::<CFNumber>().ok()?.as_i64()
}

pub fn header(bytes: &[u8]) -> Result<(u32, u32, u8)> {
    let (source, primary) = source(bytes)?;
    // SAFETY: a valid index of a valid source; ImageIO returns a dictionary of CFString keys,
    // read without decoding pixels (the source doesn't cache).
    let properties = unsafe {
        let properties = source
            .properties_at_index(primary, None)
            .ok_or_else(unreadable)?;
        CFRetained::cast_unchecked::<CFDictionary<CFString, CFType>>(properties)
    };
    // SAFETY: ImageIO's own constant keys.
    let (width, height, orientation) = unsafe {
        (
            number(&properties, kCGImagePropertyPixelWidth),
            number(&properties, kCGImagePropertyPixelHeight),
            number(&properties, kCGImagePropertyOrientation),
        )
    };
    let side = |n: Option<i64>| n.and_then(|n| u32::try_from(n).ok()).filter(|n| *n > 0);
    let (Some(width), Some(height)) = (side(width), side(height)) else {
        return Err(Failed::decode("HEIC", "its size isn't in its metadata"));
    };
    let orientation = orientation
        .and_then(|o| u8::try_from(o).ok())
        .filter(|o| (1..=8).contains(o))
        .unwrap_or(1);
    Ok((width, height, orientation))
}

/// The primary image drawn into RGBA that ace owns, in sRGB, at the size its header gave.
pub fn decode(bytes: &[u8], (width, height): (u32, u32)) -> Result<Raster> {
    let (source, primary) = source(bytes)?;
    // SAFETY: a valid index of a valid source; the image owns what it decodes.
    let image = unsafe { source.image_at_index(primary, None) }.ok_or_else(unreadable)?;
    let drawn = (CGImage::width(Some(&image)), CGImage::height(Some(&image)));
    if drawn != (width as usize, height as usize) {
        return Err(Failed::decode(
            "HEIC",
            "it decodes to a size other than its header's",
        ));
    }
    // SAFETY: ImageIO's constant name for sRGB.
    let space = CGColorSpace::with_name(Some(unsafe { kCGColorSpaceSRGB }))
        .ok_or_else(|| Failed::decode("HEIC", "sRGB isn't available"))?;
    let mut data = vec![0u8; width as usize * height as usize * 4];
    {
        // SAFETY: `data` is width × height × 4 bytes, the layout given here (8 bits a sample,
        // 4 samples a pixel, no row padding), and it outlives the context, which is dropped at
        // the end of this block before `data` is read.
        let context = unsafe {
            CGBitmapContextCreate(
                data.as_mut_ptr().cast(),
                width as usize,
                height as usize,
                8,
                width as usize * 4,
                Some(&space),
                CGImageAlphaInfo::PremultipliedLast.0,
            )
        }
        .ok_or_else(|| Failed::decode("HEIC", "no bitmap could be made for it"))?;
        CGContext::draw_image(
            Some(&context),
            CGRect {
                origin: CGPoint { x: 0.0, y: 0.0 },
                size: CGSize {
                    width: f64::from(width),
                    height: f64::from(height),
                },
            },
            Some(&image),
        );
    }
    super::unpremultiply(&mut data);
    Raster::new(width, height, data)
}

// SPDX-License-Identifier: Apache-2.0
//! Arbitrary bytes through media-image (ADR 0201): probe, then a fit and an alpha read under a
//! small pixel bound. Checks: nothing panics; whatever probe reports is within the bound the
//! decode then honours (a crafted header can't pass the check and allocate for a larger frame);
//! and an accepted fit is no larger than its box.
#![no_main]
use libfuzzer_sys::fuzz_target;
use media_image::{Input, peak_bytes, run};
use media_wire::image::{ImageOp, ImageOutput};

const MAX_PIXELS: u32 = 1 << 20;

fuzz_target!(|bytes: &[u8]| {
    let input = [Input::Encoded(bytes)];
    let probe = ImageOp::Probe { max_pixels: MAX_PIXELS };
    let probed = run(&input, &probe, &|| false);
    if let Ok(done) = &probed {
        assert!(u64::from(done.width) * u64::from(done.height) <= u64::from(MAX_PIXELS));
    }
    let fit = ImageOp::Fit {
        max_pixels: MAX_PIXELS,
        width: 64,
        height: 64,
        auto_orient: true,
        vector_scale: Some(2.0),
        output: ImageOutput::Rgba,
    };
    let reserved = peak_bytes(&input, &fit);
    if let Ok(done) = run(&input, &fit, &|| false) {
        assert!(done.width <= 64 && done.height <= 64);
        assert_eq!(done.bytes.len(), done.width as usize * done.height as usize * 4);
        // A job that decoded was reserved for, before decoding.
        assert!(reserved.is_ok());
    }
    let _ = run(&input, &ImageOp::Alpha { max_pixels: MAX_PIXELS }, &|| false);
});

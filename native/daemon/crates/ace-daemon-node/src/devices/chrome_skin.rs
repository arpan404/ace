// SPDX-License-Identifier: Apache-2.0
//! The emulator skin exports of the device look (D3.4): a skin's opening, its images' data URLs
//! and the look built from the alpha the shell sampled. Values in, JSON out.

use ace_devices::platform::{
    android_skin::{Opening, SkinImage, SkinPlan, android_skin_chrome, opening, parse_skin_layout},
    android_skin_files::IMAGE_LIMIT,
};
use napi::bindgen_prelude::Buffer;
use napi_derive::napi;
use serde::Serialize;

use super::chrome::{parse, text};

#[derive(Serialize)]
pub struct SkinRead {
    plan: SkinPlan,
    /// The image files the shell reads, each with the corner its diagonal starts at.
    images: Vec<SkinImageRead>,
}

#[derive(Serialize)]
pub struct SkinImageRead {
    key: String,
    file: String,
    #[serde(rename = "corner")]
    corner: Option<(u32, u32)>,
    reach: usize,
}

/// A skin's layout as the look ace draws, with the images to read and their corner scans.
#[napi]
pub fn device_platform_skin_opening(layout: String) -> napi::Result<String> {
    let Some(opening) = opening(&parse_skin_layout(&layout)) else {
        return Ok("null".to_string());
    };
    let images = vec![
        SkinImageRead {
            key: "back".to_string(),
            file: opening.background.clone(),
            corner: opening.back_corner(),
            reach: opening.reach(),
        },
        SkinImageRead {
            key: "mask".to_string(),
            file: opening.mask.clone().unwrap_or_default(),
            corner: Some((0, 0)),
            reach: opening.reach(),
        },
    ];
    text(&SkinRead {
        plan: opening.plan(),
        images: if opening.mask.is_some() {
            images
        } else {
            images.into_iter().take(1).collect()
        },
    })
}

/// A skin image's data URL, as the look carries it; none when it is too large to send.
#[napi]
pub fn device_platform_skin_image(bytes: Buffer, file: String) -> Option<String> {
    if bytes.len() > IMAGE_LIMIT {
        return None;
    }
    Some(ace_devices::platform::android_skin_files::image_url(
        &bytes, &file,
    ))
}

fn scan(text: Option<String>) -> napi::Result<Vec<Option<u8>>> {
    match text {
        Some(text) => parse(&text),
        None => Ok(Vec::new()),
    }
}

/// The skin's look from its measurements: the opening, the images' data URLs and the alpha the
/// shell sampled along each image's corner.
#[napi]
pub fn device_platform_skin_chrome(
    plan: String,
    back_url: String,
    back_scan: String,
    mask_url: Option<String>,
    mask_scan: Option<String>,
) -> napi::Result<String> {
    let plan: SkinPlan = parse(&plan)?;
    let opening: Opening = plan.opening();
    let backdrop = SkinImage {
        url: back_url,
        scan: scan(Some(back_scan))?,
    };
    let mask = match (mask_url, mask_scan) {
        (Some(url), Some(scan)) => Some(SkinImage {
            url,
            scan: self::scan(Some(scan))?,
        }),
        _ => None,
    };
    let chrome = android_skin_chrome(&opening, &backdrop, mask.as_ref());
    text(&chrome)
}

// SPDX-License-Identifier: Apache-2.0
//! One-shot image jobs (ADR 0208): what `image.job` asks for and what `image.done` reports.
//! Ids and bounds are checked here; whether the numbers make a sensible picture is
//! `media-image`'s to decide, so a bad job is answered with `image.failed`, never a lane error.
use serde::{Deserialize, Serialize};

/// Where one input's bytes come from.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", deny_unknown_fields)]
pub enum ImageInput {
    /// The next `bytes` of the frame's payload: an encoded image whose format is sniffed.
    #[serde(rename = "bytes")]
    Bytes {
        #[serde(rename = "bytes")]
        bytes: u32,
    },
    /// The next `bytes` of the payload: straight (not premultiplied) RGBA, 4 bytes a pixel.
    #[serde(rename = "rgba")]
    Rgba {
        #[serde(rename = "bytes")]
        bytes: u32,
        #[serde(rename = "width")]
        width: u32,
        #[serde(rename = "height")]
        height: u32,
    },
    /// A file ace itself wrote, read by ace-media; more than `maxBytes` is refused.
    #[serde(rename = "file")]
    File {
        #[serde(rename = "path")]
        path: String,
        #[serde(rename = "maxBytes")]
        max_bytes: u32,
    },
}

impl ImageInput {
    /// How many payload bytes this input takes.
    pub fn payload_bytes(&self) -> u64 {
        match self {
            Self::Bytes { bytes } | Self::Rgba { bytes, .. } => u64::from(*bytes),
            Self::File { .. } => 0,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "format", deny_unknown_fields)]
pub enum ImageOutput {
    /// Baseline JPEG; alpha is flattened over `background` (black when absent).
    #[serde(rename = "jpeg")]
    Jpeg {
        #[serde(rename = "quality")]
        quality: u8,
        #[serde(
            rename = "background",
            default,
            skip_serializing_if = "Option::is_none"
        )]
        background: Option<[u8; 3]>,
    },
    /// 8-bit RGBA PNG (RGB when every pixel is opaque).
    #[serde(rename = "png")]
    Png,
    /// Straight RGBA, 4 bytes a pixel: pixels for a caller that reads them (tests, skins).
    #[serde(rename = "rgba")]
    Rgba,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum LayerFit {
    /// Stretched to the layer's box.
    #[serde(rename = "fill")]
    Fill,
    /// Scaled to fit inside the box, keeping its shape, centred.
    #[serde(rename = "contain")]
    Contain,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", deny_unknown_fields)]
pub enum Layer {
    #[serde(rename = "image")]
    Image {
        #[serde(rename = "input")]
        input: u32,
        #[serde(rename = "left")]
        left: i32,
        #[serde(rename = "top")]
        top: i32,
        #[serde(rename = "width")]
        width: u32,
        #[serde(rename = "height")]
        height: u32,
        #[serde(rename = "fit")]
        fit: LayerFit,
        /// An input whose alpha, drawn into the same box, multiplies this layer's.
        #[serde(rename = "mask", default, skip_serializing_if = "Option::is_none")]
        mask: Option<u32>,
    },
    /// A line of the built-in bitmap font, `size` pixels high.
    #[serde(rename = "text")]
    Text {
        #[serde(rename = "text")]
        text: String,
        #[serde(rename = "left")]
        left: i32,
        #[serde(rename = "top")]
        top: i32,
        #[serde(rename = "size")]
        size: u32,
        #[serde(rename = "color")]
        color: [u8; 4],
    },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", deny_unknown_fields)]
pub enum ImageOp {
    /// The first input's stored size, format and orientation, from its header.
    #[serde(rename = "probe")]
    Probe {
        #[serde(rename = "maxPixels")]
        max_pixels: u32,
    },
    /// The first input scaled down to fit `width` × `height` (never up), then encoded.
    #[serde(rename = "fit")]
    Fit {
        #[serde(rename = "maxPixels")]
        max_pixels: u32,
        #[serde(rename = "width")]
        width: u32,
        #[serde(rename = "height")]
        height: u32,
        #[serde(rename = "autoOrient")]
        auto_orient: bool,
        /// Pixels per SVG unit at most (1 when absent); raster inputs ignore it.
        #[serde(
            rename = "vectorScale",
            default,
            skip_serializing_if = "Option::is_none"
        )]
        vector_scale: Option<f64>,
        #[serde(rename = "output")]
        output: ImageOutput,
    },
    /// The first input's alpha plane, one byte a pixel.
    #[serde(rename = "alpha")]
    Alpha {
        #[serde(rename = "maxPixels")]
        max_pixels: u32,
    },
    /// Layers drawn in order, source over, on a `width` × `height` canvas.
    #[serde(rename = "compose")]
    Compose {
        #[serde(rename = "width")]
        width: u32,
        #[serde(rename = "height")]
        height: u32,
        #[serde(rename = "background")]
        background: [u8; 4],
        #[serde(rename = "maxPixels")]
        max_pixels: u32,
        #[serde(rename = "layers")]
        layers: Vec<Layer>,
        #[serde(rename = "output")]
        output: ImageOutput,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum SourceFormat {
    #[serde(rename = "jpeg")]
    Jpeg,
    #[serde(rename = "png")]
    Png,
    #[serde(rename = "webp")]
    Webp,
    #[serde(rename = "gif")]
    Gif,
    #[serde(rename = "ico")]
    Ico,
    #[serde(rename = "svg")]
    Svg,
    #[serde(rename = "rgba")]
    Rgba,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum DoneFormat {
    #[serde(rename = "jpeg")]
    Jpeg,
    #[serde(rename = "png")]
    Png,
    #[serde(rename = "alpha")]
    Alpha,
    #[serde(rename = "rgba")]
    Rgba,
    /// `probe`: no payload.
    #[serde(rename = "none")]
    None,
}

/// The (first) input as stored: before any turn or scale.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SourceImage {
    #[serde(rename = "format")]
    pub format: SourceFormat,
    #[serde(rename = "width")]
    pub width: u32,
    #[serde(rename = "height")]
    pub height: u32,
    /// EXIF orientation, 1 (upright) to 8.
    #[serde(rename = "orientation")]
    pub orientation: u8,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum ImageFailure {
    #[serde(rename = "invalid")]
    Invalid,
    #[serde(rename = "too-large")]
    TooLarge,
    #[serde(rename = "unsupported")]
    Unsupported,
    #[serde(rename = "truncated")]
    Truncated,
    #[serde(rename = "decode-failed")]
    DecodeFailed,
    #[serde(rename = "unreadable")]
    Unreadable,
    #[serde(rename = "busy")]
    Busy,
    #[serde(rename = "deadline")]
    Deadline,
    #[serde(rename = "cancelled")]
    Cancelled,
    #[serde(rename = "shutdown")]
    Shutdown,
}

// SPDX-License-Identifier: Apache-2.0
//! The look of a device as `@ace/protocol/devices`' `DeviceChrome` carries it: the body's
//! picture and size, where the screen sits in it, its shape and the hardware drawn over it.
//! Both SDK readers (Simulator chrome, emulator skins) build this one shape, in the schema's
//! key order, so `ace-json` writes what the TypeScript wrote.

use serde::Serialize;

/// A rectangle in body units.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// The body's size and picture, the screen's hole included.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Body {
    pub width: f64,
    pub height: f64,
    pub image: String,
}

/// A button the hardware shows from the front.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Button {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub rect: Rect,
    pub image: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pressed: Option<String>,
    #[serde(rename = "onTop")]
    pub on_top: bool,
}

/// Hardware drawn over the screen that the picture doesn't show.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Cutout {
    pub rect: Rect,
    pub image: String,
}

/// One device's look.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Chrome {
    pub body: Body,
    pub screen: Rect,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mask: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cutout: Option<Cutout>,
    pub buttons: Vec<Button>,
}

/// An SVG document as a data URL, as every picture in a look travels.
pub fn svg_url(svg: &str) -> String {
    use base64::Engine as _;
    format!(
        "data:image/svg+xml;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(svg)
    )
}

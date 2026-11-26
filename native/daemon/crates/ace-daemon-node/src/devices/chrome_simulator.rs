// SPDX-License-Identifier: Apache-2.0
//! The Simulator chrome exports of the device look (D3.4): the device type's bundle, its screens,
//! the PDFs a chrome names and the look they draw. Values in, JSON out.

use std::collections::BTreeMap;

use ace_devices::platform::{
    chrome::Chrome,
    pdf_svg::{SvgArt, pdf_art},
    simulator_body::PlacedPiece,
    simulator_chrome::{ArtFrom, chrome_from_frame, frame},
    simulator_chrome_file::chrome_file,
    simulator_chrome_source::{art_path, bundle_matches, chrome_bundles, device_type_bundle},
    simulator_panels::{SimulatorPanel, profile, simulator_panels},
};
use napi_derive::napi;
use serde::Serialize;

use super::chrome::{parse, parse_json, text};

/// The device type's bundle from `simctl`'s list.
#[napi]
pub fn device_platform_device_type_bundle(types: String, identifier: String) -> Option<String> {
    device_type_bundle(&types, &identifier)
}

/// The chrome bundles a profile's identifier could live in.
#[napi]
pub fn device_platform_chrome_bundles(identifier: String, roots: String) -> napi::Result<String> {
    let roots: Vec<String> = parse(&roots)?;
    text(&chrome_bundles(&identifier, &roots))
}

/// Whether a chrome bundle's file belongs to the identifier the profile named.
#[napi]
pub fn device_platform_bundle_matches(text_: String, identifier: String) -> bool {
    bundle_matches(&text_, &identifier)
}

#[derive(Serialize)]
pub struct ArtPath {
    key: String,
    path: String,
}

/// The PDFs a chrome names, inside the bundles they come from, with the key each is answered by.
#[napi]
pub fn device_platform_simulator_art_paths(
    bundle: String,
    chrome_directory: String,
    chrome_json: String,
    mask: Option<String>,
    sensor_bar: Option<String>,
) -> napi::Result<String> {
    let (resources, chrome_resources) =
        ace_devices::platform::simulator_chrome_source::resource_directories(
            &bundle,
            &chrome_directory,
        );
    let value = parse_json(&chrome_json)?;
    let Some(file) = chrome_file(&value) else {
        return Ok("null".to_string());
    };
    let mut paths: Vec<ArtPath> = Vec::new();
    let mut add = |key: String, from_chrome: bool, name: &str| {
        if let Some(path) = art_path(&resources, &chrome_resources, from_chrome, name) {
            paths.push(ArtPath { key, path });
        }
    };
    if let Some(composite) = &file.composite {
        add("w".to_string(), true, composite);
    }
    for (index, piece) in ace_devices::platform::simulator_body::PIECES
        .iter()
        .enumerate()
    {
        if let Some(name) = file.piece(piece) {
            add(format!("p{index}"), true, name);
        }
    }
    if let Some(middle) = file.middle() {
        add("c".to_string(), true, middle);
    }
    for (index, input) in file.inputs.iter().enumerate() {
        add(format!("b{index}"), true, &input.image);
        if let Some(down) = &input.image_down {
            add(format!("d{index}"), true, down);
        }
    }
    if let Some(mask) = &mask {
        add("m".to_string(), false, mask);
    }
    if let Some(bar) = &sensor_bar {
        add("s".to_string(), false, bar);
    }
    text(&paths)
}

/// A device type's built-in screens, from its profile and capabilities files.
#[napi]
pub fn device_platform_simulator_panels(
    profile_json: Option<String>,
    capabilities_json: Option<String>,
) -> napi::Result<String> {
    let Some(profile) = profile_json
        .as_deref()
        .and_then(|text| parse_json(text).ok())
        .and_then(|value| profile(&value))
    else {
        return Ok("[]".to_string());
    };
    let capabilities = capabilities_json
        .as_deref()
        .and_then(|text| parse_json(text).ok());
    text(&simulator_panels(&profile, capabilities.as_ref()))
}

/// Whether a chrome frame still needs painting, and the pieces that paint it.
#[derive(Serialize)]
pub struct PaintedBody {
    width: f64,
    height: f64,
    pieces: Vec<PlacedPiece>,
}

#[derive(Serialize)]
pub struct ChromeAnswer {
    chrome: Option<Chrome>,
    #[serde(skip_serializing_if = "Option::is_none")]
    paint: Option<PaintedBody>,
}

/// The PDFs a look names, by the key the paths request gave them: base64 text to SVG art.
fn art_at(arts: &BTreeMap<String, String>, prefix: &str) -> Option<SvgArt> {
    let bytes = ace_devices::platform::pdf_svg::decode_base64(arts.get(prefix)?)?;
    pdf_art(&bytes, prefix)
}

/// The Simulator look for one screen. `body_url` is the painted body when the caller has drawn
/// the pieces; without it, a sliced frame answers only what still has to be painted.
#[napi]
pub fn device_platform_simulator_chrome(
    panel: String,
    chrome_json: String,
    arts: String,
    body_url: Option<String>,
) -> napi::Result<String> {
    let panel: SimulatorPanel = parse(&panel)?;
    let value = parse_json(&chrome_json)?;
    let Some(file) = chrome_file(&value) else {
        return text(&ChromeAnswer {
            chrome: None,
            paint: None,
        });
    };
    let arts: BTreeMap<String, String> = parse(&arts)?;
    let read = |_from: ArtFrom, _name: &str, prefix: &str| art_at(&arts, prefix);
    let Some(frame) = frame(&panel, &file, &read) else {
        return text(&ChromeAnswer {
            chrome: None,
            paint: None,
        });
    };
    let paint = frame.pieces.as_ref().map(|pieces| PaintedBody {
        width: frame.body.0,
        height: frame.body.1,
        pieces: pieces.clone(),
    });
    let painted = match (frame.pieces.is_some(), body_url.as_deref()) {
        (true, None) => {
            return text(&ChromeAnswer {
                chrome: None,
                paint,
            });
        }
        (true, Some(url)) => Some(url.to_string()),
        (false, _) => None,
    };
    let chrome = chrome_from_frame(&panel, &file, &frame, painted.as_deref(), &read);
    text(&ChromeAnswer { chrome, paint })
}

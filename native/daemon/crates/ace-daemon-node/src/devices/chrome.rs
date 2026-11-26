// SPDX-License-Identifier: Apache-2.0
//! The device look exports (D3.4): the chrome reader's and sources' decisions, the emulator
//! skin's geometry and the Simulator chrome's, plus the image failures ace-media reports. Every
//! function translates arguments and one JSON answer; nothing here decides anything.
//!
//! A read is a step: the shell asks, reads what the answer names, and asks again with the files
//! it has. Paths, names, bounds and the markup itself all come from `ace-devices`.

use std::collections::BTreeMap;

use ace_devices::platform::{
    android_skin_files::{
        ConfigStep, LayoutStep, avd_config_step, ini_values, skin_directories, skin_layout_step,
    },
    chrome::Chrome,
    chrome_raster::{chrome_as_png, png_requests},
    device_chrome_reader::{CACHE_CAP, chrome_key, png_key},
    device_chrome_sources::{avd_roots, chrome_roots},
    device_images::{LOOK_DEADLINE_MS, SHOT_DEADLINE_MS, device_image_error},
};
use napi_derive::napi;
use serde::Serialize;

/// The addon's own parse: a document the shell wrote, through `ace-json` so JavaScript's strings
/// and numbers survive it.
pub(crate) fn parse<T: serde::de::DeserializeOwned>(text: &str) -> napi::Result<T> {
    let value = ace_json::parse(text)
        .map_err(|error| napi::Error::from_reason(format!("ace-devices: {error}")))?;
    ace_json::from_value(&value)
        .map_err(|error| napi::Error::from_reason(format!("ace-devices: {error}")))
}

pub(crate) fn text<T: Serialize>(value: &T) -> napi::Result<String> {
    ace_json::ser::to_string(value)
        .map_err(|error| napi::Error::from_reason(format!("ace-devices: {error}")))
}

pub(crate) fn parse_json(text: &str) -> napi::Result<ace_json::Value> {
    ace_json::parse(text).map_err(|error| napi::Error::from_reason(format!("ace-devices: {error}")))
}

/// A files map as the shell sends it: a path to its bytes.
type Files = BTreeMap<String, Vec<u8>>;

fn as_text(files: &Files, path: &str) -> Option<String> {
    files
        .get(path)
        .map(|bytes| String::from_utf8_lossy(bytes).into_owned())
}

/// The deadline and per-unit bounds of every look and shot, so the shell takes them from here.
#[derive(Serialize)]
pub struct ImageLimits {
    #[serde(rename = "shotDeadlineMs")]
    shot_deadline_ms: u64,
    #[serde(rename = "lookDeadlineMs")]
    look_deadline_ms: u64,
    #[serde(rename = "cacheCap")]
    cache_cap: usize,
}

#[napi]
pub fn device_platform_image_limits() -> napi::Result<String> {
    text(&ImageLimits {
        shot_deadline_ms: SHOT_DEADLINE_MS,
        look_deadline_ms: LOOK_DEADLINE_MS,
        cache_cap: CACHE_CAP,
    })
}

/// `deviceImageError`: a failed image job as the `DeviceError` an agent or person can act on.
#[napi]
pub fn device_platform_image_error(
    what: String,
    reason: Option<String>,
    message: Option<String>,
) -> napi::Result<String> {
    text(&device_image_error(
        &what,
        reason.as_deref(),
        message.as_deref(),
    ))
}

/// What a look is remembered by: the AVD, or the Simulator's device type and shown screen.
#[napi]
pub fn device_platform_chrome_key(
    platform: String,
    avd: String,
    simulator_type: Option<String>,
    open: bool,
) -> napi::Result<Option<String>> {
    let platform = ace_devices::platform::Platform::parse(&platform)
        .map_err(|error| napi::Error::from_reason(format!("ace-devices: {error}")))?;
    Ok(chrome_key(platform, &avd, simulator_type.as_deref(), open))
}

#[napi]
pub fn device_platform_png_key(key: String) -> String {
    png_key(&key)
}

/// The folders a chrome read searches: the AVD roots and Xcode's DeviceKit roots.
#[derive(Serialize)]
pub struct ChromeRoots {
    #[serde(rename = "avdRoots")]
    avd_roots: Vec<String>,
    #[serde(rename = "chromeRoots")]
    chrome_roots: Vec<String>,
}

#[napi]
pub fn device_platform_chrome_roots(env: String, home: String) -> napi::Result<String> {
    let env: BTreeMap<String, String> = parse(&env)?;
    text(&ChromeRoots {
        avd_roots: avd_roots(&env, &home),
        chrome_roots: chrome_roots(&home),
    })
}

#[derive(Serialize)]
pub struct ReadStep {
    read: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    directory: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    text: Option<String>,
}

/// The AVD's config, or the config files the shell must read next.
#[napi]
pub fn device_platform_avd_config(
    avd: String,
    roots: String,
    files: String,
) -> napi::Result<String> {
    let roots: Vec<String> = parse(&roots)?;
    let files: Files = parse(&files)?;
    let read = |path: &str| as_text(&files, path);
    match avd_config_step(&avd, &roots, &read) {
        ConfigStep::Read(read) => text(&ReadStep {
            read,
            directory: None,
            text: None,
        }),
        ConfigStep::Config(values) => text(&ReadStep {
            read: Vec::new(),
            directory: None,
            text: Some(encode_ini(&values)),
        }),
    }
}

/// An `.ini` file's pairs as the text the next step parses again: the config crosses as text so
/// one reader decides what it says.
fn encode_ini(values: &[(String, String)]) -> String {
    values
        .iter()
        .map(|(key, value)| format!("{key}={value}\n"))
        .collect()
}

/// The directories an AVD's skin could live in, from its config.
#[napi]
pub fn device_platform_skin_directories(config: String, sdk_roots: String) -> napi::Result<String> {
    let sdk_roots: Vec<String> = parse(&sdk_roots)?;
    text(&skin_directories(&ini_values(&config), &sdk_roots))
}

/// The first skin folder with a layout, or the layouts the shell must read next.
#[napi]
pub fn device_platform_skin_layout(directories: String, files: String) -> napi::Result<String> {
    let directories: Vec<String> = parse(&directories)?;
    let files: Files = parse(&files)?;
    let read = |path: &str| as_text(&files, path);
    match skin_layout_step(&directories, &read) {
        LayoutStep::Read(read) => text(&ReadStep {
            read,
            directory: None,
            text: None,
        }),
        LayoutStep::Layout(directory, layout) => text(&ReadStep {
            read: Vec::new(),
            directory: Some(directory),
            text: Some(layout),
        }),
    }
}

#[derive(Serialize)]
pub struct PngRequest {
    svgs: Vec<String>,
}

#[derive(Serialize)]
pub struct PngAnswer {
    chrome: Option<Chrome>,
}

/// A look's SVG images drawn as PNG: first the images to draw, then the look built from them.
/// `rendered` maps each SVG data URL to the PNG data URL the caller drew.
#[napi]
pub fn device_platform_chrome_to_png(
    chrome_json: String,
    rendered: Option<String>,
) -> napi::Result<String> {
    let chrome: Chrome = parse(&chrome_json)?;
    let Some(rendered) = rendered else {
        return text(&PngRequest {
            svgs: png_requests(&chrome),
        });
    };
    let rendered: BTreeMap<String, String> = parse(&rendered)?;
    let png = chrome_as_png(&chrome, &|url: &str| rendered.get(url).cloned());
    text(&PngAnswer { chrome: png })
}

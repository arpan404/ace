// SPDX-License-Identifier: Apache-2.0
//! `simulator-panels.ts`: a Simulator device type's built-in screens. Older Xcodes describe the
//! one screen in the device type's `profile.plist` (`mainScreenWidth` and friends); Xcode 27
//! lists every screen in `capabilities.plist` instead, each with its own chrome and mask, so a
//! foldable iPhone Duo has a cover panel and an inner panel. Pure: parsed JSON in, panels out.

use serde::Serialize;

use super::posture::{Posture, is_open};

/// A panel's size in points (`z.number().finite().positive().max(100_000)`).
fn size(value: Option<&ace_json::Value>) -> Option<f64> {
    value
        .and_then(ace_json::Value::as_f64)
        .filter(|number| number.is_finite() && *number > 0.0 && *number <= 100_000.0)
}

/// A resource name (`z.string().min(1).max(256)`, counted in code points as zod counts them).
fn name(value: Option<&ace_json::Value>) -> Option<String> {
    let text = value?.as_str()?;
    let length = text.chars().count();
    match (1..=256).contains(&length) {
        true => Some(text.to_string()),
        false => None,
    }
}

/// One built-in screen: its size in points, the chrome it wears, its mask and its notch.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SimulatorPanel {
    pub width: f64,
    pub height: f64,
    #[serde(rename = "chromeIdentifier", skip_serializing_if = "Option::is_none")]
    pub chrome_identifier: Option<String>,
    #[serde(rename = "framebufferMask", skip_serializing_if = "Option::is_none")]
    pub framebuffer_mask: Option<String>,
    #[serde(rename = "sensorBarImage", skip_serializing_if = "Option::is_none")]
    pub sensor_bar_image: Option<String>,
}

/// The fields of a device type's `profile.plist` ace uses; every other one is ignored.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SimulatorProfile {
    pub main_screen_width: Option<f64>,
    pub main_screen_height: Option<f64>,
    pub main_screen_scale: Option<f64>,
    pub framebuffer_mask: Option<String>,
    pub sensor_bar_image: Option<String>,
    pub chrome_identifier: Option<String>,
}

/// `SimulatorProfile.safeParse`: the profile's fields, or none when it isn't an object.
pub fn profile(value: &ace_json::Value) -> Option<SimulatorProfile> {
    let object = value.as_object()?;
    Some(SimulatorProfile {
        main_screen_width: size(object.get("mainScreenWidth")),
        main_screen_height: size(object.get("mainScreenHeight")),
        main_screen_scale: size(object.get("mainScreenScale")),
        framebuffer_mask: name(object.get("framebufferMask")),
        sensor_bar_image: name(object.get("sensorBarImage")),
        chrome_identifier: name(object.get("chromeIdentifier")),
    })
}

/// One listed display, when `capabilities.plist` describes an integrated screen.
#[derive(Debug, Clone, PartialEq)]
struct Display {
    width: f64,
    height: f64,
    scale: f64,
    chrome_identifier: Option<String>,
    framebuffer_mask_identifier: Option<String>,
}

fn display(value: &ace_json::Value) -> Option<Display> {
    let object = value.as_object()?;
    if object.get("displayType")?.as_str()? != "integrated" {
        return None;
    }
    Some(Display {
        width: size(object.get("width"))?,
        height: size(object.get("height"))?,
        scale: size(object.get("scale"))?,
        chrome_identifier: name(object.get("chromeIdentifier")),
        framebuffer_mask_identifier: name(object.get("framebufferMaskIdentifier")),
    })
}

/// The displays `capabilities.plist` lists: more than sixteen is not a list ace reads, which
/// zod's `.max(16).catch([])` turns into none at all.
fn displays(capabilities: Option<&ace_json::Value>) -> Vec<Display> {
    let listed = capabilities
        .and_then(ace_json::Value::as_object)
        .and_then(|object| object.get("capabilities"))
        .and_then(ace_json::Value::as_object)
        .and_then(|capabilities| capabilities.get("displays"))
        .and_then(ace_json::Value::as_array);
    let Some(listed) = listed else {
        return Vec::new();
    };
    if listed.len() > 16 {
        return Vec::new();
    }
    listed.iter().filter_map(display).collect()
}

/// The device type's built-in screens, the one it shows by default first (an iPhone Duo's
/// cover). A screen's own chrome and mask win over the profile's; the notch is the first
/// screen's only, as the profile names one for the device. Empty when neither file says how big
/// the screen is.
pub fn simulator_panels(
    profile: &SimulatorProfile,
    capabilities: Option<&ace_json::Value>,
) -> Vec<SimulatorPanel> {
    let panels: Vec<SimulatorPanel> = displays(capabilities)
        .into_iter()
        .enumerate()
        .map(|(index, display)| SimulatorPanel {
            width: display.width / display.scale,
            height: display.height / display.scale,
            chrome_identifier: display
                .chrome_identifier
                .or_else(|| profile.chrome_identifier.clone()),
            framebuffer_mask: display
                .framebuffer_mask_identifier
                .or_else(|| match index == 0 {
                    true => profile.framebuffer_mask.clone(),
                    false => None,
                }),
            sensor_bar_image: match index == 0 {
                true => profile.sensor_bar_image.clone(),
                false => None,
            },
        })
        .collect();
    if !panels.is_empty() {
        return panels;
    }
    let (Some(width), Some(height), Some(scale)) = (
        profile.main_screen_width,
        profile.main_screen_height,
        profile.main_screen_scale,
    ) else {
        return Vec::new();
    };
    vec![SimulatorPanel {
        width: width / scale,
        height: height / scale,
        chrome_identifier: profile.chrome_identifier.clone(),
        framebuffer_mask: profile.framebuffer_mask.clone(),
        sensor_bar_image: profile.sensor_bar_image.clone(),
    }]
}

/// The screen a device shows in `posture`: a foldable's inner panel once it is open, even half
/// way, and its cover while shut. A device that doesn't fold always shows its one screen.
pub fn shown_panel(panels: &[SimulatorPanel], posture: Option<Posture>) -> Option<&SimulatorPanel> {
    match is_open(posture) {
        true => panels.get(1).or_else(|| panels.first()),
        false => panels.first(),
    }
}

// SPDX-License-Identifier: Apache-2.0
//! `device-chrome-reader.ts`: a device's look read once per kind of hardware and kept. Apple's
//! and Google's files don't change while ace runs, so the reader remembers what it found. The
//! key and the cap are decided here; the shell holds the promises.

use crate::platform::Platform;

/// Looks remembered before the oldest is forgotten.
pub const CACHE_CAP: usize = 64;

/// What a look is remembered by: the AVD, or the Simulator's device type and the screen it
/// shows. A Simulator whose device type isn't listed has no key, so nothing is remembered.
pub fn chrome_key(
    platform: Platform,
    avd: &str,
    simulator_type: Option<&str>,
    open: bool,
) -> Option<String> {
    match platform {
        Platform::Android => Some(format!("android:{avd}")),
        Platform::Ios => {
            let kind = simulator_type?;
            let screen = match open {
                true => "open",
                false => "closed",
            };
            Some(format!("ios:{kind}:{screen}"))
        }
    }
}

/// The key a PNG look is remembered by, drawn from the SVG look's.
pub fn png_key(key: &str) -> String {
    format!("png:{key}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_look_is_remembered_by_its_hardware_and_the_screen_it_shows() {
        assert_eq!(
            chrome_key(Platform::Android, "Pixel_7", None, false).as_deref(),
            Some("android:Pixel_7")
        );
        let kind = "com.apple.CoreSimulator.SimDeviceType.iPhone-18-Pro";
        assert_eq!(
            chrome_key(Platform::Ios, "udid", Some(kind), false),
            Some(format!("ios:{kind}:closed"))
        );
        assert_eq!(
            chrome_key(Platform::Ios, "udid", Some(kind), true),
            Some(format!("ios:{kind}:open"))
        );
        // A Simulator ace can't name a device type for is read again each time.
        assert_eq!(chrome_key(Platform::Ios, "udid", None, true), None);
    }

    #[test]
    fn a_png_look_is_its_svg_looks_key_under_another_prefix() {
        assert_eq!(png_key("ios:kind:open"), "png:ios:kind:open");
        assert_eq!(png_key(""), "png:");
    }
}

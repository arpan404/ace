// SPDX-License-Identifier: Apache-2.0
//! `simulator-screens.ts`: the built-in screens `devicectl device info displays` lists, and the
//! one a touch belongs to.

use ace_json::Value;
use serde::{Deserialize, Serialize};

/// One of a Simulator's built-in screens: devicectl's display id, native pixel size, and lit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SimulatorScreen {
    pub id: u8,
    pub width: f64,
    pub height: f64,
    pub active: bool,
}

fn screen(raw: &Value) -> Option<SimulatorScreen> {
    let id = raw.get("displayId")?.as_u64()?;
    if id > 64 {
        return None;
    }
    let size = raw.get("nativeSize")?.as_array()?;
    if size.len() != 2 {
        return None;
    }
    let width = size[0].as_f64()?;
    let height = size[1].as_f64()?;
    if width <= 0.0 || height <= 0.0 {
        return None;
    }
    Some(SimulatorScreen {
        id: id as u8,
        width,
        height,
        active: raw.get("active").and_then(Value::as_bool) == Some(true),
    })
}

/// The screens in `devicectl device info displays --json-output`; empty when unreadable.
pub fn read_screens(report: &Value) -> Vec<SimulatorScreen> {
    let Some(displays) = report
        .get("result")
        .and_then(|result| result.get("displays"))
        .and_then(Value::as_array)
    else {
        return Vec::new();
    };
    if displays.len() > 16 {
        return Vec::new();
    }
    displays.iter().filter_map(screen).collect()
}

fn near(a: f64, b: f64) -> bool {
    (a - b).abs() <= 2.0
}

/// The display a touch belongs to, as the digitizer service names it: 0, the main screen, unless
/// the device has several screens (a foldable's cover and inner panels). Then it is the one the
/// streamed picture shows, matched by size (encoders round sizes to even pixels, so a pixel or
/// two either way still matches), or with no picture yet the one devicectl says is lit.
pub fn touch_target(screens: &[SimulatorScreen], picture: Option<(f64, f64)>) -> u8 {
    if screens.len() < 2 {
        return 0;
    }
    let shown = picture.and_then(|(width, height)| {
        screens.iter().find(|screen| {
            (near(screen.width, width) && near(screen.height, height))
                || (near(screen.width, height) && near(screen.height, width))
        })
    });
    shown
        .or_else(|| screens.iter().find(|screen| screen.active))
        .map_or(0, |screen| screen.id)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `devicectl device info displays --json-output` for an unfolded iPhone Duo, trimmed.
    fn duo(inner_lit: bool) -> Value {
        ace_json::json!({
            "result": {
                "backlightState": "on",
                "displays": [
                    {"displayId": 1, "name": "LCD", "nativeSize": [1398, 2034], "primary": true, "active": !inner_lit},
                    {"displayId": 3, "name": "LCD-1", "nativeSize": [2007, 2853], "primary": false, "active": inner_lit},
                ],
            }
        })
    }

    #[test]
    fn a_touch_on_a_foldable_goes_to_the_screen_its_picture_shows() {
        let screens = read_screens(&duo(true));
        assert_eq!(screens.len(), 2);
        // The encoder rounds the inner panel to even pixels.
        assert_eq!(touch_target(&screens, Some((2006.0, 2852.0))), 3);
        assert_eq!(touch_target(&screens, Some((1398.0, 2034.0))), 1);
    }

    #[test]
    fn before_there_is_a_picture_a_touch_goes_to_the_lit_screen() {
        assert_eq!(touch_target(&read_screens(&duo(true)), None), 3);
        assert_eq!(touch_target(&read_screens(&duo(false)), None), 1);
    }

    #[test]
    fn a_phone_with_one_screen_or_a_report_devicectl_could_not_give_touches_the_main_screen() {
        let phone = ace_json::json!({"result": {"displays": [{"displayId": 1, "nativeSize": [1206, 2622], "active": true}]}});
        assert_eq!(
            touch_target(&read_screens(&phone), Some((1206.0, 2622.0))),
            0
        );
        assert_eq!(
            touch_target(&read_screens(&ace_json::json!("not json")), None),
            0
        );
    }
}

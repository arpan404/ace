use crate::errors::{Code, Error, Result};
use serde::Deserialize;
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Action {
    pub kind: String,
    pub x: Option<f64>,
    pub y: Option<f64>,
    pub to_x: Option<f64>,
    pub to_y: Option<f64>,
    pub button: Option<String>,
    pub text: Option<String>,
    pub key: Option<String>,
    pub key_code: Option<u16>,
    #[serde(default)]
    pub modifiers: Vec<String>,
    pub dx: Option<i32>,
    pub dy: Option<i32>,
    pub delta_x: Option<i32>,
    pub delta_y: Option<i32>,
}
impl Action {
    pub fn click(x: f64, y: f64) -> Self {
        Self {
            kind: "pointer.click".into(),
            x: Some(x),
            y: Some(y),
            to_x: None,
            to_y: None,
            button: Some("left".into()),
            text: None,
            key: None,
            key_code: None,
            modifiers: vec![],
            dx: None,
            dy: None,
            delta_x: None,
            delta_y: None,
        }
    }
}
#[derive(Debug, Clone, PartialEq)]
pub enum Event {
    Move {
        x: f64,
        y: f64,
    },
    Button {
        right: bool,
        up: bool,
    },
    Key {
        code: u16,
        unit: u16,
        up: bool,
        unicode: bool,
        extended: bool,
    },
    Wheel {
        horizontal: bool,
        delta: i32,
    },
}
fn key(code: u16, up: bool) -> Event {
    Event::Key {
        code,
        unit: 0,
        up,
        unicode: false,
        extended: [
            0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x2d, 0x2e, 0x5b,
        ]
        .contains(&code),
    }
}
fn missing() -> Error {
    Error::new(Code::Bounds, "Missing input argument")
}
fn point(x: Option<f64>, y: Option<f64>) -> Result<Event> {
    let x = x.ok_or_else(missing)?;
    let y = y.ok_or_else(missing)?;
    if !x.is_finite() || !y.is_finite() || x < 0.0 || y < 0.0 {
        return Err(Error::new(Code::Bounds, "Invalid input point"));
    }
    Ok(Event::Move { x, y })
}
/// Full validation precedes any OS call. UTF-16 pairs preserve non-BMP characters.
pub fn plan(action: &Action) -> Result<Vec<Event>> {
    let mut events = vec![];
    match action.kind.as_str() {
        "pointer.move" | "pointer.click" | "pointer.drag" | "click" => {
            events.push(point(action.x, action.y)?);
            if action.kind != "pointer.move" {
                let right = match action.button.as_deref().unwrap_or("left") {
                    "left" => false,
                    "right" => true,
                    _ => return Err(Error::new(Code::Bounds, "Invalid button")),
                };
                events.push(Event::Button { right, up: false });
                if action.kind == "pointer.drag" {
                    events.push(point(action.to_x, action.to_y)?);
                }
                events.push(Event::Button { right, up: true });
            }
        }
        "text.type" | "type" => {
            let text = action.text.as_ref().ok_or_else(missing)?;
            if text.encode_utf16().count() > 8192 {
                return Err(Error::new(Code::Bounds, "Text limit"));
            }
            for unit in text.encode_utf16() {
                for up in [false, true] {
                    events.push(Event::Key {
                        code: 0,
                        unit,
                        up,
                        unicode: true,
                        extended: false,
                    });
                }
            }
        }
        "key.press" | "key" => {
            if action.modifiers.len() > 4 {
                return Err(Error::new(Code::Bounds, "Modifier limit"));
            }
            let code = if let Some(name) = &action.key {
                virtual_key(name)?
            } else {
                legacy_key(action.key_code.ok_or_else(missing)?)?
            };
            let mods = action
                .modifiers
                .iter()
                .map(|name| match name.as_str() {
                    "control" => Ok(0x11),
                    "shift" => Ok(0x10),
                    "alt" | "option" => Ok(0x12),
                    "meta" | "command" => Ok(0x5b),
                    _ => Err(Error::new(Code::Bounds, "Invalid modifier")),
                })
                .collect::<Result<Vec<u16>>>()?;
            for modifier in &mods {
                events.push(key(*modifier, false));
            }
            events.push(key(code, false));
            events.push(key(code, true));
            for modifier in mods.into_iter().rev() {
                events.push(key(modifier, true));
            }
        }
        "scroll" => {
            if action.x.is_some() || action.y.is_some() {
                events.push(point(action.x, action.y)?);
            }
            let dx = action.dx.or(action.delta_x).unwrap_or(0);
            let dy = action.dy.or(action.delta_y).unwrap_or(0);
            if dx.unsigned_abs() > 1000 || dy.unsigned_abs() > 1000 {
                return Err(Error::new(Code::Bounds, "Scroll limit"));
            }
            if dx != 0 {
                events.push(Event::Wheel {
                    horizontal: true,
                    delta: dx,
                });
            }
            if dy != 0 {
                events.push(Event::Wheel {
                    horizontal: false,
                    delta: dy,
                });
            }
        }
        _ => return Err(Error::new(Code::NotSupported, "Unsupported input")),
    }
    Ok(events)
}
fn virtual_key(name: &str) -> Result<u16> {
    let upper = name.to_ascii_uppercase();
    if upper.len() == 1 {
        let byte = upper.as_bytes()[0];
        if byte.is_ascii_alphanumeric() {
            return Ok(byte as u16);
        }
    }
    Ok(match upper.as_str() {
        "ENTER" => 0x0d,
        "TAB" => 0x09,
        "ESCAPE" => 0x1b,
        "SPACE" => 0x20,
        "BACKSPACE" => 0x08,
        "DELETE" => 0x2e,
        "INSERT" => 0x2d,
        "ARROWLEFT" => 0x25,
        "ARROWRIGHT" => 0x27,
        "ARROWUP" => 0x26,
        "ARROWDOWN" => 0x28,
        "HOME" => 0x24,
        "END" => 0x23,
        "PAGEUP" => 0x21,
        "PAGEDOWN" => 0x22,
        _ => {
            if let Some(number) = upper
                .strip_prefix('F')
                .and_then(|s| s.parse::<u16>().ok())
                .filter(|n| (1..=24).contains(n))
            {
                0x70 + number - 1
            } else {
                return Err(Error::new(
                    Code::NotSupported,
                    "Use a named key or Unicode text",
                ));
            }
        }
    })
}
fn legacy_key(code: u16) -> Result<u16> {
    let name = match code {
        0 => "A",
        1 => "S",
        2 => "D",
        3 => "F",
        4 => "H",
        5 => "G",
        6 => "Z",
        7 => "X",
        8 => "C",
        9 => "V",
        11 => "B",
        12 => "Q",
        13 => "W",
        14 => "E",
        15 => "R",
        16 => "Y",
        17 => "T",
        31 => "O",
        32 => "U",
        34 => "I",
        35 => "P",
        37 => "L",
        38 => "J",
        40 => "K",
        45 => "N",
        46 => "M",
        36 => "ENTER",
        48 => "TAB",
        49 => "SPACE",
        51 => "BACKSPACE",
        53 => "ESCAPE",
        123 => "ARROWLEFT",
        124 => "ARROWRIGHT",
        125 => "ARROWDOWN",
        126 => "ARROWUP",
        _ => {
            return Err(Error::new(
                Code::NotSupported,
                "Legacy key code has no portable mapping; use key.press",
            ))
        }
    };
    virtual_key(name)
}

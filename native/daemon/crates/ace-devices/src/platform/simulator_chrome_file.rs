// SPDX-License-Identifier: Apache-2.0
//! The parts of a Simulator chrome bundle's `chrome.json` ace uses, read as the zod schema
//! `SimulatorChromeFile` reads it: a button it can't read is left out, a piece it can't read
//! makes the whole chrome unusable, and string bounds count code points as zod counts them.

use ace_json::Value;

/// `z.string().min(1).max(256)`: a resource name.
fn name(value: Option<&Value>) -> Option<String> {
    bounded_name(value, 256)
}

/// A string of one to `max` code points, as zod bounds it.
fn bounded_name(value: Option<&Value>, max: usize) -> Option<String> {
    let text = value?.as_str()?;
    let length = text.chars().count();
    match (1..=max).contains(&length) {
        true => Some(text.to_string()),
        false => None,
    }
}

/// `z.string().max(64).optional().catch(undefined)`.
fn title(value: Option<&Value>) -> Option<String> {
    let text = value?.as_str()?;
    match text.chars().count() <= 64 {
        true => Some(text.to_string()),
        false => None,
    }
}

/// A finite number in the schema's range.
fn bounded(value: Option<&Value>, low: f64, high: f64) -> Option<f64> {
    value
        .and_then(Value::as_f64)
        .filter(|number| number.is_finite() && *number >= low && *number <= high)
}

/// `offset = z.number().finite().min(-100_000).max(100_000)`.
const OFFSET: f64 = 100_000.0;

/// How far along its edge a button runs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Align {
    Leading,
    Trailing,
    Center,
}

/// The edge a button stands on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Anchor {
    Left,
    Right,
    Top,
    Bottom,
}

/// One button the chrome describes.
#[derive(Debug, Clone, PartialEq)]
pub struct ChromeInput {
    pub name: String,
    pub accessibility_title: Option<String>,
    pub image: String,
    pub image_down: Option<String>,
    pub on_top: Option<bool>,
    pub anchor: Anchor,
    pub align: Align,
    pub offsets: (f64, f64),
}

/// One chrome bundle's images and the sizes its body is sliced at.
#[derive(Debug, Clone, PartialEq)]
pub struct ChromeFile {
    pub top_left: String,
    pub top: String,
    pub top_right: String,
    pub right: String,
    pub bottom_right: String,
    pub bottom: String,
    pub bottom_left: String,
    pub left: String,
    /// The fill behind the screen, stretched over the middle.
    pub screen: Option<String>,
    /// The whole body in one drawing, for the screen size it was made for.
    pub composite: Option<String>,
    pub left_width: f64,
    pub right_width: f64,
    pub top_height: f64,
    pub bottom_height: f64,
    pub inputs: Vec<ChromeInput>,
}

impl ChromeFile {
    /// The piece a body is sliced from, by its chrome name.
    pub fn piece(&self, name: &str) -> Option<&str> {
        let piece = match name {
            "topLeft" => &self.top_left,
            "top" => &self.top,
            "topRight" => &self.top_right,
            "right" => &self.right,
            "bottomRight" => &self.bottom_right,
            "bottom" => &self.bottom,
            "bottomLeft" => &self.bottom_left,
            "left" => &self.left,
            _ => return None,
        };
        Some(piece)
    }

    /// The chrome's screen fill, when it names one.
    pub fn middle(&self) -> Option<&str> {
        self.screen.as_deref()
    }
}

fn anchor(value: &str) -> Option<Anchor> {
    match value {
        "left" => Some(Anchor::Left),
        "right" => Some(Anchor::Right),
        "top" => Some(Anchor::Top),
        "bottom" => Some(Anchor::Bottom),
        _ => None,
    }
}

fn align(value: Option<&Value>) -> Align {
    match value.and_then(Value::as_str) {
        Some("trailing") => Align::Trailing,
        Some("center") => Align::Center,
        _ => Align::Leading,
    }
}

/// `ChromeInput.safeParse`: the fields ace uses, or none when a required one is missing.
fn input(value: &Value) -> Option<ChromeInput> {
    let object = value.as_object()?;
    let button_name = bounded_name(object.get("name"), 64)?;
    let title = title(object.get("accessibilityTitle"));
    let image = name(object.get("image"))?;
    let image_down = name(object.get("imageDown"));
    let on_top = object.get("onTop").and_then(Value::as_bool);
    let anchor = anchor(object.get("anchor")?.as_str()?)?;
    let align = align(object.get("align"));
    let normal = object
        .get("offsets")?
        .as_object()?
        .get("normal")?
        .as_object()?;
    let offsets = (
        bounded(normal.get("x"), -OFFSET, OFFSET)?,
        bounded(normal.get("y"), -OFFSET, OFFSET)?,
    );
    Some(ChromeInput {
        name: button_name,
        accessibility_title: title,
        image,
        image_down,
        on_top,
        anchor,
        align,
        offsets,
    })
}

/// `SimulatorChromeFile.safeParse`: the chrome ace draws, or none when it can't.
pub fn chrome_file(value: &Value) -> Option<ChromeFile> {
    let images = value.as_object()?.get("images")?.as_object()?;
    let sizing = images.get("sizing")?.as_object()?;
    let sizing_of = |key: &str| bounded(sizing.get(key), 0.0, 10_000.0);
    let inputs = value.as_object()?.get("inputs");
    let inputs: Vec<ChromeInput> = match inputs.and_then(Value::as_array) {
        Some(listed) if listed.len() <= 16 => listed.iter().filter_map(input).collect(),
        _ => Vec::new(),
    };
    Some(ChromeFile {
        top_left: name(images.get("topLeft"))?,
        top: name(images.get("top"))?,
        top_right: name(images.get("topRight"))?,
        right: name(images.get("right"))?,
        bottom_right: name(images.get("bottomRight"))?,
        bottom: name(images.get("bottom"))?,
        bottom_left: name(images.get("bottomLeft"))?,
        left: name(images.get("left"))?,
        screen: name(images.get("screen")),
        composite: name(images.get("composite")),
        left_width: sizing_of("leftWidth")?,
        right_width: sizing_of("rightWidth")?,
        top_height: sizing_of("topHeight")?,
        bottom_height: sizing_of("bottomHeight")?,
        inputs,
    })
}

/// A chrome bundle's identity: its `identifier`, when the file names one ace reads.
pub fn identity(value: &Value) -> Option<String> {
    let text = value.as_object()?.get("identifier")?.as_str()?;
    match text.chars().count() <= 512 {
        true => Some(text.to_string()),
        false => None,
    }
}

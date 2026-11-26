// SPDX-License-Identifier: Apache-2.0
//! `android-skin.ts`: an emulator skin's look. Its `layout` file (a tree of `name { ... }`
//! blocks and `key value` lines) says the portrait picture, the screen's shape and where the
//! display sits in it. Pure: the layout text and the images' alpha (decoded by ace-media) come
//! in, the `DeviceChrome` goes out.

use serde::{Deserialize, Serialize};

use super::jsnum;

pub use drawing::{DrawnBody, android_skin_chrome, drawn_body};

mod drawing;

/// One `name { ... }` block of the layout file.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct LayoutNode {
    pub values: Vec<(String, String)>,
    pub children: Vec<(String, LayoutNode)>,
}

impl LayoutNode {
    /// A value this block sets.
    pub fn value(&self, key: &str) -> Option<&str> {
        self.values
            .iter()
            .find(|(name, _)| name == key)
            .map(|(_, value)| value.as_str())
    }

    /// A block this one holds, by name.
    pub fn child(&self, name: &str) -> Option<&LayoutNode> {
        self.children
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, node)| node)
    }
}

/// JavaScript's `String.prototype.trim`: whitespace, and the byte-order mark it also strips.
fn is_space(character: char) -> bool {
    character.is_whitespace() || character == '\u{feff}'
}

fn trim(text: &str) -> &str {
    text.trim_matches(is_space)
}

/// The layout file as a tree. Lines it can't read are skipped.
pub fn parse_skin_layout(text: &str) -> LayoutNode {
    let mut root = LayoutNode::default();
    // The open blocks' names, from the root down; `}` closes the innermost.
    let mut open: Vec<String> = Vec::new();
    for raw in text.split('\n') {
        let line = trim(match raw.find('#') {
            Some(at) => &raw[..at],
            None => raw,
        });
        if line.is_empty() {
            continue;
        }
        if line == "}" {
            open.pop();
            continue;
        }
        if let Some(rest) = line.strip_suffix('{') {
            let name = rest.trim_end_matches(is_space);
            if !name.is_empty() && !name.contains(is_space) {
                // A block that would nest past the thirty-second level is read into its parent.
                if open.len() < 31 {
                    open.push(name.to_string());
                }
                node_at(&mut root, &open);
            }
            continue;
        }
        let Some(split) = line.find(is_space) else {
            continue;
        };
        let key = &line[..split];
        // `^(\S+)\s+(.+)$`: a key, at least one space, and one more character after it.
        if key.is_empty() || line[split..].chars().count() < 2 {
            continue;
        }
        let value = trim(&line[split..]);
        let node = node_at(&mut root, &open);
        match node.values.iter_mut().find(|(name, _)| name == key) {
            Some((_, existing)) => *existing = value.to_string(),
            None => node.values.push((key.to_string(), value.to_string())),
        }
    }
    root
}

/// The node at `path`, created (with its parents) where it doesn't exist yet.
fn node_at<'a>(root: &'a mut LayoutNode, path: &[String]) -> &'a mut LayoutNode {
    let mut node = root;
    for key in path {
        let at = match node.children.iter().position(|(name, _)| name == key) {
            Some(at) => at,
            None => {
                node.children.push((key.clone(), LayoutNode::default()));
                node.children.len() - 1
            }
        };
        node = &mut node.children[at].1;
    }
    node
}

/// `Number(value)` for a layout value: an empty string is 0, a hexadecimal integer is its
/// number, and anything unreadable or infinite is none (`Number.isFinite`).
fn number(node: Option<&LayoutNode>, key: &str) -> Option<f64> {
    let value = jsnum::parse(node?.value(key)?);
    value.is_finite().then_some(value)
}

/// A resource name in a layout is a plain file name, never a path.
fn file_name(value: Option<&str>) -> Option<String> {
    let value = value?;
    if value.is_empty() || value.contains(['/', '\\', '\0']) {
        return None;
    }
    let lower = value.to_lowercase();
    match lower.ends_with(".webp") || lower.ends_with(".png") {
        true => Some(value.to_string()),
        false => None,
    }
}

/// The share of the screen's short side each part of the drawn body takes.
const BEZEL_SHARE: f64 = 0.024;
const METAL_SHARE: f64 = 0.007;
/// A screen whose corners can't be measured is rounded this much of its short side.
const FALLBACK_RADIUS_SHARE: f64 = 0.05;

/// The most diagonal steps a corner scan takes. A skin's radius is a share of its short side,
/// and the largest skins are thousands of pixels, so a real corner is well inside this; a
/// layout naming an enormous side is still walked in this many steps.
pub const MAX_CORNER_REACH: usize = 16_384;

/// One of the skin's images as the reader found it: its data URL and the alpha along the
/// diagonal from the corner the chrome measures, one value a step.
#[derive(Debug, Clone, PartialEq)]
pub struct SkinImage {
    pub url: String,
    /// `None` where the pixel is outside the picture.
    pub scan: Vec<Option<u8>>,
}

/// Where the display sits in the skin's picture, and what the skin draws around it.
#[derive(Debug, Clone, PartialEq)]
pub struct Opening {
    pub width: f64,
    pub height: f64,
    pub x: f64,
    pub y: f64,
    pub background: String,
    pub mask: Option<String>,
    /// The screen's short side: what a corner radius is measured against.
    pub short: f64,
}

/// What the shell needs to read a skin's images and build its look: the opening's geometry and
/// the diagonal each image's corner is measured along.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SkinPlan {
    pub width: f64,
    pub height: f64,
    pub x: f64,
    pub y: f64,
    pub background: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mask: Option<String>,
    pub short: f64,
    pub reach: usize,
    /// Where the backdrop's scan starts, when the display's corner is a whole pixel of it.
    #[serde(rename = "backCorner", default)]
    pub back_corner: Option<(u32, u32)>,
}

impl SkinPlan {
    /// The opening this plan draws.
    pub fn opening(&self) -> Opening {
        Opening {
            width: self.width,
            height: self.height,
            x: self.x,
            y: self.y,
            background: self.background.clone(),
            mask: self.mask.clone(),
            short: self.short,
        }
    }
}

impl Opening {
    /// This opening as the shell reads it.
    pub fn plan(&self) -> SkinPlan {
        SkinPlan {
            width: self.width,
            height: self.height,
            x: self.x,
            y: self.y,
            background: self.background.clone(),
            mask: self.mask.clone(),
            short: self.short,
            reach: self.reach(),
            back_corner: self.back_corner(),
        }
    }

    /// How many steps along the diagonal a corner's scan takes. A corner's radius is a share
    /// of the screen's short side, and any real skin is far inside this bound; a layout that
    /// names an enormous side is still walked in a bounded number of steps.
    pub fn reach(&self) -> usize {
        let span = self.short / 2.0 * (1.0 - std::f64::consts::FRAC_1_SQRT_2);
        span.floor().clamp(0.0, MAX_CORNER_REACH as f64) as usize
    }

    /// Where the backdrop picture's diagonal scan starts, when the display's corner is a whole
    /// pixel of it: a fractional corner names no pixel, so its radius can't be measured.
    pub fn back_corner(&self) -> Option<(u32, u32)> {
        let whole =
            |value: f64| value.fract() == 0.0 && value >= 0.0 && value <= f64::from(u32::MAX);
        match whole(self.x) && whole(self.y) {
            true => Some((self.x as u32, self.y as u32)),
            false => None,
        }
    }
}

/// The radius of a rounded corner, found by walking in from it along the diagonal while the
/// picture stays opaque: a circle's corner leaves r·(1 − 1/√2) of it on the diagonal.
pub fn corner_radius(scan: &[Option<u8>], limit: f64) -> Option<f64> {
    let reach = (limit * (1.0 - std::f64::consts::FRAC_1_SQRT_2)).floor();
    if !reach.is_finite() || reach < 0.0 {
        return None;
    }
    for step in 0..=(reach as usize) {
        let alpha = (*scan.get(step)?)?;
        if alpha < 128 {
            return Some(match step {
                0 => 0.0,
                step => step as f64 / (1.0 - std::f64::consts::FRAC_1_SQRT_2),
            });
        }
    }
    None
}

/// The skin's portrait layout: the one named `portrait`, or, for a skin with no portrait layout
/// such as a tablet's, its first layout, its natural way up.
fn portrait(tree: &LayoutNode) -> Option<&LayoutNode> {
    let layouts = tree.child("layouts")?;
    layouts
        .children
        .iter()
        .find(|(name, _)| name == "portrait")
        .map(|(_, node)| node)
        .or_else(|| layouts.children.first().map(|(_, node)| node))
}

/// What the skin's `layout` file says ace can draw: the display's size and place and the images
/// around it, or none when its portrait layout isn't one ace draws.
pub fn opening(tree: &LayoutNode) -> Option<Opening> {
    let portrait = portrait(tree)?;
    let width = number(Some(portrait), "width")?;
    let height = number(Some(portrait), "height")?;
    if width <= 0.0 || height <= 0.0 {
        return None;
    }
    let parts: Vec<&LayoutNode> = portrait
        .children
        .iter()
        .filter(|(_, node)| node.value("name").is_some())
        .map(|(_, node)| node)
        .collect();
    let device = parts
        .iter()
        .find(|node| node.value("name") == Some("device"))?;
    let backdrop = parts
        .iter()
        .find(|node| node.value("name") != Some("device"))?;
    if number(Some(device), "rotation").unwrap_or(0.0) != 0.0 {
        return None;
    }
    // The picture fills the layout; a skin that offsets it isn't one ace draws.
    if number(Some(backdrop), "x").unwrap_or(0.0) != 0.0
        || number(Some(backdrop), "y").unwrap_or(0.0) != 0.0
    {
        return None;
    }
    let parts_root = tree.child("parts")?;
    let look = parts_root.child(backdrop.value("name")?)?;
    let display = parts_root.child("device")?.child("display")?;
    let x = number(Some(device), "x").unwrap_or(0.0) + number(Some(display), "x").unwrap_or(0.0);
    let y = number(Some(device), "y").unwrap_or(0.0) + number(Some(display), "y").unwrap_or(0.0);
    let opening_width = number(Some(display), "width").unwrap_or(0.0);
    let opening_height = number(Some(display), "height").unwrap_or(0.0);
    if opening_width <= 0.0 || opening_height <= 0.0 {
        return None;
    }
    let background = file_name(
        look.child("background")
            .and_then(|node| node.value("image")),
    )?;
    let mask = file_name(look.child("foreground").and_then(|node| node.value("mask")));
    let short = opening_width.min(opening_height);
    Some(Opening {
        width: opening_width,
        height: opening_height,
        x,
        y,
        background,
        mask,
        short,
    })
}

#[cfg(test)]
mod tests;

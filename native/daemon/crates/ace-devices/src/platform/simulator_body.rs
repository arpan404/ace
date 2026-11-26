// SPDX-License-Identifier: Apache-2.0
//! `simulator-body.ts`: a Simulator body built from its chrome's nine pieces. Where each piece
//! goes, and how the placed pieces become one picture. Pure: the default painter writes SVG;
//! the daemon passes one that paints PNG.

use super::chrome::Rect;
use super::jsnum::rounded;
use super::pdf_svg::SvgArt;

/// The pieces a chrome's body is sliced into.
pub const PIECES: [&str; 8] = [
    "topLeft",
    "top",
    "topRight",
    "right",
    "bottomRight",
    "bottom",
    "bottomLeft",
    "left",
];

/// One piece of art stretched over `rect` of the body (edges stretch, corners don't).
#[derive(Debug, Clone, PartialEq)]
pub struct PlacedPiece {
    pub art: SvgArt,
    pub rect: Rect,
}

fn at_least(value: f64) -> f64 {
    value.max(0.001)
}

/// The nine pieces a body is drawn from: eight around the screen and the fill behind it.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct BodyArt {
    pub top_left: Option<SvgArt>,
    pub top: Option<SvgArt>,
    pub top_right: Option<SvgArt>,
    pub right: Option<SvgArt>,
    pub bottom_right: Option<SvgArt>,
    pub bottom: Option<SvgArt>,
    pub bottom_left: Option<SvgArt>,
    pub left: Option<SvgArt>,
    /// The fill behind the screen, stretched over the middle.
    pub middle: Option<SvgArt>,
}

impl BodyArt {
    /// The piece by its chrome name, as the chrome file spells it.
    pub fn by_name(&self, name: &str) -> Option<&SvgArt> {
        match name {
            "topLeft" => self.top_left.as_ref(),
            "top" => self.top.as_ref(),
            "topRight" => self.top_right.as_ref(),
            "right" => self.right.as_ref(),
            "bottomRight" => self.bottom_right.as_ref(),
            "bottom" => self.bottom.as_ref(),
            "bottomLeft" => self.bottom_left.as_ref(),
            "left" => self.left.as_ref(),
            _ => None,
        }
    }
}

/// Every piece a sliced body needs: the eight edges and corners, all of them.
pub fn all_pieces(art: &BodyArt) -> bool {
    PIECES.iter().all(|name| art.by_name(name).is_some())
}

/// Where the pieces go around a body of `width` × `height`, in drawing order: the fill behind
/// the screen, the edges stretched between the corners (tucked one unit under them), then the
/// corners at their own size, as Simulator lays them out.
pub fn body_layout(art: &BodyArt, width: f64, height: f64) -> Option<Vec<PlacedPiece>> {
    let (Some(top_left), Some(top), Some(top_right)) =
        (art.top_left.clone(), art.top.clone(), art.top_right.clone())
    else {
        return None;
    };
    let (Some(right), Some(bottom_right), Some(bottom)) = (
        art.right.clone(),
        art.bottom_right.clone(),
        art.bottom.clone(),
    ) else {
        return None;
    };
    let (Some(bottom_left), Some(left)) = (art.bottom_left.clone(), art.left.clone()) else {
        return None;
    };
    let mut placed: Vec<PlacedPiece> = Vec::new();
    if let Some(middle) = art.middle.clone() {
        placed.push(PlacedPiece {
            art: middle,
            rect: Rect {
                x: left.width,
                y: top.height,
                width: at_least(width - left.width - right.width),
                height: at_least(height - top.height - bottom.height),
            },
        });
    }
    placed.push(PlacedPiece {
        art: top.clone(),
        rect: Rect {
            x: top_left.width - 1.0,
            y: 0.0,
            width: at_least(width - top_left.width - top_right.width + 2.0),
            height: top.height,
        },
    });
    placed.push(PlacedPiece {
        art: bottom.clone(),
        rect: Rect {
            x: bottom_left.width - 1.0,
            y: height - bottom.height,
            width: at_least(width - bottom_left.width - bottom_right.width + 2.0),
            height: bottom.height,
        },
    });
    placed.push(PlacedPiece {
        art: left.clone(),
        rect: Rect {
            x: 0.0,
            y: top_left.height - 1.0,
            width: left.width,
            height: at_least(height - top_left.height - bottom_left.height + 2.0),
        },
    });
    placed.push(PlacedPiece {
        art: right.clone(),
        rect: Rect {
            x: width - right.width,
            y: top_right.height - 1.0,
            width: right.width,
            height: at_least(height - top_right.height - bottom_right.height + 2.0),
        },
    });
    placed.push(PlacedPiece {
        art: top_left.clone(),
        rect: Rect {
            x: 0.0,
            y: 0.0,
            width: top_left.width,
            height: top_left.height,
        },
    });
    placed.push(PlacedPiece {
        art: top_right.clone(),
        rect: Rect {
            x: width - top_right.width,
            y: 0.0,
            width: top_right.width,
            height: top_right.height,
        },
    });
    placed.push(PlacedPiece {
        art: bottom_left.clone(),
        rect: Rect {
            x: 0.0,
            y: height - bottom_left.height,
            width: bottom_left.width,
            height: bottom_left.height,
        },
    });
    placed.push(PlacedPiece {
        art: bottom_right.clone(),
        rect: Rect {
            x: width - bottom_right.width,
            y: height - bottom_right.height,
            width: bottom_right.width,
            height: bottom_right.height,
        },
    });
    Some(placed)
}

/// One piece's art stretched over `width` × `height`, as its own SVG element.
pub fn stretched_art(art: &SvgArt, width: f64, height: f64) -> String {
    format!(
        "<svg width=\"{}\" height=\"{}\" viewBox=\"0 0 {} {}\" preserveAspectRatio=\"none\" overflow=\"hidden\">{}</svg>",
        rounded(width, 3),
        rounded(height, 3),
        rounded(art.width, 3),
        rounded(art.height, 3),
        art.svg
    )
}

/// The pieces as one SVG. Where two pieces meet off a pixel boundary, a browser's smoothing can
/// show a hairline of the grey under each piece's glass; the daemon paints PNG instead.
pub fn svg_body(size: (f64, f64), pieces: &[PlacedPiece]) -> String {
    let parts: Vec<String> = pieces
        .iter()
        .map(|piece| {
            let inner = stretched_art(&piece.art, piece.rect.width, piece.rect.height);
            format!(
                "<svg x=\"{}\" y=\"{}\"{}",
                rounded(piece.rect.x, 3),
                rounded(piece.rect.y, 3),
                &inner["<svg".len()..]
            )
        })
        .collect();
    let svg = format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 {} {}\" width=\"{}\" height=\"{}\">{}</svg>",
        rounded(size.0, 3),
        rounded(size.1, 3),
        rounded(size.0, 3),
        rounded(size.1, 3),
        parts.join("")
    );
    super::chrome::svg_url(&svg)
}

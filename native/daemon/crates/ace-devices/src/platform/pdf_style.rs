// SPDX-License-Identifier: Apache-2.0
//! The numbers and graphics state of `pdf-svg.ts`: matrices, JavaScript number text, colours
//! and the state a `q` level saves. Pure and shared by the painter.

use ace_json::write_number;

pub type Matrix = [f64; 6];

const IDENTITY: Matrix = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0];

pub fn multiply(a: Matrix, b: Matrix) -> Matrix {
    [
        a[0] * b[0] + a[1] * b[2],
        a[0] * b[1] + a[1] * b[3],
        a[2] * b[0] + a[3] * b[2],
        a[2] * b[1] + a[3] * b[3],
        a[4] * b[0] + a[5] * b[2] + b[4],
        a[4] * b[1] + a[5] * b[3] + b[5],
    ]
}

/// `Math.round`, which rounds a half towards positive infinity where `f64::round` rounds away
/// from zero; -0 prints as 0.
pub fn js_round(value: f64) -> f64 {
    (value + 0.5).floor()
}

/// `Math.round(value * 1000) / 1000` as `String`, in JavaScript's number format.
pub fn round(value: f64) -> String {
    let rounded = js_round(value * 1000.0) / 1000.0;
    let mut out = String::new();
    if rounded == 0.0 {
        out.push('0');
    } else {
        write_number(&mut out, rounded);
    }
    out
}

pub fn channel(value: f64) -> String {
    let clamped = value.clamp(0.0, 1.0);
    js_round(clamped * 255.0).to_string()
}

/// A colour as `rgb(...)`: one grey value, three RGB values, or four CMYK ones over white.
pub fn color(components: &[f64]) -> String {
    let [a, b, c, d] = [
        components.first().copied().unwrap_or(0.0),
        components.get(1).copied().unwrap_or(0.0),
        components.get(2).copied().unwrap_or(0.0),
        components.get(3).copied().unwrap_or(0.0),
    ];
    let rgb = if components.len() >= 4 {
        vec![
            (1.0 - a) * (1.0 - d),
            (1.0 - b) * (1.0 - d),
            (1.0 - c) * (1.0 - d),
        ]
    } else if components.len() == 3 {
        vec![a, b, c]
    } else {
        vec![a, a, a]
    };
    format!(
        "rgb({})",
        rgb.iter()
            .map(|value| channel(*value))
            .collect::<Vec<String>>()
            .join(",")
    )
}

pub fn point(x: f64, y: f64) -> String {
    format!("{} {}", round(x), round(y))
}

pub fn matrix_text(matrix: Matrix) -> String {
    matrix
        .iter()
        .map(|value| round(*value))
        .collect::<Vec<String>>()
        .join(" ")
}

pub const CAPS: [&str; 3] = ["butt", "round", "square"];
pub const JOINS: [&str; 3] = ["miter", "round", "bevel"];

#[derive(Debug, Clone)]
pub struct State {
    pub ctm: Matrix,
    pub fill: String,
    pub stroke: String,
    pub fill_alpha: f64,
    pub stroke_alpha: f64,
    pub fill_components: usize,
    pub stroke_components: usize,
    pub line_width: f64,
    pub cap: usize,
    pub join: usize,
    pub miter: f64,
    pub dash: Option<String>,
    /// `<g>` elements opened since this state was saved, closed again by `Q`.
    pub opened: usize,
}

pub fn initial_state() -> State {
    State {
        ctm: IDENTITY,
        fill: "rgb(0,0,0)".to_string(),
        stroke: "rgb(0,0,0)".to_string(),
        fill_alpha: 1.0,
        stroke_alpha: 1.0,
        fill_components: 1,
        stroke_components: 1,
        line_width: 1.0,
        cap: 0,
        join: 0,
        miter: 10.0,
        dash: None,
        opened: 0,
    }
}

/// A copy of the graphics state for a new `q` level, with no groups of its own open yet.
pub fn saved(state: &State) -> State {
    State {
        opened: 0,
        ..state.clone()
    }
}

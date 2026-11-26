// SPDX-License-Identifier: Apache-2.0
//! The numbers and graphics state of `pdf-svg.ts`: matrices, JavaScript number text, colours
//! and the state a `q` level saves. Pure and shared by the painter.

use ace_json::write_number;

use super::jsnum::round as js_round;

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

/// `list[index]` as JavaScript reads it: a whole, non-negative index below the length finds an
/// element; a fractional or out-of-range one (`1.5`) finds none.
pub fn at<'a>(list: &[&'a str], index: f64) -> Option<&'a str> {
    if index.fract() != 0.0 || index < 0.0 {
        return None;
    }
    list.get(index as usize).copied()
}

/// `values.slice(-count)` as JavaScript slices it: a whole count back from the end, a count of
/// zero (or `NaN`) the whole array, and a negative count dropping that many from the front.
pub fn slice_from_end(values: &[f64], count: f64) -> &[f64] {
    let start = -count;
    if start.is_nan() {
        return values;
    }
    let start = if start.is_infinite() {
        start
    } else {
        start.trunc()
    };
    let length = values.len() as f64;
    let from = if start < 0.0 {
        (length + start).max(0.0)
    } else {
        start.min(length)
    };
    &values[from as usize..]
}

#[derive(Debug, Clone)]
pub struct State {
    pub ctm: Matrix,
    pub fill: String,
    pub stroke: String,
    pub fill_alpha: f64,
    pub stroke_alpha: f64,
    pub fill_components: f64,
    pub stroke_components: f64,
    pub line_width: f64,
    pub cap: f64,
    pub join: f64,
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
        fill_components: 1.0,
        stroke_components: 1.0,
        line_width: 1.0,
        cap: 0.0,
        join: 0.0,
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

// SPDX-License-Identifier: Apache-2.0

//! The bench from `docs/files/plan.md`: a 200,000-line file with 100 scattered edits.
//!
//! Run with `cargo bench -p editor-diff --bench line_marks`.

use std::time::{Duration, Instant};

use editor_diff::line_marks;

const LINES: usize = 200_000;
const EDITS: usize = 100;
const RUNS: usize = 20;

fn main() {
    let edited = edit_lines();
    let original = file(&[]);
    let current = file(&edited);

    let marks = line_marks(&original, &current);
    println!(
        "{LINES} lines, {EDITS} scattered edits: {} gutter marks",
        marks.len()
    );
    println!("  100 scattered edits  {}", summary(&original, &current));
    println!("  unchanged text       {}", summary(&original, &original));
}

/// A file of `LINES` lines, with every line index in `edited` changed.
fn file(edited: &[usize]) -> String {
    let mut text = String::with_capacity(LINES * 48);
    for line in 0..LINES {
        text.push_str("fn row_");
        text.push_str(&line.to_string());
        text.push_str("() { value(");
        text.push_str(&(line % 97).to_string());
        text.push_str("); }");
        if edited.binary_search(&line).is_ok() {
            text.push_str(" // edited");
        }
        text.push('\n');
    }
    text
}

/// `EDITS` scattered line indexes, the same ones every run.
fn edit_lines() -> Vec<usize> {
    let mut state = 0x9E37_79B9_u32;
    let mut picked: Vec<usize> = Vec::with_capacity(EDITS);
    while picked.len() < EDITS {
        state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        let line = (state as usize) % LINES;
        if !picked.contains(&line) {
            picked.push(line);
        }
    }
    picked.sort_unstable();
    picked
}

/// The fastest, median and slowest of [`RUNS`] calls.
fn summary(original: &str, current: &str) -> String {
    let mut times: Vec<Duration> = Vec::with_capacity(RUNS);
    for _ in 0..RUNS {
        let start = Instant::now();
        let marks = line_marks(original, current);
        times.push(start.elapsed());
        std::hint::black_box(marks);
    }
    times.sort_unstable();
    format!(
        "min {:?}, median {:?}, max {:?}",
        times.first().copied().unwrap_or_default(),
        times.get(RUNS / 2).copied().unwrap_or_default(),
        times.last().copied().unwrap_or_default(),
    )
}

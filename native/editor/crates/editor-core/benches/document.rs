// SPDX-License-Identifier: Apache-2.0

//! Manual benchmark for a large document.
//!
//! Run with `cargo bench -p editor-core --bench document`. It reports load time, the total and
//! mean time of 1,000 single-character inserts at random lines, and the median `line()` call.

use std::hint::black_box;
use std::time::{Duration, Instant};

use editor_core::{Document, Position, Selection};

const LINES: usize = 200_000;
const INSERTS: usize = 1_000;
const SAMPLES: usize = 50_000;

fn main() {
    let text = source_text();

    let start = Instant::now();
    let mut document = Document::new(&text);
    let load = start.elapsed();

    let mut seed = 0x2545_f491_4f6c_dd1d_u64;
    let mut next = move || {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        seed
    };

    let mut inserts = Duration::ZERO;
    for _ in 0..INSERTS {
        let line = (next() % LINES as u64) as u32;
        document.set_selections(vec![Selection::caret(Position::new(line, 0))]);
        let start = Instant::now();
        let applied = document.insert_text("x");
        inserts += start.elapsed();
        black_box(applied);
    }

    let mut times = Vec::with_capacity(SAMPLES);
    for _ in 0..SAMPLES {
        let line = (next() % LINES as u64) as usize;
        let start = Instant::now();
        black_box(document.line(line));
        times.push(start.elapsed().as_nanos());
    }
    times.sort_unstable();
    let p50 = times[times.len() / 2];

    println!("editor-core document bench");
    println!("  lines: {LINES}, bytes: {}", text.len());
    println!("  load: {:.2} ms", millis(load));
    println!(
        "  {INSERTS} inserts: {:.2} ms total, {:.1} us each",
        millis(inserts),
        inserts.as_secs_f64() * 1_000_000.0 / INSERTS as f64
    );
    println!("  line() p50: {:.2} us", p50 as f64 / 1_000.0);
}

fn millis(duration: Duration) -> f64 {
    duration.as_secs_f64() * 1_000.0
}

fn source_text() -> String {
    let mut text = String::with_capacity(LINES * 64);
    for index in 0..LINES {
        text.push_str("    let value_");
        text.push_str(&index.to_string());
        text.push_str(" = compute(input, ");
        text.push_str(&(index % 1_000).to_string());
        text.push_str(");\n");
    }
    text
}

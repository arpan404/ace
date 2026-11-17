// SPDX-License-Identifier: Apache-2.0

//! Manual benchmark for large documents.
//!
//! Run with `cargo bench -p editor-core --bench document`. It reports load time, single-character
//! inserts, 10,000-cursor and far-apart multi-cursor typing, a 5 MB single-line file, and the
//! median `line()` call.

use std::hint::black_box;
use std::time::{Duration, Instant};

use editor_core::{Document, Position, Selection};

const LINES: usize = 200_000;
const INSERTS: usize = 1_000;
const CURSORS: usize = 10_000;
const SINGLE_LINE_BYTES: usize = 5_000_000;

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

    let mut line_times = Vec::with_capacity(LINES);
    for _ in 0..LINES {
        let line = (next() % LINES as u64) as usize;
        let start = Instant::now();
        black_box(document.line(line));
        line_times.push(start.elapsed().as_nanos());
    }
    line_times.sort_unstable();
    let p50 = line_times[line_times.len() / 2];

    let selections: Vec<Selection> = (0..CURSORS)
        .map(|index| Selection::caret(Position::new((index * 20) as u32, 0)))
        .collect();
    document.set_selections(selections);
    let start = Instant::now();
    let many = document.insert_text("z");
    let many_elapsed = start.elapsed();

    let last_line = (LINES - 1) as u32;
    document.set_selections(vec![
        Selection::caret(Position::new(0, 0)),
        Selection::caret(Position::new(last_line, 0)),
    ]);
    let mut far_apart = Duration::ZERO;
    let mut far_spans = 0;
    for _ in 0..INSERTS {
        let start = Instant::now();
        let applied = document.insert_text("y");
        far_apart += start.elapsed();
        far_spans = applied.spans.len();
    }

    let single = single_line(SINGLE_LINE_BYTES);
    let start = Instant::now();
    let mut single_document = Document::new(&single);
    let single_load = start.elapsed();
    let mut single_inserts = Duration::ZERO;
    for increment in 0..INSERTS {
        let length = SINGLE_LINE_BYTES as u32 + increment as u32;
        let column = (next() % (length as u64 + 1)) as u32;
        single_document.set_selections(vec![Selection::caret(Position::new(0, column))]);
        let start = Instant::now();
        let applied = single_document.insert_text("x");
        single_inserts += start.elapsed();
        black_box(applied);
    }
    let mut single_line_times = Vec::with_capacity(50);
    for _ in 0..50 {
        let start = Instant::now();
        black_box(single_document.line(0));
        single_line_times.push(start.elapsed().as_nanos());
    }
    single_line_times.sort_unstable();
    let single_p50 = single_line_times[single_line_times.len() / 2];

    println!("editor-core document bench");
    println!("  lines: {LINES}, bytes: {}", text.len());
    println!("  load: {:.2} ms", millis(load));
    println!(
        "  {INSERTS} inserts: {:.2} ms total, {:.1} us each",
        millis(inserts),
        per(inserts, INSERTS)
    );
    println!("  line() p50: {:.2} us", p50 as f64 / 1_000.0);
    println!(
        "  {CURSORS} cursors, one insert: {:.2} ms total, {:.1} us each, {} spans",
        millis(many_elapsed),
        per(many_elapsed, CURSORS),
        many.spans.len()
    );
    println!(
        "  far-apart pair, {INSERTS} inserts: {:.2} ms total, {:.1} us each, {far_spans} spans",
        millis(far_apart),
        per(far_apart, INSERTS)
    );
    println!(
        "  5 MB single line: load {:.2} ms, {INSERTS} inserts {:.2} ms total, {:.1} us each, line() p50 {:.2} ms",
        millis(single_load),
        millis(single_inserts),
        per(single_inserts, INSERTS),
        single_p50 as f64 / 1_000_000.0
    );
}

fn millis(duration: Duration) -> f64 {
    duration.as_secs_f64() * 1_000.0
}

fn per(duration: Duration, count: usize) -> f64 {
    duration.as_secs_f64() * 1_000_000.0 / count as f64
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

fn single_line(bytes: usize) -> String {
    const UNIT: &str = "abcdefghij";
    let mut text = String::with_capacity(bytes + UNIT.len());
    while text.len() < bytes {
        text.push_str(UNIT);
    }
    text.truncate(bytes);
    text
}

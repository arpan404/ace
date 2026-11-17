// SPDX-License-Identifier: Apache-2.0

//! Quick-open timings on a million generated paths.
//!
//! Run with `cargo bench -p files-index --bench quick_open`. The paths are generated in memory and
//! handed to `PathIndex::from_paths`, so no checkout with a million real files is needed.

use std::time::{Duration, Instant};

use files_index::PathIndex;

const PATHS: usize = 1_000_000;
const LIMIT: usize = 100;
const ROUNDS: usize = 21;
const QUERIES: [&str; 3] = ["srvmain", "main.rs", "crates/ace"];

fn main() {
    let paths = generated(PATHS);
    let started = Instant::now();
    let index = PathIndex::from_paths(paths);
    let build = started.elapsed();

    let bytes_per_path = index.bytes_used() as f64 / index.len().max(1) as f64;
    println!("paths             {}", index.len());
    println!("build             {:.1} ms", millis(build));
    println!("bytes per path    {bytes_per_path:.1}");

    for query in QUERIES {
        let hits = index.search(query, LIMIT);
        let mut samples: Vec<Duration> = Vec::with_capacity(ROUNDS);
        for _ in 0..ROUNDS {
            let started = Instant::now();
            let found = index.search(query, LIMIT);
            samples.push(started.elapsed());
            assert_eq!(found.len(), hits.len());
        }
        samples.sort_unstable();
        println!(
            "query {query:<12} p50 {:.2} ms  best {:.2} ms  hits {}",
            millis(samples[ROUNDS / 2]),
            millis(samples[0]),
            hits.len()
        );
    }
}

fn millis(duration: Duration) -> f64 {
    duration.as_secs_f64() * 1_000.0
}

/// A deterministic, checkout-shaped list: mostly crate sources, some packages and apps, a little
/// documentation, and about one path in a hundred that the three benchmark queries are aimed at.
/// Every path carries its own numbered folder so the index holds a full million distinct paths
/// while file names stay the ones a person actually searches for.
fn generated(count: usize) -> Vec<String> {
    let mut rng = Rng(0x2545_f491_4f6c_dd1d);
    let mut paths = Vec::with_capacity(count);
    for number in 0..count {
        let path = if number % 100 == 0 {
            format!("crates/srvmain/src/server/part_{number}/main.rs")
        } else if number % 100 == 1 {
            format!("crates/ace/src/index/part_{number}/lib.rs")
        } else {
            match rng.below(10) {
                0..=5 => format!(
                    "{dir}/{krate}/src/{module}/part_{number}/{module2}.{ext}",
                    dir = if rng.below(4) == 0 { "apps" } else { "crates" },
                    krate = pick(&mut rng, &CRATES),
                    module = pick(&mut rng, &MODULES),
                    module2 = pick(&mut rng, &MODULES),
                    ext = if rng.below(8) == 0 { "ts" } else { "rs" },
                ),
                6..=7 => format!(
                    "packages/{krate}/src/part_{number}/{module}.ts",
                    krate = pick(&mut rng, &CRATES),
                    module = pick(&mut rng, &MODULES),
                ),
                8 => format!(
                    "{dir}/{module}/part_{number}/{module2}.rs",
                    dir = pick(&mut rng, &DIRS),
                    module = pick(&mut rng, &MODULES),
                    module2 = pick(&mut rng, &MODULES),
                ),
                _ => format!(
                    "docs/{module}/part_{number}/readme.md",
                    module = pick(&mut rng, &MODULES)
                ),
            }
        };
        paths.push(path);
    }
    paths
}

fn pick<'a>(rng: &mut Rng, choices: &[&'a str]) -> &'a str {
    choices[rng.below(choices.len())]
}

struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self
            .0
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        self.0 >> 33
    }

    fn below(&mut self, bound: usize) -> usize {
        (self.next() % bound.max(1) as u64) as usize
    }
}

const CRATES: [&str; 16] = [
    "ace", "files", "editor", "protocol", "daemon", "ui-core", "core", "server", "srvmain",
    "index", "watch", "search", "io", "wire", "diff", "cli",
];

const MODULES: [&str; 16] = [
    "main", "lib", "state", "index", "query", "walk", "apply", "render", "socket", "history",
    "models", "views", "util", "error", "config", "types",
];

const DIRS: [&str; 10] = [
    "src",
    "src/server",
    "src/render",
    "crates",
    "packages",
    "apps",
    "lib",
    "src/ui",
    "test",
    "docs",
];

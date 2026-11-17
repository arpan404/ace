// SPDX-License-Identifier: Apache-2.0

//! Times a literal search over this repository's `apps/` and `packages/` folders.
//!
//! Run once from `native/files`: `cargo bench -p files-search --bench search`.

use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::atomic::AtomicBool;
use std::time::{Duration, Instant};

use files_safe::Root;
use files_search::{Case, Query, Summary, search};

/// The literal the bench looks for: a symbol the dashboard uses, absent from most files.
const PATTERN: &str = "useDaemonQuery";

fn main() -> ExitCode {
    let repository = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../../");
    let mut totals = Totals::default();
    for folder in ["apps", "packages"] {
        let path = repository.join(folder);
        let root = match Root::open(&path) {
            Ok(root) => root,
            Err(error) => {
                eprintln!("cannot open {}: {error}", path.display());
                return ExitCode::FAILURE;
            }
        };
        let query = Query {
            pattern: PATTERN.to_owned(),
            regex: false,
            case: Case::Sensitive,
            whole_word: false,
            include: Vec::new(),
            exclude: Vec::new(),
            include_ignored: false,
            max_matches: 0,
            max_file_bytes: 0,
        };
        let cancel = AtomicBool::new(false);
        let start = Instant::now();
        let summary = match search(&root, &query, &cancel, &|_file| true) {
            Ok(summary) => summary,
            Err(error) => {
                eprintln!("searching {folder} failed: {error}");
                return ExitCode::FAILURE;
            }
        };
        let elapsed = start.elapsed();
        report(folder, &summary, elapsed);
        totals.add(&summary, elapsed);
    }
    report("total", &totals.summary, totals.elapsed);
    ExitCode::SUCCESS
}

fn report(label: &str, summary: &Summary, elapsed: Duration) {
    let seconds = elapsed.as_secs_f64();
    let megabytes = summary.bytes as f64 / 1_000_000.0;
    let rate = if seconds > 0.0 {
        megabytes / seconds
    } else {
        0.0
    };
    println!(
        "{label}: {} files, {} matches, {} bytes ({megabytes:.1} MB) in {:.1} ms ({rate:.0} MB/s)",
        summary.files,
        summary.matches,
        summary.bytes,
        seconds * 1000.0,
    );
}

/// Sums one summary and duration per folder into a whole-repository line.
#[derive(Default)]
struct Totals {
    summary: Summary,
    elapsed: Duration,
}

impl Totals {
    fn add(&mut self, summary: &Summary, elapsed: Duration) {
        self.summary.files += summary.files;
        self.summary.bytes += summary.bytes;
        self.summary.matches += summary.matches;
        self.summary.limit_hit |= summary.limit_hit;
        self.elapsed += elapsed;
    }
}

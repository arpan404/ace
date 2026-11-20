// SPDX-License-Identifier: Apache-2.0

//! Content search through the real `ace-files` binary next to `rg` on the same generated tree.
//!
//! Run from `native/files`: `cargo bench -p ace-files --bench search`. Options:
//! `--files N` (default 200000), `--dir PATH` (default `/var/tmp/ace-search-bench`, or
//! `ACE_SEARCH_BENCH_DIR`), `--runs N` (default 5, the median is reported), `--rg PATH`,
//! `--query NAME` (repeatable), `--regenerate`, and `--drop-caches CMD`, a shell command run before
//! every sample of a cold pass (`sync && sudo purge` on macOS,
//! `sync && echo 3 | sudo tee /proc/sys/vm/drop_caches` on Linux); without it only the warm pass
//! runs. The tree is described in `support/search_tree.rs`; each sample starts a fresh process
//! of each tool, alternating, and runs them one at a time. The table also goes to
//! `target/bench/search.md`.

#[path = "support/search_runs.rs"]
mod search_runs;
#[path = "support/search_tree.rs"]
mod search_tree;
// The shared bench client; this bench uses only part of its surface.
#[allow(dead_code)]
#[path = "support/wire.rs"]
mod wire;

use std::error::Error;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use search_runs::{Query, Sample};

/// The daemon's default match cap, which the capped query runs into.
const DAEMON_CAP: u64 = 2000;

fn main() {
    if let Err(error) = run() {
        eprintln!("search bench: {error}");
        std::process::exit(1);
    }
}

fn queries() -> Vec<Query> {
    let query = |name, pattern: &str, regex, insensitive, word, cap| Query {
        name,
        pattern: pattern.to_owned(),
        regex,
        insensitive,
        word,
        cap,
    };
    vec![
        query("rare literal", search_tree::RARE, false, false, false, 0),
        query("common literal", "ConfigHandler", false, false, false, 0),
        query("case-insensitive", "errorhandler", false, true, false, 0),
        query("regex", r"fn \w+_(load|save)\(", true, false, false, 0),
        query("whole word", "index", false, false, true, 0),
        query("cap (2000)", "the", false, false, false, DAEMON_CAP),
    ]
}

struct Options {
    files: usize,
    dir: PathBuf,
    runs: usize,
    rg: PathBuf,
    only: Vec<String>,
    regenerate: bool,
    drop_caches: Option<String>,
}

fn run() -> Result<(), Box<dyn Error>> {
    let options = parse(std::env::args().skip(1))?;
    let tree = search_tree::ensure(&options.dir, options.files, options.regenerate)?;
    let binary = binary();
    let scratch = search_runs::scratch(&target_dir())?;
    let chosen: Vec<Query> = queries()
        .into_iter()
        .filter(|query| {
            options.only.is_empty() || options.only.iter().any(|name| name == query.name)
        })
        .collect();
    let mut out = format!(
        "{} files, {:.0} MB, {} runs per cell (median), binary {}, {}\n",
        tree.files,
        tree.bytes as f64 / 1e6,
        options.runs,
        binary.display(),
        rg_version(&options.rg),
    );
    println!("{out}");
    // Warm the cache with one full pass of each tool before the warm pass.
    let all = queries();
    let warmup = &all[0];
    search_runs::rg(&options.rg, &tree.root, warmup, &scratch)?;
    search_runs::ace(&binary, &tree.root, warmup, &scratch)?;
    out += &pass(
        "warm", &options, &tree.root, &binary, &chosen, &scratch, None,
    )?;
    if let Some(command) = &options.drop_caches {
        out += &pass(
            "cold",
            &options,
            &tree.root,
            &binary,
            &chosen,
            &scratch,
            Some(command),
        )?;
    } else {
        out += "\ncold: not measured (pass --drop-caches CMD)\n";
    }
    let path = target_dir().join("bench/search.md");
    fs::write(&path, &out)?;
    println!("wrote {}", path.display());
    Ok(())
}

/// One pass over every query, returning its markdown table.
fn pass(
    label: &str,
    options: &Options,
    root: &Path,
    binary: &Path,
    queries: &[Query],
    scratch: &Path,
    drop_caches: Option<&String>,
) -> Result<String, Box<dyn Error>> {
    let mut table = format!(
        "\n{label}\n\n| query | ace first ms | ace total ms | rg first ms | rg total ms | ace/rg | ace CPU s | rg CPU s | ace RSS MB | rg RSS MB | ace lines | rg lines |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|\n"
    );
    for query in queries {
        let mut ace = Vec::new();
        let mut rg = Vec::new();
        for _ in 0..options.runs {
            drop_cache(drop_caches)?;
            ace.push(search_runs::ace(binary, root, query, scratch)?);
            drop_cache(drop_caches)?;
            rg.push(search_runs::rg(&options.rg, root, query, scratch)?);
        }
        let (a, r) = (median(&ace), median(&rg));
        let row = format!(
            "| {} | {} | {:.0} | {} | {:.0} | {:.2} | {:.2} | {:.2} | {:.0} | {:.0} | {} | {} |\n",
            query.name,
            first(&a),
            ms(a.total),
            first(&r),
            ms(r.total),
            a.total.as_secs_f64() / r.total.as_secs_f64().max(1e-9),
            a.cpu.as_secs_f64(),
            r.cpu.as_secs_f64(),
            a.peak_rss as f64 / 1e6,
            r.peak_rss as f64 / 1e6,
            a.lines,
            r.lines,
        );
        print!("{label} {row}");
        table += &row;
    }
    println!("{table}");
    Ok(table)
}

fn drop_cache(command: Option<&String>) -> Result<(), Box<dyn Error>> {
    if let Some(command) = command {
        let status = Command::new("sh").args(["-c", command]).status()?;
        if !status.success() {
            return Err(format!("--drop-caches {command:?} exited with {status}").into());
        }
    }
    Ok(())
}

/// The per-field median of a run's samples.
fn median(samples: &[Sample]) -> Sample {
    let middle = |mut values: Vec<Duration>| {
        values.sort_unstable();
        values[values.len() / 2]
    };
    let firsts: Vec<Duration> = samples.iter().filter_map(|sample| sample.first).collect();
    let mut rss: Vec<u64> = samples.iter().map(|sample| sample.peak_rss).collect();
    rss.sort_unstable();
    Sample {
        first: (!firsts.is_empty()).then(|| middle(firsts)),
        total: middle(samples.iter().map(|sample| sample.total).collect()),
        cpu: middle(samples.iter().map(|sample| sample.cpu).collect()),
        peak_rss: rss[rss.len() / 2],
        lines: samples.first().map_or(0, |sample| sample.lines),
    }
}

fn ms(duration: Duration) -> f64 {
    duration.as_secs_f64() * 1000.0
}

fn first(sample: &Sample) -> String {
    sample
        .first
        .map_or_else(|| "-".to_owned(), |first| format!("{:.0}", ms(first)))
}

fn rg_version(rg: &Path) -> String {
    Command::new(rg)
        .arg("--version")
        .output()
        .ok()
        .and_then(|output| {
            String::from_utf8_lossy(&output.stdout)
                .lines()
                .next()
                .map(str::to_owned)
        })
        .unwrap_or_else(|| "rg version unknown".to_owned())
}

fn parse(args: impl Iterator<Item = String>) -> Result<Options, Box<dyn Error>> {
    let mut options = Options {
        files: 200_000,
        dir: std::env::var_os("ACE_SEARCH_BENCH_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("/var/tmp/ace-search-bench")),
        runs: 5,
        rg: PathBuf::from("rg"),
        only: Vec::new(),
        regenerate: false,
        drop_caches: None,
    };
    let mut args = args;
    while let Some(arg) = args.next() {
        let mut value = |name: &str| args.next().ok_or_else(|| format!("{name} needs a value"));
        match arg.as_str() {
            "--files" => options.files = value("--files")?.parse()?,
            "--dir" => options.dir = PathBuf::from(value("--dir")?),
            "--runs" => options.runs = value("--runs")?.parse::<usize>()?.max(1),
            "--rg" => options.rg = PathBuf::from(value("--rg")?),
            "--query" => options.only.push(value("--query")?),
            "--drop-caches" => options.drop_caches = Some(value("--drop-caches")?),
            "--regenerate" => options.regenerate = true,
            "--bench" => {}
            other => return Err(format!("unknown argument {other}").into()),
        }
    }
    Ok(options)
}

/// The release binary `cargo bench` built beside this bench, or `ACE_FILES_BIN`.
fn binary() -> PathBuf {
    if let Some(path) = std::env::var_os("ACE_FILES_BIN") {
        return PathBuf::from(path);
    }
    if let Some(path) = option_env!("CARGO_BIN_EXE_ace-files") {
        return PathBuf::from(path);
    }
    target_dir().join("release/ace-files")
}

fn target_dir() -> PathBuf {
    if let Some(path) = std::env::var_os("CARGO_TARGET_DIR") {
        return PathBuf::from(path);
    }
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    fs::canonicalize(manifest.join("../.."))
        .map(|workspace| workspace.join("target"))
        .unwrap_or_else(|_| manifest.join("../../target"))
}

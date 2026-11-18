// SPDX-License-Identifier: Apache-2.0

//! End-to-end timings of the real `ace-files` binary on a million-file checkout.
//!
//! Run with `cargo bench -p ace-files --bench checkout`; `-- --files 100000` measures a tenth of
//! the tree for a quick check, `-- --dir PATH` picks where the tree lives (or set
//! `ACE_FILES_BENCH_DIR`), and `-- --regenerate` replaces a tree at that path. The tree is left
//! behind for the next run: the marker it ends with is what says it is complete.
//!
//! Everything is measured over the wire against the release binary: the first folder page, the
//! quick-open index, a literal content search sized to two gigabytes, watcher latency and a burst
//! that makes the watcher give up on individual changes. Each run clears the `bench/` folder it
//! writes into, so a reused tree still measures creates. Numbers go to a table and to
//! `target/bench/checkout.json` (or `--json PATH`). Set `ACE_BENCH_VERBOSE` to print what the
//! watcher reported while the burst runs.

#[path = "support/content.rs"]
mod content;
#[path = "support/measure.rs"]
mod measure;
#[path = "support/report.rs"]
mod report;
#[path = "support/tree.rs"]
mod tree;
#[path = "support/units.rs"]
mod units;
#[path = "support/watch.rs"]
mod watch;
#[path = "support/wire.rs"]
mod wire;

use std::error::Error;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use report::Report;
use units::{megabytes, thousands};
use wire::Wire;

fn main() {
    if let Err(error) = run() {
        eprintln!("checkout bench: {error}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), Box<dyn Error>> {
    let options = Options::parse(std::env::args().skip(1))?;
    let tree = tree::ensure(&options.dir, options.files, options.regenerate)?;
    let binary = binary();
    let mut report = Report::new(format!(
        "ace-files checkout bench: {} files in {} folders",
        thousands(tree.shape.files),
        thousands(tree.shape.folders())
    ));
    report.fact("tree", tree.root.display().to_string());
    report.fact(
        "tree state",
        if tree.generated {
            "generated"
        } else {
            "reused"
        },
    );
    report.fact(
        "content",
        format!(
            "{:.0} MB in {} source files, {} node_modules files, {} in one folder",
            megabytes(tree.bytes),
            thousands(tree.shape.source_files),
            thousands(tree.shape.node_files),
            thousands(tree.shape.big_files)
        ),
    );
    report.fact("load", load_average());
    report.fact("machine", machine());
    report.fact("binary", binary.display().to_string());

    let mut wire = Wire::start(&binary)?;
    wire.hello()?;

    measure::measure(&mut wire, &tree, &options, &mut report)?;
    wire.stop();

    report.print();
    report.write_json(&options.json)?;
    println!("wrote {}", options.json.display());
    Ok(())
}

/// What the run was asked for.
pub struct Options {
    files: usize,
    dir: PathBuf,
    /// Where the JSON copy goes.
    pub json: PathBuf,
    regenerate: bool,
}

impl Options {
    fn parse(args: impl Iterator<Item = String>) -> Result<Options, Box<dyn Error>> {
        let mut options = Options {
            files: 1_000_000,
            dir: std::env::var_os("ACE_FILES_BENCH_DIR")
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from("/var/tmp/ace-files-bench")),
            json: target_dir().join("bench/checkout.json"),
            regenerate: false,
        };
        let mut args = args;
        while let Some(arg) = args.next() {
            match arg.as_str() {
                "--files" => {
                    let value = args.next().ok_or("--files needs a count")?;
                    options.files = value
                        .parse()
                        .map_err(|error| format!("--files {value}: {error}"))?;
                }
                "--dir" => {
                    options.dir = PathBuf::from(args.next().ok_or("--dir needs a path")?);
                }
                "--json" => {
                    options.json = PathBuf::from(args.next().ok_or("--json needs a path")?);
                }
                "--regenerate" => options.regenerate = true,
                // Cargo passes this to every bench executable; a harness-less bench ignores it.
                "--bench" => {}
                "--help" | "-h" => {
                    println!(
                        "cargo bench -p ace-files --bench checkout -- [--files N] [--dir PATH] [--json PATH] [--regenerate]"
                    );
                    std::process::exit(0);
                }
                other => return Err(format!("unknown argument {other}").into()),
            }
        }
        Ok(options)
    }
}

/// The release binary `cargo bench` built beside this bench.
fn binary() -> PathBuf {
    if let Some(path) = std::env::var_os("ACE_FILES_BIN") {
        return PathBuf::from(path);
    }
    if let Some(path) = option_env!("CARGO_BIN_EXE_ace-files") {
        return PathBuf::from(path);
    }
    target_dir().join("release/ace-files")
}

/// The workspace's target folder.
fn target_dir() -> PathBuf {
    if let Some(path) = std::env::var_os("CARGO_TARGET_DIR") {
        return PathBuf::from(path);
    }
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    match fs::canonicalize(manifest.join("../..")) {
        Ok(workspace) => workspace.join("target"),
        Err(_) => manifest.join("../../target"),
    }
}

/// The machine's load average, as `sysctl` prints it.
fn load_average() -> String {
    match Command::new("sysctl").args(["-n", "vm.loadavg"]).output() {
        Ok(output) => String::from_utf8_lossy(&output.stdout)
            .trim()
            .trim_start_matches('{')
            .trim_end_matches('}')
            .trim()
            .to_owned(),
        Err(error) => format!("unknown: {error}"),
    }
}

/// What the machine is, so the numbers have a context.
fn machine() -> String {
    let cpu = Command::new("sysctl")
        .args(["-n", "machdep.cpu.brand_string"])
        .output()
        .ok()
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_owned())
        .unwrap_or_default();
    let cores = std::thread::available_parallelism()
        .map(|cores| cores.get())
        .unwrap_or(0);
    if cpu.is_empty() {
        format!("{cores} cores")
    } else {
        format!("{cpu}, {cores} cores")
    }
}

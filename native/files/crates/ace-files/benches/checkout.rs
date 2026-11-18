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
//! that makes the watcher give up on individual changes. Numbers go to a table and to
//! `target/bench/checkout.json` (or `--json PATH`). Set `ACE_BENCH_VERBOSE` to print what the
//! watcher reported while the burst runs.

#[path = "support/report.rs"]
mod report;
#[path = "support/tree.rs"]
mod tree;
#[path = "support/wire.rs"]
mod wire;

use std::error::Error;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

use files_wire::{Case, EventPayload, IndexResult, Op, Page, Reply, SearchQuery};
use report::Report;
use tree::Tree;
use wire::Wire;

/// Entries one page asks for: the Files panel's first page.
const PAGE: u64 = 500;

/// Quick-open hits per query: more than a person reads in the list.
const HITS: u64 = 100;

/// How many quick-open queries the percentiles are taken from.
const QUICK_OPEN_SAMPLES: usize = 50;

/// Quick-open queries, cycled, of the kind a person types in a checkout this shape.
const QUERIES: [&str; 10] = [
    "srvmain",
    "main.rs",
    "crates/ace",
    "index",
    "mod.rs",
    "socket",
    "src/walk",
    "lib",
    "config",
    "group_07",
];

/// The literal the content search looks for: present in about one source file in fifty.
const SEARCH_LITERAL: &str = "bench_search_marker_token";

/// How much content the content search may read: the tree's source files are sized to this.
const SEARCH_BUDGET: u64 = 2 * 1024 * 1024 * 1024;

/// Single writes whose latency the watcher is measured on.
const LATENCY_SAMPLES: usize = 50;

/// Files one burst creates, past the watcher's 5,000-change coalescing window.
const BURST_FILES: usize = 20_000;

/// Files per folder in the burst.
const BURST_SET: usize = 1_000;

/// How long the index build may take before the bench calls it hung.
const INDEX_DEADLINE: Duration = Duration::from_secs(900);

/// How long the watcher has to report one small change.
const WATCH_DEADLINE: Duration = Duration::from_secs(60);

/// How long the watcher has to report a burst at all.
const BURST_DEADLINE: Duration = Duration::from_secs(180);

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

    measure(&mut wire, &tree, &options, &mut report)?;
    wire.stop();

    report.print();
    report.write_json(&options.json)?;
    println!("wrote {}", options.json.display());
    Ok(())
}

/// Every measurement, in the order a person opens a checkout.
fn measure(
    wire: &mut Wire,
    tree: &Tree,
    options: &Options,
    report: &mut Report,
) -> Result<(), Box<dyn Error>> {
    let shape = &tree.shape;

    // Opening the root, then the first page of its listing: what the Files panel waits for.
    let opened = Instant::now();
    let id = wire.request(Op::OpenRoot {
        path: tree.root.to_string_lossy().into_owned(),
    })?;
    let root = match wire.answer(id)? {
        Reply::Root { root } => root,
        other => return Err(format!("openRoot answered {other:?}").into()),
    };
    let open_ms = millis(opened.elapsed());
    let page = list(wire, root, "", PAGE)?;
    let root_page_ms = millis(opened.elapsed());
    report.metric(
        "openRoot",
        open_ms,
        "ms",
        "canonicalize and open the root handle",
    );
    report.metric(
        "openRoot -> first root page",
        root_page_ms,
        "ms",
        format!("{} entries of {}", page.entries.len(), page.total),
    );

    // The first page of the twenty-thousand-entry folder.
    let started = Instant::now();
    let big = list(wire, root, shape.big_dir(), PAGE)?;
    report.metric(
        "first page of a 20,000-entry folder",
        millis(started.elapsed()),
        "ms",
        format!("{} entries of {}", big.entries.len(), big.total),
    );

    // Quick open becomes usable when the background walk publishes its index.
    let mut index = index_query(wire, root, "main", 10)?;
    while !index.ready {
        if opened.elapsed() > INDEX_DEADLINE {
            return Err(format!("the index was not ready within {INDEX_DEADLINE:?}").into());
        }
        std::thread::sleep(Duration::from_millis(50));
        index = index_query(wire, root, "main", 10)?;
    }
    report.metric(
        "openRoot -> index ready",
        millis(opened.elapsed()),
        "ms",
        format!(
            "{} paths{}",
            thousands(index.total as usize),
            if index.truncated { ", truncated" } else { "" }
        ),
    );
    report.metric(
        "RSS after index build",
        resident_mb(wire.pid())?,
        "MB",
        "ps -o rss= -p <ace-files>",
    );

    // Quick open, fifty queries over the wire.
    let mut samples = Vec::with_capacity(QUICK_OPEN_SAMPLES);
    let mut hits = 0;
    for sample in 0..QUICK_OPEN_SAMPLES {
        let query = QUERIES[sample % QUERIES.len()];
        let started = Instant::now();
        let result = index_query(wire, root, query, HITS)?;
        samples.push(started.elapsed());
        if sample == 0 {
            hits = result.hits.len();
        }
    }
    report.metric(
        "quick open p50",
        percentile(&samples, 50),
        "ms",
        format!("{QUICK_OPEN_SAMPLES} queries, top {hits} of {HITS}"),
    );
    report.metric(
        "quick open p95",
        percentile(&samples, 95),
        "ms",
        "worst queries of the fifty",
    );

    // A literal content search over the tree's two gigabytes of source.
    let started = Instant::now();
    let id = wire.request(Op::Search {
        root,
        query: SearchQuery {
            pattern: SEARCH_LITERAL.to_owned(),
            regex: false,
            case: Case::Sensitive,
            whole_word: false,
            include: Vec::new(),
            exclude: Vec::new(),
            include_ignored: false,
            max_matches: 0,
            max_file_bytes: SEARCH_BUDGET,
        },
    })?;
    let subscription = match wire.answer(id)? {
        Reply::Subscription { subscription } => subscription,
        other => return Err(format!("search answered {other:?}").into()),
    };
    let summary = loop {
        match wire.try_event(subscription, Duration::from_secs(120))? {
            Some(EventPayload::Matches { .. }) => {}
            Some(EventPayload::SearchDone { summary }) => break summary,
            Some(EventPayload::SearchFailed { code, message }) => {
                return Err(format!("the search failed: {code}: {message}").into());
            }
            Some(_) => {}
            None => return Err("the search sent no event for two minutes".into()),
        }
    };
    let search = started.elapsed();
    report.metric(
        "content search, literal",
        millis(search),
        "ms",
        format!(
            "{} files with matches, {} matches",
            thousands(summary.files as usize),
            thousands(summary.matches as usize)
        ),
    );
    report.metric(
        "content search bytes",
        megabytes(summary.bytes),
        "MB",
        format!(
            "{:.0} MB/s",
            megabytes(summary.bytes) / search.as_secs_f64()
        ),
    );

    // Watcher latency on single writes, then a burst the watcher cannot describe one by one.
    let subscription = watch(wire, root)?;
    let watch_dir = tree.root.join("bench/watch");
    fs::create_dir_all(&watch_dir)?;
    for sample in 0..LATENCY_SAMPLES {
        fs::write(watch_dir.join(latency_name(sample)), "sample 0\n")?;
    }
    await_change(
        wire,
        subscription,
        &format!("bench/watch/{}", latency_name(LATENCY_SAMPLES - 1)),
        WATCH_DEADLINE,
    )?;
    let mut latencies = Vec::with_capacity(LATENCY_SAMPLES);
    for sample in 0..LATENCY_SAMPLES {
        let name = latency_name(sample);
        let path = format!("bench/watch/{name}");
        let started = Instant::now();
        fs::write(watch_dir.join(&name), format!("sample {}\n", sample + 1))?;
        await_change(wire, subscription, &path, WATCH_DEADLINE)?;
        latencies.push(started.elapsed());
    }
    report.metric(
        "watcher latency p50",
        percentile(&latencies, 50),
        "ms",
        format!("{LATENCY_SAMPLES} single writes to one folder"),
    );
    report.metric(
        "watcher latency p95",
        percentile(&latencies, 95),
        "ms",
        "worst of the fifty writes",
    );

    let burst_dir = tree.root.join("bench/burst");
    let sets = BURST_FILES.div_ceil(BURST_SET);
    for set in 0..sets {
        fs::create_dir_all(burst_dir.join(format!("set_{set:02}")))?;
    }
    quiet(wire, subscription, Duration::from_secs(5))?;
    let indexed_before = index_query(wire, root, "main.rs", 10)?.total;
    let started = Instant::now();
    for file in 0..BURST_FILES {
        let name = format!("set_{:02}/burst_{file:05}.txt", file / BURST_SET);
        fs::write(burst_dir.join(name), format!("burst {file}\n"))?;
    }
    let created = Instant::now();
    let burst_write_ms = millis(created.duration_since(started));
    let outcome = await_burst(wire, subscription, started)?;
    report.metric(
        format!("burst of {} creates", thousands(BURST_FILES)),
        burst_write_ms,
        "ms",
        format!(
            "{:.0} files/s",
            BURST_FILES as f64 / created.duration_since(started).as_secs_f64()
        ),
    );
    match outcome.rescan_ms {
        Some(ms) => report.metric(
            "burst -> Rescan",
            ms,
            "ms",
            format!(
                "from the first create; {} rescan event(s), {} change batch(es) before it",
                outcome.rescans, outcome.batches
            ),
        ),
        None => report.metric(
            "burst -> first report",
            outcome.first_ms,
            "ms",
            format!(
                "no rescan: {} change batch(es) of {} paths",
                outcome.batches, outcome.paths
            ),
        ),
    }
    let caught = await_burst_index(wire, root, "burst_19999", Duration::from_secs(120))?;
    let added = caught.total.saturating_sub(indexed_before);
    if caught.caught_up {
        report.metric(
            "burst -> index caught up",
            millis(created.elapsed()),
            "ms",
            format!(
                "{} of {} paths indexed",
                thousands(added as usize),
                thousands(BURST_FILES)
            ),
        );
    } else {
        report.metric(
            "burst -> index still partial",
            millis(caught.elapsed),
            "ms",
            format!(
                "{} of {} paths indexed; the rescan walked while files were still landing",
                thousands(added as usize),
                thousands(BURST_FILES)
            ),
        );
    }
    report.metric(
        "RSS after burst",
        resident_mb(wire.pid())?,
        "MB",
        format!("index holds {} paths", thousands(caught.total as usize)),
    );

    report.fact("json", options.json.display().to_string());
    Ok(())
}

/// What the watcher did with the burst.
struct Burst {
    rescan_ms: Option<f64>,
    first_ms: f64,
    rescans: usize,
    batches: usize,
    paths: usize,
}

/// Wait for the burst's news: one rescan, or change batches that may arrive instead.
///
/// Times run from `origin`, the burst's first create, so a rescan that arrives while the writes
/// are still landing reads as what it is.
fn await_burst(
    wire: &mut Wire,
    subscription: u64,
    origin: Instant,
) -> Result<Burst, Box<dyn Error>> {
    let mut outcome = Burst {
        rescan_ms: None,
        first_ms: 0.0,
        rescans: 0,
        batches: 0,
        paths: 0,
    };
    let mut last_report = origin;
    loop {
        if origin.elapsed() > BURST_DEADLINE {
            if outcome.batches == 0 && outcome.rescans == 0 {
                return Err(
                    format!("the watcher reported nothing within {BURST_DEADLINE:?}").into(),
                );
            }
            return Ok(outcome);
        }
        match wire.try_event(subscription, Duration::from_secs(2))? {
            Some(EventPayload::Rescan { dir }) => {
                if verbose() {
                    eprintln!(
                        "  watch: rescan {dir:?} at {:.0} ms",
                        millis(origin.elapsed())
                    );
                }
                outcome.rescans += 1;
                outcome.rescan_ms = Some(millis(origin.elapsed()));
                return Ok(outcome);
            }
            Some(EventPayload::Changes { changes }) => {
                if verbose() {
                    eprintln!("  watch: {} changes", changes.len());
                }
                outcome.batches += 1;
                outcome.paths += changes.len();
                if outcome.batches == 1 {
                    outcome.first_ms = millis(origin.elapsed());
                }
                last_report = Instant::now();
            }
            Some(_) => {}
            // A window with no event after the batch means the watcher described the burst
            // change by change; a rescan would have followed by now.
            None if outcome.batches > 0 && last_report.elapsed() > Duration::from_secs(10) => {
                return Ok(outcome);
            }
            None => {}
        }
    }
}

/// Whether quick open picked up the burst's files.
struct Caught {
    caught_up: bool,
    total: u64,
    elapsed: Duration,
}

/// Wait until quick open answers `query` with a path ending in `<query>.txt`.
///
/// A rescan the watcher sent while the burst was still landing can walk a folder that is not
/// finished, so this reports a partial index instead of waiting forever.
fn await_burst_index(
    wire: &mut Wire,
    root: u64,
    query: &str,
    deadline: Duration,
) -> Result<Caught, Box<dyn Error>> {
    let started = Instant::now();
    let wanted = format!("{query}.txt");
    let mut last_report = Instant::now();
    loop {
        let index = index_query(wire, root, query, 10)?;
        let caught_up = index.ready && index.hits.iter().any(|hit| hit.path.ends_with(&wanted));
        if caught_up || started.elapsed() > deadline {
            return Ok(Caught {
                caught_up,
                total: index.total,
                elapsed: started.elapsed(),
            });
        }
        if verbose() && last_report.elapsed() > Duration::from_secs(5) {
            last_report = Instant::now();
            eprintln!(
                "  waiting for quick open to find {wanted}: {} paths, {} hits",
                index.total,
                index.hits.len()
            );
        }
        std::thread::sleep(Duration::from_millis(25));
    }
}

/// True when `ACE_BENCH_VERBOSE` is set, which prints what the watcher reported.
fn verbose() -> bool {
    std::env::var_os("ACE_BENCH_VERBOSE").is_some()
}

/// The name of one latency sample's file.
fn latency_name(sample: usize) -> String {
    format!("lat_{sample:02}.txt")
}

/// Wait until the watch reports `path` as changed, rewriting the file if the watcher lost detail.
fn await_change(
    wire: &mut Wire,
    subscription: u64,
    path: &str,
    deadline: Duration,
) -> Result<(), Box<dyn Error>> {
    let started = Instant::now();
    loop {
        if started.elapsed() > deadline {
            return Err(format!("the watch never reported {path} within {deadline:?}").into());
        }
        match wire.try_event(subscription, Duration::from_millis(500))? {
            Some(EventPayload::Changes { changes })
                if changes.iter().any(|change| change.path == path) =>
            {
                return Ok(());
            }
            Some(_) | None => {}
        }
    }
}

/// Drop events until the watcher has been quiet for `window`.
fn quiet(wire: &mut Wire, subscription: u64, window: Duration) -> Result<(), Box<dyn Error>> {
    while wire.try_event(subscription, window)?.is_some() {}
    Ok(())
}

/// One page of one folder.
fn list(wire: &mut Wire, root: u64, dir: &str, limit: u64) -> Result<Page, Box<dyn Error>> {
    let id = wire.request(Op::List {
        root,
        dir: dir.to_owned(),
        limit,
        cursor: None,
        hide: vec![".git".to_owned(), ".DS_Store".to_owned()],
    })?;
    match wire.answer(id)? {
        Reply::Page(page) => Ok(page),
        other => Err(format!("list answered {other:?}").into()),
    }
}

/// One quick-open query.
fn index_query(
    wire: &mut Wire,
    root: u64,
    query: &str,
    limit: u64,
) -> Result<IndexResult, Box<dyn Error>> {
    let id = wire.request(Op::IndexQuery {
        root,
        query: query.to_owned(),
        limit,
    })?;
    match wire.answer(id)? {
        Reply::Index(index) => Ok(index),
        other => Err(format!("indexQuery answered {other:?}").into()),
    }
}

/// The subscription of a watch.
fn watch(wire: &mut Wire, root: u64) -> Result<u64, Box<dyn Error>> {
    let id = wire.request(Op::Watch { root })?;
    match wire.answer(id)? {
        Reply::Subscription { subscription } => Ok(subscription),
        other => Err(format!("watch answered {other:?}").into()),
    }
}

/// The `percent`-th sample of a run, in milliseconds.
fn percentile(samples: &[Duration], percent: usize) -> f64 {
    let mut sorted = samples.to_vec();
    sorted.sort_unstable();
    let last = sorted.len().saturating_sub(1);
    millis(sorted[(sorted.len() * percent / 100).min(last)])
}

/// The process's resident set size in megabytes, as `ps` reports it.
fn resident_mb(pid: u32) -> Result<f64, Box<dyn Error>> {
    let output = Command::new("ps")
        .args(["-o", "rss=", "-p", &pid.to_string()])
        .output()?;
    let text = String::from_utf8_lossy(&output.stdout);
    let kilobytes: f64 = text
        .trim()
        .parse()
        .map_err(|error| format!("ps reported {text:?} for pid {pid}: {error}"))?;
    Ok(kilobytes / 1024.0)
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

fn millis(duration: Duration) -> f64 {
    duration.as_secs_f64() * 1_000.0
}

fn megabytes(bytes: u64) -> f64 {
    bytes as f64 / 1_000_000.0
}

/// A count with thousands separated, so a million reads as a million.
fn thousands(count: usize) -> String {
    let digits = count.to_string();
    let mut grouped = String::with_capacity(digits.len() + digits.len() / 3);
    for (position, digit) in digits.chars().enumerate() {
        if position > 0 && (digits.len() - position).is_multiple_of(3) {
            grouped.push(',');
        }
        grouped.push(digit);
    }
    grouped
}

/// What the run was asked for.
struct Options {
    files: usize,
    dir: PathBuf,
    json: PathBuf,
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

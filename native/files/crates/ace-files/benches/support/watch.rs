// SPDX-License-Identifier: Apache-2.0

//! The watcher phases: one write at a time, then a burst past the coalescing window.

use std::error::Error;
use std::fs;
use std::time::{Duration, Instant};

use files_wire::EventPayload;

use crate::measure::{index_query, resident_mb, subscribe};
use crate::report::Report;
use crate::tree::Tree;
use crate::units::{millis, percentile, thousands};
use crate::wire::Wire;

/// Single writes whose latency the watcher is measured on.
const LATENCY_SAMPLES: usize = 50;

/// Files one burst creates, past the watcher's 5,000-change coalescing window.
const BURST_FILES: usize = 20_000;

/// Files per folder in the burst.
const BURST_SET: usize = 1_000;

/// How long the watcher has to report one small change.
const WATCH_DEADLINE: Duration = Duration::from_secs(60);

/// How long the watcher has to report a burst at all.
const BURST_DEADLINE: Duration = Duration::from_secs(180);

/// How long a rescan's walk has to bring the burst's paths into quick open.
const CATCH_UP_DEADLINE: Duration = Duration::from_secs(120);

/// Time fifty single writes from the write to the batch that names them.
pub fn latency(
    wire: &mut Wire,
    tree: &Tree,
    root: u64,
    report: &mut Report,
) -> Result<(), Box<dyn Error>> {
    let subscription = subscribe(wire, root)?;
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
    Ok(())
}

/// Create twenty thousand files as fast as the disk allows and time what the watcher does.
pub fn burst(
    wire: &mut Wire,
    tree: &Tree,
    root: u64,
    report: &mut Report,
) -> Result<(), Box<dyn Error>> {
    let subscription = subscribe(wire, root)?;
    let burst_dir = tree.root.join("bench/burst");
    for set in 0..BURST_FILES.div_ceil(BURST_SET) {
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
    report.metric(
        format!("burst of {} creates", thousands(BURST_FILES)),
        millis(created.duration_since(started)),
        "ms",
        format!(
            "{:.0} files/s",
            BURST_FILES as f64 / created.duration_since(started).as_secs_f64()
        ),
    );
    let outcome = await_burst(wire, subscription, started)?;
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
    let caught = await_burst_index(wire, root, "burst_19999", CATCH_UP_DEADLINE)?;
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

/// Wait until the watch reports `path` as changed.
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

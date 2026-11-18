// SPDX-License-Identifier: Apache-2.0

//! The watcher phases: one write at a time, then a burst past the coalescing window.
//!
//! A frame's time is the moment the reader decoded it, and every burst number runs from the
//! burst's first create, so a rescan that arrives while the writes are still landing reads as what
//! it is instead of hiding behind the writes. Only changes and rescans under `bench/burst/` count
//! as the burst's news; a whole-root rescan is labelled as one. Quick open is polled alongside the
//! events, and every expected burst path is checked once the index has caught up.

use std::collections::HashSet;
use std::error::Error;
use std::fs;
use std::time::{Duration, Instant};

use files_wire::EventPayload;

use crate::measure::{index_query, index_ready, resident_mib, subscribe};
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

/// The folder the burst creates, root-relative.
const BURST_DIR: &str = "bench/burst";

/// Root-relative prefix every burst path starts with.
const BURST_PREFIX: &str = "bench/burst/";

/// How long the watcher has to report one small change.
const WATCH_DEADLINE: Duration = Duration::from_secs(60);

/// How long the watcher has to report the burst at all.
const BURST_DEADLINE: Duration = Duration::from_secs(180);

/// How long the burst's paths have to reach quick open, from the burst's first create.
const INDEX_DEADLINE: Duration = Duration::from_secs(120);

/// How often quick open is asked while the burst runs.
const INDEX_POLL: Duration = Duration::from_millis(250);

/// How quiet a watcher that described the burst change by change has to go before the bench stops
/// waiting for a rescan.
const BURST_QUIET: Duration = Duration::from_secs(10);

/// Time fifty single writes from the write to the batch that names them.
pub fn latency(
    wire: &mut Wire,
    tree: &Tree,
    root: u64,
    report: &mut Report,
) -> Result<(), Box<dyn Error>> {
    wire.begin_phase(
        "watcher latency",
        WATCH_DEADLINE * LATENCY_SAMPLES as u32 + Duration::from_secs(120),
    );
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
    // Those fifty creates can arrive as more than one batch; drain them so a stale batch naming
    // sample 0's path cannot masquerade as its answer and report a zero-millisecond latency.
    quiet(wire, subscription, Duration::from_millis(500))?;
    let mut latencies = Vec::with_capacity(LATENCY_SAMPLES);
    for sample in 0..LATENCY_SAMPLES {
        let name = latency_name(sample);
        let path = format!("bench/watch/{name}");
        let started = Instant::now();
        fs::write(watch_dir.join(&name), format!("sample {}\n", sample + 1))?;
        let reported = await_change(wire, subscription, &path, WATCH_DEADLINE)?;
        latencies.push(reported.saturating_duration_since(started));
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
        format!("nearest rank of the {LATENCY_SAMPLES} writes"),
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
    wire.begin_phase("watcher burst", BURST_DEADLINE + INDEX_DEADLINE);
    let subscription = subscribe(wire, root)?;
    let burst_dir = tree.root.join(BURST_DIR);
    let sets = BURST_FILES.div_ceil(BURST_SET);
    for set in 0..sets {
        fs::create_dir_all(burst_dir.join(format!("set_{set:02}")))?;
    }
    quiet(wire, subscription, Duration::from_secs(5))?;
    let indexed_before = index_ready(wire, root)?.total;
    let expected: Vec<String> = (0..BURST_FILES).map(burst_path).collect();
    let expected_set: HashSet<&str> = expected.iter().map(String::as_str).collect();

    let write_started = Instant::now();
    let mut origin = None;
    for (file, path) in expected.iter().enumerate() {
        if origin.is_none() {
            origin = Some(Instant::now());
        }
        fs::write(tree.root.join(path), format!("burst {file}\n"))?;
    }
    let origin = origin.unwrap_or(write_started);
    let written = Instant::now();
    let writing = written.duration_since(write_started);
    report.metric(
        format!("burst of {} creates", thousands(BURST_FILES)),
        millis(writing),
        "ms",
        format!("{:.0} files/s", BURST_FILES as f64 / writing.as_secs_f64()),
    );

    let outcome = await_burst(
        wire,
        subscription,
        origin,
        root,
        &expected_set,
        indexed_before,
    )?;

    let watcher = &outcome.watcher;
    let news = format!(
        "from the first create; {} change batch(es) of {} paths under {BURST_DIR}/, {} rescan(s), {} of them the whole root",
        watcher.batches,
        thousands(watcher.paths),
        watcher.rescans,
        watcher.root_rescans
    );
    if let Some(ms) = watcher.scoped_ms {
        report.metric(
            "burst -> Rescan",
            ms,
            "ms",
            format!("scoped under {BURST_DIR}/; {news}"),
        );
    } else if let Some((scope, ms)) = &watcher.wider {
        report.metric(format!("burst -> rescan of {scope}"), *ms, "ms", news);
    } else if let Some(ms) = watcher.first_ms {
        report.metric(
            "burst -> first report",
            ms,
            "ms",
            format!("no rescan; {news}"),
        );
    }

    let index = &outcome.index;
    let note = format!(
        "from the first create; {} of {} burst paths in quick open, {} paths in the index",
        thousands(index.found),
        thousands(BURST_FILES),
        thousands(index.total as usize)
    );
    if index.complete {
        report.metric("burst -> index caught up", index.ms, "ms", note);
    } else {
        report.metric(
            "burst -> index still partial",
            index.ms,
            "ms",
            format!("when the deadline passed; {note}"),
        );
    }
    report.metric(
        "RSS after burst",
        resident_mib(wire.pid())?,
        "MiB",
        format!("index holds {} paths", thousands(index.total as usize)),
    );
    Ok(())
}

/// What the watcher did with the burst.
#[derive(Default)]
struct Watcher {
    /// The moment the first rescan under `bench/burst/` arrived.
    scoped_ms: Option<f64>,
    /// The moment the first rescan of a wider folder arrived, with that folder's name.
    wider: Option<(String, f64)>,
    /// Rescans of any kind, and how many covered the whole root.
    rescans: usize,
    root_rescans: usize,
    /// The moment the first batch naming a burst path arrived.
    first_ms: Option<f64>,
    /// Batches that named at least one burst path, and how many paths they named.
    batches: usize,
    paths: usize,
}

/// What quick open held when the check last ran.
struct Indexed {
    /// True when every expected burst path was in the index.
    complete: bool,
    /// The moment of the check, from the burst's first create.
    ms: f64,
    /// How many expected burst paths were found.
    found: usize,
    /// How many paths the index held at all.
    total: u64,
}

struct Burst {
    watcher: Watcher,
    index: Indexed,
}

/// Wait for the burst's news and for quick open to hold every burst path, polling both together.
///
/// Times run from `origin`, the burst's first create, so a rescan that arrives while the writes
/// are still landing reads as what it is and a partial index reports how partial it was.
fn await_burst(
    wire: &mut Wire,
    subscription: u64,
    origin: Instant,
    root: u64,
    expected: &HashSet<&str>,
    indexed_before: u64,
) -> Result<Burst, Box<dyn Error>> {
    let watcher_deadline = origin + BURST_DEADLINE;
    let index_deadline = origin + INDEX_DEADLINE;
    let sets = BURST_FILES.div_ceil(BURST_SET);
    let mut watcher = Watcher::default();
    let mut found = vec![0usize; sets];
    let mut watcher_done = false;
    let mut index_done = false;
    let mut index: Option<Indexed> = None;
    let mut last_report = origin;
    let mut next_poll = Instant::now();
    loop {
        if !watcher_done && Instant::now() >= watcher_deadline {
            if watcher.batches == 0 && watcher.rescans == 0 {
                return Err(format!(
                    "the watcher reported nothing about the burst within {BURST_DEADLINE:?}"
                )
                .into());
            }
            watcher_done = true;
        }
        if watcher_done && index_done {
            break;
        }

        if !index_done && Instant::now() >= next_poll {
            let cheap = index_ready(wire, root)?;
            let expected_total = indexed_before.saturating_add(BURST_FILES as u64);
            // Checking every path costs a query per set, so it waits until the index's own count
            // says the paths should all be there, or until the deadline asks for the honest
            // partial number.
            let late = Instant::now() >= index_deadline;
            if cheap.ready && (cheap.total >= expected_total || late) {
                for (set, count) in found.iter_mut().enumerate() {
                    if *count >= set_files(set) {
                        continue;
                    }
                    *count = verify_set(wire, root, set, expected)?;
                }
            }
            let complete = found
                .iter()
                .enumerate()
                .all(|(set, count)| *count >= set_files(set));
            index = Some(Indexed {
                complete,
                ms: millis(origin.elapsed()),
                found: found.iter().sum(),
                total: cheap.total,
            });
            index_done = complete || late;
            next_poll = Instant::now() + INDEX_POLL;
            continue;
        }

        if watcher_done {
            std::thread::sleep(Duration::from_millis(20));
            continue;
        }
        let window = next_poll
            .saturating_duration_since(Instant::now())
            .max(Duration::from_millis(20));
        match wire.try_event(subscription, window)? {
            Some((at, EventPayload::Rescan { dir })) => {
                let ms = millis(at.saturating_duration_since(origin));
                watcher.rescans += 1;
                if verbose() {
                    eprintln!("  watch: rescan {dir:?} at {ms:.0} ms");
                }
                match dir.as_deref() {
                    Some(dir) if is_burst_dir(dir) => {
                        watcher.scoped_ms.get_or_insert(ms);
                    }
                    Some(dir) => {
                        watcher.wider.get_or_insert_with(|| (dir.to_owned(), ms));
                    }
                    None => {
                        watcher.root_rescans += 1;
                        watcher
                            .wider
                            .get_or_insert_with(|| ("the whole root".to_owned(), ms));
                    }
                }
                // A rescan is the watcher's last word on the burst.
                watcher_done = true;
            }
            Some((at, EventPayload::Changes { changes })) => {
                let burst = changes
                    .iter()
                    .filter(|change| change.path.starts_with(BURST_PREFIX))
                    .count();
                if burst > 0 {
                    let ms = millis(at.saturating_duration_since(origin));
                    watcher.batches += 1;
                    watcher.paths += burst;
                    if watcher.first_ms.is_none() && watcher.scoped_ms.is_none() {
                        watcher.first_ms = Some(ms);
                    }
                    last_report = at;
                    if verbose() {
                        eprintln!("  watch: {burst} burst paths at {ms:.0} ms");
                    }
                }
            }
            Some(_) => {}
            None if watcher.batches > 0 && last_report.elapsed() > BURST_QUIET => {
                watcher_done = true;
            }
            None => {}
        }
    }
    let index = match index {
        Some(index) => index,
        // Only reachable if the loop ended before its first index poll, which its break condition
        // rules out; an empty answer is still honest.
        None => Indexed {
            complete: false,
            ms: millis(origin.elapsed()),
            found: 0,
            total: indexed_before,
        },
    };
    Ok(Burst { watcher, index })
}

/// True when a rescan's folder is the burst's own folder or one inside it.
fn is_burst_dir(dir: &str) -> bool {
    dir == BURST_DIR || dir.starts_with(BURST_PREFIX)
}

/// Files expected in burst set `set`, the last one holding the remainder.
fn set_files(set: usize) -> usize {
    BURST_SET.min(BURST_FILES - set * BURST_SET)
}

/// One burst file's root-relative path.
fn burst_path(file: usize) -> String {
    format!(
        "{BURST_DIR}/set_{:02}/burst_{file:05}.txt",
        file / BURST_SET
    )
}

/// How many of one set's expected paths quick open answers now.
fn verify_set(
    wire: &mut Wire,
    root: u64,
    set: usize,
    expected: &HashSet<&str>,
) -> Result<usize, Box<dyn Error>> {
    let query = format!("set_{set:02}/burst_");
    let result = index_query(wire, root, &query, BURST_SET as u64)?;
    Ok(result
        .hits
        .iter()
        .filter(|hit| expected.contains(hit.path.as_str()))
        .count())
}

/// True when `ACE_BENCH_VERBOSE` is set, which prints what the watcher reported.
fn verbose() -> bool {
    std::env::var_os("ACE_BENCH_VERBOSE").is_some()
}

/// The name of one latency sample's file.
fn latency_name(sample: usize) -> String {
    format!("lat_{sample:02}.txt")
}

/// Wait until the watch reports `path` as changed, and hand back the moment it did.
fn await_change(
    wire: &mut Wire,
    subscription: u64,
    path: &str,
    deadline: Duration,
) -> Result<Instant, Box<dyn Error>> {
    let started = Instant::now();
    loop {
        if started.elapsed() > deadline {
            return Err(format!("the watch never reported {path} within {deadline:?}").into());
        }
        match wire.try_event(subscription, Duration::from_millis(500))? {
            Some((at, EventPayload::Changes { changes }))
                if changes.iter().any(|change| change.path == path) =>
            {
                return Ok(at);
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

// SPDX-License-Identifier: Apache-2.0

//! The watcher phases: one write at a time, then a burst past the coalescing window.
//!
//! A frame is judged by when the reader decoded it: nothing decoded before the burst's first
//! create or after the phase's cutoff counts, and only paths inside this run's scratch folder are
//! the run's own news. A rescan of a folder around the scratch is recorded separately, a rescan of
//! an unrelated folder is ignored, and frames already queued when a deadline arrives are drained
//! before the watcher is called silent. Quick open is polled alongside the events, and every
//! expected burst path is checked for membership once it is there, so a partial index is reported
//! as partial instead of as caught up.

use std::error::Error;
use std::fs;
use std::time::{Duration, Instant};

use files_wire::EventPayload;

use crate::measure::{index_ready_until, index_until, resident_mib, subscribe};
use crate::report::Report;
use crate::scratch::Scratch;
use crate::units::{millis, percentile, thousands};
use crate::wire::{Wire, WireError};

/// Single writes whose latency the watcher is measured on.
const LATENCY_SAMPLES: usize = 50;

/// Files one burst creates, past the watcher's 5,000-change coalescing window.
const BURST_FILES: usize = 20_000;

/// Files per folder in the burst.
const BURST_SET: usize = 1_000;

/// The burst folder, relative to the run's scratch folder.
const BURST_DIR: &str = "burst";

/// The single-write folder, relative to the run's scratch folder.
const WATCH_DIR: &str = "watch";

/// How long the watcher has to report one small change.
const WATCH_DEADLINE: Duration = Duration::from_secs(60);

/// How long the watcher has to report the burst at all, from the first create.
const BURST_DEADLINE: Duration = Duration::from_secs(180);

/// How long the burst's paths have to reach quick open, from the burst's first create.
const INDEX_DEADLINE: Duration = Duration::from_secs(120);

/// How often quick open is asked while the burst runs.
const INDEX_POLL: Duration = Duration::from_millis(250);

/// How quiet a watcher that described the burst change by change has to go before the bench stops
/// waiting for a rescan.
const BURST_QUIET: Duration = Duration::from_secs(10);

/// How many queued frames one drain may process before the clock is checked again.
const DRAIN_LIMIT: usize = 256;

/// Time fifty single writes from the write to the batch that names them.
pub fn latency(
    wire: &mut Wire,
    root: u64,
    scratch: &Scratch,
    report: &mut Report,
) -> Result<(), Box<dyn Error>> {
    wire.begin_phase(
        "watcher latency",
        WATCH_DEADLINE * LATENCY_SAMPLES as u32 + Duration::from_secs(120),
    );
    let subscription = subscribe(wire, root)?;
    let watch_rel = scratch.relative_path(WATCH_DIR);
    let watch_dir = scratch.path(WATCH_DIR);
    fs::create_dir_all(&watch_dir)?;
    for sample in 0..LATENCY_SAMPLES {
        fs::write(watch_dir.join(latency_name(sample)), "sample 0\n")?;
    }
    await_change(
        wire,
        subscription,
        &format!("{watch_rel}/{}", latency_name(LATENCY_SAMPLES - 1)),
        WATCH_DEADLINE,
        None,
    )?;
    // The fifty creates can arrive as more than one batch; drain them so a stale batch naming
    // sample 0's path cannot masquerade as its answer and report a zero-millisecond latency.
    quiet(wire, subscription, Duration::from_millis(500))?;
    let mut latencies = Vec::with_capacity(LATENCY_SAMPLES);
    for sample in 0..LATENCY_SAMPLES {
        let path = format!("{watch_rel}/{}", latency_name(sample));
        let started = Instant::now();
        fs::write(
            watch_dir.join(latency_name(sample)),
            format!("sample {}\n", sample + 1),
        )?;
        let reported = await_change(wire, subscription, &path, WATCH_DEADLINE, Some(started))?;
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
    names(wire, subscription, &watch_rel, &watch_dir, report)
}

/// Time lone renames, lone deletes and deletes of a name renamed moments before, each awaited
/// before the next. A delete or rename takes the old path out of quick open before its batch is
/// sent, so these also cover what the index costs on the tree.
fn names(
    wire: &mut Wire,
    subscription: u64,
    watch_rel: &str,
    watch_dir: &std::path::Path,
    report: &mut Report,
) -> Result<(), Box<dyn Error>> {
    let half = LATENCY_SAMPLES / 2;
    let timed = |wire: &mut Wire, path: String, change: &dyn Fn() -> std::io::Result<()>| {
        let started = Instant::now();
        change()?;
        let reported = await_change(wire, subscription, &path, WATCH_DEADLINE, Some(started))?;
        Ok::<Duration, Box<dyn Error>>(reported.saturating_duration_since(started))
    };
    let (mut renames, mut after_rename, mut deletes) = (Vec::new(), Vec::new(), Vec::new());
    for sample in 0..half {
        let from = watch_dir.join(latency_name(sample));
        let moved = format!("moved_{sample:02}.txt");
        let to = watch_dir.join(&moved);
        renames.push(timed(wire, format!("{watch_rel}/{moved}"), &|| {
            fs::rename(&from, &to)
        })?);
        after_rename.push(timed(wire, format!("{watch_rel}/{moved}"), &|| {
            fs::remove_file(&to)
        })?);
    }
    for sample in half..LATENCY_SAMPLES {
        let gone = watch_dir.join(latency_name(sample));
        deletes.push(timed(
            wire,
            format!("{watch_rel}/{}", latency_name(sample)),
            &|| fs::remove_file(&gone),
        )?);
    }
    for (name, samples, what) in [
        ("watcher delete", &deletes, "single deletes in one folder"),
        (
            "watcher rename",
            &renames,
            "single renames in one folder, to the new name",
        ),
        (
            "watcher delete after rename",
            &after_rename,
            "deletes of the name each rename just made",
        ),
    ] {
        report.metric(
            format!("{name} p50"),
            percentile(samples, 50),
            "ms",
            format!("{} {what}", samples.len()),
        );
        report.metric(
            format!("{name} max"),
            percentile(samples, 100),
            "ms",
            format!("slowest of the {}", samples.len()),
        );
    }
    Ok(())
}

/// Create twenty thousand files as fast as the disk allows and time what the watcher does.
pub fn burst(
    wire: &mut Wire,
    root: u64,
    scratch: &Scratch,
    report: &mut Report,
) -> Result<(), Box<dyn Error>> {
    wire.begin_phase(
        "watcher burst",
        Duration::from_secs(60) + BURST_DEADLINE + INDEX_DEADLINE,
    );
    let subscription = subscribe(wire, root)?;
    let burst_rel = scratch.relative_path(BURST_DIR);
    let burst_dir = scratch.path(BURST_DIR);
    let sets = BURST_FILES.div_ceil(BURST_SET);
    for set in 0..sets {
        fs::create_dir_all(burst_dir.join(format!("set_{set:02}")))?;
    }
    quiet(wire, subscription, Duration::from_secs(5))?;
    let indexed_before = crate::measure::index_ready(wire, root)?.total;
    // The paths this burst adds, set by set, so every one of them can be checked for membership.
    let expected: Vec<Vec<String>> = (0..sets)
        .map(|set| {
            (0..set_files(set))
                .map(|file| burst_path(&burst_rel, set * BURST_SET + file))
                .collect()
        })
        .collect();

    let write_started = Instant::now();
    let mut origin = None;
    let mut file = 0;
    for paths in &expected {
        for path in paths {
            if origin.is_none() {
                origin = Some(Instant::now());
            }
            fs::write(scratch.join(path), format!("burst {file}\n"))?;
            file += 1;
        }
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
        root,
        subscription,
        scratch,
        origin,
        &expected,
        indexed_before,
    )?;

    let watcher = &outcome.watcher;
    let news = format!(
        "from the first create; {} change batch(es) of {} paths under {burst_rel}/, {} rescan(s): {} under {burst_rel}/, {} around it, {} of the whole root, {} unrelated, {} frame(s) after the cutoff",
        watcher.batches,
        thousands(watcher.paths),
        watcher.rescans,
        watcher.scoped,
        watcher.ancestor.is_some() as usize,
        watcher.root_rescans,
        watcher.unrelated,
        watcher.late
    );
    if let Some(ms) = watcher.scoped_ms {
        report.metric(
            "burst -> Rescan",
            ms,
            "ms",
            format!("scoped under {burst_rel}/; {news}"),
        );
    } else if let Some((folder, ms)) = &watcher.ancestor {
        report.metric(format!("burst -> rescan of {folder}"), *ms, "ms", news);
    } else if let Some(ms) = watcher.root_ms {
        report.metric("burst -> rescan of the whole root", ms, "ms", news);
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
        "from the first create; {} of {} burst paths confirmed in quick open, {} paths in the index",
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
    /// Rescans whose folder covers the burst: scoped under it, around it, or the whole root.
    rescans: usize,
    /// Rescans scoped under the burst folder, and the moment the first of them arrived.
    scoped: usize,
    scoped_ms: Option<f64>,
    /// The first rescan of a folder around the burst, with that folder's name.
    ancestor: Option<(String, f64)>,
    /// The first rescan of the whole root.
    root_ms: Option<f64>,
    root_rescans: usize,
    /// Rescans of folders that have nothing to do with the burst.
    unrelated: usize,
    /// Frames decoded after the watcher's cutoff, which do not count.
    late: usize,
    /// The moment the first batch naming a burst path arrived.
    first_ms: Option<f64>,
    /// Batches that named at least one burst path, and how many paths they named.
    batches: usize,
    paths: usize,
    /// When the last burst batch arrived, for the quiet window.
    last_report: Option<Instant>,
}

impl Watcher {
    fn quiet_for(&self, origin: Instant) -> Duration {
        self.last_report.unwrap_or(origin).elapsed()
    }
}

/// What quick open held when the check last ran.
struct Indexed {
    /// True when every expected burst path was confirmed present.
    complete: bool,
    /// The moment of the check, from the burst's first create.
    ms: f64,
    /// How many expected burst paths were confirmed, across the best check of each set.
    found: usize,
    /// How many paths the index held at all.
    total: u64,
}

struct Burst {
    watcher: Watcher,
    index: Indexed,
}

/// What one frame told the bench about the burst.
enum News {
    /// Not the burst's: another folder, another phase, or outside the window.
    Ignored,
    /// A batch naming burst paths, decoded at this moment.
    Batch(Instant),
    /// A rescan whose folder covers the burst: the watcher's last word on it.
    Rescan,
}

/// Wait for the burst's news and for quick open to hold every burst path, polling both together.
///
/// Times run from `origin`, the burst's first create, so a rescan that arrives while the writes
/// are still landing reads as what it is, and a partial index reports how partial it was.
fn await_burst(
    wire: &mut Wire,
    root: u64,
    subscription: u64,
    scratch: &Scratch,
    origin: Instant,
    expected: &[Vec<String>],
    indexed_before: u64,
) -> Result<Burst, Box<dyn Error>> {
    let burst_rel = scratch.relative_path(BURST_DIR);
    let burst_prefix = format!("{burst_rel}/");
    let watcher_cutoff = origin + BURST_DEADLINE;
    let index_cutoff = origin + INDEX_DEADLINE;
    let mut watcher = Watcher::default();
    let mut confirmed = vec![0usize; expected.len()];
    let mut watcher_done = false;
    let mut index_done = false;
    let mut index = Indexed {
        complete: false,
        ms: 0.0,
        found: 0,
        total: indexed_before,
    };
    let mut next_poll = Instant::now();
    loop {
        if !watcher_done && Instant::now() >= watcher_cutoff {
            // Frames the reader already decoded before the cutoff still count: drain them all
            // before the watcher is called silent.
            loop {
                let processed = drain(
                    wire,
                    subscription,
                    &mut watcher,
                    origin,
                    watcher_cutoff,
                    &burst_rel,
                    &burst_prefix,
                )?;
                if watcher.batches > 0 || watcher.rescans > 0 || processed < DRAIN_LIMIT {
                    break;
                }
            }
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
            if Instant::now() >= index_cutoff {
                // Never start a query after the deadline: report what was confirmed.
                index.found = confirmed.iter().sum();
                index.complete = false;
                index.ms = millis(origin.elapsed());
                index_done = true;
                continue;
            }
            match poll_index(
                wire,
                root,
                origin,
                index_cutoff,
                expected,
                indexed_before,
                &mut confirmed,
            ) {
                Ok(polled) => {
                    index = polled;
                    index_done = index.complete;
                    next_poll = Instant::now() + INDEX_POLL;
                }
                Err(error) => {
                    if !error.timed_out {
                        return Err(error.into());
                    }
                    // A check that ran out of time keeps what it confirmed before the cutoff.
                    index.found = confirmed.iter().sum();
                    index.complete = false;
                    index.ms = millis(origin.elapsed());
                    index_done = true;
                }
            }
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
            Some((at, payload)) => match observe(
                &mut watcher,
                origin,
                watcher_cutoff,
                &burst_rel,
                &burst_prefix,
                at,
                payload,
            ) {
                News::Batch(at) => watcher.last_report = Some(at),
                News::Ignored => {}
                News::Rescan => watcher_done = true,
            },
            None if watcher.batches > 0 && watcher.quiet_for(origin) > BURST_QUIET => {
                watcher_done = true;
            }
            None => {}
        }
    }
    Ok(Burst { watcher, index })
}

/// One index poll: a count as the hint, then the membership checks that decide completion.
fn poll_index(
    wire: &mut Wire,
    root: u64,
    origin: Instant,
    cutoff: Instant,
    expected: &[Vec<String>],
    indexed_before: u64,
    confirmed: &mut [usize],
) -> Result<Indexed, WireError> {
    let cheap = index_ready_until(wire, root, cutoff)?;
    let expected_total = indexed_before.saturating_add(BURST_FILES as u64);
    // The count is only a hint: it says the expensive membership check should sweep every set
    // now. Otherwise one set per poll keeps the check cheap while the index is still filling.
    let hint = cheap.ready && cheap.total >= expected_total;
    if cheap.ready {
        let mut checked = 0;
        for (set, count) in confirmed.iter_mut().enumerate() {
            if *count == expected[set].len() {
                continue;
            }
            if Instant::now() >= cutoff {
                break;
            }
            if !hint && checked > 0 {
                break;
            }
            match verify_set(wire, root, set, &expected[set], cutoff) {
                Ok(found) => *count = (*count).max(found),
                Err(error) if error.timed_out => break,
                Err(error) => return Err(error),
            }
            checked += 1;
        }
    }
    let complete = confirmed
        .iter()
        .zip(expected)
        .all(|(count, paths)| *count == paths.len());
    Ok(Indexed {
        complete,
        ms: millis(origin.elapsed()),
        found: confirmed.iter().sum(),
        total: cheap.total,
    })
}

/// How many of one set's expected paths quick open returns, checked one path at a time against a
/// deduplicated hit list rather than inferred from a count.
fn verify_set(
    wire: &mut Wire,
    root: u64,
    set: usize,
    expected: &[String],
    cutoff: Instant,
) -> Result<usize, WireError> {
    let query = format!("set_{set:02}/burst_");
    let result = index_until(wire, root, &query, BURST_SET as u64, cutoff)?;
    let returned: std::collections::HashSet<&str> =
        result.hits.iter().map(|hit| hit.path.as_str()).collect();
    Ok(expected
        .iter()
        .filter(|path| returned.contains(path.as_str()))
        .count())
}

/// Record what one frame said, if anything, about the burst.
fn observe(
    watcher: &mut Watcher,
    origin: Instant,
    cutoff: Instant,
    burst_rel: &str,
    burst_prefix: &str,
    at: Instant,
    payload: EventPayload,
) -> News {
    if at < origin {
        return News::Ignored;
    }
    if at > cutoff {
        watcher.late += 1;
        return News::Ignored;
    }
    match payload {
        EventPayload::Rescan { dir } => {
            let ms = millis(at.saturating_duration_since(origin));
            if verbose() {
                eprintln!("  watch: rescan {dir:?} at {ms:.0} ms");
            }
            match dir.as_deref() {
                None => {
                    watcher.rescans += 1;
                    watcher.root_rescans += 1;
                    watcher.root_ms.get_or_insert(ms);
                    News::Rescan
                }
                Some(dir) if below(dir, burst_rel) => {
                    watcher.rescans += 1;
                    watcher.scoped += 1;
                    watcher.scoped_ms.get_or_insert(ms);
                    News::Rescan
                }
                Some(dir) if below(burst_rel, dir) => {
                    // A folder around the burst, such as `bench` or the scratch folder: the
                    // watcher rescanned the burst as part of it, so it is news, but it is not the
                    // watcher narrowing to the burst.
                    watcher.rescans += 1;
                    watcher.ancestor.get_or_insert_with(|| (dir.to_owned(), ms));
                    News::Rescan
                }
                Some(_) => {
                    watcher.unrelated += 1;
                    News::Ignored
                }
            }
        }
        EventPayload::Changes { changes } => {
            let burst = changes
                .iter()
                .filter(|change| change.path.starts_with(burst_prefix))
                .count();
            if burst == 0 {
                return News::Ignored;
            }
            let ms = millis(at.saturating_duration_since(origin));
            if verbose() {
                eprintln!("  watch: {burst} burst paths at {ms:.0} ms");
            }
            watcher.batches += 1;
            watcher.paths += burst;
            if watcher.first_ms.is_none() && watcher.scoped_ms.is_none() {
                watcher.first_ms = Some(ms);
            }
            News::Batch(at)
        }
        _ => News::Ignored,
    }
}

/// True when `dir` is `ancestor` itself or sits below it.
fn below(dir: &str, ancestor: &str) -> bool {
    dir == ancestor
        || (dir.len() > ancestor.len()
            && dir.starts_with(ancestor)
            && dir.as_bytes().get(ancestor.len()) == Some(&b'/'))
}

/// Process the frames already queued before a deadline, so one that arrived in time is not lost.
/// Returns how many frames it processed, so the caller can tell whether the queue is now empty.
fn drain(
    wire: &mut Wire,
    subscription: u64,
    watcher: &mut Watcher,
    origin: Instant,
    cutoff: Instant,
    burst_rel: &str,
    burst_prefix: &str,
) -> Result<usize, Box<dyn Error>> {
    let mut processed = 0;
    for _ in 0..DRAIN_LIMIT {
        let Some((at, payload)) = wire.try_event(subscription, Duration::ZERO)? else {
            break;
        };
        processed += 1;
        if let News::Batch(at) = observe(
            watcher,
            origin,
            cutoff,
            burst_rel,
            burst_prefix,
            at,
            payload,
        ) {
            watcher.last_report = Some(at);
        }
    }
    Ok(processed)
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
    since: Option<Instant>,
) -> Result<Instant, Box<dyn Error>> {
    let started = Instant::now();
    loop {
        if started.elapsed() > deadline {
            return Err(format!("the watch never reported {path} within {deadline:?}").into());
        }
        match wire.try_event(subscription, Duration::from_millis(500))? {
            Some((at, EventPayload::Changes { changes }))
                if since.is_none_or(|floor| at >= floor)
                    && changes.iter().any(|change| change.path == path) =>
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

/// Files expected in burst set `set`, the last one holding the remainder.
fn set_files(set: usize) -> usize {
    BURST_SET.min(BURST_FILES - set * BURST_SET)
}

/// One burst file's tree-relative path.
fn burst_path(burst_rel: &str, file: usize) -> String {
    format!(
        "{burst_rel}/set_{:02}/burst_{file:05}.txt",
        file / BURST_SET
    )
}

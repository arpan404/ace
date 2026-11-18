// SPDX-License-Identifier: Apache-2.0

//! The measurements, in the order a person opens a checkout.
//!
//! Readiness is polled with a query that matches nothing, so it reads the index's counters instead
//! of scanning its paths. Polling starts right after the root opens, before the first listing, so
//! the readiness number does not wait on listing work, and it is labelled as the first poll that
//! saw the index ready. Every step runs inside a wire phase with an absolute deadline, so a stuck
//! binary fails here instead of hanging the run.

use std::error::Error;
use std::process::Command;
use std::time::{Duration, Instant};

use files_wire::{Case, EventPayload, IndexResult, Op, Page, Reply, SearchQuery};

use crate::Options;
use crate::report::Report;
use crate::scratch::Scratch;
use crate::tree::Tree;
use crate::units::{megabytes, millis, percentile, thousands};
use crate::watch;
use crate::wire::{Wire, WireError};

/// Entries one page asks for: the Files panel's first page.
const PAGE: u64 = 500;

/// Quick-open hits per query: more than a person reads in the list.
const HITS: u64 = 100;

/// How many quick-open queries the percentiles are taken from.
const QUICK_OPEN_SAMPLES: usize = 50;

/// How often readiness is asked for while the index builds.
const READY_POLL: Duration = Duration::from_millis(50);

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

/// The cap on one file the content search reads. The tree writes source files of at most 8 KiB, so
/// this excludes nothing: it is a limit on one file, not a budget for the whole search. Only the
/// tree's source bytes (about two gigabytes at a million files) size the search.
const SEARCH_FILE_CAP: u64 = 1024 * 1024;

/// How long the index build may take before the bench calls it hung.
const INDEX_DEADLINE: Duration = Duration::from_secs(900);

/// How long one listing or quick-open step may take.
const STEP_DEADLINE: Duration = Duration::from_secs(120);

/// How long the content search may take.
const SEARCH_DEADLINE: Duration = Duration::from_secs(600);

/// Every measurement, in the order a person opens a checkout.
pub fn measure(
    wire: &mut Wire,
    tree: &Tree,
    options: &Options,
    report: &mut Report,
) -> Result<(), Box<dyn Error>> {
    let shape = &tree.shape;
    // The watcher and burst write only into this run's scratch folder, which its drop removes.
    let scratch = Scratch::create(&tree.root)?;

    wire.begin_phase("open and list", STEP_DEADLINE);
    // Opening the root, then the first page of its listing: what the Files panel waits for.
    let opened = Instant::now();
    let root = match wire.ask(Op::OpenRoot {
        path: tree.root.to_string_lossy().into_owned(),
    })? {
        Reply::Root { root } => root,
        other => return Err(format!("openRoot answered {other:?}").into()),
    };
    let open_ms = millis(opened.elapsed());

    // Readiness polling starts here, right after the root opened, and not after any listing: the
    // first poll is part of what the Files panel waits for, not a consequence of its pages.
    wire.begin_phase("index build", INDEX_DEADLINE);
    let mut index = index_ready(wire, root)?;

    let page = list(wire, root, "", PAGE)?;
    let root_page_ms = millis(opened.elapsed());
    let big_started = Instant::now();
    let big = list(wire, root, shape.big_dir(), PAGE)?;
    let big_ms = millis(big_started.elapsed());

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
    report.metric(
        format!(
            "first page of the {}-entry folder",
            thousands(big.total as usize)
        ),
        big_ms,
        "ms",
        format!("{} entries of {}", big.entries.len(), big.total),
    );

    while !index.ready {
        if opened.elapsed() > INDEX_DEADLINE {
            return Err(format!("the index was not ready within {INDEX_DEADLINE:?}").into());
        }
        std::thread::sleep(READY_POLL);
        index = index_ready(wire, root)?;
    }
    report.metric(
        "openRoot -> first observed ready",
        millis(opened.elapsed()),
        "ms",
        format!(
            "first {}-ms poll that saw the index ready: {} paths{}",
            READY_POLL.as_millis(),
            thousands(index.total as usize),
            if index.truncated { ", truncated" } else { "" }
        ),
    );
    report.metric(
        "RSS after index build",
        resident_mib(wire.pid())?,
        "MiB",
        "ps -o rss= -p <ace-files>",
    );

    // Quick open, fifty queries over the wire.
    wire.begin_phase("quick open", STEP_DEADLINE);
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
        format!("nearest rank of the {QUICK_OPEN_SAMPLES} queries"),
    );

    // A literal content search over the tree's source, capped per file rather than in total.
    wire.begin_phase("content search", SEARCH_DEADLINE);
    let started = Instant::now();
    let subscription = match wire.ask(Op::Search {
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
            max_file_bytes: SEARCH_FILE_CAP,
        },
    })? {
        Reply::Subscription { subscription } => subscription,
        other => return Err(format!("search answered {other:?}").into()),
    };
    let summary = loop {
        match wire.try_event(subscription, SEARCH_DEADLINE)? {
            Some((_, EventPayload::Matches { .. })) => {}
            Some((_, EventPayload::SearchDone { summary })) => break summary,
            Some((_, EventPayload::SearchFailed { code, message })) => {
                return Err(format!("the search failed: {code}: {message}").into());
            }
            Some(_) => {}
            None => {
                return Err(format!("the search sent no event for {SEARCH_DEADLINE:?}").into());
            }
        }
    };
    let search = started.elapsed();
    report.metric(
        "content search, literal",
        millis(search),
        "ms",
        format!(
            "{} files with matches, {} matches, {}-byte per-file cap",
            thousands(summary.files as usize),
            thousands(summary.matches as usize),
            SEARCH_FILE_CAP
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

    // The watcher: one write at a time, then a burst it cannot describe one by one.
    watch::latency(wire, root, &scratch, report)?;
    watch::burst(wire, root, &scratch, report)?;

    report.fact("scratch", scratch.relative().to_owned());
    report.fact("json", options.json.display().to_string());
    Ok(())
}

/// One page of one folder.
pub fn list(wire: &mut Wire, root: u64, dir: &str, limit: u64) -> Result<Page, WireError> {
    match wire.ask(Op::List {
        root,
        dir: dir.to_owned(),
        limit,
        cursor: None,
        hide: vec![".git".to_owned(), ".DS_Store".to_owned()],
    })? {
        Reply::Page(page) => Ok(page),
        other => Err(WireError::failed(format!("list answered {other:?}"))),
    }
}

/// One quick-open query.
pub fn index_query(
    wire: &mut Wire,
    root: u64,
    query: &str,
    limit: u64,
) -> Result<IndexResult, WireError> {
    match wire.ask(Op::IndexQuery {
        root,
        query: query.to_owned(),
        limit,
    })? {
        Reply::Index(index) => Ok(index),
        other => Err(WireError::failed(format!("indexQuery answered {other:?}"))),
    }
}

/// One quick-open query that never runs past `deadline`.
pub fn index_until(
    wire: &mut Wire,
    root: u64,
    query: &str,
    limit: u64,
    deadline: Instant,
) -> Result<IndexResult, WireError> {
    match wire.ask_until(
        Op::IndexQuery {
            root,
            query: query.to_owned(),
            limit,
        },
        deadline,
    )? {
        Reply::Index(index) => Ok(index),
        other => Err(WireError::failed(format!("indexQuery answered {other:?}"))),
    }
}

/// The index's size and readiness, from a query with no terms: it matches nothing, so it reads the
/// index's counters rather than scanning every path.
pub fn index_ready(wire: &mut Wire, root: u64) -> Result<IndexResult, WireError> {
    index_query(wire, root, "", 1)
}

/// The index's size and readiness, never running past `deadline`.
pub fn index_ready_until(
    wire: &mut Wire,
    root: u64,
    deadline: Instant,
) -> Result<IndexResult, WireError> {
    index_until(wire, root, "", 1, deadline)
}

/// The subscription of a watch.
pub fn subscribe(wire: &mut Wire, root: u64) -> Result<u64, WireError> {
    match wire.ask(Op::Watch { root })? {
        Reply::Subscription { subscription } => Ok(subscription),
        other => Err(WireError::failed(format!("watch answered {other:?}"))),
    }
}

/// The process's resident set size in MiB, as `ps` reports it.
pub fn resident_mib(pid: u32) -> Result<f64, Box<dyn Error>> {
    let output = Command::new("ps")
        .args(["-o", "rss=", "-p", &pid.to_string()])
        .output()?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("ps failed for pid {pid} ({}) : {stderr}", output.status).into());
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let kilobytes: f64 = text
        .trim()
        .parse()
        .map_err(|error| format!("ps reported {text:?} for pid {pid}: {error}"))?;
    Ok(kilobytes / 1024.0)
}

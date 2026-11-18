// SPDX-License-Identifier: Apache-2.0

//! The measurements, in the order a person opens a checkout.

use std::error::Error;
use std::fs;
use std::process::Command;
use std::time::{Duration, Instant};

use files_wire::{Case, EventPayload, IndexResult, Op, Page, Reply, SearchQuery};

use crate::Options;
use crate::report::Report;
use crate::tree::Tree;
use crate::units::{megabytes, millis, percentile, thousands};
use crate::watch;
use crate::wire::Wire;

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

/// How long the index build may take before the bench calls it hung.
const INDEX_DEADLINE: Duration = Duration::from_secs(900);

/// Every measurement, in the order a person opens a checkout.
pub fn measure(
    wire: &mut Wire,
    tree: &Tree,
    options: &Options,
    report: &mut Report,
) -> Result<(), Box<dyn Error>> {
    let shape = &tree.shape;
    // The watcher and burst phases write into `bench/`, which is this bench's own folder. Clearing
    // it first keeps a reused tree's index at the generated paths and makes every run's burst
    // creates rather than overwrites.
    match fs::remove_dir_all(tree.root.join("bench")) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }

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

    // The watcher: one write at a time, then a burst it cannot describe one by one.
    watch::latency(wire, tree, root, report)?;
    watch::burst(wire, tree, root, report)?;

    report.fact("json", options.json.display().to_string());
    Ok(())
}

/// One page of one folder.
pub fn list(wire: &mut Wire, root: u64, dir: &str, limit: u64) -> Result<Page, Box<dyn Error>> {
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
pub fn index_query(
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
pub fn subscribe(wire: &mut Wire, root: u64) -> Result<u64, Box<dyn Error>> {
    let id = wire.request(Op::Watch { root })?;
    match wire.answer(id)? {
        Reply::Subscription { subscription } => Ok(subscription),
        other => Err(format!("watch answered {other:?}").into()),
    }
}

/// The process's resident set size in megabytes, as `ps` reports it.
pub fn resident_mb(pid: u32) -> Result<f64, Box<dyn Error>> {
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

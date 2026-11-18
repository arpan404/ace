// SPDX-License-Identifier: Apache-2.0

//! Temporary flood diagnostic: prints every batch while 50,000 files appear.

use std::time::{Duration, Instant};

use files_watch::{Batch, WatchOptions, Watcher};

fn main() {
    let count: usize = std::env::args()
        .nth(1)
        .and_then(|count| count.parse().ok())
        .unwrap_or(1_000);
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir(dir.path().join("flood")).unwrap();
    std::thread::sleep(Duration::from_millis(1_200));
    let root = files_safe::Root::open(dir.path()).unwrap();
    let start = Instant::now();
    let watcher = Watcher::start(
        root,
        WatchOptions {
            debounce: Duration::from_millis(3_000),
            ..WatchOptions::default()
        },
        Box::new(move |batch: Batch| {
            let summary = match &batch {
                Batch::Changes(changes) => format!("Changes({})", changes.len()),
                Batch::Rescan { dir } => format!("Rescan({dir:?})"),
                Batch::Warning(message) => format!("Warning({message})"),
            };
            println!("[{:?}] {summary}", start.elapsed());
        }),
    )
    .unwrap();
    println!(
        "watcher armed at {:?}, mode {:?}",
        start.elapsed(),
        watcher.mode()
    );
    for index in 0..count {
        std::fs::write(dir.path().join(format!("flood/file{index}")), b"x").unwrap();
        if index % 5_000 == 0 || count < 5_000 {
            println!("wrote {index} at {:?}", start.elapsed());
        }
    }
    println!("writes done at {:?}", start.elapsed());
    std::thread::sleep(Duration::from_secs(15));
    drop(watcher);
    println!("done at {:?}", start.elapsed());
}

// SPDX-License-Identifier: Apache-2.0

//! Resolving every entry of one large folder, against listing the folder for every entry.
//!
//! Run with `cargo run --release --example bench_resolve`. The second measurement repeats what the
//! previous implementation did — list the folder and match the name by text — on a sample of the
//! same entries, because listing twenty thousand entries twenty thousand times takes minutes.

use std::fs::{self, File};
use std::time::Instant;

use cap_std::ambient_authority;
use files_safe::Root;

const ENTRIES: usize = 20_000;

/// How many entries the listing measurement runs over before it is extrapolated.
const SAMPLE: usize = 200;

const ENTRIES_U32: u32 = ENTRIES as u32;
const SAMPLE_U32: u32 = SAMPLE as u32;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let temp = tempfile::tempdir()?;
    let checkout = temp.path().join("checkout");
    fs::create_dir_all(&checkout)?;
    for index in 0..ENTRIES {
        File::create(checkout.join(format!("file{index:05}.txt")))?;
    }
    let root = Root::open(&checkout)?;
    let names: Vec<String> = (0..ENTRIES)
        .map(|index| format!("file{index:05}.txt"))
        .collect();

    let start = Instant::now();
    let mut resolved = 0;
    for name in &names {
        if root.resolve(name).is_ok() {
            resolved += 1;
        }
    }
    let after = start.elapsed();
    assert_eq!(resolved, ENTRIES, "every entry must resolve");

    let folder = cap_std::fs::Dir::open_ambient_dir(root.path(), ambient_authority())?;
    let start = Instant::now();
    let mut found = 0;
    for name in names.iter().take(SAMPLE) {
        let hit = folder.entries()?.flatten().find(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .eq_ignore_ascii_case(name)
        });
        if hit.is_some() {
            found += 1;
        }
    }
    let sample = start.elapsed();
    assert_eq!(found, SAMPLE, "every sampled entry must be listed");

    let per_listing = sample / SAMPLE_U32;
    let before = per_listing * ENTRIES_U32;
    println!("resolve {ENTRIES} entries of one folder");
    println!(
        "  handles and one listing: {after:?} for all {ENTRIES} ({:?} each)",
        after / ENTRIES_U32
    );
    println!(
        "  listing per entry:       ~{before:?} for all {ENTRIES} ({per_listing:?} each, {SAMPLE} sampled)"
    );
    Ok(())
}

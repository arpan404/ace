// SPDX-License-Identifier: Apache-2.0

//! The bench from the contract: a folder of 100,000 files, first page of 500.
//!
//! Ignored by default because it creates 100,000 files. Run it once, in release:
//!
//! ```text
//! cargo test -p files-list --release -- --ignored --nocapture
//! ```

mod support;

use std::fs::File;
use std::time::Instant;

use files_list::ListOptions;
use tempfile::TempDir;

const FILES: usize = 100_000;

#[ignore = "bench: creates 100,000 files, release only"]
#[test]
fn lists_the_first_page_of_a_hundred_thousand_files() {
    let home = TempDir::new().unwrap();
    let root = home.path();

    let started = Instant::now();
    for index in 0..FILES {
        File::create(root.join(format!("entry-{index:06}.dat"))).unwrap();
    }
    let created = started.elapsed();

    let lister = support::lister(root);
    let options = ListOptions {
        limit: 500,
        cursor: None,
        hide: vec![".git".to_owned(), ".DS_Store".to_owned()],
    };

    let started = Instant::now();
    let first = lister.list("", &options).unwrap();
    let cold = started.elapsed();
    assert_eq!(first.entries.len(), 500);
    assert_eq!(first.total, FILES);
    assert!(first.next_cursor.is_some());

    let started = Instant::now();
    let second = lister
        .list(
            "",
            &ListOptions {
                cursor: first.next_cursor.clone(),
                ..options.clone()
            },
        )
        .unwrap();
    let warm = started.elapsed();
    assert_eq!(second.total, FILES);

    let started = Instant::now();
    let again = lister.list("", &options).unwrap();
    let cached = started.elapsed();
    assert_eq!(again.entries, first.entries);

    println!("create {FILES} files:        {created:?}");
    println!("first page, folder unread:   {cold:?}");
    println!("next page, cached snapshot:  {warm:?}");
    println!("first page again, cached:    {cached:?}");
}

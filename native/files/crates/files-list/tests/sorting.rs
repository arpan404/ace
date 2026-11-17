// SPDX-License-Identifier: Apache-2.0

//! Listing order, as VS Code's explorer shows it.

// The fixture helper is not a `#[test]` function, so clippy's test exemption for `unwrap` does not
// reach it; a temporary folder that cannot be made should fail the test loudly.
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use tempfile::TempDir;

use support::{first_page, lister, names, options};

fn listed(names_in_creation_order: &[&str]) -> Vec<String> {
    let home = TempDir::new().unwrap();
    for name in names_in_creation_order {
        support::write(home.path(), name, "x");
    }
    let page = first_page(&lister(home.path()), "", &options(100));
    names(&page.entries)
        .into_iter()
        .map(str::to_owned)
        .collect()
}

#[test]
fn accents_sort_with_their_letter() {
    assert_eq!(
        listed(&["eb.txt", "éa.txt"]),
        ["éa.txt", "eb.txt"].map(str::to_owned)
    );
}

#[test]
fn punctuation_sorts_before_letters() {
    assert_eq!(
        listed(&["a.txt", "~x.txt"]),
        ["~x.txt", "a.txt"].map(str::to_owned)
    );
}

#[test]
fn whitespace_is_part_of_the_name() {
    let order = listed(&["ab.txt", "a b.txt", "a-c.txt"]);

    assert_eq!(order, ["a b.txt", "a-c.txt", "ab.txt"].map(str::to_owned));
}

#[test]
fn numbers_sort_by_value() {
    assert_eq!(
        listed(&["file10.txt", "file2.txt", "file1.txt"]),
        ["file1.txt", "file2.txt", "file10.txt"].map(str::to_owned)
    );
}

#[test]
fn case_does_not_decide_the_order() {
    assert_eq!(
        listed(&["Zebra.txt", "apple.txt", "Ant.txt"]),
        ["Ant.txt", "apple.txt", "Zebra.txt"].map(str::to_owned)
    );
}

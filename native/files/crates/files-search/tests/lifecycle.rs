// SPDX-License-Identifier: Apache-2.0

//! How a search ends: the sink stopping it, the cap, cancellation and bad arguments.

mod support;

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

use files_safe::Root;
use files_search::search;

use support::{TestResult, paths, query, run, write};

#[test]
fn sink_false_stops_search() -> TestResult {
    let temp = tempfile::tempdir()?;
    for index in 0..300 {
        write(temp.path(), &format!("many/file{index}.txt"), "needle\n")?;
    }
    let root = Root::open(temp.path())?;
    let calls = AtomicUsize::new(0);
    let cancel = AtomicBool::new(false);
    let summary = search(&root, &query("needle"), &cancel, &|_file| {
        calls.fetch_add(1, Ordering::SeqCst);
        false
    })?;

    assert_eq!(
        calls.load(Ordering::SeqCst),
        1,
        "the sink was called again after it returned false"
    );
    assert_eq!(summary.files, 1);
    assert_eq!(summary.matches, 1);
    Ok(())
}

#[test]
fn dropped_binary_file_returns_its_match_slots() -> TestResult {
    let temp = tempfile::tempdir()?;
    // Two matches, then a NUL far beyond the first buffer, so it is only noticed late.
    let mut blob = String::from("needle\nneedle\n");
    blob.push_str(&"x".repeat(100_000 - blob.len()));
    blob.push('\0');
    blob.push_str("\nneedle\n");
    write(temp.path(), "blob.bin", blob.as_bytes())?;
    write(temp.path(), "text.txt", "needle\n")?;
    let root = Root::open(temp.path())?;
    let mut query = query("needle");
    query.max_matches = 3;
    let (files, summary) = run(&root, &query)?;

    assert_eq!(paths(&files), ["text.txt"]);
    assert_eq!(summary.matches, 1);
    assert!(!summary.limit_hit);
    Ok(())
}

#[test]
fn cancel_stops_search() -> TestResult {
    let temp = tempfile::tempdir()?;
    write(temp.path(), "a.txt", "needle\n")?;
    let root = Root::open(temp.path())?;
    let cancel = AtomicBool::new(true);
    let code = match search(&root, &query("needle"), &cancel, &|_file| true) {
        Ok(_) => panic!("a cancelled search must not run"),
        Err(error) => error.code(),
    };
    assert_eq!(code, "ABORTED");
    Ok(())
}

#[test]
fn cancel_from_the_sink_stops_the_search() -> TestResult {
    let temp = tempfile::tempdir()?;
    // A large file with no match must stop reading as soon as the sink cancels.
    let mut large = String::from("nothing to see here\n");
    large.push_str(&"x".repeat(2_000_000));
    write(temp.path(), "large.txt", large)?;
    for index in 0..40 {
        write(temp.path(), &format!("many/file{index}.txt"), "needle\n")?;
    }
    let root = Root::open(temp.path())?;
    let cancel = AtomicBool::new(false);
    let result = search(&root, &query("needle"), &cancel, &|_file| {
        cancel.store(true, Ordering::SeqCst);
        true
    });
    let code = match result {
        Ok(_) => panic!("a search cancelled from the sink must not finish"),
        Err(error) => error.code(),
    };
    assert_eq!(code, "ABORTED");
    Ok(())
}

#[test]
fn invalid_regex_is_an_argument_error() -> TestResult {
    let temp = tempfile::tempdir()?;
    let root = Root::open(temp.path())?;
    let cancel = AtomicBool::new(false);
    let mut query = query("(");
    query.regex = true;
    let code = match search(&root, &query, &cancel, &|_file| true) {
        Ok(_) => panic!("an invalid regex must not search"),
        Err(error) => error.code(),
    };
    assert_eq!(code, "INVALID_ARGUMENT");
    Ok(())
}

#[test]
fn newline_in_pattern_is_an_argument_error() -> TestResult {
    let temp = tempfile::tempdir()?;
    write(temp.path(), "a.txt", "one\ntwo\n")?;
    let root = Root::open(temp.path())?;
    let cancel = AtomicBool::new(false);
    let mut expression = query("one\ntwo");
    expression.regex = true;
    for query in [expression, query("one\ntwo")] {
        let code = match search(&root, &query, &cancel, &|_file| true) {
            Ok(_) => panic!("a pattern with a line terminator must not search"),
            Err(error) => error.code(),
        };
        assert_eq!(code, "INVALID_ARGUMENT");
    }
    Ok(())
}

// SPDX-License-Identifier: Apache-2.0

//! Behaviour of content search on real temporary checkouts.

use std::fs;
use std::io;
use std::path::Path;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

use files_safe::Root;
use files_search::{Case, FileMatches, Query, Summary, search};

type TestResult = Result<(), Box<dyn std::error::Error>>;

fn write(root: &Path, path: &str, contents: impl AsRef<[u8]>) -> io::Result<()> {
    let full = root.join(path);
    if let Some(parent) = full.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(full, contents)
}

fn query(pattern: &str) -> Query {
    Query {
        pattern: pattern.to_owned(),
        regex: false,
        case: Case::Sensitive,
        whole_word: false,
        include: Vec::new(),
        exclude: Vec::new(),
        include_ignored: false,
        max_matches: 1000,
        max_file_bytes: 0,
    }
}

fn run(root: &Root, query: &Query) -> Result<(Vec<FileMatches>, Summary), files_search::Error> {
    let files = Mutex::new(Vec::new());
    let cancel = AtomicBool::new(false);
    let summary = search(root, query, &cancel, &|file| {
        match files.lock() {
            Ok(mut files) => files.push(file),
            Err(poisoned) => poisoned.into_inner().push(file),
        }
        true
    })?;
    let files = match files.into_inner() {
        Ok(files) => files,
        Err(poisoned) => poisoned.into_inner(),
    };
    Ok((files, summary))
}

fn paths(files: &[FileMatches]) -> Vec<&str> {
    let mut paths: Vec<&str> = files.iter().map(|file| file.path.as_str()).collect();
    paths.sort_unstable();
    paths
}

#[test]
fn finds_literal_across_files() -> TestResult {
    let temp = tempfile::tempdir()?;
    write(temp.path(), "a.txt", "alpha needle\n")?;
    write(temp.path(), "nested/b.txt", "needle beta\nneedle again\n")?;
    write(temp.path(), "c.txt", "nothing here\n")?;
    let root = Root::open(temp.path())?;
    let (files, summary) = run(&root, &query("needle"))?;

    assert_eq!(summary.files, 2);
    assert_eq!(summary.matches, 3);
    assert!(summary.bytes > 0);
    assert!(!summary.limit_hit);
    assert_eq!(paths(&files), ["a.txt", "nested/b.txt"]);

    let nested = match files.iter().find(|file| file.path == "nested/b.txt") {
        Some(found) => found,
        None => panic!("nested/b.txt was not searched"),
    };
    assert_eq!(nested.lines.len(), 2);
    assert_eq!(nested.lines[0].line, 1);
    assert_eq!(nested.lines[0].preview, "needle beta");
    assert_eq!(nested.lines[0].ranges, [(0, 6)]);
    assert_eq!(nested.lines[1].line, 2);
    assert_eq!(nested.lines[1].preview, "needle again");
    Ok(())
}

#[test]
fn regex_with_groups() -> TestResult {
    let temp = tempfile::tempdir()?;
    write(temp.path(), "main.rs", "fn main() {\n    run();\n}\n")?;
    let root = Root::open(temp.path())?;
    let mut query = query(r"fn (\w+)\(");
    query.regex = true;
    let (files, summary) = run(&root, &query)?;

    assert_eq!(summary.matches, 1);
    assert_eq!(files.len(), 1);
    let line = &files[0].lines[0];
    assert_eq!(line.line, 1);
    assert_eq!(line.preview, "fn main() {");
    assert_eq!(line.ranges, [(0, 8)]);
    assert_eq!(&line.preview[0..8], "fn main(");
    Ok(())
}

#[test]
fn smart_case_is_insensitive_for_lowercase_query() -> TestResult {
    let temp = tempfile::tempdir()?;
    write(
        temp.path(),
        "cases.txt",
        "Needle one\nneedle two\nNEEDLE three\n",
    )?;
    let root = Root::open(temp.path())?;

    let mut smart = query("needle");
    smart.case = Case::Smart;
    assert_eq!(run(&root, &smart)?.1.matches, 3);

    let mut exact = query("needle");
    exact.case = Case::Sensitive;
    assert_eq!(run(&root, &exact)?.1.matches, 1);

    let mut upper = query("Needle");
    upper.case = Case::Smart;
    assert_eq!(run(&root, &upper)?.1.matches, 1);

    let mut insensitive = query("nEeDlE");
    insensitive.case = Case::Insensitive;
    assert_eq!(run(&root, &insensitive)?.1.matches, 3);
    Ok(())
}

#[test]
fn whole_word_skips_substrings() -> TestResult {
    let temp = tempfile::tempdir()?;
    write(temp.path(), "words.txt", "cat\nconcatenate\ncat.\n")?;
    let root = Root::open(temp.path())?;
    let mut query = query("cat");
    query.whole_word = true;
    let (files, summary) = run(&root, &query)?;

    assert_eq!(summary.matches, 2);
    let lines: Vec<u64> = files[0].lines.iter().map(|line| line.line).collect();
    assert_eq!(lines, [1, 3]);
    Ok(())
}

#[test]
fn include_and_exclude_globs() -> TestResult {
    let temp = tempfile::tempdir()?;
    write(temp.path(), "keep/a.txt", "needle\n")?;
    write(temp.path(), "keep/notes.md", "needle\n")?;
    write(temp.path(), "skip/b.txt", "needle\n")?;
    write(temp.path(), "top.txt", "needle\n")?;
    let root = Root::open(temp.path())?;
    let mut query = query("needle");
    query.include = vec!["**/*.txt".to_owned()];
    query.exclude = vec!["skip/**".to_owned()];
    let (files, summary) = run(&root, &query)?;

    assert_eq!(paths(&files), ["keep/a.txt", "top.txt"]);
    assert_eq!(summary.files, 2);
    assert_eq!(summary.matches, 2);
    Ok(())
}

#[test]
fn skips_gitignored_unless_asked() -> TestResult {
    let temp = tempfile::tempdir()?;
    write(temp.path(), ".gitignore", "ignored.txt\nbuild/\n")?;
    write(temp.path(), "ignored.txt", "needle ignored\n")?;
    write(temp.path(), "build/generated.txt", "needle built\n")?;
    write(temp.path(), "kept.txt", "needle kept\n")?;
    let root = Root::open(temp.path())?;

    let (files, summary) = run(&root, &query("needle"))?;
    assert_eq!(paths(&files), ["kept.txt"]);
    assert_eq!(summary.files, 1);

    let mut asked = query("needle");
    asked.include_ignored = true;
    let (files, summary) = run(&root, &asked)?;
    assert_eq!(
        paths(&files),
        ["build/generated.txt", "ignored.txt", "kept.txt"]
    );
    assert_eq!(summary.files, 3);
    Ok(())
}

#[test]
fn skips_binary_files() -> TestResult {
    let temp = tempfile::tempdir()?;
    write(temp.path(), "image.bin", b"\x00needle\nneedle\n")?;
    write(temp.path(), "text.txt", "needle\n")?;
    let root = Root::open(temp.path())?;
    let (files, summary) = run(&root, &query("needle"))?;

    assert_eq!(paths(&files), ["text.txt"]);
    assert_eq!(summary.files, 1);
    assert_eq!(summary.matches, 1);
    Ok(())
}

#[test]
fn stops_at_max_matches_with_limit_hit() -> TestResult {
    let temp = tempfile::tempdir()?;
    write(temp.path(), "many.txt", "needle\nneedle\nneedle\nneedle\n")?;
    let root = Root::open(temp.path())?;
    let mut query = query("needle");
    query.max_matches = 2;
    let (files, summary) = run(&root, &query)?;

    assert_eq!(summary.matches, 2);
    assert!(summary.limit_hit);
    let ranges: usize = files
        .iter()
        .flat_map(|file| file.lines.iter())
        .map(|line| line.ranges.len())
        .sum();
    assert_eq!(ranges, 2);
    Ok(())
}

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

    let calls = calls.load(Ordering::SeqCst);
    assert!(calls >= 1);
    assert!(calls < 300, "the sink's false stopped only after {calls}");
    assert_eq!(summary.files as usize, calls);
    assert_eq!(summary.matches as usize, calls);
    Ok(())
}

#[test]
fn long_line_preview_is_bounded() -> TestResult {
    let temp = tempfile::tempdir()?;
    let mut line = String::new();
    line.push_str(&"x".repeat(5000));
    line.push_str("needle");
    line.push_str(&"y".repeat(5000));
    line.push('\n');
    write(temp.path(), "long.txt", line)?;
    let root = Root::open(temp.path())?;
    let (files, summary) = run(&root, &query("needle"))?;

    assert_eq!(summary.matches, 1);
    assert_eq!(files.len(), 1);
    let found = &files[0].lines[0];
    assert!(found.preview.len() <= 400);
    assert!(found.preview.contains("needle"));
    assert_eq!(found.ranges.len(), 1);
    let (start, end) = found.ranges[0];
    assert_eq!(&found.preview[start as usize..end as usize], "needle");
    Ok(())
}

#[test]
fn searches_hidden_files_and_folders() -> TestResult {
    let temp = tempfile::tempdir()?;
    write(temp.path(), ".env", "needle\n")?;
    write(temp.path(), ".config/app.txt", "needle\n")?;
    let root = Root::open(temp.path())?;
    let (files, summary) = run(&root, &query("needle"))?;

    assert_eq!(paths(&files), [".config/app.txt", ".env"]);
    assert_eq!(summary.matches, 2);
    Ok(())
}

#[test]
fn reports_every_match_on_a_line() -> TestResult {
    let temp = tempfile::tempdir()?;
    write(temp.path(), "twice.txt", "needle and needle\n")?;
    let root = Root::open(temp.path())?;
    let (files, summary) = run(&root, &query("needle"))?;

    assert_eq!(summary.matches, 2);
    assert_eq!(files.len(), 1);
    let line = &files[0].lines[0];
    assert_eq!(line.ranges, [(0, 6), (11, 17)]);
    for (start, end) in &line.ranges {
        assert_eq!(&line.preview[*start as usize..*end as usize], "needle");
    }
    Ok(())
}

#[test]
fn preview_offsets_survive_multibyte_text() -> TestResult {
    let temp = tempfile::tempdir()?;
    write(temp.path(), "accent.txt", "héllo needle\n")?;
    let root = Root::open(temp.path())?;
    let (files, _summary) = run(&root, &query("needle"))?;

    assert_eq!(files.len(), 1);
    let line = &files[0].lines[0];
    assert_eq!(line.preview, "héllo needle");
    let (start, end) = line.ranges[0];
    assert_eq!(start, 7);
    assert_eq!(&line.preview[start as usize..end as usize], "needle");
    Ok(())
}

#[test]
fn max_file_bytes_skips_large_files() -> TestResult {
    let temp = tempfile::tempdir()?;
    write(temp.path(), "small.txt", "needle\n")?;
    let mut large = String::from("needle\n");
    large.push_str(&"x".repeat(200));
    write(temp.path(), "large.txt", large)?;
    let root = Root::open(temp.path())?;
    let mut query = query("needle");
    query.max_file_bytes = 50;
    let (files, summary) = run(&root, &query)?;

    assert_eq!(paths(&files), ["small.txt"]);
    assert_eq!(summary.files, 1);
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

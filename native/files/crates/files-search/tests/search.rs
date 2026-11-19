// SPDX-License-Identifier: Apache-2.0

//! What a search finds, how it reports each line and when it stops at the cap.

mod support;

use files_safe::Root;
use files_search::Case;

use support::{TestResult, paths, query, run, write};

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
    // The match sits 5000 characters into the line, wherever the preview was cut.
    assert_eq!(found.column + start as u64, 5000);
    Ok(())
}

#[test]
fn long_multibyte_line_preview_is_bounded() -> TestResult {
    let temp = tempfile::tempdir()?;
    let line = format!("{}needle{}", "é".repeat(3000), "日本".repeat(1000));
    write(temp.path(), "wide.txt", format!("{line}\n"))?;
    let root = Root::open(temp.path())?;
    let (files, summary) = run(&root, &query("needle"))?;

    assert_eq!(summary.matches, 1);
    assert_eq!(files.len(), 1);
    let found = &files[0].lines[0];
    assert!(found.preview.len() <= 400);
    assert_eq!(found.ranges.len(), 1);
    let (start, end) = found.ranges[0];
    assert_eq!(&found.preview[start as usize..end as usize], "needle");
    // Each "é" is one UTF-16 unit and two bytes: the column counts what an editor counts.
    let before: String = found.preview[..start as usize].to_owned();
    assert_eq!(found.column + before.encode_utf16().count() as u64, 3000);
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
fn zero_width_matches_keep_their_place_at_a_line_edge() -> TestResult {
    let temp = tempfile::tempdir()?;
    write(temp.path(), "short.txt", "abc\n")?;
    write(temp.path(), "long.txt", format!("{}\n", "x".repeat(1000)))?;
    let root = Root::open(temp.path())?;
    for (pattern, short, long) in [("$", (3, 3), (400, 400)), ("^", (0, 0), (0, 0))] {
        let mut query = query(pattern);
        query.regex = true;
        let (files, _summary) = run(&root, &query)?;
        let ranges = |path: &str| {
            files
                .iter()
                .find(|file| file.path == path)
                .map(|file| file.lines[0].ranges.clone())
        };
        assert_eq!(
            ranges("short.txt"),
            Some(vec![short]),
            "{pattern} on a short line"
        );
        let long_line = files.iter().find(|file| file.path == "long.txt");
        let column = long_line.map(|file| file.lines[0].column);
        let expected_column = if pattern == "$" { 600 } else { 0 };
        assert_eq!(
            column,
            Some(expected_column),
            "{pattern} column on a cut line"
        );
        assert_eq!(
            ranges("long.txt"),
            Some(vec![long]),
            "{pattern} on a cut line"
        );
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

// SPDX-License-Identifier: Apache-2.0

//! Which files a search walks: hidden entries, includes and git's ignore rules.

mod support;

use std::fs;

use files_safe::Root;

use support::{TestResult, paths, query, run, write};

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
fn include_globs_do_not_unignore_gitignored_files() -> TestResult {
    let temp = tempfile::tempdir()?;
    write(temp.path(), ".gitignore", "secret.txt\n")?;
    write(temp.path(), "secret.txt", "needle\n")?;
    write(temp.path(), "public.txt", "needle\n")?;
    let root = Root::open(temp.path())?;
    let mut query = query("needle");
    query.include = vec!["**/*.txt".to_owned()];
    let (files, summary) = run(&root, &query)?;

    assert_eq!(paths(&files), ["public.txt"]);
    assert_eq!(summary.files, 1);
    Ok(())
}

#[test]
fn never_searches_inside_a_dot_git_folder() -> TestResult {
    let temp = tempfile::tempdir()?;
    write(temp.path(), ".git/config", "needle in git\n")?;
    write(temp.path(), "src/a.txt", "needle\n")?;
    let root = Root::open(temp.path())?;
    let (files, summary) = run(&root, &query("needle"))?;

    assert_eq!(paths(&files), ["src/a.txt"]);
    assert_eq!(summary.files, 1);
    Ok(())
}

#[test]
fn inherits_gitignore_rules_up_to_the_repository_top() -> TestResult {
    let temp = tempfile::tempdir()?;
    fs::create_dir_all(temp.path().join("repo/.git"))?;
    write(temp.path(), "repo/.gitignore", "secret.txt\n")?;
    write(temp.path(), "repo/sub/a.txt", "needle\n")?;
    write(temp.path(), "repo/sub/secret.txt", "needle\n")?;
    write(temp.path(), "repo/sub/outside.txt", "needle\n")?;
    // Above the repository's top: a search must never reach this rule.
    write(temp.path(), ".gitignore", "outside.txt\n")?;
    let root = Root::open(&temp.path().join("repo/sub"))?;
    let (files, summary) = run(&root, &query("needle"))?;

    assert_eq!(paths(&files), ["a.txt", "outside.txt"]);
    assert_eq!(summary.files, 2);
    Ok(())
}

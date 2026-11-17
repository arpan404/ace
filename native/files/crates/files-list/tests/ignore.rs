// SPDX-License-Identifier: Apache-2.0

//! Git's ignore rules, reported per entry instead of hiding anything.
//!
//! The root can be a subfolder of a repository, so the rules start at the repository top.

mod support;

use tempfile::TempDir;

use support::{entry, first_page, folder, lister, options, write};

/// A suffix no global excludes file is likely to name, so these tests read the same on any machine.
const IGNORED: &str = "generated.ignored-by-test";

#[test]
fn marks_gitignored_entries_without_hiding_them() {
    let home = TempDir::new().unwrap();
    let root = home.path();
    write(root, ".gitignore", "*.ignored-by-test\nbuild-cache/\n");
    write(root, "keep.txt", "x");
    write(root, IGNORED, "x");
    write(root, "build-cache/artifact.bin", "x");

    let listing = first_page(&lister(root), "", &options(100));

    assert_eq!(listing.total, 4);
    assert!(entry(&listing.entries, IGNORED).ignored);
    assert!(entry(&listing.entries, "build-cache").ignored);
    assert!(!entry(&listing.entries, "keep.txt").ignored);
    assert!(!entry(&listing.entries, ".gitignore").ignored);
}

#[test]
fn nested_gitignore_applies_to_its_folder_only() {
    let home = TempDir::new().unwrap();
    let root = home.path();
    write(root, "sub/.gitignore", "*.ignored-by-test\n");
    write(root, "top.ignored-by-test", "x");
    write(root, "plain.txt", "x");
    write(root, "sub/inside.ignored-by-test", "x");
    write(root, "sub/plain.txt", "x");

    let lister = lister(root);
    let top = first_page(&lister, "", &options(100));
    assert!(!entry(&top.entries, "top.ignored-by-test").ignored);
    assert!(!entry(&top.entries, "plain.txt").ignored);

    let nested = first_page(&lister, "sub", &options(100));
    assert!(entry(&nested.entries, "sub/inside.ignored-by-test").ignored);
    assert!(!entry(&nested.entries, "sub/plain.txt").ignored);
    assert!(!entry(&nested.entries, "sub/.gitignore").ignored);
}

#[test]
fn a_whitelist_reincludes_a_file() {
    let home = TempDir::new().unwrap();
    let root = home.path();
    write(
        root,
        ".gitignore",
        "*.ignored-by-test\n!keep.ignored-by-test\n",
    );
    write(root, "drop.ignored-by-test", "x");
    write(root, "keep.ignored-by-test", "x");

    let listing = first_page(&lister(root), "", &options(100));

    assert!(entry(&listing.entries, "drop.ignored-by-test").ignored);
    assert!(!entry(&listing.entries, "keep.ignored-by-test").ignored);
}

#[test]
fn everything_inside_an_ignored_folder_is_ignored() {
    let home = TempDir::new().unwrap();
    let root = home.path();
    write(root, ".gitignore", "vendor/\n");
    write(root, "vendor/inner.txt", "x");
    write(root, "vendor/deeper/leaf.txt", "x");

    let lister = lister(root);
    let vendor = first_page(&lister, "vendor", &options(100));
    assert!(entry(&vendor.entries, "vendor/inner.txt").ignored);

    let deeper = first_page(&lister, "vendor/deeper", &options(100));
    assert!(entry(&deeper.entries, "vendor/deeper/leaf.txt").ignored);
}

#[test]
fn an_info_exclude_file_applies_to_the_whole_checkout() {
    let home = TempDir::new().unwrap();
    let root = home.path();
    folder(root, ".git/info");
    write(root, ".git/info/exclude", "*.ignored-by-test\n");
    write(root, IGNORED, "x");
    write(root, "nested/deeper.ignored-by-test", "x");

    let lister = lister(root);
    let top = first_page(&lister, "", &options(100));
    assert!(entry(&top.entries, IGNORED).ignored);

    let nested = first_page(&lister, "nested", &options(100));
    assert!(entry(&nested.entries, "nested/deeper.ignored-by-test").ignored);
}

#[test]
fn a_core_excludes_file_from_the_repository_config_applies() {
    let home = TempDir::new().unwrap();
    let root = home.path();
    folder(root, ".git");
    write(
        root,
        ".git/config",
        "[core]\n\texcludesFile = extra-ignore\n",
    );
    write(root, "extra-ignore", "*.ignored-by-test\n");
    write(root, IGNORED, "x");
    write(root, "kept.txt", "x");

    let listing = first_page(&lister(root), "", &options(100));

    assert!(entry(&listing.entries, IGNORED).ignored);
    assert!(!entry(&listing.entries, "kept.txt").ignored);
}

#[test]
fn invalidate_picks_up_a_gitignore_written_later() {
    let home = TempDir::new().unwrap();
    let root = home.path();
    write(root, &format!("sub/{IGNORED}"), "x");

    let lister = lister(root);
    let before = first_page(&lister, "sub", &options(100));
    assert!(!entry(&before.entries, &format!("sub/{IGNORED}")).ignored);

    write(root, "sub/.gitignore", "*.ignored-by-test\n");
    lister.invalidate(&["sub"]);

    let after = first_page(&lister, "sub", &options(100));
    assert!(entry(&after.entries, &format!("sub/{IGNORED}")).ignored);
}

#[test]
fn invalidating_the_root_forgets_every_child() {
    let home = TempDir::new().unwrap();
    let root = home.path();
    write(root, &format!("sub/{IGNORED}"), "x");

    let lister = lister(root);
    let before = first_page(&lister, "", &options(100));
    assert!(!entry(&before.entries, "sub").ignored);

    write(root, ".gitignore", "sub/\n");
    lister.invalidate(&[""]);
    lister.invalidate(&[".", "sub"]);

    let after = first_page(&lister, "", &options(100));
    assert!(entry(&after.entries, "sub").ignored);
}

#[test]
fn parent_gitignore_inside_the_repo_applies() {
    let home = TempDir::new().unwrap();
    let repo = home.path();
    folder(repo, ".git");
    write(repo, ".gitignore", "*.log\n");
    write(repo, "sub/a.log", "x");
    write(repo, "sub/kept.txt", "x");
    write(repo, "sub/nested/b.log", "x");

    let lister = lister(&repo.join("sub"));
    let page = first_page(&lister, "", &options(100));
    assert!(entry(&page.entries, "a.log").ignored);
    assert!(!entry(&page.entries, "kept.txt").ignored);

    let nested = first_page(&lister, "nested", &options(100));
    assert!(entry(&nested.entries, "nested/b.log").ignored);
}

#[test]
fn a_gitignore_above_the_repository_top_does_not_apply() {
    let home = TempDir::new().unwrap();
    let outer = home.path();
    write(outer, ".gitignore", "*.ignored-by-test\n");
    folder(outer, "repo/.git");
    write(outer, "repo/sub/file.ignored-by-test", "x");
    write(outer, "repo/sub/kept.txt", "x");

    let lister = lister(&outer.join("repo/sub"));
    let page = first_page(&lister, "", &options(100));

    assert!(!entry(&page.entries, "file.ignored-by-test").ignored);
    assert!(!entry(&page.entries, "kept.txt").ignored);
}

#[test]
fn a_parent_folder_ignored_by_the_repo_ignores_its_contents() {
    let home = TempDir::new().unwrap();
    let repo = home.path();
    folder(repo, ".git");
    write(repo, ".gitignore", "sub/\n");
    write(repo, "sub/deep/inner.txt", "x");

    let page = first_page(&lister(&repo.join("sub/deep")), "", &options(100));

    assert!(entry(&page.entries, "inner.txt").ignored);
}

#[test]
fn the_repository_info_exclude_applies_under_a_subfolder_root() {
    let home = TempDir::new().unwrap();
    let repo = home.path();
    folder(repo, ".git/info");
    write(repo, ".git/info/exclude", "*.ignored-by-test\n");
    write(repo, "sub/file.ignored-by-test", "x");
    write(repo, "sub/kept.txt", "x");

    let page = first_page(&lister(&repo.join("sub")), "", &options(100));

    assert!(entry(&page.entries, "file.ignored-by-test").ignored);
    assert!(!entry(&page.entries, "kept.txt").ignored);
}

#[test]
fn a_linked_worktree_reads_the_main_repositorys_exclude_file() {
    let home = TempDir::new().unwrap();
    let main = home.path().join("main");
    folder(&main, "");
    git(&main, &["init", "-q"]);
    git(
        &main,
        &[
            "-c",
            "user.email=ace@example.com",
            "-c",
            "user.name=ace",
            "commit",
            "-q",
            "--allow-empty",
            "-m",
            "init",
        ],
    );
    write(&main, ".git/info/exclude", "*.ignored-by-test\n");
    let worktree = home.path().join("wt");
    git(
        &main,
        &["worktree", "add", "-q", &worktree.display().to_string()],
    );
    write(&worktree, "sub/file.ignored-by-test", "x");
    write(&worktree, "sub/kept.txt", "x");

    let page = first_page(&lister(&worktree.join("sub")), "", &options(100));

    assert!(entry(&page.entries, "file.ignored-by-test").ignored);
    assert!(!entry(&page.entries, "kept.txt").ignored);
}

/// Runs git for real; a machine without git fails the test rather than skipping it.
fn git(dir: &std::path::Path, args: &[&str]) {
    let output = std::process::Command::new("git")
        .args(args)
        .current_dir(dir)
        .output()
        .unwrap_or_else(|error| panic!("git {args:?} could not run: {error}"));
    assert!(
        output.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn creating_a_gitignore_refreshes_the_flags_without_invalidate() {
    let home = TempDir::new().unwrap();
    let root = home.path();
    write(root, &format!("sub/{IGNORED}"), "x");

    let lister = lister(root);
    let before = first_page(&lister, "sub", &options(100));
    assert!(!entry(&before.entries, &format!("sub/{IGNORED}")).ignored);

    write(root, "sub/.gitignore", "*.ignored-by-test\n");

    let after = first_page(&lister, "sub", &options(100));
    assert!(entry(&after.entries, &format!("sub/{IGNORED}")).ignored);
}

#[test]
fn rewriting_a_gitignore_in_place_refreshes_the_flags() {
    let home = TempDir::new().unwrap();
    let root = home.path();
    write(root, "sub/.gitignore", "*.ignored-a-test\n");
    write(root, "sub/file.ignored-a-test", "x");
    write(root, "sub/file.ignored-b-test", "x");

    let path = root.join("sub/.gitignore");
    let older = std::time::SystemTime::now() - std::time::Duration::from_secs(20);
    std::fs::File::options()
        .write(true)
        .open(&path)
        .unwrap()
        .set_modified(older)
        .unwrap();

    let lister = lister(root);
    let before = first_page(&lister, "sub", &options(100));
    assert!(entry(&before.entries, "sub/file.ignored-a-test").ignored);
    assert!(!entry(&before.entries, "sub/file.ignored-b-test").ignored);

    write(root, "sub/.gitignore", "*.ignored-b-test\n");

    let after = first_page(&lister, "sub", &options(100));
    assert!(!entry(&after.entries, "sub/file.ignored-a-test").ignored);
    assert!(entry(&after.entries, "sub/file.ignored-b-test").ignored);
}

#[test]
fn a_nested_repository_ignores_by_its_own_rules() {
    let home = TempDir::new().unwrap();
    let repo = home.path();
    folder(repo, ".git");
    folder(repo, "sub/.git/info");
    write(repo, ".gitignore", "*.log\n");
    write(repo, "sub/.git/info/exclude", "*.ignored-by-test\n");
    write(repo, "sub/x.log", "x");
    write(repo, "sub/y.ignored-by-test", "x");
    write(repo, "sub/kept.txt", "x");
    write(repo, "top.log", "x");

    let page = first_page(&lister(&repo.join("sub")), "", &options(100));
    assert!(!entry(&page.entries, "x.log").ignored);
    assert!(entry(&page.entries, "y.ignored-by-test").ignored);
    assert!(!entry(&page.entries, "kept.txt").ignored);

    let outer = first_page(&lister(repo), "", &options(100));
    assert!(entry(&outer.entries, "top.log").ignored);
}

#[test]
fn a_core_excludes_file_value_ignores_a_trailing_comment() {
    let home = TempDir::new().unwrap();
    let root = home.path();
    folder(root, ".git");
    write(
        root,
        ".git/config",
        "[core]\n\texcludesFile = extra-ignore ; this is a note\n",
    );
    write(root, "extra-ignore", "*.ignored-by-test\n");
    write(root, IGNORED, "x");

    let page = first_page(&lister(root), "", &options(100));

    assert!(entry(&page.entries, IGNORED).ignored);
}

#[test]
fn a_quoted_core_excludes_file_keeps_its_spaces() {
    let home = TempDir::new().unwrap();
    let root = home.path();
    folder(root, "ignore files");
    write(
        root,
        ".git/config",
        "[core]\n\texcludesFile = \"ignore files/extra\" # quoted\n",
    );
    write(root, "ignore files/extra", "*.ignored-by-test\n");
    write(root, IGNORED, "x");

    let page = first_page(&lister(root), "", &options(100));

    assert!(entry(&page.entries, IGNORED).ignored);
}

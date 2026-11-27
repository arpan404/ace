use super::*;
use crate::core::credentials::test_support::Fixture;
use crate::reads::test_support::ProcessCommands;

/// The shell's change listing limit; the tests only need it larger than their fixtures.
const LIMIT: usize = 500;

fn write(repo: &Path, name: &str, contents: &[u8]) {
    let path = repo.join(name);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).expect("parent");
    }
    std::fs::write(path, contents).expect("file");
}

#[tokio::test]
async fn changed_files_lists_status_paths_sorted_with_counts_from_numstat() {
    let fixture = Fixture::new("g3a-changed");
    let repo = fixture.repository("repo");
    write(&repo, "src/added.ts", b"one\ntwo\nthree\n");
    write(&repo, "untracked.txt", b"a\nb\n");
    write(&repo, "binary.bin", &[0, 1, 2]);
    fixture.git(&repo, &["add", "src/added.ts", "binary.bin"]);
    std::fs::write(repo.join("file.txt"), "changed\n").expect("edit");
    let port = ProcessCommands { fixture: &fixture };
    let changed = changed_files(&port, &repo.to_string_lossy(), LIMIT)
        .await
        .expect("changed");
    let listed: Vec<(&str, &str, u64, u64, bool)> = changed
        .files
        .iter()
        .map(|file| {
            (
                file.path.as_str(),
                file.status.as_str(),
                file.additions,
                file.deletions,
                file.binary,
            )
        })
        .collect();
    assert_eq!(
        listed,
        vec![
            ("binary.bin", "added", 0, 0, true),
            ("file.txt", "modified", 1, 1, false),
            ("src/added.ts", "added", 3, 0, false),
            ("untracked.txt", "untracked", 2, 0, false),
        ]
    );
    assert!(!changed.truncated);
}

#[tokio::test]
async fn a_limit_caps_the_list_and_says_it_did() {
    let fixture = Fixture::new("g3a-limit");
    let repo = fixture.repository("repo");
    for name in ["a.txt", "b.txt", "c.txt"] {
        write(&repo, name, b"x\n");
    }
    let port = ProcessCommands { fixture: &fixture };
    let changed = changed_files(&port, &repo.to_string_lossy(), 2)
        .await
        .expect("changed");
    assert_eq!(changed.files.len(), 2);
    assert_eq!(changed.files[0].path, "a.txt");
    assert!(changed.truncated);
}

#[tokio::test]
async fn sections_report_each_kind_and_a_dirty_nested_repository_counts_as_untracked() {
    let fixture = Fixture::new("g3a-sections");
    let repo = fixture.repository("repo");
    fixture.git(&repo, &["config", "user.email", "t@example.invalid"]);
    fixture.git(&repo, &["config", "user.name", "T"]);
    write(&repo, "staged.txt", b"s\n");
    fixture.git(&repo, &["add", "staged.txt"]);
    std::fs::write(repo.join("file.txt"), "modified\n").expect("edit");
    write(&repo, "untracked.txt", b"u\n");
    let port = ProcessCommands { fixture: &fixture };
    let state = source_control_state(&port, &repo.to_string_lossy(), LIMIT)
        .await
        .expect("state");
    assert_eq!(state.branch.as_deref(), Some("main"));
    assert_eq!(
        state.staged,
        vec![SectionEntry {
            path: "staged.txt".to_owned(),
            from: None,
            status: "added".to_owned(),
        }]
    );
    assert_eq!(
        state.unstaged,
        vec![SectionEntry {
            path: "file.txt".to_owned(),
            from: None,
            status: "modified".to_owned(),
        }]
    );
    assert_eq!(state.untracked.len(), 1);
}

#[tokio::test]
async fn a_summary_counts_paths_and_lines_and_an_empty_repository_counts_nothing_tracked() {
    let fixture = Fixture::new("g3a-summary");
    let repo = fixture.repository("repo");
    std::fs::write(repo.join("file.txt"), "a\nb\n").expect("edit");
    write(&repo, "untracked.txt", b"u\n");
    let port = ProcessCommands { fixture: &fixture };
    let summary = change_summary(&port, &repo.to_string_lossy())
        .await
        .expect("summary");
    assert_eq!(
        summary,
        ChangeSummary {
            files: 2,
            additions: 2,
            deletions: 1,
        }
    );
    let checkout = checkout_summary(&port, &repo.to_string_lossy())
        .await
        .expect("checkout");
    assert_eq!(checkout.info.branch.branch.as_deref(), Some("main"));
    assert_eq!(checkout.diff.files, 2);
}

#[tokio::test]
async fn source_control_status_reports_the_commit_after_the_file_list() {
    let fixture = Fixture::new("g3a-status");
    let repo = fixture.repository("repo");
    write(&repo, "untracked.txt", b"x\n");
    let port = ProcessCommands { fixture: &fixture };
    let status = source_control_status(&port, &repo.to_string_lossy(), LIMIT)
        .await
        .expect("status");
    let head = String::from_utf8_lossy(&fixture.git(&repo, &["rev-parse", "HEAD"]))
        .trim_end()
        .to_owned();
    assert_eq!(status.head.as_deref(), Some(head.as_str()));
    assert_eq!(status.files.len(), 1);
    assert_eq!(status.untracked.len(), 1);
}

// `changed-files-regressions.process`: counts, binary markers and renames for paths with tabs.
#[tokio::test]
async fn a_tab_in_a_path_survives_numstat_framing_and_a_rename_reports_both_paths() {
    let fixture = Fixture::new("g3a-tabs");
    let repo = fixture.repository("repo");
    let tabbed = "tab\tname.txt";
    std::fs::write(repo.join(tabbed), "one\ntwo\n").expect("tabbed");
    fixture.git(&repo, &["add", "--", tabbed]);
    fixture.git(&repo, &["commit", "--quiet", "-m", "tabbed"]);
    let renamed = "other\ttab.txt";
    fixture.git(&repo, &["mv", "--", tabbed, renamed]);
    std::fs::write(repo.join(renamed), "one\ntwo\nthree\n").expect("edit");
    let binary = "image\tbytes.bin";
    std::fs::write(repo.join(binary), [0u8, 1, 2]).expect("binary");
    fixture.git(&repo, &["add", "--", binary]);
    let port = ProcessCommands { fixture: &fixture };
    let changed = changed_files(&port, &repo.to_string_lossy(), 500)
        .await
        .expect("changed");
    let listed: Vec<ChangedFile> = changed.files.clone();
    assert_eq!(
        listed,
        vec![
            ChangedFile {
                path: binary.to_owned(),
                from: None,
                status: "added".to_owned(),
                additions: 0,
                deletions: 0,
                binary: true,
            },
            ChangedFile {
                path: renamed.to_owned(),
                from: Some(tabbed.to_owned()),
                status: "renamed".to_owned(),
                additions: 1,
                deletions: 0,
                binary: false,
            },
        ]
    );
}

use super::*;
use crate::core::credentials::test_support::Fixture;
use crate::core::error::GitErrorCode;

#[test]
fn hook_command_paths_resolve_every_slash_word_against_the_working_tree() {
    assert_eq!(
        hook_command_paths("sh hooks/check.sh /elsewhere/x.sh name", "/repo"),
        vec![
            "/repo/hooks/check.sh".to_owned(),
            "/elsewhere/x.sh".to_owned(),
        ]
    );
    // One leading and one trailing quote come off, as the TypeScript's replace does.
    assert_eq!(
        hook_command_paths("'hooks/a.sh' \"hooks/b.sh\"", "/repo"),
        vec!["/repo/hooks/a.sh".to_owned(), "/repo/hooks/b.sh".to_owned()]
    );
    assert!(hook_command_paths("check.sh", "/repo").is_empty());
    // ECMAScript `\s` is not ASCII: NBSP and a BOM split (Rust's `split_whitespace` also
    // splits NBSP but not the BOM), and NEL stays inside the word (Rust's would split it).
    assert_eq!(
        hook_command_paths("a\u{a0}hooks/b.sh", "/repo"),
        vec!["/repo/hooks/b.sh".to_owned()]
    );
    assert_eq!(
        hook_command_paths("a\u{feff}hooks/b.sh", "/repo"),
        vec!["/repo/hooks/b.sh".to_owned()]
    );
    assert_eq!(
        hook_command_paths("a\u{85}hooks/b.sh", "/repo"),
        vec!["/repo/a\u{85}hooks/b.sh".to_owned()]
    );
}

#[tokio::test]
async fn a_relative_hooks_path_inside_the_checkout_is_the_authors_program() {
    let fixture = Fixture::new("reviewer-hooks");
    let repo = fixture.repository("repo");
    fixture.git(&repo, &["config", "core.hooksPath", ".husky"]);
    std::fs::create_dir_all(repo.join(".husky")).expect("hooks dir");
    let query = crate::core::credentials::test_support::ProcessQuery {
        fixture: &fixture,
        cwd: &repo,
        env: &[],
    };
    let inside = hooks_inside_checkout(&query, &repo.to_string_lossy())
        .await
        .expect("hooks");
    assert!(inside);
}

#[tokio::test]
async fn the_repositorys_own_git_directory_is_not_the_checkouts_content() {
    let fixture = Fixture::new("reviewer-own-hooks");
    let repo = fixture.repository("repo");
    let query = crate::core::credentials::test_support::ProcessQuery {
        fixture: &fixture,
        cwd: &repo,
        env: &[],
    };
    // The default hooks directory sits inside the working tree in a main checkout, but it
    // is the repository's own state, not a file a PR could change.
    let inside = hooks_inside_checkout(&query, &repo.to_string_lossy())
        .await
        .expect("hooks");
    assert!(!inside);
}

#[tokio::test]
async fn a_configured_hook_command_inside_the_working_tree_is_the_authors_program() {
    let fixture = Fixture::new("reviewer-commands");
    let repo = fixture.repository("repo");
    std::fs::create_dir_all(repo.join("hooks")).expect("hooks dir");
    std::fs::write(repo.join("hooks/check.sh"), "#!/bin/sh\nexit 0\n").expect("hook");
    let query = crate::core::credentials::test_support::ProcessQuery {
        fixture: &fixture,
        cwd: &repo,
        env: &[],
    };
    fixture.git(&repo, &["config", "hook.ace.command", "sh hooks/check.sh"]);
    assert!(
        hooks_inside_checkout(&query, &repo.to_string_lossy())
            .await
            .expect("hooks")
    );
    // A bare program name is looked up on PATH and names no file of the checkout.
    fixture.git(&repo, &["config", "hook.ace.command", "check.sh"]);
    assert!(
        !hooks_inside_checkout(&query, &repo.to_string_lossy())
            .await
            .expect("hooks")
    );
    // Nor does a file outside the checkout.
    let outside = fixture.root.join("outside.sh");
    std::fs::write(&outside, "#!/bin/sh\n").expect("outside");
    fixture.git(
        &repo,
        &[
            "config",
            "hook.ace.command",
            &format!("sh {}", outside.display()),
        ],
    );
    assert!(
        !hooks_inside_checkout(&query, &repo.to_string_lossy())
            .await
            .expect("hooks")
    );
}

#[tokio::test]
async fn a_hook_file_inside_the_tree_counts_even_when_it_links_out_of_it() {
    let fixture = Fixture::new("reviewer-links");
    let repo = fixture.repository("repo");
    let outside = fixture.root.join("outside.sh");
    std::fs::write(&outside, "#!/bin/sh\n").expect("outside");
    std::os::unix::fs::symlink(&outside, repo.join("link.sh")).expect("symlink");
    fixture.git(&repo, &["config", "hook.ace.command", "sh link.sh"]);
    // `link.sh` holds no `/`, so it names no path at all.
    let query = crate::core::credentials::test_support::ProcessQuery {
        fixture: &fixture,
        cwd: &repo,
        env: &[],
    };
    assert!(
        !hooks_inside_checkout(&query, &repo.to_string_lossy())
            .await
            .expect("hooks")
    );
    // Named through a directory the entry is inside the tree; the link's target is the
    // author's own file either way.
    fixture.git(&repo, &["config", "hook.ace.command", "sh ./link.sh"]);
    assert!(
        hooks_inside_checkout(&query, &repo.to_string_lossy())
            .await
            .expect("hooks")
    );
}

#[tokio::test]
async fn an_unresolvable_query_is_the_error_the_caller_sees() {
    // The port's own error is propagated, never turned into "outside the checkout".
    struct Failing;
    impl GitQuery for Failing {
        fn query(
            &self,
            _args: &[String],
        ) -> crate::core::spawn::BoxFuture<'_, Result<ConfigOutput, GitError>> {
            Box::pin(async { Err(GitError::new(GitErrorCode::GitFailed, "query failed")) })
        }
    }
    let result = hooks_inside_checkout(&Failing, "/repo").await;
    assert_eq!(
        result.err().map(|error| error.code),
        Some(GitErrorCode::GitFailed)
    );
}

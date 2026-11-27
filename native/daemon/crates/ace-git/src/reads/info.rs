//! Checkout discovery, `Repository.info` and its remotes (`packages/git/src/repository.ts`,
//! G3a).
//!
//! Proof: `repository.process` and `checkout-paths.process` (root and info), and
//! `failure-categories.process` for `not_a_repo`.

use crate::core::error::{GitError, GitErrorCode};
use crate::core::paths;
use crate::parse::repository::{
    BranchState, Remote, RepositoryInfo, Worktree, native_worktree_paths, parse_remotes,
    parse_worktrees,
};
use crate::reads::status::state;
use crate::reads::{Command, CommandPort, checked, text_output};
use crate::refs::{self, Cancel, Outcome};
use crate::worktrees_gix;

/// `Repository.root`: the registered checkout that contains `repo`.
pub async fn repository_root(
    port: &dyn CommandPort,
    repo: &str,
    is_windows: bool,
) -> Result<String, GitError> {
    let cwd = paths::canonical(repo)
        .map_err(|_| not_a_repo(&format!("Repository path does not exist: {repo}")))?;
    let inside = checked(
        port,
        Command::new(&cwd, &["rev-parse", "--is-inside-work-tree"]).allowing_failure(),
    )
    .await?;
    if inside.exit_code != 0 || text_output(&inside.stdout).as_deref() != Ok("true") {
        return Err(not_a_repo(&format!("Not a Git working tree: {repo}")));
    }
    let roots: Vec<String> = worktrees(port, &cwd, is_windows)
        .await?
        .into_iter()
        .filter(|tree| !tree.bare)
        .map(|tree| {
            paths::canonical(&tree.path).unwrap_or_else(|_| paths::resolve(&cwd, &tree.path))
        })
        .collect();
    let mut containing: Vec<&String> = roots
        .iter()
        .filter(|root| paths::within(root, &cwd))
        .collect();
    containing.sort_by_key(|root| std::cmp::Reverse(root.len()));
    containing
        .first()
        .map(|root| (*root).clone())
        .ok_or_else(|| not_a_repo(&format!("No registered worktree contains: {repo}")))
}

fn not_a_repo(message: &str) -> GitError {
    GitError::new(GitErrorCode::NotARepo, message)
}

/// `Repository.worktrees`: the porcelain listing, through the gix read where it applies.
pub async fn worktrees(
    port: &dyn CommandPort,
    repo: &str,
    is_windows: bool,
) -> Result<Vec<Worktree>, GitError> {
    let bytes = match worktrees_gix::worktrees(repo, &Cancel::never()) {
        Outcome::Data(bytes) => bytes,
        Outcome::Fallback(_) => {
            checked(
                port,
                Command::new(repo, &["worktree", "list", "--porcelain", "-z"]),
            )
            .await?
            .stdout
        }
    };
    let mut trees = parse_worktrees(&bytes)?;
    native_worktree_paths(&mut trees, is_windows);
    Ok(trees)
}

/// `Repository.remotes`: one config query, then the strict parse.
pub async fn remotes(port: &dyn CommandPort, root: &str) -> Result<Vec<Remote>, GitError> {
    let output = checked(
        port,
        Command::new(
            root,
            &[
                "config",
                "-z",
                "--get-regexp",
                r"^remote\..*\.(url|pushurl)$",
            ],
        )
        .allowing_failure(),
    )
    .await?;
    if output.exit_code != 0 && output.exit_code != 1 {
        return Err(GitError::new(GitErrorCode::GitFailed, output.stderr));
    }
    parse_remotes(&output.stdout)
}

/// `Repository.info`: branch facts from the status read and the remotes.
pub async fn info(port: &dyn CommandPort, root: &str) -> Result<RepositoryInfo, GitError> {
    let branch = branch_of(port, root).await?;
    Ok(info_with(root, branch, remotes(port, root).await?))
}

/// The branch headers alone, when the caller already has another use for the status read.
pub async fn branch_of(port: &dyn CommandPort, root: &str) -> Result<BranchState, GitError> {
    Ok(state(port, root, &[]).await?.branch)
}

/// `RepositoryInfo` from facts already read (`checkoutSummary` builds one this way).
pub fn info_with(root: &str, branch: BranchState, remotes: Vec<Remote>) -> RepositoryInfo {
    RepositoryInfo {
        root: root.to_owned(),
        branch,
        remotes,
    }
}

/// Resolves `HEAD` to a commit, or `None` on a branch that has no commit yet
/// (`Repository.head`, whose gix read falls back to the exact CLI steps).
pub async fn head(port: &dyn CommandPort, root: &str) -> Result<Option<String>, GitError> {
    match refs::resolve_commit(root, "HEAD", &Cancel::never()) {
        Outcome::Data(resolution) => match resolution.kind() {
            "commit" => Ok(resolution.id().map(str::to_owned)),
            "unborn" => Ok(None),
            _ => Err(GitError::new(
                GitErrorCode::InvalidRef,
                "Commit not found: HEAD",
            )),
        },
        Outcome::Fallback(_) => head_on_cli(port, root).await,
    }
}

async fn head_on_cli(port: &dyn CommandPort, root: &str) -> Result<Option<String>, GitError> {
    let resolved = checked(
        port,
        Command::new(
            root,
            &["rev-parse", "--verify", "--end-of-options", "HEAD^{commit}"],
        )
        .allowing_failure(),
    )
    .await?;
    if resolved.exit_code == 0 {
        return Ok(Some(crate::core::decode::hash(&text_output(
            &resolved.stdout,
        )?)?));
    }
    // HEAD naming a branch with no commit yet is an empty repository, not a bad ref.
    let symbolic = checked(
        port,
        Command::new(root, &["symbolic-ref", "--quiet", "HEAD"]).allowing_failure(),
    )
    .await?;
    if symbolic.exit_code == 0 {
        Ok(None)
    } else {
        Err(GitError::new(
            GitErrorCode::InvalidRef,
            "Commit not found: HEAD",
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::credentials::test_support::Fixture;
    use crate::reads::test_support::ProcessCommands;

    #[tokio::test]
    async fn a_checkout_is_its_own_root_and_a_subdirectory_belongs_to_it() {
        let fixture = Fixture::new("g3a-root");
        let repo = fixture.repository("repo with spaces\nand \u{96ea}");
        std::fs::create_dir_all(repo.join("src/deep")).expect("subdir");
        let port = ProcessCommands { fixture: &fixture };
        let root = repository_root(&port, &repo.to_string_lossy(), false)
            .await
            .expect("root");
        assert_eq!(
            root,
            paths::canonical(&repo.to_string_lossy()).expect("canonical")
        );
        let sub = repository_root(&port, &repo.join("src/deep").to_string_lossy(), false)
            .await
            .expect("sub root");
        assert_eq!(sub, root);
    }

    #[tokio::test]
    async fn a_folder_outside_a_work_tree_is_not_a_repo() {
        let fixture = Fixture::new("g3a-norepo");
        std::fs::create_dir_all(fixture.root.join("plain")).expect("plain");
        let port = ProcessCommands { fixture: &fixture };
        let error = repository_root(&port, &fixture.root.join("plain").to_string_lossy(), false)
            .await
            .expect_err("no repo");
        assert_eq!(error.code, GitErrorCode::NotARepo);
        let missing = repository_root(&port, &fixture.root.join("absent").to_string_lossy(), false)
            .await
            .expect_err("missing");
        assert_eq!(missing.code, GitErrorCode::NotARepo);
    }

    #[tokio::test]
    async fn info_reports_branch_upstream_counts_and_remotes_in_config_order() {
        let fixture = Fixture::new("g3a-info");
        let repo = fixture.repository("repo");
        let path = repo.to_string_lossy().into_owned();
        fixture.git(
            &repo,
            &["remote", "add", "origin", "https://example.invalid/a.git"],
        );
        fixture.git(
            &repo,
            &["remote", "add", "upstream", "ssh://example.invalid/b"],
        );
        let port = ProcessCommands { fixture: &fixture };
        let info = info(&port, &path).await.expect("info");
        assert_eq!(info.root, path);
        assert_eq!(info.branch.branch.as_deref(), Some("main"));
        assert_eq!(info.branch.ahead, 0);
        assert_eq!(info.branch.behind, 0);
        assert_eq!(
            info.remotes,
            vec![
                Remote {
                    name: "origin".to_owned(),
                    fetch_urls: vec!["https://example.invalid/a.git".to_owned()],
                    push_urls: vec!["https://example.invalid/a.git".to_owned()],
                },
                Remote {
                    name: "upstream".to_owned(),
                    fetch_urls: vec!["ssh://example.invalid/b".to_owned()],
                    push_urls: vec!["ssh://example.invalid/b".to_owned()],
                },
            ]
        );
    }

    #[tokio::test]
    async fn head_is_a_commit_on_a_born_branch_and_none_before_the_first_commit() {
        let fixture = Fixture::new("g3a-head");
        std::fs::create_dir_all(fixture.root.join("empty")).expect("dir");
        let empty = fixture.root.join("empty");
        fixture.git(&empty, &["init", "--quiet"]);
        let port = ProcessCommands { fixture: &fixture };
        let unborn = head(&port, &empty.to_string_lossy())
            .await
            .expect("unborn head");
        assert_eq!(unborn, None);
        let repo = fixture.repository("repo");
        let commit = String::from_utf8_lossy(&fixture.git(&repo, &["rev-parse", "HEAD"]))
            .trim_end()
            .to_owned();
        assert_eq!(
            head(&port, &repo.to_string_lossy()).await.expect("head"),
            Some(commit)
        );
    }
}

#[cfg(test)]
mod divergence_tests {
    use super::*;
    use crate::core::credentials::test_support::Fixture;
    use crate::reads::test_support::ProcessCommands;

    // `repository.process`: info reports root, branch, HEAD, remotes and upstream divergence.
    #[tokio::test]
    async fn info_reports_the_upstream_and_its_divergence_in_both_directions() {
        let fixture = Fixture::new("g3a-divergence");
        let repo = fixture.repository("repo");
        let remote = fixture.root.join("remote.git");
        std::fs::create_dir_all(&remote).expect("remote dir");
        fixture.git(&remote, &["init", "--bare", "--quiet"]);
        fixture.git(
            &repo,
            &["remote", "add", "origin", &remote.to_string_lossy()],
        );
        fixture.git(&repo, &["push", "--quiet", "-u", "origin", "main"]);
        std::fs::write(repo.join("local.txt"), "local\n").expect("local");
        fixture.git(&repo, &["add", "local.txt"]);
        fixture.git(&repo, &["commit", "--quiet", "-m", "local"]);
        let other = fixture.root.join("other");
        fixture.git(
            &fixture.root,
            &[
                "clone",
                "--quiet",
                &remote.to_string_lossy(),
                &other.to_string_lossy(),
            ],
        );
        fixture.git(&other, &["config", "user.email", "t@example.invalid"]);
        fixture.git(&other, &["config", "user.name", "T"]);
        std::fs::write(other.join("remote.txt"), "remote\n").expect("remote");
        fixture.git(&other, &["add", "remote.txt"]);
        fixture.git(&other, &["commit", "--quiet", "-m", "remote"]);
        fixture.git(&other, &["push", "--quiet", "origin", "main"]);
        fixture.git(&repo, &["fetch", "--quiet", "origin"]);
        let port = ProcessCommands { fixture: &fixture };
        let info = info(&port, &repo.to_string_lossy()).await.expect("info");
        assert_eq!(info.branch.branch.as_deref(), Some("main"));
        assert_eq!(info.branch.upstream.as_deref(), Some("origin/main"));
        assert_eq!(info.branch.ahead, 1);
        assert_eq!(info.branch.behind, 1);
        assert!(info.branch.head.is_some());
        assert_eq!(info.remotes.len(), 1);
    }
}

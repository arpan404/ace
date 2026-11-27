// SPDX-License-Identifier: Apache-2.0
//! Transfer reads (`transfer-branch-name.ts`, `transfer-ignored.ts`, `transfer-source.ts`,
//! `transfer-refs.ts` reads, G3d): the names a branch may land under, the ignored paths, the
//! folder's Git-ness, and the refs a bundle carries.
//!
//! Proof: every case of `transfer-names.test.ts` moved here, and `transfer-bundle.process`'s
//! read cases against real Git in temp repositories.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;

use serde::Serialize;

use crate::core::decode::{hash, nul};
use crate::core::error::{GitError, GitErrorCode};
use crate::core::paths;
use crate::reads::remote::normalize_remote_url;
use crate::reads::{Command, CommandPort, checked, text_output};

/// The most suffixes tried per spelling of a branch before landing gives up.
pub const MAX_SUFFIXES: usize = 100;

/// A machine name as a branch-name fragment: `Arpan's MacBook Pro` → `arpans-macbook-pro`.
pub fn machine_slug(machine: &str) -> String {
    use unicode_normalization::UnicodeNormalization;
    // The TypeScript normalises NFKD first, so `École` (E + combining acute) becomes `e-cole`.
    let folded: String = machine
        .nfkd()
        .map(|character| match character {
            '\u{2019}' => '\'',
            other => other,
        })
        .collect();
    let mut slug = String::new();
    for character in folded.to_lowercase().chars() {
        if character == '\'' {
            continue;
        }
        if character.is_ascii_alphanumeric() {
            slug.push(character);
        } else if !slug.ends_with('-') {
            slug.push('-');
        }
    }
    let slug = slug.trim_matches('-').to_owned();
    let mut clipped: String = slug.chars().take(40).collect();
    while clipped.ends_with('-') {
        clipped.pop();
    }
    if clipped.is_empty() {
        "machine".to_owned()
    } else {
        clipped
    }
}

/// The names a transferred branch may land under, in the order they are tried.
pub fn landing_candidates(branch: &str, machine: &str) -> Vec<String> {
    let slug = machine_slug(machine);
    let mut names = vec![branch.to_owned()];
    let mut spellings = vec![branch.to_owned()];
    if branch.contains('/') {
        spellings.push(branch.replace('/', "-"));
    }
    for spelling in spellings {
        for n in 1..=MAX_SUFFIXES {
            names.push(if n == 1 {
                format!("{spelling}-from-{slug}")
            } else {
                format!("{spelling}-from-{slug}-{n}")
            });
        }
    }
    names
}

/// Where a transferred branch lands.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LandingBranch {
    pub branch: String,
    pub existing: bool,
}

fn nests(name: &str, heads: &HashMap<String, String>) -> bool {
    heads
        .keys()
        .any(|head| head.starts_with(&format!("{name}/")) || name.starts_with(&format!("{head}/")))
}

/// The first candidate that is free, or already exactly at `commit` and not occupied.
pub fn landing_branch_name(
    branch: &str,
    commit: &str,
    machine: &str,
    heads: &HashMap<String, String>,
    occupied: &HashSet<String>,
) -> Result<LandingBranch, GitError> {
    for name in landing_candidates(branch, machine) {
        match heads.get(&name) {
            Some(current) if current == commit && !occupied.contains(&name) => {
                return Ok(LandingBranch {
                    branch: name,
                    existing: true,
                });
            }
            None if !nests(&name, heads) => {
                return Ok(LandingBranch {
                    branch: name,
                    existing: false,
                });
            }
            _ => {}
        }
    }
    Err(GitError::new(
        GitErrorCode::RefConflict,
        format!(
            "No free branch name for {}: the names it would land under are all taken",
            clamp(branch, 200)
        ),
    ))
}

fn clamp(text: &str, chars: usize) -> String {
    text.chars().take(chars).collect()
}

/// The paths Git ignores in a checkout, as `ls-files --others --ignored` lists them.
pub async fn ignored_paths(
    port: &dyn CommandPort,
    root: &str,
    under: Option<&str>,
) -> Result<Vec<String>, GitError> {
    let mut args: Vec<String> = [
        "ls-files",
        "-z",
        "--others",
        "--ignored",
        "--exclude-standard",
        "--directory",
    ]
    .iter()
    .map(|arg| (*arg).to_owned())
    .collect();
    if let Some(under) = under {
        args.push("--".to_owned());
        args.push(format!(":(literal){under}"));
    }
    let result = checked(
        port,
        Command::owned(root, args).with_capture_bytes(16 * 1024 * 1024),
    )
    .await?;
    if result.truncated {
        return Err(GitError::new(
            GitErrorCode::GitFailed,
            "Too many ignored paths to list",
        ));
    }
    nul(&result.stdout)
}

/// What a folder about to be sent is, as far as Git is concerned.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SourceCheckout {
    Checkout { root: String },
    Folder,
    Untrusted,
}

/// True when `path` or a folder above it holds a `.git` entry (a folder or a worktree's file).
pub fn git_above(path: &str) -> bool {
    let mut current = PathBuf::from(path);
    loop {
        if std::fs::symlink_metadata(current.join(".git")).is_ok() {
            return true;
        }
        let Some(parent) = current.parent() else {
            return false;
        };
        if parent == current {
            return false;
        }
        current = parent.to_path_buf();
    }
}

/// Tells a work tree from a plain folder without treating every Git failure as "not a repository".
pub async fn source_checkout(
    port: &dyn CommandPort,
    path: &str,
) -> Result<SourceCheckout, GitError> {
    let cwd = paths::canonical(path)
        .map_err(|_| GitError::new(GitErrorCode::NotARepo, format!("Not a path: {path}")))?;
    let inside = port
        .run(Command::new(&cwd, &["rev-parse", "--is-inside-work-tree"]).allowing_failure())
        .await;
    let inside = match inside {
        Ok(inside) => inside,
        Err(error) => {
            if error.code == GitErrorCode::GitMissing && !git_above(&cwd) {
                return Ok(SourceCheckout::Folder);
            }
            return Err(error);
        }
    };
    if inside.exit_code == 0 {
        return if text_output(&inside.stdout).as_deref() == Ok("true") {
            Ok(SourceCheckout::Checkout {
                root: crate::reads::info::repository_root(port, &cwd, cfg!(windows)).await?,
            })
        } else {
            Ok(SourceCheckout::Folder)
        };
    }
    if inside.stderr.to_lowercase().contains("dubious ownership") {
        return Ok(SourceCheckout::Untrusted);
    }
    if inside
        .stderr
        .to_lowercase()
        .contains("not a git repository")
        && !git_above(&cwd)
    {
        return Ok(SourceCheckout::Folder);
    }
    Err(
        GitError::new(GitErrorCode::GitFailed, "Git couldn't read the repository").with_detail(
            "stderr",
            ace_json::Value::from(clamp_tail(&inside.stderr, 2048)),
        ),
    )
}

fn clamp_tail(text: &str, bytes: usize) -> String {
    if text.len() <= bytes {
        return text.to_owned();
    }
    let mut start = text.len() - bytes;
    while !text.is_char_boundary(start) {
        start += 1;
    }
    text[start..].to_owned()
}

/// Full ref names under `prefixes` with the commit each points at.
pub async fn refs_under(
    port: &dyn CommandPort,
    root: &str,
    prefixes: &[&str],
) -> Result<Vec<(String, String)>, GitError> {
    let mut args: Vec<String> = vec![
        "for-each-ref".to_owned(),
        "--format=%(refname)%00%(objectname)%00%(symref)".to_owned(),
    ];
    args.extend(prefixes.iter().map(|prefix| (*prefix).to_owned()));
    let output = checked(port, Command::owned(root, args)).await?;
    let text = String::from_utf8_lossy(&output.stdout);
    let mut refs = Vec::new();
    for line in text.split('\n') {
        let fields: Vec<&str> = line.split('\0').collect();
        let [name, sha, symref] = match fields.as_slice() {
            [name, sha, symref] => [*name, *sha, *symref],
            _ => continue,
        };
        if name.is_empty() || sha.is_empty() || !symref.is_empty() {
            continue;
        }
        refs.push((name.to_owned(), hash(sha)?));
    }
    Ok(refs)
}

/// The refs a bundle carries, and the branch and HEAD facts beside them.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BundleRefs {
    pub branches: Vec<String>,
    pub tags: Vec<String>,
    pub origin_tracking: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub head: Option<String>,
}

/// `bundleRefs`: local branches, tags and origin-tracking refs, the checked-out branch and HEAD.
pub async fn bundle_refs(port: &dyn CommandPort, root: &str) -> Result<BundleRefs, GitError> {
    let refs = refs_under(
        port,
        root,
        &["refs/heads", "refs/tags", "refs/remotes/origin"],
    )
    .await?;
    let current = checked(
        port,
        Command::new(root, &["symbolic-ref", "--quiet", "--short", "HEAD"]).allowing_failure(),
    )
    .await?;
    let head = crate::reads::info::head(port, root).await?;
    let branch = if current.exit_code == 0 && head.is_some() {
        Some(text_output(&current.stdout)?)
    } else {
        None
    };
    let names: Vec<String> = refs.into_iter().map(|(name, _)| name).collect();
    Ok(BundleRefs {
        branches: names
            .iter()
            .filter(|name| name.starts_with("refs/heads/"))
            .cloned()
            .collect(),
        tags: names
            .iter()
            .filter(|name| name.starts_with("refs/tags/"))
            .cloned()
            .collect(),
        origin_tracking: names
            .iter()
            .filter(|name| name.starts_with("refs/remotes/origin/"))
            .cloned()
            .collect(),
        branch,
        head,
    })
}

/// `origin`'s fetch URL and its key (`transferOrigin`); `None` without one.
pub async fn transfer_origin(
    port: &dyn CommandPort,
    root: &str,
) -> Result<Option<(String, String)>, GitError> {
    let result = checked(
        port,
        Command::new(root, &["remote", "get-url", "origin"]).allowing_failure(),
    )
    .await?;
    if result.exit_code == 2 {
        return Ok(None);
    }
    if result.exit_code != 0 {
        return Err(GitError::new(
            GitErrorCode::GitFailed,
            "Cannot read the origin remote",
        ));
    }
    let url = text_output(&result.stdout)?;
    if url.is_empty() {
        return Ok(None);
    }
    Ok(Some((url.clone(), normalize_remote_url(&url, root))))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::credentials::test_support::Fixture;
    use crate::reads::test_support::ProcessCommands;

    fn heads(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(name, sha)| ((*name).to_owned(), (*sha).to_owned()))
            .collect()
    }

    #[test]
    fn a_machine_name_becomes_a_bounded_branch_fragment() {
        assert_eq!(machine_slug("Arpan's MacBook Pro"), "arpans-macbook-pro");
        // NFKD first, as the TypeScript does: `École` folds to `e-cole`, not `cole`.
        assert_eq!(machine_slug("École"), "e-cole");
        assert_eq!(machine_slug("Ångström"), "a-ngstro-m");
        assert_eq!(machine_slug("① Box"), "1-box");
        // Writing systems without ASCII letters leave nothing but the fallback.
        assert_eq!(machine_slug("東京"), "machine");
        assert_eq!(machine_slug("🚀 Box"), "box");
        assert_eq!(machine_slug("  --  "), "machine");
        assert_eq!(machine_slug(""), "machine");
        assert_eq!(machine_slug(&"x".repeat(80)).len(), 40);
        // A cut may leave a trailing dash; the TypeScript strips it again.
        assert_eq!(
            machine_slug(&format!("{} x", "a".repeat(40))),
            "a".repeat(40)
        );
    }

    // Every case of `transfer-names.test.ts` moved here.
    #[test]
    fn a_free_branch_lands_under_its_own_name_and_taken_names_fall_back_to_the_machine() {
        let commit = "a".repeat(40);
        assert_eq!(
            landing_branch_name("feature", &commit, "Box", &heads(&[]), &HashSet::new())
                .expect("free"),
            LandingBranch {
                branch: "feature".to_owned(),
                existing: false,
            }
        );
        let taken = heads(&[("feature", "b".repeat(40).as_str())]);
        assert_eq!(
            landing_branch_name("feature", &commit, "Box", &taken, &HashSet::new())
                .expect("suffix")
                .branch,
            "feature-from-box"
        );
        // The same branch at the same commit is reused unless a worktree holds it.
        let same = heads(&[("feature", commit.as_str())]);
        assert_eq!(
            landing_branch_name("feature", &commit, "Box", &same, &HashSet::new())
                .expect("existing"),
            LandingBranch {
                branch: "feature".to_owned(),
                existing: true,
            }
        );
        let occupied = HashSet::from(["feature".to_owned()]);
        assert_eq!(
            landing_branch_name("feature", &commit, "Box", &same, &occupied)
                .expect("occupied")
                .branch,
            "feature-from-box"
        );
    }

    #[test]
    fn a_folder_branch_flattens_and_nesting_blocks_a_name_and_exhaustion_is_ref_conflict() {
        let commit = "a".repeat(40);
        let nested = heads(&[("feature/one", "b".repeat(40).as_str())]);
        assert_eq!(
            landing_branch_name("feature", &commit, "Box", &nested, &HashSet::new())
                .expect("flat")
                .branch,
            "feature-from-box"
        );
        let names = landing_candidates("a/b", "Box");
        assert_eq!(names[0], "a/b");
        assert_eq!(names[1], "a/b-from-box");
        assert_eq!(names[101], "a-b-from-box");
        let mut all = HashMap::new();
        for name in landing_candidates("x", "Box") {
            all.insert(name, "b".repeat(40));
        }
        assert_eq!(
            landing_branch_name("x", &commit, "Box", &all, &HashSet::new())
                .expect_err("taken")
                .code,
            GitErrorCode::RefConflict
        );
    }

    #[tokio::test]
    async fn ignored_paths_list_files_and_whole_folders_once() {
        let fixture = Fixture::new("g3d-ignored");
        let repo = fixture.repository("repo");
        std::fs::write(repo.join(".gitignore"), "node_modules/\nbuild\n").expect("ignore");
        std::fs::create_dir_all(repo.join("node_modules/deep")).expect("dirs");
        std::fs::write(repo.join("node_modules/deep/x.js"), "x").expect("x");
        std::fs::write(repo.join("build"), "b").expect("build");
        let port = ProcessCommands { fixture: &fixture };
        let paths = ignored_paths(&port, &repo.to_string_lossy(), None)
            .await
            .expect("ignored");
        assert!(paths.contains(&"node_modules/".to_owned()), "{paths:?}");
        assert!(paths.contains(&"build".to_owned()), "{paths:?}");
        let under = ignored_paths(&port, &repo.to_string_lossy(), Some("node_modules"))
            .await
            .expect("under");
        assert_eq!(under, vec!["node_modules/".to_owned()]);
    }

    #[tokio::test]
    async fn a_checkout_a_plain_folder_and_missing_git_are_told_apart() {
        let fixture = Fixture::new("g3d-source");
        let repo = fixture.repository("repo");
        std::fs::create_dir_all(fixture.root.join("plain")).expect("plain");
        let port = ProcessCommands { fixture: &fixture };
        assert_eq!(
            source_checkout(&port, &repo.to_string_lossy())
                .await
                .expect("checkout"),
            SourceCheckout::Checkout {
                root: paths::canonical(&repo.to_string_lossy()).expect("canonical")
            }
        );
        assert_eq!(
            source_checkout(&port, &fixture.root.join("plain").to_string_lossy())
                .await
                .expect("folder"),
            SourceCheckout::Folder
        );
        assert!(git_above(&repo.to_string_lossy()));
        assert!(!git_above(&fixture.root.join("plain").to_string_lossy()));
    }

    #[tokio::test]
    async fn a_bundle_lists_its_branches_tags_and_origin_tracking_refs() {
        let fixture = Fixture::new("g3d-bundle");
        let repo = fixture.repository("repo");
        fixture.git(&repo, &["tag", "v1"]);
        fixture.git(&repo, &["update-ref", "refs/remotes/origin/main", "HEAD"]);
        fixture.git(
            &repo,
            &["remote", "add", "origin", "https://example.invalid/a.git"],
        );
        let port = ProcessCommands { fixture: &fixture };
        let refs = bundle_refs(&port, &repo.to_string_lossy())
            .await
            .expect("refs");
        assert_eq!(refs.branches, vec!["refs/heads/main".to_owned()]);
        assert_eq!(refs.tags, vec!["refs/tags/v1".to_owned()]);
        assert_eq!(
            refs.origin_tracking,
            vec!["refs/remotes/origin/main".to_owned()]
        );
        assert_eq!(refs.branch.as_deref(), Some("main"));
        assert!(refs.head.is_some());
        let origin = transfer_origin(&port, &repo.to_string_lossy())
            .await
            .expect("origin")
            .expect("url");
        assert_eq!(origin.0, "https://example.invalid/a.git");
        assert_eq!(origin.1, "v2:example.invalid/a");
    }
}

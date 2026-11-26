// SPDX-License-Identifier: Apache-2.0
//! What a draft was written for (`writing-context.ts`, G4): the selection's changed paths, its
//! patch, the conventions files and a fingerprint over all of it, so a commit can refuse a draft
//! whose changes moved.
//!
//! Proof: `client-actions.process` (a draft commits only while its fingerprint matches) and
//! `source-control-ops.process`.

use std::path::Path;

use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::core::error::{GitError, GitErrorCode};
use crate::core::paths;
use crate::core::temp_index::TemporaryIndex;
use crate::parse::diff::parse_diff;
use crate::reads::remote::{assert_pr_base, publication_remote};
use crate::reads::{Command, CommandPort, checked, text_output};

/// The most paths one selection may name.
pub const MAX_SELECTION_PATHS: usize = 1000;
/// The most conventions one context carries.
pub const MAX_CONVENTIONS: usize = 32;
/// The bytes one conventions file contributes.
pub const CONVENTION_BYTES: usize = 16_384;
/// The patch cap a draft reads.
pub const PATCH_BYTES: usize = 65_536;
/// The recent-commit cap.
pub const RECENT_BYTES: usize = 8_192;

/// What the draft describes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SourceControlSelection {
    Commit {
        paths: Vec<String>,
    },
    Pr {
        branch: String,
        base: String,
        base_ref: Option<String>,
    },
}

/// One conventions file the draft carried.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Convention {
    pub path: String,
    pub text: String,
}

/// The draft's facts, in `SourceControlContext`'s order.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceControlContext {
    pub fingerprint: String,
    pub head: Option<String>,
    pub base: Option<String>,
    pub paths: Vec<String>,
    pub patch: String,
    pub truncated: bool,
    pub conventions: Vec<Convention>,
    pub recent_commits: String,
}

fn invalid(message: impl Into<String>) -> GitError {
    GitError::new(GitErrorCode::InvalidArgument, message)
}

fn head_moved(message: &str) -> GitError {
    GitError::new(GitErrorCode::HeadMoved, message)
}

fn validate_selection(selection: &SourceControlSelection) -> Result<(), GitError> {
    match selection {
        SourceControlSelection::Commit { paths } => {
            if paths.is_empty() || paths.len() > MAX_SELECTION_PATHS {
                return Err(invalid("Name between 1 and 1000 paths"));
            }
            for path in paths {
                if path.is_empty() || path.chars().count() > 4096 || path.contains('\0') {
                    return Err(invalid(format!("Invalid repository path: {path}")));
                }
            }
        }
        SourceControlSelection::Pr {
            branch,
            base,
            base_ref,
        } => {
            if branch.is_empty() || branch.encode_utf16().count() > 256 {
                return Err(invalid("Invalid branch"));
            }
            if base.is_empty() || base.encode_utf16().count() > 256 {
                return Err(invalid("Invalid base"));
            }
            if base_ref.as_ref().is_some_and(|base_ref| {
                base_ref.is_empty() || base_ref.encode_utf16().count() > 1200
            }) {
                return Err(invalid("Invalid base ref"));
            }
        }
    }
    Ok(())
}

/// Bounded repository text only. Symlinks and paths outside the checkout are never followed.
fn repository_text(root: &str, path: &str) -> Result<Option<(String, bool)>, GitError> {
    // The checkout's root is canonical in the service; a caller's alias is resolved here so the
    // containment checks compare like paths.
    let root = paths::canonical(root).unwrap_or_else(|_| root.to_owned());
    let root = root.as_str();
    let target = paths::resolve(root, path);
    if Path::new(path).is_absolute() || !paths::within(root, &target) {
        return Ok(None);
    }
    let Some(name) = Path::new(&target).file_name() else {
        return Ok(None);
    };
    let Some(parent) = Path::new(&target).parent() else {
        return Ok(None);
    };
    let Ok(parent) = paths::canonical(&parent.to_string_lossy()) else {
        return Ok(None);
    };
    if !paths::within(root, &parent) {
        return Ok(None);
    }
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let file = match options.open(Path::new(&parent).join(name)) {
        Ok(file) => file,
        Err(error)
            if matches!(
                error.kind(),
                std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
            ) =>
        {
            return Ok(None);
        }
        #[cfg(unix)]
        Err(error) if error.raw_os_error() == Some(libc::ELOOP) => return Ok(None),
        Err(error) => return Err(GitError::from_io(&error)),
    };
    let metadata = file.metadata().map_err(|error| GitError::from_io(&error))?;
    if !metadata.is_file() {
        return Ok(None);
    }
    use std::io::Read;
    let mut bytes = Vec::with_capacity(CONVENTION_BYTES + 1);
    let read = file
        .take(CONVENTION_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| GitError::from_io(&error))?;
    if bytes[..read].contains(&0) {
        return Ok(None);
    }
    let kept = &bytes[..read.min(CONVENTION_BYTES)];
    let text = String::from_utf8_lossy(kept).into_owned();
    Ok(Some((text, read > CONVENTION_BYTES)))
}

fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

/// `writingContext`: the selection's context and the fingerprint a draft is bound to.
pub async fn writing_context(
    port: &dyn CommandPort,
    root: &str,
    temp_directory: &str,
    selection: &SourceControlSelection,
) -> Result<SourceControlContext, GitError> {
    validate_selection(selection)?;
    let state = crate::reads::status::state(port, root, &[]).await?;
    if !state.status.conflicted.is_empty() {
        return Err(GitError::new(
            GitErrorCode::Conflicts,
            "Resolve conflicts before drafting",
        ));
    }
    let mut base: Option<String> = None;
    let mut remote = None;
    let (from, to);
    match selection {
        SourceControlSelection::Pr {
            branch,
            base: base_name,
            base_ref,
        } => {
            if state.branch.branch.as_deref() != Some(branch.as_str())
                || state.branch.head.is_none()
            {
                return Err(head_moved("Branch changed"));
            }
            let head = state.branch.head.clone().unwrap_or_default();
            let reference = base_ref.as_deref().unwrap_or(base_name);
            base = Some(crate::reads::diff::resolve_commit(port, root, reference).await?);
            let remotes = crate::reads::info::remotes(port, root).await?;
            remote = publication_remote(&remotes, |remote| remote.name.as_str()).cloned();
            let canonical = checked(
                port,
                Command::new(
                    root,
                    &[
                        "rev-parse",
                        "--symbolic-full-name",
                        "--verify",
                        "--end-of-options",
                        reference,
                    ],
                ),
            )
            .await?;
            let canonical = text_output(&canonical.stdout)?;
            assert_pr_base(
                &canonical,
                base_name,
                remote.as_ref().map(|r| r.name.as_str()),
            )?;
            let merge_base = checked(
                port,
                Command::new(
                    root,
                    &["merge-base", &base.clone().unwrap_or_default(), &head],
                ),
            )
            .await?;
            from = text_output(&merge_base.stdout)?;
            to = head;
        }
        SourceControlSelection::Commit { paths } => {
            let known: Vec<String> = state
                .status
                .staged
                .iter()
                .chain(state.status.unstaged.iter())
                .flat_map(|entry| match &entry.old_path {
                    Some(old) => vec![entry.path.clone(), old.clone()],
                    None => vec![entry.path.clone()],
                })
                .chain(state.status.untracked.iter().cloned())
                .collect();
            if paths
                .iter()
                .any(|path| !known.iter().any(|known| known == path))
            {
                return Err(head_moved("Selected changes moved"));
            }
            from = match &state.branch.head {
                Some(head) => head.clone(),
                None => {
                    let empty = checked(
                        port,
                        Command::new(root, &["hash-object", "-t", "tree", "--stdin"])
                            .with_input(b"")
                            .writing(),
                    )
                    .await?;
                    text_output(&empty.stdout)?
                }
            };
            let index = TemporaryIndex::create(temp_directory)?;
            let env: Vec<(&str, &str)> = index
                .env()
                .iter()
                .map(|(key, value)| (key.as_str(), value.as_str()))
                .collect();
            let mut read_tree: Vec<&str> = vec!["read-tree"];
            match &state.branch.head {
                Some(head) => read_tree.push(head),
                None => read_tree.push("--empty"),
            }
            checked(
                port,
                Command::new(root, &read_tree).with_env(&env).writing(),
            )
            .await?;
            let mut input = String::new();
            for path in paths {
                input.push_str(path);
                input.push('\0');
            }
            let mut literal_env = env.clone();
            literal_env.push(("GIT_LITERAL_PATHSPECS", "1"));
            checked(
                port,
                Command::new(
                    root,
                    &[
                        "add",
                        "--all",
                        "--pathspec-from-file=-",
                        "--pathspec-file-nul",
                    ],
                )
                .with_env(&literal_env)
                .with_input(input.as_bytes())
                .writing(),
            )
            .await?;
            let tree = checked(
                port,
                Command::new(root, &["write-tree"]).with_env(&env).writing(),
            )
            .await?;
            to = text_output(&tree.stdout)?;
        }
    }
    let metadata = checked(
        port,
        Command::owned(
            root,
            vec![
                "diff".to_owned(),
                "--no-ext-diff".to_owned(),
                "--no-textconv".to_owned(),
                "--no-color".to_owned(),
                "--find-renames".to_owned(),
                from.clone(),
                to.clone(),
                "--raw".to_owned(),
                "--no-abbrev".to_owned(),
                "--numstat".to_owned(),
                "-z".to_owned(),
                "--".to_owned(),
            ],
        ),
    )
    .await?;
    let files = parse_diff(&metadata.stdout)?;
    let mut paths: Vec<String> = Vec::new();
    for file in &files {
        for path in std::iter::once(&file.entry.path).chain(file.entry.old_path.iter()) {
            if !paths.contains(path) {
                paths.push(path.clone());
            }
        }
    }
    paths.sort_by(|left, right| left.encode_utf16().cmp(right.encode_utf16()));
    if paths.is_empty() {
        return Err(invalid("No changes to describe"));
    }
    if paths.len() > MAX_SELECTION_PATHS {
        return Err(GitError::new(
            GitErrorCode::OutputTooLarge,
            "Too many changes to describe",
        ));
    }
    let patch = checked(
        port,
        Command::owned(
            root,
            vec![
                "diff".to_owned(),
                "--no-ext-diff".to_owned(),
                "--no-textconv".to_owned(),
                "--no-color".to_owned(),
                "--find-renames".to_owned(),
                from.clone(),
                to.clone(),
                "--patch".to_owned(),
                "--unified=3".to_owned(),
                "--".to_owned(),
            ],
        )
        .with_capture_bytes(PATCH_BYTES),
    )
    .await?;
    let recent = match &state.branch.head {
        Some(head) => Some(
            checked(
                port,
                Command::owned(
                    root,
                    vec![
                        "log".to_owned(),
                        "-12".to_owned(),
                        "--format=%s".to_owned(),
                        head.clone(),
                        "--".to_owned(),
                    ],
                )
                .with_capture_bytes(RECENT_BYTES),
            )
            .await?,
        ),
        None => None,
    };
    let configured = checked(
        port,
        Command::new(root, &["config", "--get", "commit.template"])
            .allowing_failure()
            .with_capture_bytes(4096),
    )
    .await?;
    let mut candidates: Vec<String> =
        vec!["AGENTS.md".to_owned(), ".ace/source-control.md".to_owned()];
    if matches!(selection, SourceControlSelection::Pr { .. }) {
        for name in [
            ".github/PULL_REQUEST_TEMPLATE.md",
            ".github/pull_request_template.md",
            "PULL_REQUEST_TEMPLATE.md",
        ] {
            push_unique(&mut candidates, name.to_owned());
        }
    }
    if matches!(selection, SourceControlSelection::Commit { .. }) && configured.exit_code == 0 {
        let template = text_output(&configured.stdout)?;
        let relative = if Path::new(&template).is_absolute() {
            Path::new(&template)
                .strip_prefix(Path::new(root))
                .map(|rest| rest.to_string_lossy().into_owned())
                .unwrap_or(template.clone())
        } else {
            template.clone()
        };
        push_unique(&mut candidates, relative);
    }
    for path in &paths {
        let mut directory = Path::new(path).parent();
        while let Some(dir) = directory {
            if dir.as_os_str().is_empty() || candidates.len() >= MAX_CONVENTIONS {
                break;
            }
            let name = if dir == Path::new(".") {
                "AGENTS.md".to_owned()
            } else {
                format!("{}/AGENTS.md", dir.to_string_lossy())
            };
            push_unique(&mut candidates, name);
            directory = dir.parent().filter(|parent| !parent.as_os_str().is_empty());
        }
    }
    let mut conventions: Vec<Convention> = Vec::new();
    let mut convention_bytes = 0usize;
    let mut truncated = patch.truncated || recent.as_ref().is_some_and(|recent| recent.truncated);
    for path in &candidates {
        truncated |= candidates.len() >= MAX_CONVENTIONS;
        let Some((text, content_truncated)) = repository_text(root, path)? else {
            continue;
        };
        let remaining = CONVENTION_BYTES.saturating_sub(convention_bytes);
        let bytes = text.as_bytes();
        let kept = &bytes[..bytes.len().min(remaining)];
        let kept = String::from_utf8_lossy(kept).into_owned();
        truncated |= content_truncated || utf16_len(&kept) < utf16_len(&text);
        if !kept.is_empty() {
            convention_bytes += kept.len();
            conventions.push(Convention {
                path: path.clone(),
                text: kept,
            });
        }
    }
    let fingerprint = fingerprint_of(
        selection,
        &state,
        base.as_deref(),
        remote.as_ref(),
        &from,
        &to,
        &conventions,
    )?;
    Ok(SourceControlContext {
        fingerprint,
        head: state.branch.head,
        base,
        paths,
        patch: crate::core::cli::patch_output(&patch.stdout, patch.truncated),
        truncated,
        conventions,
        recent_commits: recent
            .map(|recent| crate::core::cli::patch_output(&recent.stdout, recent.truncated))
            .unwrap_or_default(),
    })
}

fn push_unique(items: &mut Vec<String>, value: String) {
    if !items.contains(&value) {
        items.push(value);
    }
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum FingerprintSelection {
    Commit {
        paths: Vec<String>,
    },
    Pr {
        branch: String,
        base: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        base_ref: Option<String>,
    },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Fingerprint<'a> {
    selection: FingerprintSelection,
    head: Option<&'a str>,
    branch: Option<&'a str>,
    base: Option<&'a str>,
    remote: Option<&'a crate::parse::repository::Remote>,
    from: &'a str,
    to: &'a str,
    conventions: &'a [Convention],
}

#[allow(clippy::too_many_arguments)]
fn fingerprint_of(
    selection: &SourceControlSelection,
    state: &crate::parse::status::ParsedStatus,
    base: Option<&str>,
    remote: Option<&crate::parse::repository::Remote>,
    from: &str,
    to: &str,
    conventions: &[Convention],
) -> Result<String, GitError> {
    let selection = match selection {
        SourceControlSelection::Commit { paths } => {
            let mut paths: Vec<String> = paths.clone();
            paths.sort_by(|left, right| left.encode_utf16().cmp(right.encode_utf16()));
            paths.dedup();
            FingerprintSelection::Commit { paths }
        }
        SourceControlSelection::Pr {
            branch,
            base,
            base_ref,
        } => FingerprintSelection::Pr {
            branch: branch.clone(),
            base: base.clone(),
            base_ref: base_ref.clone(),
        },
    };
    let value = Fingerprint {
        selection,
        head: state.branch.head.as_deref(),
        branch: state.branch.branch.as_deref(),
        base,
        remote,
        from,
        to,
        conventions,
    };
    let json = ace_json::ser::to_string(&value)
        .map_err(|error| GitError::new(GitErrorCode::GitFailed, error.to_string()))?;
    Ok(format!("{:x}", Sha256::digest(json.as_bytes())))
}

/// The selection a commit's draft was written for, when the caller gave a fingerprint.
pub fn draft_selection(
    request_paths: Option<&Vec<String>>,
    stage_listed: Option<&Vec<String>>,
    staged_only: bool,
    staged_paths: &[String],
) -> Option<Vec<String>> {
    if let Some(paths) = request_paths {
        return Some(paths.clone());
    }
    if let Some(listed) = stage_listed {
        return Some(listed.clone());
    }
    if staged_only {
        return Some(staged_paths.to_vec());
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::credentials::test_support::Fixture;
    use crate::reads::test_support::ProcessCommands;

    #[tokio::test]
    async fn a_commit_selection_describes_its_paths_patch_conventions_and_fingerprint() {
        let fixture = Fixture::new("g4-context");
        let repo = fixture.repository("repo");
        std::fs::create_dir_all(repo.join("src")).expect("dir");
        std::fs::write(repo.join("src/lib.rs"), "before\n").expect("lib");
        std::fs::write(repo.join("AGENTS.md"), "rules\n").expect("agents");
        fixture.git(&repo, &["add", "."]);
        fixture.git(&repo, &["commit", "--quiet", "-m", "tree"]);
        std::fs::write(repo.join("src/lib.rs"), "after\n").expect("edit");
        let port = ProcessCommands { fixture: &fixture };
        let root = repo.to_string_lossy().into_owned();
        let context = writing_context(
            &port,
            &root,
            &fixture.root.to_string_lossy(),
            &SourceControlSelection::Commit {
                paths: vec!["src/lib.rs".to_owned()],
            },
        )
        .await
        .expect("context");
        assert_eq!(context.paths, vec!["src/lib.rs".to_owned()]);
        assert!(context.patch.contains("-before\n+after"));
        assert_eq!(context.fingerprint.len(), 64);
        assert!(context.head.is_some());
        let convention = context
            .conventions
            .iter()
            .find(|convention| convention.path == "AGENTS.md")
            .expect("AGENTS.md");
        assert_eq!(convention.text, "rules\n");
        assert!(!context.truncated);
        // The same selection fingerprints the same way twice.
        let again = writing_context(
            &port,
            &root,
            &fixture.root.to_string_lossy(),
            &SourceControlSelection::Commit {
                paths: vec!["src/lib.rs".to_owned()],
            },
        )
        .await
        .expect("again");
        assert_eq!(again.fingerprint, context.fingerprint);
    }

    #[tokio::test]
    async fn a_selection_whose_changes_moved_or_vanished_is_refused() {
        let fixture = Fixture::new("g4-context-moved");
        let repo = fixture.repository("repo");
        let port = ProcessCommands { fixture: &fixture };
        let root = repo.to_string_lossy().into_owned();
        let error = writing_context(
            &port,
            &root,
            &fixture.root.to_string_lossy(),
            &SourceControlSelection::Commit {
                paths: vec!["absent.txt".to_owned()],
            },
        )
        .await
        .expect_err("moved");
        assert_eq!(error.code, GitErrorCode::HeadMoved);
        assert_eq!(
            writing_context(
                &port,
                &root,
                &fixture.root.to_string_lossy(),
                &SourceControlSelection::Commit { paths: Vec::new() },
            )
            .await
            .expect_err("empty")
            .code,
            GitErrorCode::InvalidArgument
        );
    }
}

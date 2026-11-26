// SPDX-License-Identifier: Apache-2.0
//! Commit and index diffs (`packages/git/src/diff.ts`, `diff-binary.ts`, G3b): the exact diff
//! command, the raw/numstat correspondence, the `cat-file --batch` binary classifier, the
//! binary notices and the patch's byte bound with its UTF-8 cut.
//!
//! A working-tree side needs G5's snapshot and a checkpoint side G5's `readCheckpoint`; those
//! sides stay in TypeScript until then, so [`DiffSide`] names only what this item serves.
//!
//! Proof: `diff-resources.process` (commit-to-commit mixed binary/text), `review-regressions`
//! (binary payloads never in the patch), `diff.process`'s commit-side cases (patch cap,
//! unknown commits, binary detection past the first block) and `malformed-output.test.ts`'s
//! diff and blob cases, against real Git in temp repositories.

use ace_json::Value;
use serde::Serialize;

use crate::core::decode::hash;
use crate::core::error::{GitError, GitErrorCode};
use crate::core::temp_index::TemporaryIndex;
use crate::parse::diff::{DiffEntry, DiffFile, parse_diff};
use crate::reads::blob_classifier::BlobClassifier;
use crate::reads::{Command, CommandPort, checked, text_output};
use crate::refs::{self, Cancel, Outcome};

/// One side of a diff this item can serve.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DiffSide {
    /// The person's index written as a tree (`write-tree`).
    Index,
    /// A commit ref (`rev-parse --verify <ref>^{commit}`).
    Commit(String),
}

/// One diff request.
#[derive(Debug, Clone)]
pub struct DiffRequest {
    pub from: DiffSide,
    pub to: DiffSide,
    /// The caller's patch bound; the entries are always complete.
    pub max_patch_bytes: usize,
    /// Literal pathspecs; empty means every path.
    pub paths: Vec<String>,
}

/// The diff result: every entry, the bounded patch and whether the patch was cut.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DiffResult {
    pub entries: Vec<DiffEntry>,
    pub patch: String,
    pub truncated: bool,
}

/// Node's `os.devNull`.
pub fn dev_null() -> &'static str {
    if cfg!(windows) {
        r"\\.\nul"
    } else {
        "/dev/null"
    }
}

async fn resolve_side(
    port: &dyn CommandPort,
    root: &str,
    side: &DiffSide,
) -> Result<String, GitError> {
    match side {
        DiffSide::Index => {
            let output = checked(port, Command::new(root, &["write-tree"]).writing()).await?;
            text_output(&output.stdout)
        }
        DiffSide::Commit(reference) => resolve_commit(port, root, reference).await,
    }
}

pub(crate) async fn resolve_commit(
    port: &dyn CommandPort,
    root: &str,
    reference: &str,
) -> Result<String, GitError> {
    if reference.is_empty() || reference.contains('\0') {
        return Err(GitError::new(
            GitErrorCode::InvalidRef,
            "A commit ref is required",
        ));
    }
    match refs::resolve_commit(root, reference, &Cancel::never()) {
        Outcome::Data(resolution) => match resolution.kind() {
            "commit" => resolution
                .id()
                .map(str::to_owned)
                .ok_or_else(|| not_found(reference)),
            "unborn" if reference == "HEAD" => empty_tree(port, root).await,
            _ => Err(not_found(reference)),
        },
        Outcome::Fallback(_) => {
            let resolved = checked(
                port,
                Command::new(
                    root,
                    &[
                        "rev-parse",
                        "--verify",
                        "--end-of-options",
                        &format!("{reference}^{{commit}}"),
                    ],
                )
                .allowing_failure(),
            )
            .await?;
            if resolved.exit_code == 0 {
                return hash(&text_output(&resolved.stdout)?);
            }
            if reference != "HEAD" {
                return Err(not_found(reference));
            }
            let symbolic = checked(
                port,
                Command::new(root, &["symbolic-ref", "--quiet", "HEAD"]).allowing_failure(),
            )
            .await?;
            if symbolic.exit_code == 0 {
                return empty_tree(port, root).await;
            }
            Err(not_found(reference))
        }
    }
}

fn not_found(reference: &str) -> GitError {
    GitError::new(
        GitErrorCode::InvalidRef,
        format!("Commit not found: {reference}"),
    )
}

/// `hash-object -t tree --stdin` on no input: the empty tree for an unborn `HEAD`.
async fn empty_tree(port: &dyn CommandPort, root: &str) -> Result<String, GitError> {
    let output = checked(
        port,
        Command::new(root, &["hash-object", "-t", "tree", "--stdin"]).with_input(b""),
    )
    .await?;
    text_output(&output.stdout)
}

fn diff_args() -> Vec<String> {
    let mut args: Vec<String> = [
        "-c",
        "core.quotePath=true",
        "-c",
        "diff.suppressBlankEmpty=false",
        "diff",
    ]
    .iter()
    .map(|arg| (*arg).to_owned())
    .collect();
    args.push(format!("-O{}", dev_null()));
    for arg in [
        "--no-relative",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        "--ignore-submodules=none",
        "--submodule=short",
        "--diff-algorithm=myers",
        "--indent-heuristic",
        "--find-renames=50%",
        "--src-prefix=a/",
        "--dst-prefix=b/",
        "--line-prefix=",
    ] {
        args.push(arg.to_owned());
    }
    args
}

/// Windows: Git for Windows maps `/dev/null` itself; Node's `\\.\nul` reaches it as `//./nul`.
fn windows_order_file(args: &mut [String]) {
    let order = format!("-O{}", dev_null());
    if let Some(index) = args.iter().position(|arg| *arg == order) {
        args[index] = "-O/dev/null".to_owned();
    }
}

fn pathspecs(paths: &[String]) -> Vec<String> {
    // Literal pathspecs: a path is never read as a glob or as pathspec magic.
    paths
        .iter()
        .map(|path| format!(":(literal){path}"))
        .collect()
}

/// Marks the entries whose blobs hold a NUL byte, from one `cat-file --batch` stream.
pub async fn classify_binaries(
    port: &dyn CommandPort,
    root: &str,
    files: &mut [DiffFile],
) -> Result<(), GitError> {
    let mut hashes: Vec<String> = Vec::new();
    for file in files.iter() {
        for (mode, sha) in [
            (&file.old_mode, &file.old_sha),
            (&file.new_mode, &file.new_sha),
        ] {
            if mode != "160000" && sha.bytes().any(|byte| byte != b'0') && !hashes.contains(sha) {
                hashes.push(sha.clone());
            }
        }
    }
    if hashes.is_empty() {
        return Ok(());
    }
    let input = format!("{}\n", hashes.join("\n"));
    let output = checked(
        port,
        Command::new(root, &["cat-file", "--batch"]).with_input(input.as_bytes()),
    )
    .await?;
    let mut classifier = BlobClassifier::new(hashes);
    classifier.feed(&output.stdout)?;
    let binary = classifier.finish()?;
    for file in files.iter_mut() {
        if binary
            .iter()
            .any(|sha| sha == &file.old_sha || sha == &file.new_sha)
        {
            file.entry.binary = true;
        }
        if file.entry.binary {
            file.entry.additions = 0;
            file.entry.deletions = 0;
        }
    }
    Ok(())
}

/// The tree of only the changed text entries, on both sides, through a temporary index.
pub async fn text_trees(
    port: &dyn CommandPort,
    root: &str,
    temp_directory: &str,
    files: &[DiffFile],
) -> Result<(String, String), GitError> {
    let mut old_entries: Vec<(String, String)> = Vec::new();
    let mut new_entries: Vec<(String, String)> = Vec::new();
    for file in files {
        if file.entry.binary {
            continue;
        }
        if file.old_mode != "000000" {
            let path = file.entry.old_path.as_deref().unwrap_or(&file.entry.path);
            old_entries.push((
                path.to_owned(),
                format!("{} {} 0\t{path}\0", file.old_mode, file.old_sha),
            ));
        }
        if file.new_mode != "000000" {
            new_entries.push((
                file.entry.path.clone(),
                format!(
                    "{} {} 0\t{}\0",
                    file.new_mode, file.new_sha, file.entry.path
                ),
            ));
        }
    }
    async fn write(
        port: &dyn CommandPort,
        root: &str,
        temp_directory: &str,
        entries: &[(String, String)],
    ) -> Result<String, GitError> {
        let index = TemporaryIndex::create(temp_directory)?;
        let env: Vec<(&str, &str)> = index
            .env()
            .iter()
            .map(|(key, value)| (key.as_str(), value.as_str()))
            .collect();
        checked(
            port,
            Command::new(root, &["read-tree", "--empty"])
                .with_env(&env)
                .writing(),
        )
        .await?;
        let mut seed = String::new();
        for (_, entry) in entries {
            seed.push_str(entry);
        }
        checked(
            port,
            Command::new(root, &["update-index", "-z", "--index-info"])
                .with_env(&env)
                .with_input(seed.as_bytes())
                .writing(),
        )
        .await?;
        let tree = checked(
            port,
            Command::new(root, &["write-tree"]).with_env(&env).writing(),
        )
        .await?;
        hash(&text_output(&tree.stdout)?)
    }
    Ok((
        write(port, root, temp_directory, &old_entries).await?,
        write(port, root, temp_directory, &new_entries).await?,
    ))
}

/// The patch section for every binary entry, in entry order.
pub fn binary_notices(files: &[DiffFile]) -> String {
    let mut notices = String::new();
    for file in files.iter().filter(|file| file.entry.binary) {
        let entry = &file.entry;
        let old = entry.old_path.as_deref().unwrap_or(&entry.path);
        let from = if entry.status == "A" {
            "/dev/null".to_owned()
        } else {
            format!("a/{old}")
        };
        let to = if entry.status == "D" {
            "/dev/null".to_owned()
        } else {
            format!("b/{}", entry.path)
        };
        notices.push_str(&format!(
            "diff --git {} {}\nBinary files {} and {} differ\n",
            quote(&format!("a/{old}")),
            quote(&format!("b/{}", entry.path)),
            quote(&from),
            quote(&to),
        ));
    }
    notices
}

fn quote(text: &str) -> String {
    ace_json::to_string(&Value::from(text))
}

/// `diff`: the entries always, the patch up to `max_patch_bytes` and whether it was cut.
pub async fn diff(
    port: &dyn CommandPort,
    root: &str,
    temp_directory: &str,
    request: &DiffRequest,
    is_windows: bool,
) -> Result<DiffResult, GitError> {
    let temp_directory = temp_directory.to_owned();
    let mut a = resolve_side(port, root, &request.from).await?;
    let mut b = resolve_side(port, root, &request.to).await?;
    let mut args = diff_args();
    if is_windows {
        windows_order_file(&mut args);
    }
    let mut metadata_args = args.clone();
    for arg in ["--raw", "--no-abbrev", "--numstat", "-z"] {
        metadata_args.push(arg.to_owned());
    }
    metadata_args.push(a.clone());
    metadata_args.push(b.clone());
    metadata_args.push("--".to_owned());
    metadata_args.extend(pathspecs(&request.paths));
    let output = checked(port, Command::owned(root, metadata_args)).await?;
    let mut files = parse_diff(&output.stdout)?;
    classify_binaries(port, root, &mut files).await?;
    let notices = binary_notices(&files);
    let notices_bytes = notices.as_bytes();
    let prefix_len = notices_bytes.len().min(request.max_patch_bytes);
    let prefix = &notices_bytes[..prefix_len];
    let mut truncated = notices_bytes.len() > request.max_patch_bytes;
    let mut bytes = prefix.to_vec();
    if !truncated && files.iter().any(|file| !file.entry.binary) {
        // Only changed text entries enter the patch indexes. Both sides of every binary rename
        // are absent, without materializing the repository index.
        if files.iter().any(|file| file.entry.binary) {
            let (old, new) = text_trees(port, root, &temp_directory, &files).await?;
            a = old;
            b = new;
        }
        let mut patch_args = args;
        for arg in ["--patch", "--unified=3", "--inter-hunk-context=0", "-z"] {
            patch_args.push(arg.to_owned());
        }
        patch_args.push(a);
        patch_args.push(b);
        patch_args.push("--".to_owned());
        patch_args.extend(pathspecs(&request.paths));
        let capture = request.max_patch_bytes - prefix.len();
        let patch = checked(
            port,
            Command::owned(root, patch_args).with_capture_bytes(capture),
        )
        .await?;
        bytes.extend_from_slice(&patch.stdout);
        truncated = patch.truncated;
    }
    Ok(DiffResult {
        entries: files.into_iter().map(|file| file.entry).collect(),
        patch: crate::core::cli::patch_output(&bytes, truncated),
        truncated,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::credentials::test_support::Fixture;
    use crate::reads::test_support::ProcessCommands;

    fn request(from: DiffSide, to: DiffSide) -> DiffRequest {
        DiffRequest {
            from,
            to,
            max_patch_bytes: 1_000_000,
            paths: Vec::new(),
        }
    }

    // `diff-resources.process`: mixed binary and text commit diffs succeed with complete entries.
    #[tokio::test]
    async fn a_commit_diff_reports_text_and_binary_entries_without_binary_bytes() {
        let fixture = Fixture::new("g3b-diff");
        let repo = fixture.repository("repo");
        std::fs::write(repo.join("text.txt"), "before\n").expect("text");
        std::fs::write(repo.join("binary.bin"), b"before\0SECRET\n").expect("binary");
        fixture.git(&repo, &["add", "."]);
        fixture.git(&repo, &["commit", "--quiet", "-m", "add"]);
        let before = String::from_utf8_lossy(&fixture.git(&repo, &["rev-parse", "HEAD"]))
            .trim_end()
            .to_owned();
        std::fs::write(repo.join("text.txt"), "after\n").expect("text");
        std::fs::write(repo.join("binary.bin"), b"after\0SECRET\n").expect("binary");
        fixture.git(&repo, &["commit", "--quiet", "-am", "change"]);
        let after = String::from_utf8_lossy(&fixture.git(&repo, &["rev-parse", "HEAD"]))
            .trim_end()
            .to_owned();
        let port = ProcessCommands { fixture: &fixture };
        let result = diff(
            &port,
            &repo.to_string_lossy(),
            &fixture.root.to_string_lossy(),
            &request(DiffSide::Commit(before), DiffSide::Commit(after)),
            false,
        )
        .await
        .expect("diff");
        assert_eq!(result.entries.len(), 2);
        let binary = result
            .entries
            .iter()
            .find(|entry| entry.path == "binary.bin")
            .expect("binary entry");
        assert!(binary.binary);
        assert_eq!((binary.additions, binary.deletions), (0, 0));
        let text = result
            .entries
            .iter()
            .find(|entry| entry.path == "text.txt")
            .expect("text entry");
        assert!(!text.binary);
        assert_eq!((text.additions, text.deletions), (1, 1));
        assert!(result.patch.contains("-before\n+after"));
        assert!(result.patch.contains("Binary files"));
        assert!(!result.patch.contains("SECRET"));
        assert!(!result.patch.contains('\0'));
        assert!(!result.truncated);
    }

    // `review-regressions`: a binary rename never exposes the payload, even as a notice.
    #[tokio::test]
    async fn a_binary_rename_is_a_notice_that_names_both_paths_and_no_bytes() {
        let fixture = Fixture::new("g3b-rename");
        let repo = fixture.repository("repo");
        let old = "old binary\n\u{96ea}.bin";
        std::fs::write(repo.join(old), b"LEAK_RENAME_PAYLOAD\0private\n").expect("binary");
        fixture.git(&repo, &["add", "."]);
        fixture.git(&repo, &["commit", "--quiet", "-m", "binary"]);
        let before = String::from_utf8_lossy(&fixture.git(&repo, &["rev-parse", "HEAD"]))
            .trim_end()
            .to_owned();
        let new = "new binary\n\u{2603}.bin";
        fixture.git(&repo, &["mv", old, new]);
        fixture.git(&repo, &["commit", "--quiet", "-m", "rename"]);
        let after = String::from_utf8_lossy(&fixture.git(&repo, &["rev-parse", "HEAD"]))
            .trim_end()
            .to_owned();
        let port = ProcessCommands { fixture: &fixture };
        let result = diff(
            &port,
            &repo.to_string_lossy(),
            &fixture.root.to_string_lossy(),
            &request(DiffSide::Commit(before), DiffSide::Commit(after)),
            false,
        )
        .await
        .expect("diff");
        assert_eq!(
            result.entries,
            vec![DiffEntry {
                path: new.to_owned(),
                old_path: Some(old.to_owned()),
                status: "R".to_owned(),
                additions: 0,
                deletions: 0,
                binary: true,
            }]
        );
        assert!(result.patch.contains("Binary files"));
        assert!(!result.patch.contains("LEAK_RENAME_PAYLOAD"));
    }

    // `diff.process`: the patch cap bounds bytes without cutting a character.
    #[tokio::test]
    async fn a_patch_cap_bounds_bytes_keeps_entries_and_never_splits_a_character() {
        let fixture = Fixture::new("g3b-cap");
        let repo = fixture.repository("repo");
        std::fs::write(repo.join("file.txt"), "\u{96ea}\u{2603}\n".repeat(10_000)).expect("text");
        fixture.git(&repo, &["add", "file.txt"]);
        fixture.git(&repo, &["commit", "--quiet", "-m", "text"]);
        std::fs::write(repo.join("file.txt"), "changed\n").expect("change");
        fixture.git(&repo, &["commit", "--quiet", "-am", "change"]);
        let after = String::from_utf8_lossy(&fixture.git(&repo, &["rev-parse", "HEAD"]))
            .trim_end()
            .to_owned();
        let before = String::from_utf8_lossy(&fixture.git(&repo, &["rev-parse", "HEAD~1"]))
            .trim_end()
            .to_owned();
        let port = ProcessCommands { fixture: &fixture };
        let mut capped = request(
            DiffSide::Commit(before.clone()),
            DiffSide::Commit(after.clone()),
        );
        capped.max_patch_bytes = 257;
        let result = diff(
            &port,
            &repo.to_string_lossy(),
            &fixture.root.to_string_lossy(),
            &capped,
            false,
        )
        .await
        .expect("capped");
        assert_eq!(result.entries.len(), 1);
        assert!(result.truncated);
        assert!(result.patch.len() <= 257);
        assert!(!result.patch.contains('\u{FFFD}'));
        let mut zero = request(DiffSide::Commit(before), DiffSide::Commit(after));
        zero.max_patch_bytes = 0;
        let empty = diff(
            &port,
            &repo.to_string_lossy(),
            &fixture.root.to_string_lossy(),
            &zero,
            false,
        )
        .await
        .expect("zero");
        assert_eq!(empty.patch, "");
        assert!(empty.truncated);
    }

    #[tokio::test]
    async fn an_unknown_commit_is_invalid_ref_and_an_index_side_reads_the_staged_tree() {
        let fixture = Fixture::new("g3b-sides");
        let repo = fixture.repository("repo");
        let port = ProcessCommands { fixture: &fixture };
        let error = diff(
            &port,
            &repo.to_string_lossy(),
            &fixture.root.to_string_lossy(),
            &request(
                DiffSide::Commit("no-such-ref".to_owned()),
                DiffSide::Commit("HEAD".to_owned()),
            ),
            false,
        )
        .await
        .expect_err("unknown commit");
        assert_eq!(error.code, GitErrorCode::InvalidRef);

        std::fs::write(repo.join("staged.txt"), "staged\n").expect("staged");
        fixture.git(&repo, &["add", "staged.txt"]);
        let index = diff(
            &port,
            &repo.to_string_lossy(),
            &fixture.root.to_string_lossy(),
            &request(DiffSide::Commit("HEAD".to_owned()), DiffSide::Index),
            false,
        )
        .await
        .expect("index diff");
        assert_eq!(index.entries.len(), 1);
        assert_eq!(index.entries[0].path, "staged.txt");
        assert_eq!(index.entries[0].status, "A");
        // The person's index is untouched: the same read again reports the same entry.
        let again = diff(
            &port,
            &repo.to_string_lossy(),
            &fixture.root.to_string_lossy(),
            &request(DiffSide::Commit("HEAD".to_owned()), DiffSide::Index),
            false,
        )
        .await
        .expect("index diff again");
        assert_eq!(again.entries, index.entries);
    }
}

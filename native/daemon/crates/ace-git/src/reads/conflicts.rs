// SPDX-License-Identifier: Apache-2.0
//! Merge-conflict reads (`packages/git/src/conflict-markers.ts` and the read side of
//! `merge-conflicts.ts`, G3c): the marker parser and the checkout's unmerged paths with their
//! hunks.
//!
//! Proof: every case of `conflict-markers.test.ts` (moved here) and `merge-conflicts.process`'s
//! read cases, against a real conflicted checkout. Writes (`startMerge`, `takeSide`,
//! `writeResolution`, `commitMerge`, `abortMerge`) belong to G4d.

use std::path::Path;

use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::core::decode::nul;
use crate::core::error::{GitError, GitErrorCode};
use crate::core::paths;
use crate::reads::{Command, CommandPort, checked};

/// The largest file whose hunks a read carries.
pub const MAX_CONFLICT_FILE_BYTES: u64 = 131_072;
/// The most conflicted files one read lists.
pub const CONFLICT_FILE_LIMIT: usize = 200;
/// Everything a read's hunks may carry together, inside one wire frame.
pub const READ_BUDGET_BYTES: u64 = 6 * MAX_CONFLICT_FILE_BYTES;

/// One plain-text or conflict segment of a file Git left mid-merge.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ConflictSegment {
    Text {
        text: String,
    },
    Conflict {
        ours: String,
        base: Option<String>,
        theirs: String,
        markers: ConflictMarkers,
    },
}

/// Git's own marker lines, verbatim with line endings.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ConflictMarkers {
    pub ours: String,
    pub base: Option<String>,
    pub separator: String,
    pub theirs: String,
}

/// Which of the merge's three versions have a path.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct ConflictStages {
    pub base: bool,
    pub ours: bool,
    pub theirs: bool,
}

/// One conflicted file's content, or why only a whole side can be taken.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ConflictContent {
    Text {
        revision: String,
        segments: Vec<ConflictSegment>,
    },
    Unavailable {
        reason: String,
    },
}

/// One file `git ls-files -u` lists.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ConflictFile {
    pub path: String,
    pub stages: ConflictStages,
    pub content: ConflictContent,
}

/// The checkout's merge state and every unmerged path.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Conflicts {
    pub head: Option<String>,
    pub merging: bool,
    pub dirty: bool,
    pub files: Vec<ConflictFile>,
    pub truncated: bool,
}

fn lines(text: &str) -> Vec<&str> {
    // `/[^\n]*\n|[^\n]+$/g`: every terminated line, then a trailing unterminated one.
    let mut all = Vec::new();
    let mut start = 0usize;
    while let Some(index) = text[start..].find('\n') {
        let end = start + index + 1;
        all.push(&text[start..end]);
        start = end;
    }
    if start < text.len() {
        all.push(&text[start..]);
    }
    all
}

fn marker(line: &str, character: char) -> bool {
    let mut characters = line.chars();
    for _ in 0..7 {
        if characters.next() != Some(character) {
            return false;
        }
    }
    let rest = characters.as_str();
    rest.is_empty() || rest.starts_with(' ') || rest.starts_with('\r') || rest.starts_with('\n')
}

/// Splits a file into its plain text and its conflict hunks (`merge` and `diff3` styles).
/// A marker that opens no complete hunk stays text, so a partly edited file is never misread.
pub fn parse_conflict_markers(text: &str) -> Vec<ConflictSegment> {
    let all = lines(text);
    let mut segments = Vec::new();
    let mut plain = String::new();
    let mut index = 0usize;
    while index < all.len() {
        let hunk = if marker(all[index], '<') {
            read_hunk(&all, index)
        } else {
            None
        };
        let Some((hunk, next)) = hunk else {
            plain.push_str(all[index]);
            index += 1;
            continue;
        };
        if !plain.is_empty() {
            segments.push(ConflictSegment::Text {
                text: std::mem::take(&mut plain),
            });
        }
        segments.push(hunk);
        index = next;
    }
    if !plain.is_empty() {
        segments.push(ConflictSegment::Text { text: plain });
    }
    segments
}

/// Whether any complete conflict hunk is left in `text`.
pub fn has_conflict_hunks(text: &str) -> bool {
    parse_conflict_markers(text)
        .iter()
        .any(|segment| matches!(segment, ConflictSegment::Conflict { .. }))
}

fn read_hunk(all: &[&str], start: usize) -> Option<(ConflictSegment, usize)> {
    let mut sections: Vec<String> = vec![String::new()];
    let mut found: Vec<String> = vec![all[start].to_owned()];
    let mut phase = "ours";
    for (index, line) in all.iter().enumerate().skip(start + 1) {
        if marker(line, '<') {
            return None;
        }
        if phase == "ours" && marker(line, '|') {
            phase = "base";
            found.push((*line).to_owned());
            sections.push(String::new());
        } else if phase != "theirs"
            && marker(line, '=')
            && crate::core::reviewer::ecma_trim_end(&line[7..]).is_empty()
        {
            if phase == "ours" {
                found.push(String::new());
            }
            phase = "theirs";
            found.push((*line).to_owned());
            sections.push(String::new());
        } else if phase == "theirs" && marker(line, '>') {
            let ours = sections.first().cloned().unwrap_or_default();
            let base = sections.get(1).cloned().unwrap_or_default();
            let theirs = sections.get(2).cloned().unwrap_or_default();
            let open = found.first().cloned().unwrap_or_default();
            let base_marker = found.get(1).cloned().unwrap_or_default();
            let separator = found.get(2).cloned().unwrap_or_default();
            let has_base = !base_marker.is_empty();
            return Some((
                ConflictSegment::Conflict {
                    ours,
                    base: has_base.then_some(base),
                    theirs: if has_base {
                        theirs
                    } else {
                        sections.get(1).cloned().unwrap_or_default()
                    },
                    markers: ConflictMarkers {
                        ours: open,
                        base: has_base.then_some(base_marker),
                        separator,
                        theirs: (*line).to_owned(),
                    },
                },
                index + 1,
            ));
        } else if let Some(section) = sections.last_mut() {
            section.push_str(line);
        }
    }
    None
}

fn parse_unmerged(bytes: &[u8]) -> Result<Vec<(String, ConflictStages)>, GitError> {
    let mut paths: Vec<(String, ConflictStages)> = Vec::new();
    for record in nul(bytes)? {
        let Some(tab) = record.find('\t') else {
            return Err(GitError::new(
                GitErrorCode::MalformedOutput,
                "Unreadable unmerged entry",
            ));
        };
        let header: Vec<&str> = record[..tab].split(' ').collect();
        let [mode, sha, stage] = match header.as_slice() {
            [mode, sha, stage] => [*mode, *sha, *stage],
            _ => {
                return Err(GitError::new(
                    GitErrorCode::MalformedOutput,
                    "Unreadable unmerged entry",
                ));
            }
        };
        if !mode.bytes().all(|byte| byte.is_ascii_digit())
            || sha.is_empty()
            || !sha.bytes().all(|byte| byte.is_ascii_hexdigit())
            || !matches!(stage, "1" | "2" | "3")
        {
            return Err(GitError::new(
                GitErrorCode::MalformedOutput,
                "Unreadable unmerged entry",
            ));
        }
        let path = &record[tab + 1..];
        if path.is_empty() {
            return Err(GitError::new(
                GitErrorCode::MalformedOutput,
                "Unreadable unmerged entry",
            ));
        }
        let index = match paths.iter().position(|(known, _)| known == path) {
            Some(index) => index,
            None => {
                paths.push((
                    path.to_owned(),
                    ConflictStages {
                        base: false,
                        ours: false,
                        theirs: false,
                    },
                ));
                paths.len() - 1
            }
        };
        if let Some((_, stages)) = paths.get_mut(index) {
            match stage {
                "1" => stages.base = true,
                "2" => stages.ours = true,
                _ => stages.theirs = true,
            }
        }
    }
    Ok(paths)
}

async fn merging(port: &dyn CommandPort, root: &str) -> Result<bool, GitError> {
    let head = checked(
        port,
        Command::new(
            root,
            &["rev-parse", "--verify", "--quiet", "MERGE_HEAD^{commit}"],
        )
        .allowing_failure(),
    )
    .await?;
    Ok(head.exit_code == 0)
}

async fn unmerged_paths(
    port: &dyn CommandPort,
    root: &str,
) -> Result<Vec<(String, ConflictStages)>, GitError> {
    let listed = checked(
        port,
        Command::new(root, &["ls-files", "--unmerged", "-z"]).with_capture_bytes(8 * 1024 * 1024),
    )
    .await?;
    if listed.truncated {
        return Err(GitError::new(
            GitErrorCode::OutputTooLarge,
            "Too many conflicted files",
        ));
    }
    parse_unmerged(&listed.stdout)
}

fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

/// The path inside the checkout when it is a regular file there (no symlink on the way out).
fn regular_file(root: &str, name: &str) -> Option<String> {
    let root = paths::canonical(root).unwrap_or_else(|_| root.to_owned());
    let file = Path::new(&root).join(name);
    let parent = file.parent()?;
    let real_parent = paths::canonical(&parent.to_string_lossy()).ok()?;
    if !paths::within(&root, &real_parent) {
        return None;
    }
    std::fs::symlink_metadata(&file)
        .ok()
        .filter(|metadata| metadata.is_file())
        .map(|_| file.to_string_lossy().into_owned())
}

fn unavailable(reason: &str) -> (ConflictContent, u64) {
    (
        ConflictContent::Unavailable {
            reason: reason.to_owned(),
        },
        0,
    )
}

fn working_text(root: &str, name: &str, budget: u64) -> (ConflictContent, u64) {
    let file = Path::new(root).join(name);
    let Ok(metadata) = std::fs::symlink_metadata(&file) else {
        return unavailable("missing");
    };
    if regular_file(root, name).is_none() {
        return unavailable("unsupported");
    }
    let limit = MAX_CONFLICT_FILE_BYTES.min(budget);
    if metadata.len() > limit {
        return unavailable("too_large");
    }
    let Ok(bytes) = std::fs::read(&file) else {
        return unavailable("missing");
    };
    if bytes.len() as u64 > limit {
        return unavailable("too_large");
    }
    if bytes.contains(&0) || std::str::from_utf8(&bytes).is_err() {
        return unavailable("binary");
    }
    let text = String::from_utf8_lossy(&bytes).into_owned();
    (
        ConflictContent::Text {
            revision: digest(&bytes),
            segments: parse_conflict_markers(&text),
        },
        bytes.len() as u64,
    )
}

/// `readConflicts`: the merge state and every unmerged path, each with its hunks when text.
pub async fn read_conflicts(port: &dyn CommandPort, root: &str) -> Result<Conflicts, GitError> {
    let state = crate::reads::status::state(port, root, &[]).await?;
    let in_merge = merging(port, root).await?;
    let unmerged = unmerged_paths(port, root).await?;
    let mut paths: Vec<String> = unmerged.iter().map(|(path, _)| path.clone()).collect();
    paths.sort_by(|left, right| left.encode_utf16().cmp(right.encode_utf16()));
    let empty = ConflictStages {
        base: false,
        ours: false,
        theirs: false,
    };
    let mut budget = READ_BUDGET_BYTES;
    let mut files = Vec::new();
    for name in paths.iter().take(CONFLICT_FILE_LIMIT) {
        let stages = unmerged
            .iter()
            .find(|(path, _)| path == name)
            .map(|(_, stages)| *stages)
            .unwrap_or(empty);
        let (content, bytes) = working_text(root, name, budget);
        budget = budget.saturating_sub(bytes);
        files.push(ConflictFile {
            path: name.clone(),
            stages,
            content,
        });
    }
    Ok(Conflicts {
        head: state.branch.head,
        merging: in_merge,
        dirty: !in_merge
            && (!state.status.conflicted.is_empty()
                || !state.status.staged.is_empty()
                || !state.status.unstaged.is_empty()),
        files,
        truncated: paths.len() > CONFLICT_FILE_LIMIT,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::credentials::test_support::Fixture;
    use crate::reads::test_support::ProcessCommands;

    fn diff3() -> String {
        [
            "before\n",
            "<<<<<<< HEAD\n",
            "ours line\n",
            "||||||| base\n",
            "base line\n",
            "=======\n",
            "theirs line\n",
            ">>>>>>> origin/main\n",
            "after\n",
        ]
        .join("")
    }

    // Every case of `conflict-markers.test.ts`.
    #[test]
    fn a_diff3_hunk_splits_into_ours_base_and_theirs_between_the_plain_text() {
        assert_eq!(
            parse_conflict_markers(&diff3()),
            vec![
                ConflictSegment::Text {
                    text: "before\n".to_owned()
                },
                ConflictSegment::Conflict {
                    ours: "ours line\n".to_owned(),
                    base: Some("base line\n".to_owned()),
                    theirs: "theirs line\n".to_owned(),
                    markers: ConflictMarkers {
                        ours: "<<<<<<< HEAD\n".to_owned(),
                        base: Some("||||||| base\n".to_owned()),
                        separator: "=======\n".to_owned(),
                        theirs: ">>>>>>> origin/main\n".to_owned(),
                    },
                },
                ConflictSegment::Text {
                    text: "after\n".to_owned()
                },
            ]
        );
    }

    #[test]
    fn a_hunk_without_a_base_section_has_a_null_base_and_joining_gives_the_file_back() {
        let segments = parse_conflict_markers("<<<<<<< a\nx\n=======\ny\n>>>>>>> b");
        assert_eq!(
            segments,
            vec![ConflictSegment::Conflict {
                ours: "x\n".to_owned(),
                base: None,
                theirs: "y\n".to_owned(),
                markers: ConflictMarkers {
                    ours: "<<<<<<< a\n".to_owned(),
                    base: None,
                    separator: "=======\n".to_owned(),
                    theirs: ">>>>>>> b".to_owned(),
                },
            }]
        );
        let text = diff3().replace('\n', "\r\n");
        let joined: String = parse_conflict_markers(&text)
            .iter()
            .map(|segment| match segment {
                ConflictSegment::Text { text } => text.clone(),
                ConflictSegment::Conflict {
                    ours,
                    base,
                    theirs,
                    markers,
                } => format!(
                    "{}{}{}{}{}{}{}",
                    markers.ours,
                    ours,
                    markers.base.clone().unwrap_or_default(),
                    base.clone().unwrap_or_default(),
                    markers.separator,
                    theirs,
                    markers.theirs
                ),
            })
            .collect();
        assert_eq!(joined, text);
    }

    #[test]
    fn the_separator_ignores_only_ecmascript_whitespace_after_its_seven_equals() {
        // `line.slice(7).trim()` in the TypeScript: a space, tab or NBSP after the seven `=`
        // leaves nothing, U+0085 (Rust's whitespace, not the runtime's) leaves text.
        for (separator, hunks) in [
            ("=======\n", true),
            ("======= \t\n", true),
            ("======= \u{00A0}\n", true),
            ("======= \u{0085}\n", false),
        ] {
            let text = format!("<<<<<<< a\nx\n{separator}y\n>>>>>>> b");
            assert_eq!(has_conflict_hunks(&text), hunks, "{separator:?}");
        }
    }

    #[test]
    fn marker_like_lines_that_open_no_complete_hunk_stay_text() {
        let markdown = "Title\n=======\n<<<<<<< not closed\nstill text\n";
        assert_eq!(
            parse_conflict_markers(markdown),
            vec![ConflictSegment::Text {
                text: markdown.to_owned()
            }]
        );
        assert!(!has_conflict_hunks(markdown));
        assert!(has_conflict_hunks(&diff3()));
    }

    // `merge-conflicts.process`: a real conflict reads its stages and hunks; a dirty checkout
    // without a merge is reported as dirty, not merging.
    #[tokio::test]
    async fn a_conflicted_checkout_reads_its_stages_hunks_and_merge_state() {
        let fixture = Fixture::new("g3c-conflicts");
        let repo = fixture.repository("repo");
        fixture.git(&repo, &["checkout", "--quiet", "-b", "other"]);
        std::fs::write(repo.join("file.txt"), "theirs line\n").expect("theirs");
        fixture.git(&repo, &["commit", "--quiet", "-am", "theirs"]);
        fixture.git(&repo, &["checkout", "--quiet", "main"]);
        std::fs::write(repo.join("file.txt"), "ours line\n").expect("ours");
        fixture.git(&repo, &["commit", "--quiet", "-am", "ours"]);
        let merge = fixture
            .command(&repo, &[])
            .args([
                "-c",
                "merge.conflictStyle=diff3",
                "merge",
                "--no-commit",
                "other",
            ])
            .output()
            .expect("merge");
        assert!(!merge.status.success());
        let port = ProcessCommands { fixture: &fixture };
        let root = paths::canonical(&repo.to_string_lossy()).expect("canonical");
        let conflicts = read_conflicts(&port, &root).await.expect("conflicts");
        assert!(conflicts.merging);
        assert!(!conflicts.dirty);
        assert_eq!(conflicts.files.len(), 1);
        assert_eq!(conflicts.files[0].path, "file.txt");
        assert_eq!(
            conflicts.files[0].stages,
            ConflictStages {
                base: true,
                ours: true,
                theirs: true,
            }
        );
        let ConflictContent::Text { revision, segments } = &conflicts.files[0].content else {
            panic!("text");
        };
        assert_eq!(revision.len(), 64);
        assert!(
            segments
                .iter()
                .any(|segment| matches!(segment, ConflictSegment::Conflict { .. }))
        );
        assert!(!conflicts.truncated);

        // A clean checkout with an edit is dirty, not merging, and lists no files.
        fixture.git(&repo, &["merge", "--abort"]);
        std::fs::write(repo.join("file.txt"), "edited\n").expect("edit");
        let dirty = read_conflicts(&port, &root).await.expect("dirty");
        assert!(!dirty.merging);
        assert!(dirty.dirty);
        assert!(dirty.files.is_empty());
    }

    #[tokio::test]
    async fn a_binary_conflict_is_unavailable_and_a_symlink_is_unsupported() {
        let fixture = Fixture::new("g3c-conflicts-binary");
        let repo = fixture.repository("repo");
        let root = paths::canonical(&repo.to_string_lossy()).expect("canonical");
        std::fs::write(repo.join("file.bin"), [0u8, 1, 2]).expect("binary");
        fixture.git(&repo, &["add", "file.bin"]);
        fixture.git(&repo, &["commit", "--quiet", "-m", "binary"]);
        assert_eq!(
            working_text(&root, "file.bin", READ_BUDGET_BYTES).0,
            ConflictContent::Unavailable {
                reason: "binary".to_owned()
            }
        );
        assert_eq!(
            working_text(&root, "absent.txt", READ_BUDGET_BYTES).0,
            ConflictContent::Unavailable {
                reason: "missing".to_owned()
            }
        );
        let huge = working_text(&root, "file.bin", MAX_CONFLICT_FILE_BYTES.min(1)).0;
        assert_eq!(
            huge,
            ConflictContent::Unavailable {
                reason: "too_large".to_owned()
            }
        );
    }
}

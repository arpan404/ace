// SPDX-License-Identifier: Apache-2.0
#![allow(clippy::expect_used)]
//! Moving pending review drafts across PR head updates (`review-draft-move.ts`).

use std::collections::HashMap;

use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::pure::review::{ForgeReviewAnchor, ReviewSide, valid_hosted_anchor};

/// Maximum code lines kept on an outdated draft (`maxDraftCodeLines`).
pub const MAX_DRAFT_CODE_LINES: usize = 12;

/// One row of a unified patch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PatchRow {
    pub kind: char,
    pub left: Option<usize>,
    pub right: Option<usize>,
    pub text: String,
}

/// One file in a commit comparison (`ComparedFile`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ComparedFile {
    pub path: String,
    pub previous_path: Option<String>,
    pub status: String,
    pub patch: Option<String>,
}

/// Comparison of a draft's commit with the new PR head (`Comparison`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Comparison {
    pub descends: bool,
    pub merges: bool,
    pub complete: bool,
    pub files: Vec<ComparedFile>,
}

/// Outdated draft snapshot (`ForgeReviewDraft.outdated`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutdatedDraft {
    pub head_sha: String,
    pub code: Vec<String>,
}

/// Pending review draft (`ForgeReviewDraft`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForgeReviewDraft {
    pub id: String,
    pub body: String,
    pub anchor: ForgeReviewAnchor,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub outdated: Option<OutdatedDraft>,
}

/// Result of attempting to move a draft to the new PR head (`DraftMove`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DraftMove {
    Moved { anchor: ForgeReviewAnchor },
    Outdated { code: Vec<String> },
}

/// Parses a unified diff patch into rows plus `insert_after[row_index] = left_line` (`patchRows`).
pub fn patch_rows(patch: &str) -> (Vec<PatchRow>, HashMap<usize, usize>) {
    static HUNK_RE: std::sync::LazyLock<Regex> = std::sync::LazyLock::new(|| {
        Regex::new(r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,\d+)? @@").expect("compiles")
    });
    let mut rows = Vec::new();
    let mut insert_after = HashMap::new();
    let mut left: usize = 0;
    let mut right: usize = 0;
    let mut last: usize = 0;
    let mut active = false;
    for text in patch.split('\n') {
        if let Some(caps) = HUNK_RE.captures(text) {
            left = caps[1].parse().unwrap_or(0);
            right = caps[3].parse().unwrap_or(0);
            last = if caps.get(2).map(|m| m.as_str()) == Some("0") {
                left
            } else {
                left.saturating_sub(1)
            };
            active = true;
            continue;
        }
        if !active || text.starts_with('\\') {
            continue;
        }
        if let Some(rest) = text.strip_prefix('-') {
            rows.push(PatchRow {
                kind: '-',
                left: Some(left),
                right: None,
                text: rest.to_owned(),
            });
            last = left;
            left += 1;
        } else if let Some(rest) = text.strip_prefix('+') {
            let idx = rows.len();
            insert_after.insert(idx, last);
            rows.push(PatchRow {
                kind: '+',
                left: None,
                right: Some(right),
                text: rest.to_owned(),
            });
            right += 1;
        } else if let Some(rest) = text.strip_prefix(' ') {
            rows.push(PatchRow {
                kind: ' ',
                left: Some(left),
                right: Some(right),
                text: rest.to_owned(),
            });
            last = left;
            left += 1;
            right += 1;
        }
    }
    (rows, insert_after)
}

/// Tracks lines `start..=end` across `patch`, returning `None` if removed/replaced/split (`followLines`).
pub fn follow_lines(patch: &str, start: usize, end: usize) -> Option<(usize, usize)> {
    let (rows, insert_after) = patch_rows(patch);
    let mut shift: isize = 0;
    for (idx, row) in rows.iter().enumerate() {
        if row.kind == '-'
            && let Some(l) = row.left
        {
            if l >= start && l <= end {
                return None;
            }
            if l < start {
                shift -= 1;
            }
        } else if row.kind == '+' {
            let after = insert_after.get(&idx).copied().unwrap_or(0);
            if after >= start && after < end {
                return None;
            }
            if after < start {
                shift += 1;
            }
        }
    }
    let next_start = usize::try_from(start as isize + shift).ok()?;
    let next_end = usize::try_from(end as isize + shift).ok()?;
    Some((next_start, next_end))
}

fn lines_from(
    patch: Option<&str>,
    side: ReviewSide,
    start: usize,
    end: usize,
) -> HashMap<usize, String> {
    let Some(patch) = patch else {
        return HashMap::new();
    };
    let mut found = HashMap::new();
    for row in patch_rows(patch).0 {
        let line = match side {
            ReviewSide::Left => row.left,
            ReviewSide::Right => row.right,
        };
        if let Some(l) = line
            && l >= start
            && l <= end
        {
            found.insert(l, row.text);
        }
    }
    found
}

/// Extracts the code lines a draft was written on (`draftCode`).
pub fn draft_code(
    anchor: &ForgeReviewAnchor,
    compared: Option<&str>,
    hosted: Option<&str>,
    file: Option<&[String]>,
) -> Vec<String> {
    let base_start = anchor.start_line.unwrap_or(anchor.line).saturating_sub(3);
    let cap_start = anchor.line.saturating_sub(MAX_DRAFT_CODE_LINES) + 1;
    let start = 1.max(base_start).max(cap_start);
    let compared_map = if anchor.side == ReviewSide::Right {
        lines_from(compared, ReviewSide::Left, start, anchor.line)
    } else {
        HashMap::new()
    };
    let hosted_map = lines_from(hosted, anchor.side, start, anchor.line);
    let mut code = Vec::new();
    for line in start..=anchor.line {
        let text = compared_map
            .get(&line)
            .cloned()
            .or_else(|| hosted_map.get(&line).cloned())
            .or_else(|| {
                if anchor.side == ReviewSide::Right {
                    file.and_then(|lines| lines.get(line.saturating_sub(1)).cloned())
                } else {
                    None
                }
            });
        if let Some(t) = text {
            code.push(t);
        }
    }
    code
}

/// Moves a pending draft onto `head_sha`, or marks it outdated keeping its code (`moveDraft`).
pub fn move_draft(
    draft: &ForgeReviewDraft,
    head_sha: &str,
    comparison: &Comparison,
    hosted: &[(String, Option<String>)],
    file: Option<&[String]>,
) -> DraftMove {
    let anchor = &draft.anchor;
    let changed = comparison.files.iter().find(|f| {
        f.path == anchor.path || f.previous_path.as_deref() == Some(anchor.path.as_str())
    });
    let outdated = || DraftMove::Outdated {
        code: draft_code(
            anchor,
            changed.and_then(|c| c.patch.as_deref()),
            if anchor.side == ReviewSide::Left {
                hosted
                    .iter()
                    .find(|(p, _)| p == &anchor.path)
                    .and_then(|(_, patch)| patch.as_deref())
            } else {
                None
            },
            file,
        ),
    };
    if !comparison.descends {
        return outdated();
    }
    if changed.is_none() && !comparison.complete {
        return outdated();
    }
    if changed.is_some_and(|c| c.status == "removed") {
        return outdated();
    }
    let path = changed
        .map(|c| c.path.clone())
        .unwrap_or_else(|| anchor.path.clone());
    let start = anchor.start_line.unwrap_or(anchor.line);
    let mut lines = Some((start, anchor.line));
    if anchor.side == ReviewSide::Left {
        if comparison.merges {
            return outdated();
        }
    } else if let Some(c) = changed
        && (c.patch.is_some() || c.status != "renamed")
    {
        let Some(patch) = c.patch.as_deref() else {
            return outdated();
        };
        lines = follow_lines(patch, start, anchor.line);
    }
    let Some((next_start, next_end)) = lines else {
        return outdated();
    };
    let next = ForgeReviewAnchor {
        commit: head_sha.to_owned(),
        path: path.clone(),
        line: next_end,
        side: anchor.side,
        start_line: anchor.start_line.map(|_| next_start),
        start_side: anchor.start_side,
    };
    let patch = hosted
        .iter()
        .find(|(p, _)| p == &path)
        .and_then(|(_, p)| p.as_deref());
    match patch {
        Some(p) if valid_hosted_anchor(p, &next) => DraftMove::Moved { anchor: next },
        _ => outdated(),
    }
}

/// Drafts written on an earlier commit and not yet tried at `head_sha` (`draftsToMove`).
pub fn drafts_to_move<'a>(
    drafts: &'a [ForgeReviewDraft],
    head_sha: &str,
) -> Vec<&'a ForgeReviewDraft> {
    drafts
        .iter()
        .filter(|d| {
            d.anchor.commit != head_sha
                && d.outdated.as_ref().map(|o| o.head_sha.as_str()) != Some(head_sha)
        })
        .collect()
}

/// Applies `DraftMove` to `draft`, preserving previously captured code if a later attempt
/// found none (`movedDraft`).
pub fn moved_draft(draft: &ForgeReviewDraft, mv: DraftMove, head_sha: &str) -> ForgeReviewDraft {
    match mv {
        DraftMove::Moved { anchor } => ForgeReviewDraft {
            id: draft.id.clone(),
            body: draft.body.clone(),
            anchor,
            outdated: None,
        },
        DraftMove::Outdated { code } => {
            let kept = if code.is_empty() {
                draft
                    .outdated
                    .as_ref()
                    .map(|o| o.code.clone())
                    .unwrap_or_default()
            } else {
                code
            };
            ForgeReviewDraft {
                outdated: Some(OutdatedDraft {
                    head_sha: head_sha.to_owned(),
                    code: kept,
                }),
                ..draft.clone()
            }
        }
    }
}

/// Formats an outdated draft as a file-level comment (`fileCommentBody`).
pub fn file_comment_body(draft: &ForgeReviewDraft) -> String {
    static TICKS: std::sync::LazyLock<Regex> =
        std::sync::LazyLock::new(|| Regex::new(r"`+").expect("compiles"));
    let anchor = &draft.anchor;
    let lines = match anchor.start_line {
        Some(s) if s != anchor.line => format!("lines {s}–{}", anchor.line),
        _ => format!("line {}", anchor.line),
    };
    let side = if anchor.side == ReviewSide::Left {
        " (old side)"
    } else {
        ""
    };
    let short_sha: String = anchor.commit.chars().take(7).collect();
    let where_text = format!("On {lines}{side} at {short_sha}:");
    let code = draft
        .outdated
        .as_ref()
        .map(|o| o.code.as_slice())
        .unwrap_or(&[]);
    let longest = code
        .iter()
        .filter_map(|l| TICKS.find(l).map(|m| m.len()))
        .fold(2, usize::max);
    let fence = "`".repeat(longest + 1);
    let quoted = if code.is_empty() {
        String::new()
    } else {
        format!("\n\n{fence}\n{}\n{fence}", code.join("\n"))
    };
    format!("{where_text}{quoted}\n\n{}", draft.body)
}

#[cfg(test)]
mod tests {
    use super::{
        ComparedFile, Comparison, DraftMove, ForgeReviewDraft, OutdatedDraft, file_comment_body,
        follow_lines, move_draft,
    };
    use crate::pure::review::{ForgeReviewAnchor, ReviewSide};

    #[test]
    fn follow_lines_shifts_and_invalidates_touched_ranges() {
        let patch = "@@ -1,3 +1,5 @@\n a\n+x\n+y\n b\n c";
        assert_eq!(follow_lines(patch, 2, 3), Some((4, 5)));
        assert_eq!(follow_lines(patch, 1, 2), None); // insertion inside range
    }

    #[test]
    fn move_draft_reanchors_or_marks_outdated_with_fenced_file_body() {
        let draft = ForgeReviewDraft {
            id: String::from("d1"),
            body: String::from("Check this"),
            anchor: ForgeReviewAnchor {
                commit: String::from("1111111aaaa"),
                path: String::from("a.rs"),
                line: 2,
                side: ReviewSide::Right,
                start_line: None,
                start_side: None,
            },
            outdated: None,
        };
        let cmp = Comparison {
            descends: true,
            merges: false,
            complete: true,
            files: vec![ComparedFile {
                path: String::from("a.rs"),
                previous_path: None,
                status: String::from("modified"),
                patch: Some(String::from("@@ -1,2 +1,3 @@\n+top\n line1\n line2")),
            }],
        };
        let hosted = vec![(
            String::from("a.rs"),
            Some(String::from("@@ -1,1 +1,3 @@\n+top\n+line1\n+line2")),
        )];
        assert_eq!(
            move_draft(&draft, "2222222bbbb", &cmp, &hosted, None),
            DraftMove::Moved {
                anchor: ForgeReviewAnchor {
                    commit: String::from("2222222bbbb"),
                    path: String::from("a.rs"),
                    line: 3,
                    side: ReviewSide::Right,
                    start_line: None,
                    start_side: None,
                }
            }
        );

        let outdated_draft = ForgeReviewDraft {
            outdated: Some(OutdatedDraft {
                head_sha: String::from("2222222"),
                code: vec![String::from("```code```")],
            }),
            ..draft
        };
        let body = file_comment_body(&outdated_draft);
        assert!(body.contains("On line 2 at 1111111:"));
        assert!(body.contains("````\n```code```\n````"));
    }
}

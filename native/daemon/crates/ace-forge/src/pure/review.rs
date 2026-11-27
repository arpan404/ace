// SPDX-License-Identifier: Apache-2.0
#![allow(clippy::expect_used)]
//! Review comment body markers, diff line anchors, hunk tails and suggestion blocks
//! (`review-comment-body.ts`, `review-anchor.ts`, `review-hunk.ts`, `suggestions.ts`).

use std::collections::HashSet;

use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::pure::draft_move::{PatchRow, patch_rows};

/// Most code lines of a thread's hunk kept (`hunkTailLines`).
pub const HUNK_TAIL_LINES: usize = 12;
const MAX_HUNK_LINE_UTF16: usize = 1_000;

/// Strips the exact trailing ace write marker suffix if present (`authoredReviewComment`).
pub fn authored_review_comment(hosted: &str) -> &str {
    static SUFFIX: std::sync::LazyLock<Regex> = std::sync::LazyLock::new(|| {
        Regex::new(r"\n\n<!-- ace-write:[0-9a-f]{64} -->\z").expect("compiles")
    });
    match SUFFIX.find(hosted) {
        Some(m) => &hosted[..m.start()],
        None => hosted,
    }
}

/// Retains the publication identity suffix from `expected_body` when editing (`hostedReviewCommentEdit`).
pub fn hosted_review_comment_edit(body: &str, expected_body: &str) -> String {
    static SUFFIX: std::sync::LazyLock<Regex> = std::sync::LazyLock::new(|| {
        Regex::new(r"\n\n<!-- ace-write:[0-9a-f]{64} -->\z").expect("compiles")
    });
    match SUFFIX.find(expected_body) {
        Some(m) => format!("{body}{}", m.as_str()),
        None => body.to_owned(),
    }
}

/// A review comment side (`LEFT` or `RIGHT`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum ReviewSide {
    Left,
    Right,
}

/// A hosted diff anchor (`ForgeReviewAnchor`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForgeReviewAnchor {
    pub commit: String,
    pub path: String,
    pub line: usize,
    pub side: ReviewSide,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_line: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_side: Option<ReviewSide>,
}

/// One line from a hosted unified diff with optional old/new coordinates (`hostedDiffLines`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostedDiffLine {
    pub text: String,
    pub left: Option<usize>,
    pub right: Option<usize>,
}

/// Computes hosted diff coordinates (`hostedDiffLines`).
pub fn hosted_diff_lines(patch: &str) -> Vec<HostedDiffLine> {
    static HUNK_RE: std::sync::LazyLock<Regex> = std::sync::LazyLock::new(|| {
        Regex::new(r"^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@").expect("compiles")
    });
    let mut left: usize = 0;
    let mut right: usize = 0;
    let mut active = false;
    patch
        .split('\n')
        .map(|text| {
            if let Some(caps) = HUNK_RE.captures(text) {
                left = caps[1].parse().unwrap_or(0);
                right = caps[2].parse().unwrap_or(0);
                active = true;
                return HostedDiffLine {
                    text: text.to_owned(),
                    left: None,
                    right: None,
                };
            }
            if !active || text.starts_with('\\') {
                return HostedDiffLine {
                    text: text.to_owned(),
                    left: None,
                    right: None,
                };
            }
            if text.starts_with('-') {
                let l = left;
                left += 1;
                HostedDiffLine {
                    text: text.to_owned(),
                    left: Some(l),
                    right: None,
                }
            } else if text.starts_with('+') {
                let r = right;
                right += 1;
                HostedDiffLine {
                    text: text.to_owned(),
                    left: None,
                    right: Some(r),
                }
            } else if text.starts_with(' ') {
                let l = left;
                let r = right;
                left += 1;
                right += 1;
                HostedDiffLine {
                    text: text.to_owned(),
                    left: Some(l),
                    right: Some(r),
                }
            } else {
                HostedDiffLine {
                    text: text.to_owned(),
                    left: None,
                    right: None,
                }
            }
        })
        .collect()
}

/// Validates whether `anchor` lies completely inside `patch` (`validHostedAnchor`).
pub fn valid_hosted_anchor(patch: &str, anchor: &ForgeReviewAnchor) -> bool {
    if let Some(start_side) = anchor.start_side
        && start_side != anchor.side
    {
        return false;
    }
    let start = anchor.start_line.unwrap_or(anchor.line);
    if start > anchor.line || anchor.line - start > 1_000 {
        return false;
    }
    let lines: HashSet<usize> = hosted_diff_lines(patch)
        .into_iter()
        .filter_map(|line| match anchor.side {
            ReviewSide::Left => line.left,
            ReviewSide::Right => line.right,
        })
        .collect();
    (start..=anchor.line).all(|line| lines.contains(&line))
}

fn slice_utf16(text: &str, max_units: usize) -> String {
    let mut units = 0;
    let mut end = 0;
    for (idx, ch) in text.char_indices() {
        let w = ch.len_utf16();
        if units + w > max_units {
            break;
        }
        units += w;
        end = idx + ch.len_utf8();
    }
    text[..end].to_owned()
}

/// Keeps the last `keep` code lines of a diff hunk with a recomputed header (`hunkTail`).
pub fn hunk_tail(hunk: &str, keep: usize) -> Option<String> {
    let (rows, _) = patch_rows(hunk);
    if rows.is_empty() {
        return None;
    }
    let start = rows.len().saturating_sub(keep);
    let before = &rows[..start];
    let kept = &rows[start..];
    let next_left = kept
        .iter()
        .find_map(|r| r.left)
        .unwrap_or_else(|| before.iter().rev().find_map(|r| r.left).unwrap_or(0) + 1);
    let next_right = kept
        .iter()
        .find_map(|r| r.right)
        .unwrap_or_else(|| before.iter().rev().find_map(|r| r.right).unwrap_or(0) + 1);
    let lefts = kept.iter().filter(|r| r.left.is_some()).count();
    let rights = kept.iter().filter(|r| r.right.is_some()).count();
    let header_left = if lefts > 0 {
        next_left
    } else {
        next_left.saturating_sub(1)
    };
    let header_right = if rights > 0 {
        next_right
    } else {
        next_right.saturating_sub(1)
    };
    let mut out = Vec::with_capacity(kept.len() + 1);
    out.push(format!(
        "@@ -{header_left},{lefts} +{header_right},{rights} @@"
    ));
    for row in kept {
        out.push(format!(
            "{}{}",
            row.kind,
            slice_utf16(&row.text, MAX_HUNK_LINE_UTF16)
        ));
    }
    Some(out.join("\n"))
}

/// Parsed hunk rows (`hunkRows`).
pub fn hunk_rows(hunk: Option<&str>) -> Vec<PatchRow> {
    match hunk {
        Some(h) if !h.is_empty() => patch_rows(h).0,
        _ => Vec::new(),
    }
}

/// Extracts the single ```suggestion block's lines from a review comment (`suggestionOf`).
pub fn suggestion_of(body: &str) -> Option<Vec<String>> {
    static OPENING: std::sync::LazyLock<Regex> = std::sync::LazyLock::new(|| {
        Regex::new(r"^ {0,3}(`{3,}|~{3,})[ \t]*([^`\s]*)[^`]*$").expect("compiles")
    });
    let normalized = body.replace("\r\n", "\n");
    let lines: Vec<&str> = normalized.split('\n').collect();
    let mut found: Option<Vec<String>> = None;
    let mut index = 0;
    while index < lines.len() {
        let Some(caps) = OPENING.captures(lines[index]) else {
            index += 1;
            continue;
        };
        let fence = &caps[1];
        let fence_char = fence.chars().next().unwrap_or('`');
        let fence_len = fence.len();
        let end = ((index + 1)..lines.len()).find(|&at| {
            let line = lines[at];
            let trimmed_start = line.trim_start_matches(' ');
            let leading_spaces = line.len() - trimmed_start.len();
            if leading_spaces > 3 {
                return false;
            }
            let fence_count = trimmed_start
                .chars()
                .take_while(|&c| c == fence_char)
                .count();
            if fence_count < fence_len {
                return false;
            }
            trimmed_start[fence_count..]
                .chars()
                .all(|c| c == ' ' || c == '\t')
        });
        let end = end?;
        if caps[2].eq_ignore_ascii_case("suggestion") {
            if found.is_some() {
                return None;
            }
            found = Some(
                lines[(index + 1)..end]
                    .iter()
                    .map(|l| (*l).to_owned())
                    .collect(),
            );
        }
        index = end + 1;
    }
    found
}

/// One suggestion replacement range (`SuggestionEdit`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SuggestionEdit {
    pub start_line: usize,
    pub end_line: usize,
    pub lines: Vec<String>,
}

/// Applies non-overlapping 1-based line edits preserving line endings (`applySuggestions`).
pub fn apply_suggestions(text: &str, edits: &[SuggestionEdit]) -> Option<String> {
    let eol = if text.contains("\r\n") { "\r\n" } else { "\n" };
    let has_final = text.ends_with(eol);
    let body = if has_final {
        &text[..text.len() - eol.len()]
    } else {
        text
    };
    let mut lines: Vec<String> = if text.is_empty() {
        Vec::new()
    } else {
        body.split(eol).map(str::to_owned).collect()
    };
    let mut sorted: Vec<&SuggestionEdit> = edits.iter().collect();
    sorted.sort_by_key(|e| e.start_line);
    for (idx, edit) in sorted.iter().enumerate() {
        if edit.start_line < 1 || edit.end_line < edit.start_line || edit.end_line > lines.len() {
            return None;
        }
        if idx > 0 && sorted[idx - 1].end_line >= edit.start_line {
            return None;
        }
    }
    for edit in sorted.into_iter().rev() {
        lines.splice(
            (edit.start_line - 1)..edit.end_line,
            edit.lines.iter().cloned(),
        );
    }
    if lines.is_empty() {
        return Some(String::new());
    }
    let mut out = lines.join(eol);
    if has_final {
        out.push_str(eol);
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::{
        ForgeReviewAnchor, ReviewSide, SuggestionEdit, apply_suggestions, authored_review_comment,
        hosted_review_comment_edit, hunk_tail, suggestion_of, valid_hosted_anchor,
    };

    #[test]
    fn review_comment_body_strips_only_exact_trailing_marker() {
        let marker = format!("<!-- ace-write:{} -->", "a".repeat(64));
        let hosted = format!("Looks good\n\n{marker}");
        assert_eq!(authored_review_comment(&hosted), "Looks good");
        assert_eq!(
            hosted_review_comment_edit("Edited", &hosted),
            format!("Edited\n\n{marker}")
        );
        // Trailing newline after marker means authored text, not metadata.
        let with_nl = format!("{hosted}\n");
        assert_eq!(authored_review_comment(&with_nl), with_nl);
    }

    #[test]
    fn valid_hosted_anchor_and_hunk_tail_match_ts() {
        let patch = "@@ -1,3 +1,4 @@\n a\n-b\n+B1\n+B2\n c";
        assert!(valid_hosted_anchor(
            patch,
            &ForgeReviewAnchor {
                commit: String::from("abc"),
                path: String::from("f.rs"),
                line: 3,
                side: ReviewSide::Right,
                start_line: Some(2),
                start_side: Some(ReviewSide::Right),
            }
        ));
        assert!(!valid_hosted_anchor(
            patch,
            &ForgeReviewAnchor {
                commit: String::from("abc"),
                path: String::from("f.rs"),
                line: 3,
                side: ReviewSide::Right,
                start_line: Some(2),
                start_side: Some(ReviewSide::Left),
            }
        ));
        let tail = hunk_tail(patch, 2).expect("tail");
        assert_eq!(tail, "@@ -3,1 +3,2 @@\n+B2\n c");
    }

    #[test]
    fn suggestion_extraction_and_application_preserve_crlf_and_reject_overlaps() {
        let body = "Consider:\r\n```suggestion\r\nlet x = 2;\r\n```\r\n";
        assert_eq!(suggestion_of(body), Some(vec![String::from("let x = 2;")]));
        assert_eq!(
            suggestion_of("```suggestion\na\n```\n```suggestion\nb\n```"),
            None
        );
        let applied = apply_suggestions(
            "a\r\nb\r\nc\r\n",
            &[SuggestionEdit {
                start_line: 2,
                end_line: 2,
                lines: vec![String::from("B")],
            }],
        );
        assert_eq!(applied, Some(String::from("a\r\nB\r\nc\r\n")));
        assert_eq!(
            apply_suggestions(
                "a\nb\nc\n",
                &[
                    SuggestionEdit {
                        start_line: 1,
                        end_line: 2,
                        lines: vec![String::from("x")],
                    },
                    SuggestionEdit {
                        start_line: 2,
                        end_line: 3,
                        lines: vec![String::from("y")],
                    },
                ],
            ),
            None
        );
    }
}

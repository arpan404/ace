use crate::{
    constants::{IGNORED_DIRECTORY_NAMES, IGNORED_FILE_NAMES},
    models::{ProjectEntry, ProjectEntryKind},
};
use std::path::Path;

pub(crate) fn should_ignore_name(name: &str, is_directory: bool) -> bool {
    IGNORED_FILE_NAMES.contains(&name)
        || name.starts_with("._")
        || (is_directory && IGNORED_DIRECTORY_NAMES.contains(&name))
}

pub(crate) fn score_entry(entry: &ProjectEntry, query: &str) -> Option<usize> {
    if query.is_empty() {
        return Some(if matches!(entry.kind, ProjectEntryKind::Directory) {
            0
        } else {
            1
        });
    }
    let path = entry.path.to_lowercase();
    let name = Path::new(&path)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(&path)
        .to_string();
    if name == query {
        Some(0)
    } else if path == query {
        Some(1)
    } else if name.starts_with(query) {
        Some(2)
    } else if path.starts_with(query) {
        Some(3)
    } else if path.contains(&format!("/{query}")) {
        Some(4)
    } else if name.contains(query) {
        Some(5)
    } else if path.contains(query) {
        Some(6)
    } else {
        subsequence_score(&name, query)
            .map(|score| 100 + score)
            .or_else(|| subsequence_score(&path, query).map(|score| 200 + score))
    }
}

pub(crate) fn normalize_query(query: &str) -> String {
    query
        .trim()
        .trim_start_matches(['@', '.', '/'])
        .to_lowercase()
}

fn subsequence_score(value: &str, query: &str) -> Option<usize> {
    let mut query_chars = query.chars();
    let mut current = query_chars.next()?;
    let mut first_match = None;
    let mut previous_match = None;
    let mut gap_penalty = 0usize;
    let mut matched = 0usize;
    for (index, ch) in value.chars().enumerate() {
        if ch != current {
            continue;
        }
        first_match.get_or_insert(index);
        if let Some(previous) = previous_match {
            gap_penalty += index - previous - 1;
        }
        previous_match = Some(index);
        matched += 1;
        if let Some(next) = query_chars.next() {
            current = next;
        } else {
            let first = first_match.unwrap_or(index);
            let span_penalty = index - first + 1 - matched;
            return Some(
                first * 2
                    + gap_penalty * 3
                    + span_penalty
                    + value.len().saturating_sub(query.len()).min(64),
            );
        }
    }
    None
}

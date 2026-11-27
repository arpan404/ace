// SPDX-License-Identifier: Apache-2.0
//! The flat file list over one status read (`changed-files.ts`'s `readChangedFiles`, G3a).

use std::collections::HashSet;

use crate::core::error::GitError;
use crate::parse::status::ParsedStatus;
use crate::parse::status::StatusEntry;
use crate::reads::CommandPort;

use super::{
    ChangedFile, ChangedFiles, HashMap, SectionEntry, by_path, kind_of, staged_kind,
    tracked_counts, unstaged_kind, untracked_count,
};

pub(crate) fn add_file(
    files: &mut Vec<ChangedFile>,
    seen: &mut HashSet<String>,
    entry: &StatusEntry,
) {
    if !seen.insert(entry.path.clone()) {
        return;
    }
    files.push(ChangedFile {
        path: entry.path.clone(),
        from: entry.old_path.clone(),
        status: kind_of(entry).to_owned(),
        additions: 0,
        deletions: 0,
        binary: false,
    });
}

pub(crate) async fn read_changed_files(
    port: &dyn CommandPort,
    root: &str,
    state: &ParsedStatus,
    limit: usize,
) -> Result<ChangedFiles, GitError> {
    let mut files: Vec<ChangedFile> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for entry in state
        .status
        .conflicted
        .iter()
        .chain(state.status.staged.iter())
        .chain(state.status.unstaged.iter())
    {
        add_file(&mut files, &mut seen, entry);
    }
    for path in &state.status.untracked {
        if !seen.insert(path.clone()) {
            continue;
        }
        files.push(ChangedFile {
            path: path.clone(),
            from: None,
            status: "untracked".to_owned(),
            additions: 0,
            deletions: 0,
            binary: false,
        });
    }
    let sorted = by_path(files, |file| file.path.as_str());
    let truncated = sorted.len() > limit;
    let mut listed = sorted;
    listed.truncate(limit);
    let paths: Vec<String> = listed
        .iter()
        .filter(|file| file.status != "untracked")
        .flat_map(|file| match &file.from {
            Some(from) => vec![file.path.clone(), from.clone()],
            None => vec![file.path.clone()],
        })
        .collect();
    let counts = if state.branch.head.is_some() {
        tracked_counts(port, root, &paths).await?
    } else {
        HashMap::new()
    };
    for file in &mut listed {
        if let Some(counted) = counts.get(&file.path) {
            file.additions = counted.added;
            file.deletions = counted.deleted;
            file.binary = counted.binary;
        }
    }
    for file in &mut listed {
        if file.status == "untracked" {
            let counted = untracked_count(root, &file.path);
            file.additions = counted.added;
            file.binary = counted.binary;
        }
    }
    Ok(ChangedFiles {
        files: listed,
        truncated,
    })
}

pub(crate) fn sections_from_state(
    state: &ParsedStatus,
    limit: usize,
) -> (
    Vec<SectionEntry>,
    Vec<SectionEntry>,
    Vec<SectionEntry>,
    Vec<SectionEntry>,
    bool,
) {
    let staged = by_path(
        state
            .status
            .staged
            .iter()
            .map(|entry| SectionEntry {
                path: entry.path.clone(),
                from: entry.old_path.clone(),
                status: staged_kind(entry).to_owned(),
            })
            .collect(),
        |entry| entry.path.as_str(),
    );
    let unstaged = by_path(
        state
            .status
            .unstaged
            .iter()
            .map(|entry| SectionEntry {
                path: entry.path.clone(),
                from: entry.old_path.clone(),
                status: unstaged_kind(entry).to_owned(),
            })
            .collect(),
        |entry| entry.path.as_str(),
    );
    let untracked = by_path(
        state
            .status
            .untracked
            .iter()
            .map(|path| SectionEntry {
                path: path.clone(),
                from: None,
                status: "untracked".to_owned(),
            })
            .collect(),
        |entry| entry.path.as_str(),
    );
    let conflicted = by_path(
        state
            .status
            .conflicted
            .iter()
            .map(|entry| SectionEntry {
                path: entry.path.clone(),
                from: entry.old_path.clone(),
                status: "conflicted".to_owned(),
            })
            .collect(),
        |entry| entry.path.as_str(),
    );
    let truncated = staged.len() > limit
        || unstaged.len() > limit
        || untracked.len() > limit
        || conflicted.len() > limit;
    let cut = |mut entries: Vec<SectionEntry>| {
        entries.truncate(limit);
        entries
    };
    (
        cut(staged),
        cut(unstaged),
        cut(untracked),
        cut(conflicted),
        truncated,
    )
}

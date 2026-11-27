// SPDX-License-Identifier: Apache-2.0
//! The change counts over one status read (`changed-files.ts`'s `summarize` and
//! `checkoutSummary`, G3a).

use std::collections::HashSet;

use serde::Serialize;

use crate::core::error::GitError;
use crate::parse::repository::RepositoryInfo;
use crate::parse::status::ParsedStatus;
use crate::reads::CommandPort;
use crate::reads::info;
use crate::reads::status::state;

use super::{HashMap, tracked_counts};

/// What one `changeSummary` reports.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ChangeSummary {
    pub files: usize,
    pub additions: u64,
    pub deletions: u64,
}

/// `checkoutSummary`'s answer: branch, remotes and counts from one status read plus numstat.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CheckoutSummary {
    pub info: RepositoryInfo,
    pub diff: ChangeSummary,
}

async fn summarize(
    port: &dyn CommandPort,
    root: &str,
    state: &ParsedStatus,
) -> Result<ChangeSummary, GitError> {
    let mut paths: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for entry in state
        .status
        .conflicted
        .iter()
        .chain(state.status.staged.iter())
        .chain(state.status.unstaged.iter())
    {
        if seen.insert(entry.path.clone()) {
            paths.push(entry.path.clone());
        }
    }
    let counts = if state.branch.head.is_some() {
        tracked_counts(port, root, &paths).await?
    } else {
        HashMap::new()
    };
    for path in &state.status.untracked {
        seen.insert(path.clone());
    }
    Ok(ChangeSummary {
        files: seen.len(),
        additions: counts.values().map(|counted| counted.added).sum(),
        deletions: counts.values().map(|counted| counted.deleted).sum(),
    })
}

/// `changeSummary`: counts from one status read, never a snapshot or an untracked read.
pub async fn change_summary(port: &dyn CommandPort, root: &str) -> Result<ChangeSummary, GitError> {
    let state = state(port, root, &[]).await?;
    summarize(port, root, &state).await
}

/// `checkoutSummary`: branch, upstream, remotes and counts from one status read.
pub async fn checkout_summary(
    port: &dyn CommandPort,
    root: &str,
) -> Result<CheckoutSummary, GitError> {
    let state = state(port, root, &[]).await?;
    let diff = summarize(port, root, &state).await?;
    let info = info::info_with(root, state.branch, info::remotes(port, root).await?);
    Ok(CheckoutSummary { info, diff })
}

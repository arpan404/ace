// SPDX-License-Identifier: Apache-2.0
//! Index stage lines and update-index staging without re-reading the worktree.

use crate::core::decode::nul;
use crate::core::error::{GitError, GitErrorCode};
use crate::reads::{Command, CommandPort, checked, text_output};
use crate::writes::bind::long_writing;

/// One `git ls-files -s` or unmerged line: mode, blob id, stage number.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StageLine {
    pub mode: String,
    pub oid: String,
    pub stage: u8,
}

fn head_moved(message: impl Into<String>) -> GitError {
    GitError::new(GitErrorCode::HeadMoved, message.into())
}

/// Exact stage rows for `path`, merged and unmerged (`-s` and `-u`).
pub async fn stage_lines(
    port: &dyn CommandPort,
    root: &str,
    path: &str,
) -> Result<Vec<StageLine>, GitError> {
    let listed = checked(
        port,
        Command::new(root, &["ls-files", "-s", "-u", "-z", "--", path])
            .with_env(&[("GIT_LITERAL_PATHSPECS", "1")]),
    )
    .await?;
    let mut lines = Vec::new();
    for record in nul(&listed.stdout)? {
        let Some(tab) = record.find('\t') else {
            continue;
        };
        let header: Vec<&str> = record[..tab].split(' ').collect();
        if header.len() < 3 {
            continue;
        }
        let Ok(stage) = header[2].parse::<u8>() else {
            continue;
        };
        lines.push(StageLine {
            mode: header[0].to_owned(),
            oid: header[1].to_owned(),
            stage,
        });
    }
    Ok(lines)
}

pub fn assert_stage_lines(expected: &[StageLine], current: &[StageLine], path: &str) -> Result<(), GitError> {
    if expected != current {
        return Err(head_moved(format!(
            "{path} changed since it was read; refresh first"
        )));
    }
    Ok(())
}

async fn hash_and_store(
    port: &dyn CommandPort,
    root: &str,
    content: &[u8],
) -> Result<String, GitError> {
    let stored = checked(
        port,
        long_writing(Command::new(root, &["hash-object", "-w", "--stdin"]).with_input(content)),
    )
    .await?;
    Ok(text_output(&stored.stdout)?)
}

async fn apply_index_info(
    port: &dyn CommandPort,
    root: &str,
    mode: &str,
    oid: &str,
    path: &str,
) -> Result<(), GitError> {
    let line = format!("{mode} {oid}\t{path}\n");
    checked(
        port,
        long_writing(
            Command::new(root, &["update-index", "--index-info"]).with_input(line.as_bytes()),
        ),
    )
    .await?;
    Ok(())
}

/// Stage resolved bytes by blob id, re-checking unmerged stages first.
pub async fn stage_resolved_bytes(
    port: &dyn CommandPort,
    root: &str,
    path: &str,
    content: &[u8],
    bound: &[StageLine],
) -> Result<(), GitError> {
    assert_stage_lines(bound, &stage_lines(port, root, path).await?, path)?;
    let oid = hash_and_store(port, root, content).await?;
    assert_stage_lines(bound, &stage_lines(port, root, path).await?, path)?;
    apply_index_info(port, root, "100644", &oid, path).await
}

/// Stage an existing unmerged side by its stage entry, without `git checkout`.
pub async fn stage_side_entry(
    port: &dyn CommandPort,
    root: &str,
    path: &str,
    entry: &StageLine,
    bound: &[StageLine],
) -> Result<(), GitError> {
    assert_stage_lines(bound, &stage_lines(port, root, path).await?, path)?;
    apply_index_info(port, root, &entry.mode, &entry.oid, path).await
}

/// Remove a path from the index when that side deleted it.
pub async fn stage_removal(
    port: &dyn CommandPort,
    root: &str,
    path: &str,
    bound: &[StageLine],
) -> Result<(), GitError> {
    assert_stage_lines(bound, &stage_lines(port, root, path).await?, path)?;
    checked(
        port,
        long_writing(Command::new(root, &["update-index", "--remove", "--", path])
            .with_env(&[("GIT_LITERAL_PATHSPECS", "1")])),
    )
    .await?;
    Ok(())
}
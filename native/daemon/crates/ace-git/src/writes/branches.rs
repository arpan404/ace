// SPDX-License-Identifier: Apache-2.0
//! Branch writes' shared checks (`ref-conflict.ts`, G4a): refs are files, so branch `ace` and
//! branch `ace/1f2e` cannot both exist.
//!
//! Proof: `client-actions.process` and `branch-cleanup.process`.

use crate::core::error::{GitError, GitErrorCode};
use crate::reads::{Command, CommandPort, checked};

fn conflict(branch: &str, existing: &str) -> GitError {
    GitError::new(
        GitErrorCode::RefConflict,
        format!("Branch {branch} can't be created while branch {existing} exists"),
    )
    .with_detail("branch", ace_json::Value::from(branch))
    .with_detail("conflictsWith", ace_json::Value::from(existing))
}

/// Names the existing branch that blocks `branch`, before Git fails with a lock error.
pub async fn assert_no_ref_conflict(
    port: &dyn CommandPort,
    root: &str,
    branch: &str,
) -> Result<(), GitError> {
    let parts: Vec<&str> = branch.split('/').collect();
    for length in 1..parts.len() {
        let prefix = parts[..length].join("/");
        let found = checked(
            port,
            Command::new(
                root,
                &[
                    "show-ref",
                    "--verify",
                    "--quiet",
                    &format!("refs/heads/{prefix}"),
                ],
            )
            .allowing_failure(),
        )
        .await?;
        if found.exit_code == 0 {
            return Err(conflict(branch, &prefix));
        }
    }
    let below = checked(
        port,
        Command::new(
            root,
            &[
                "for-each-ref",
                "--count=1",
                "--format=%(refname:short)",
                &format!("refs/heads/{branch}/"),
            ],
        )
        .with_capture_bytes(8192),
    )
    .await?;
    let existing = String::from_utf8_lossy(&below.stdout).trim().to_owned();
    if existing.is_empty() {
        Ok(())
    } else {
        Err(conflict(branch, &existing))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::credentials::test_support::Fixture;
    use crate::reads::test_support::ProcessCommands;

    #[tokio::test]
    async fn a_branch_is_blocked_by_its_own_folder_and_by_a_branch_under_it() {
        let fixture = Fixture::new("g4a-ref-conflict");
        let repo = fixture.repository("repo");
        let port = ProcessCommands { fixture: &fixture };
        let root = repo.to_string_lossy();
        assert_no_ref_conflict(&port, &root, "feature")
            .await
            .expect("free");
        fixture.git(&repo, &["branch", "ace"]);
        let error = assert_no_ref_conflict(&port, &root, "ace/1f2e")
            .await
            .expect_err("parent exists");
        assert_eq!(error.code, GitErrorCode::RefConflict);
        fixture.git(&repo, &["branch", "group/topic"]);
        let error = assert_no_ref_conflict(&port, &root, "group")
            .await
            .expect_err("child exists");
        assert_eq!(error.code, GitErrorCode::RefConflict);
    }
}

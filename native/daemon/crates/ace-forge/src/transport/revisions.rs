// SPDX-License-Identifier: Apache-2.0
//! Status revisions (`revisions.ts`): non-owning deltas for a PR status's comments, checks
//! and review threads, so a reader can publish what moved without a history.

use crate::github::status::{CheckRow, CommentRow};
use crate::transport::incremental::{Changes, CollectionVersions};

/// A comment's identity: its kind and host id.
pub fn comment_identity(comment: &CommentRow) -> String {
    format!("{}:{}", comment.kind, comment.id)
}

/// A check's identity: its host id (which already carries `check:`/`status:`).
pub fn check_identity(check: &CheckRow) -> String {
    check.id.clone()
}

/// A review thread, as much as a revision needs of it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Thread {
    pub id: String,
}

/// One thread's identity: its host id.
pub fn thread_identity(thread: &Thread) -> String {
    thread.id.clone()
}

/// The deltas a reader keeps for one PR's last published status.
#[derive(Debug, Default)]
pub struct StatusRevisions {
    pub comments: CollectionVersions<CommentRow>,
    pub checks: CollectionVersions<CheckRow>,
    pub threads: CollectionVersions<Thread>,
}

impl StatusRevisions {
    /// A fresh set of revisions.
    pub fn new() -> StatusRevisions {
        StatusRevisions::default()
    }
}

impl StatusRevisions {
    /// The comments' delta.
    pub fn comment_changes(
        &mut self,
        previous: &[CommentRow],
        next: Vec<CommentRow>,
    ) -> Changes<CommentRow> {
        self.comments.changes(previous, next, comment_identity)
    }

    /// The checks' delta.
    pub fn check_changes(
        &mut self,
        previous: &[CheckRow],
        next: Vec<CheckRow>,
    ) -> Changes<CheckRow> {
        self.checks.changes(previous, next, check_identity)
    }
}

#[cfg(test)]
mod tests {
    use super::{StatusRevisions, check_identity, comment_identity};
    use crate::github::status::{CheckRow, CheckStatus, CommentRow};

    fn check(id: &str) -> CheckRow {
        CheckRow {
            id: id.to_owned(),
            name: String::from("test"),
            status: CheckStatus::Success,
            conclusion: None,
            completed_at: None,
            started_at: None,
            job_id: None,
            url: None,
        }
    }

    fn comment(id: i64, barrel: &'static str) -> CommentRow {
        CommentRow {
            kind: barrel,
            id,
            body: String::new(),
            author: String::from("octo"),
            author_avatar_url: None,
            file: None,
            line: None,
            updated_at: String::new(),
            created_at: None,
            reply_to: None,
            review_state: None,
        }
    }

    #[test]
    fn identities_carry_the_kind_and_the_host_id() {
        assert_eq!(comment_identity(&comment(5, "inline")), "inline:5");
        assert_ne!(comment_identity(&comment(5, "issue")), "inline:5");
        assert_eq!(check_identity(&check("check:11")), "check:11");
    }

    #[test]
    fn a_moved_check_is_an_upsert() {
        let mut revisions = StatusRevisions::new();
        let changes = revisions.check_changes(&[check("check:1")], vec![check("check:2")]);
        assert_eq!(changes.upsert.len(), 1);
        assert_eq!(changes.removed.len(), 1);
    }
}

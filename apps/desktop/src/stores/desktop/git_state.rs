use super::{
    DESKTOP_DIFF_PREVIEW_LIMIT, ReviewFileProjection, ReviewProjection, WorktreeEntryProjection,
};
use ace_runtime::chat::ThreadSummary;

pub(super) fn parse_review_files(value: serde_json::Value) -> Vec<ReviewFileProjection> {
    value
        .as_array()
        .map(|files| {
            files
                .iter()
                .filter_map(|file| {
                    let path = file.get("path")?.as_str()?.to_string();
                    Some(ReviewFileProjection {
                        path,
                        original_path: file
                            .get("original_path")
                            .and_then(serde_json::Value::as_str)
                            .map(ToString::to_string),
                        status: file
                            .get("status")
                            .and_then(serde_json::Value::as_str)
                            .unwrap_or("unknown")
                            .to_string(),
                        additions: file
                            .get("additions")
                            .and_then(serde_json::Value::as_u64)
                            .and_then(|value| u32::try_from(value).ok()),
                        deletions: file
                            .get("deletions")
                            .and_then(serde_json::Value::as_u64)
                            .and_then(|value| u32::try_from(value).ok()),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

pub(super) fn parse_worktree_entries(
    value: serde_json::Value,
    repo_path: &str,
    active_worktree_path: Option<&str>,
) -> Vec<WorktreeEntryProjection> {
    value
        .as_array()
        .map(|entries| {
            entries
                .iter()
                .filter_map(|entry| {
                    let path = entry.get("path")?.as_str()?.to_string();
                    let primary = path == repo_path;
                    let active_thread =
                        active_worktree_path.map_or(primary, |active_path| active_path == path);
                    Some(WorktreeEntryProjection {
                        path,
                        branch: entry
                            .get("branch")
                            .and_then(serde_json::Value::as_str)
                            .map(ToString::to_string),
                        head: entry
                            .get("head")
                            .and_then(serde_json::Value::as_str)
                            .map(ToString::to_string),
                        detached: entry
                            .get("detached")
                            .and_then(serde_json::Value::as_bool)
                            .unwrap_or(false),
                        bare: entry
                            .get("bare")
                            .and_then(serde_json::Value::as_bool)
                            .unwrap_or(false),
                        active_thread,
                        primary,
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

pub(super) fn suggested_worktree_branch(thread: &ThreadSummary) -> String {
    let title = thread
        .title
        .split_whitespace()
        .take(6)
        .collect::<Vec<_>>()
        .join("-");
    let normalized = title
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '/') {
                ch.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect::<String>()
        .split('-')
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<_>>()
        .join("-");
    if normalized.is_empty() {
        format!("ace/{}", thread.id.0)
    } else {
        format!("ace/{normalized}")
    }
}

pub(super) fn truncate_diff_preview(diff: &str) -> (String, bool) {
    if diff.len() <= DESKTOP_DIFF_PREVIEW_LIMIT {
        return (diff.to_string(), false);
    }

    let mut end = DESKTOP_DIFF_PREVIEW_LIMIT;
    while !diff.is_char_boundary(end) {
        end -= 1;
    }
    (diff[..end].to_string(), true)
}

pub(super) fn generated_review_commit_message(review: &ReviewProjection) -> String {
    match review.files.as_slice() {
        [] => "Update project".to_string(),
        [file] => format!("Update {}", file.path),
        files => format!("Update {} files", files.len()),
    }
}

pub(super) fn review_file_summary(file: &ReviewFileProjection) -> String {
    let stat = match (file.additions, file.deletions) {
        (Some(additions), Some(deletions)) => format!("+{additions} -{deletions}"),
        _ => "diff stat unavailable".to_string(),
    };
    format!("{} · {} · {stat}", file.path, file.status)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ace_core::{ProjectId, ProviderKind, ThreadId};
    use ace_runtime::chat::ThreadStatus;

    #[test]
    fn review_file_parser_reads_git_changed_file_json() {
        let files = parse_review_files(serde_json::json!([
            {
                "path": "src/lib.rs",
                "original_path": null,
                "status": "modified",
                "additions": 3,
                "deletions": 1
            },
            {
                "path": "new.rs",
                "original_path": "old.rs",
                "status": "renamed",
                "additions": null,
                "deletions": null
            }
        ]));

        assert_eq!(files.len(), 2);
        assert_eq!(files[0].path, "src/lib.rs");
        assert_eq!(files[0].status, "modified");
        assert_eq!(files[0].additions, Some(3));
        assert_eq!(files[0].deletions, Some(1));
        assert_eq!(files[1].original_path.as_deref(), Some("old.rs"));
    }

    #[test]
    fn worktree_parser_marks_primary_and_active_entries() {
        let entries = parse_worktree_entries(
            serde_json::json!([
                {
                    "path": "/repo",
                    "branch": "main",
                    "head": "abc",
                    "detached": false,
                    "bare": false
                },
                {
                    "path": "/repo-worktrees/feature",
                    "branch": "feature/task",
                    "head": "def",
                    "detached": false,
                    "bare": false
                }
            ]),
            "/repo",
            Some("/repo-worktrees/feature"),
        );

        assert_eq!(entries.len(), 2);
        assert!(entries[0].primary);
        assert!(!entries[0].active_thread);
        assert!(!entries[1].primary);
        assert!(entries[1].active_thread);
        assert_eq!(entries[1].branch.as_deref(), Some("feature/task"));
    }

    #[test]
    fn suggested_worktree_branch_uses_thread_title() {
        let thread = ThreadSummary {
            id: ThreadId("thread-1".to_string()),
            provider_thread_id: None,
            project_id: ProjectId::new(),
            title: "Implement Worktree Manager!".to_string(),
            status: ThreadStatus::Idle,
            provider: ProviderKind::Codex,
            model: None,
            pinned: false,
            archived: false,
            pinned_item_count: 0,
            highlighted_count: 0,
            todo_count: 0,
            open_todo_count: 0,
            unseen_completion: false,
            latest_activity_at: "now".to_string(),
            latest_message_preview: None,
            pending_approvals: 0,
            pending_user_inputs: 0,
            has_actionable_plan: false,
            branch: Some("main".to_string()),
            worktree_path: None,
        };

        assert_eq!(
            suggested_worktree_branch(&thread),
            "ace/implement-worktree-manager"
        );
    }

    #[test]
    fn generated_review_commit_message_describes_changed_files() {
        let empty = ReviewProjection::default();
        assert_eq!(generated_review_commit_message(&empty), "Update project");

        let single = ReviewProjection {
            files: vec![ReviewFileProjection {
                path: "src/lib.rs".to_string(),
                original_path: None,
                status: "modified".to_string(),
                additions: Some(1),
                deletions: Some(0),
            }],
            ..ReviewProjection::default()
        };
        assert_eq!(
            generated_review_commit_message(&single),
            "Update src/lib.rs"
        );

        let many = ReviewProjection {
            files: vec![
                ReviewFileProjection {
                    path: "src/lib.rs".to_string(),
                    original_path: None,
                    status: "modified".to_string(),
                    additions: Some(1),
                    deletions: Some(0),
                },
                ReviewFileProjection {
                    path: "src/main.rs".to_string(),
                    original_path: None,
                    status: "modified".to_string(),
                    additions: Some(2),
                    deletions: Some(1),
                },
            ],
            ..ReviewProjection::default()
        };
        assert_eq!(generated_review_commit_message(&many), "Update 2 files");
    }

    #[test]
    fn diff_preview_truncates_on_utf8_boundary() {
        let diff = format!("{}é", "a".repeat(DESKTOP_DIFF_PREVIEW_LIMIT));
        let (preview, truncated) = truncate_diff_preview(&diff);

        assert!(truncated);
        assert!(preview.len() <= DESKTOP_DIFF_PREVIEW_LIMIT);
        assert!(std::str::from_utf8(preview.as_bytes()).is_ok());
    }
}

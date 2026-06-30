use super::{ReviewCommentItem, TodoAssignee, TodoItem, TodoPriority, TodoStatus};

pub(super) fn review_comment_detail(comment: &ReviewCommentItem) -> String {
    let status = if comment.resolved { "resolved" } else { "open" };
    match comment.line {
        Some(line) => format!("{status} · line {line} · {}", comment.body),
        None => format!("{status} · {}", comment.body),
    }
}

fn todo_status_label(status: TodoStatus) -> &'static str {
    match status {
        TodoStatus::Open => "open",
        TodoStatus::InProgress => "in progress",
        TodoStatus::Blocked => "blocked",
        TodoStatus::Done => "done",
        TodoStatus::Canceled => "canceled",
    }
}

fn todo_priority_label(priority: TodoPriority) -> &'static str {
    match priority {
        TodoPriority::Low => "low",
        TodoPriority::Normal => "normal",
        TodoPriority::High => "high",
    }
}

fn todo_assignee_label(assignee: TodoAssignee) -> &'static str {
    match assignee {
        TodoAssignee::User => "user",
        TodoAssignee::Agent => "agent",
        TodoAssignee::Both => "user and agent",
    }
}

pub(super) fn todo_context_line(todo: &TodoItem) -> String {
    let mut parts = vec![
        format!("[{}]", todo_status_label(todo.status)),
        format!("priority {}", todo_priority_label(todo.priority)),
        format!("assigned to {}", todo_assignee_label(todo.assigned_to)),
        todo.title.clone(),
    ];
    if !todo.related_files.is_empty() {
        parts.push(format!("files: {}", todo.related_files.join(", ")));
    }
    if !todo.related_diff_comments.is_empty() {
        parts.push(format!(
            "diff comments: {}",
            todo.related_diff_comments.join(", ")
        ));
    }
    parts.join(" · ")
}

pub(super) fn extend_unique(target: &mut Vec<String>, values: Vec<String>) {
    for value in values {
        if !target.contains(&value) {
            target.push(value);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ace_core::ThreadId;

    fn todo() -> TodoItem {
        TodoItem {
            id: "todo-1".to_string(),
            thread_id: ThreadId("thread-1".to_string()),
            source_message_id: None,
            title: "Follow up on review feedback".to_string(),
            description: None,
            status: TodoStatus::InProgress,
            priority: TodoPriority::High,
            created_by: super::super::TodoCreatedBy::User,
            assigned_to: TodoAssignee::Agent,
            created_at: "2026-01-01T00:00:00Z".to_string(),
            updated_at: "2026-01-01T00:00:00Z".to_string(),
            completed_at: None,
            related_files: vec!["apps/desktop/src/main.rs".to_string()],
            related_tool_events: Vec::new(),
            related_diff_comments: vec!["review-1".to_string()],
        }
    }

    #[test]
    fn todo_context_line_includes_status_priority_assignee_and_links() {
        assert_eq!(
            todo_context_line(&todo()),
            "[in progress] · priority high · assigned to agent · Follow up on review feedback · files: apps/desktop/src/main.rs · diff comments: review-1"
        );
    }

    #[test]
    fn review_comment_detail_includes_resolution_and_line_when_present() {
        let mut comment = ReviewCommentItem {
            id: "review-1".to_string(),
            thread_id: ThreadId("thread-1".to_string()),
            project_id: ace_core::ProjectId::new(),
            file_path: "src/lib.rs".to_string(),
            line: Some(42),
            body: "Tighten this error path.".to_string(),
            created_at: "2026-01-01T00:00:00Z".to_string(),
            updated_at: "2026-01-01T00:00:00Z".to_string(),
            resolved: false,
        };

        assert_eq!(
            review_comment_detail(&comment),
            "open · line 42 · Tighten this error path."
        );

        comment.resolved = true;
        comment.line = None;
        assert_eq!(
            review_comment_detail(&comment),
            "resolved · Tighten this error path."
        );
    }

    #[test]
    fn extend_unique_preserves_existing_order_and_appends_new_values() {
        let mut target = vec!["a".to_string(), "b".to_string()];

        extend_unique(
            &mut target,
            vec!["b".to_string(), "c".to_string(), "a".to_string()],
        );

        assert_eq!(target, vec!["a", "b", "c"]);
    }
}

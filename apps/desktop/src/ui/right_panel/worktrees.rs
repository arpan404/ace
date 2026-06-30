use crate::{
    actions::{CreateWorktree, RefreshWorktrees, RemoveWorktree},
    stores::{DesktopProjection, WorktreeEntryProjection, WorktreeProjection},
    ui::{components::*, theme::Theme},
};
use gpui::{AnyElement, IntoElement, div, prelude::*, px};
use gpui_component::{IconName, scroll::ScrollableElement as _};

use super::{clamp_text, empty_panel_body, info_row, registry_error_card, short_path};

pub(super) fn worktrees_body(theme: Theme, projection: &DesktopProjection) -> AnyElement {
    if projection.chat.active_thread.is_none() {
        return empty_panel_body(
            theme,
            AceIconName::Review,
            "Worktrees",
            "No active thread is selected.",
        );
    }

    let worktrees = &projection.worktrees;
    div()
        .size_full()
        .flex()
        .flex_col()
        .gap_3()
        .child(info_row(
            theme,
            "Repository",
            worktrees
                .repo_path
                .as_deref()
                .map(short_path)
                .unwrap_or_else(|| "No repository".to_string())
                .as_str(),
        ))
        .child(info_row(
            theme,
            "Worktrees",
            &worktrees.entries.len().to_string(),
        ))
        .when_some(worktrees.updated_at.as_deref(), |this, updated| {
            this.child(info_row(theme, "Updated", updated))
        })
        .when_some(worktrees.last_created_path.as_deref(), |this, path| {
            this.child(info_row(theme, "Created", &short_path(path)))
        })
        .child(worktree_actions(theme, worktrees))
        .when_some(worktrees.error.as_deref(), |this, error| {
            this.child(registry_error_card(theme, error))
        })
        .child(worktree_list(theme, worktrees))
        .into_any_element()
}

fn worktree_actions(theme: Theme, worktrees: &WorktreeProjection) -> AnyElement {
    div()
        .flex()
        .flex_row()
        .items_center()
        .gap_2()
        .child(action_button(IconName::Info, "Refresh", theme, || {
            Box::new(RefreshWorktrees)
        }))
        .when(worktrees.repo_path.is_some(), |this| {
            this.child(action_button(IconName::Plus, "Create", theme, || {
                Box::new(CreateWorktree)
            }))
        })
        .into_any_element()
}

fn worktree_list(theme: Theme, worktrees: &WorktreeProjection) -> AnyElement {
    if worktrees.entries.is_empty() {
        return div()
            .rounded_md()
            .border_1()
            .border_color(theme.border_subtle)
            .bg(theme.panel)
            .px_2()
            .py_2()
            .text_size(px(12.0))
            .text_color(theme.muted)
            .child("No worktrees loaded")
            .into_any_element();
    }

    div()
        .flex_1()
        .min_h_0()
        .flex()
        .flex_col()
        .gap_2()
        .children(
            worktrees
                .entries
                .iter()
                .map(|entry| worktree_entry_card(theme, entry))
                .collect::<Vec<_>>(),
        )
        .overflow_y_scrollbar()
        .into_any_element()
}

fn worktree_entry_card(theme: Theme, entry: &WorktreeEntryProjection) -> AnyElement {
    let status_color = if entry.active_thread {
        theme.accent_success
    } else if entry.detached || entry.bare {
        theme.accent_warning
    } else {
        theme.muted_subtle
    };
    let branch = entry_branch_label(entry);
    let badges = worktree_badges(entry);

    div()
        .rounded_md()
        .border_1()
        .border_color(theme.border_subtle)
        .bg(theme.panel)
        .p_2()
        .flex()
        .flex_col()
        .gap_2()
        .child(
            div()
                .flex()
                .flex_row()
                .items_center()
                .gap_2()
                .text_size(px(12.0))
                .text_color(theme.foreground.opacity(0.84))
                .child(div().w(px(6.0)).h(px(6.0)).rounded_full().bg(status_color))
                .child(icon_svg(IconName::FolderOpen, theme.muted))
                .child(clamp_text(branch, 120)),
        )
        .child(
            div()
                .text_size(px(11.0))
                .line_height(px(16.0))
                .text_color(theme.muted)
                .child(short_path(&entry.path)),
        )
        .when(!badges.is_empty(), |this| {
            this.child(
                div()
                    .text_size(px(11.0))
                    .text_color(theme.muted_subtle)
                    .child(badges.join(" · ")),
            )
        })
        .when(!entry.primary, |this| {
            let path = entry.path.clone();
            this.child(action_button(
                IconName::Delete,
                "Remove",
                theme,
                move || {
                    Box::new(RemoveWorktree {
                        path: path.clone(),
                        force: false,
                    })
                },
            ))
        })
        .into_any_element()
}

fn entry_branch_label(entry: &WorktreeEntryProjection) -> &str {
    entry
        .branch
        .as_deref()
        .or(entry.head.as_deref())
        .unwrap_or("detached")
}

fn worktree_badges(entry: &WorktreeEntryProjection) -> Vec<&'static str> {
    let mut badges = Vec::new();
    if entry.primary {
        badges.push("primary");
    }
    if entry.active_thread {
        badges.push("active");
    }
    if entry.bare {
        badges.push("bare");
    } else if entry.detached {
        badges.push("detached");
    }
    badges
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn worktree_badges_prioritize_primary_active_and_git_state() {
        let entry = WorktreeEntryProjection {
            path: "/tmp/project".to_string(),
            branch: Some("feature".to_string()),
            head: Some("abc123".to_string()),
            primary: true,
            bare: false,
            detached: true,
            active_thread: true,
        };

        assert_eq!(entry_branch_label(&entry), "feature");
        assert_eq!(
            worktree_badges(&entry),
            vec!["primary", "active", "detached"]
        );
    }

    #[test]
    fn worktree_branch_label_falls_back_to_head_then_detached() {
        let with_head = WorktreeEntryProjection {
            path: "/tmp/project".to_string(),
            branch: None,
            head: Some("abc123".to_string()),
            primary: false,
            bare: false,
            detached: false,
            active_thread: false,
        };
        let detached = WorktreeEntryProjection {
            head: None,
            detached: true,
            ..with_head.clone()
        };

        assert_eq!(entry_branch_label(&with_head), "abc123");
        assert_eq!(entry_branch_label(&detached), "detached");
    }
}

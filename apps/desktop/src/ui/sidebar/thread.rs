use crate::{
    stores::ui::RightPanelTab,
    ui::{components::*, theme::Theme},
};
use ace_runtime::chat::{ThreadStatus, ThreadSummary};
use gpui::{AnyElement, IntoElement, MouseButton, div, prelude::*, px};
use gpui_component::{IconName, tooltip::Tooltip};

pub(super) fn thread_row(
    theme: Theme,
    project_name: &str,
    thread: ThreadSummary,
    active: bool,
) -> AnyElement {
    let id = thread.id.clone();
    let pin_thread_id = thread.id.clone();
    let archive_thread_id = thread.id.clone();
    let tooltip_thread = thread.clone();
    let tooltip_project_name = project_name.to_string();
    div()
        .id("thread-row")
        .h(px(28.0))
        .rounded_lg()
        .pl_2()
        .pr_2()
        .bg(if active {
            theme.selection
        } else {
            theme.sidebar
        })
        .hover(|this| this.bg(theme.button))
        .flex()
        .flex_row()
        .items_center()
        .gap_1()
        .child(
            div()
                .id("thread-row-open-area")
                .flex_1()
                .min_w_0()
                .flex()
                .flex_row()
                .items_center()
                .gap_1()
                .child(thread_status_icon(&thread, theme))
                .when(thread.pinned, |this| {
                    this.child(ace_icon_svg(
                        AceIconName::PinFilled,
                        if active {
                            theme.foreground
                        } else {
                            theme.muted_subtle
                        },
                    ))
                })
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .overflow_hidden()
                        .text_ellipsis()
                        .whitespace_nowrap()
                        .text_size(px(12.0))
                        .text_color(if active {
                            theme.foreground
                        } else {
                            theme.foreground.opacity(0.72)
                        })
                        .child(thread.title.clone()),
                )
                .children(thread_annotation_badges(theme, &thread))
                .tooltip(move |window, cx| {
                    Tooltip::new(thread_hover_tooltip(&tooltip_project_name, &tooltip_thread))
                        .build(window, cx)
                })
                .on_mouse_up(MouseButton::Left, move |_, window, cx| {
                    window.dispatch_action(
                        Box::new(crate::actions::OpenThread {
                            thread_id: id.clone(),
                        }),
                        cx,
                    );
                }),
        )
        .child(thread_row_icon_button(
            theme,
            AceIconName::PinFilled,
            if thread.pinned {
                "Unpin thread"
            } else {
                "Pin thread"
            },
            move || {
                Box::new(crate::actions::TogglePinThread {
                    thread_id: pin_thread_id.clone(),
                })
            },
        ))
        .child(thread_row_lucide_button(
            theme,
            IconName::CircleX,
            "Archive thread",
            move || {
                Box::new(crate::actions::ArchiveThread {
                    thread_id: archive_thread_id.clone(),
                })
            },
        ))
        .into_any_element()
}

fn thread_row_icon_button<F>(
    theme: Theme,
    icon: AceIconName,
    tooltip: &'static str,
    action: F,
) -> AnyElement
where
    F: Fn() -> Box<dyn gpui::Action> + 'static,
{
    div()
        .id(tooltip)
        .w(px(22.0))
        .h(px(22.0))
        .rounded_md()
        .flex()
        .items_center()
        .justify_center()
        .text_color(theme.muted_subtle)
        .hover(|this| this.bg(theme.button_hover).text_color(theme.foreground))
        .child(ace_icon_svg(icon, theme.muted_subtle))
        .tooltip(move |window, cx| Tooltip::new(tooltip).build(window, cx))
        .on_mouse_up(MouseButton::Left, move |_, window, cx| {
            window.dispatch_action(action(), cx);
        })
        .into_any_element()
}

fn thread_row_lucide_button<F>(
    theme: Theme,
    icon: IconName,
    tooltip: &'static str,
    action: F,
) -> AnyElement
where
    F: Fn() -> Box<dyn gpui::Action> + 'static,
{
    div()
        .id(tooltip)
        .w(px(22.0))
        .h(px(22.0))
        .rounded_md()
        .flex()
        .items_center()
        .justify_center()
        .text_color(theme.muted_subtle)
        .hover(|this| this.bg(theme.button_hover).text_color(theme.foreground))
        .child(icon_svg(icon, theme.muted_subtle))
        .tooltip(move |window, cx| Tooltip::new(tooltip).build(window, cx))
        .on_mouse_up(MouseButton::Left, move |_, window, cx| {
            window.dispatch_action(action(), cx);
        })
        .into_any_element()
}

fn thread_hover_tooltip(project_name: &str, thread: &ThreadSummary) -> String {
    let mut lines = vec![
        thread.title.clone(),
        format!(
            "{} · {} · {}",
            thread_status_label(thread.status),
            thread.provider.display_name(),
            thread.model.as_deref().unwrap_or("Default model")
        ),
        format!("Updated: {}", thread.latest_activity_at),
        format!("Project: {project_name}"),
    ];

    if let Some(branch) = thread.branch.as_deref().filter(|branch| !branch.is_empty()) {
        lines.push(format!("Branch: {branch}"));
    }
    if let Some(worktree) = thread
        .worktree_path
        .as_deref()
        .filter(|worktree| !worktree.is_empty())
    {
        lines.push(format!("Worktree: {worktree}"));
    }
    if thread.open_todo_count > 0 {
        lines.push(format!("Open todos: {}", thread.open_todo_count));
    } else if thread.todo_count > 0 {
        lines.push(format!("Todos: {} completed", thread.todo_count));
    }
    if thread.pending_approvals > 0 {
        lines.push(format!("Pending approvals: {}", thread.pending_approvals));
    }
    if thread.pending_user_inputs > 0 {
        lines.push(format!("Waiting for input: {}", thread.pending_user_inputs));
    }
    if thread.has_actionable_plan {
        lines.push("Plan ready for implementation".to_string());
    }
    if thread.unseen_completion {
        lines.push("Unseen completion".to_string());
    }
    if thread.pinned_item_count > 0 {
        lines.push(format!("Pinned items: {}", thread.pinned_item_count));
    }
    if thread.highlighted_count > 0 {
        lines.push(format!("Highlights: {}", thread.highlighted_count));
    }
    if let Some(preview) = thread
        .latest_message_preview
        .as_deref()
        .filter(|preview| !preview.is_empty())
    {
        lines.push(preview.to_string());
    }

    lines.join("\n")
}

fn thread_status_label(status: ThreadStatus) -> &'static str {
    match status {
        ThreadStatus::Draft => "Draft",
        ThreadStatus::Idle => "Idle",
        ThreadStatus::Working => "Working",
        ThreadStatus::PendingApproval => "Needs approval",
        ThreadStatus::AwaitingInput => "Awaiting input",
        ThreadStatus::PlanReady => "Plan ready",
        ThreadStatus::Completed => "Complete",
        ThreadStatus::Error => "Failed",
        ThreadStatus::Archived => "Archived",
        ThreadStatus::Connecting => "Connecting",
    }
}

fn thread_annotation_badges(theme: Theme, thread: &ThreadSummary) -> Vec<AnyElement> {
    let mut badges = Vec::new();
    if thread.pinned_item_count > 0 {
        let thread_id = thread.id.clone();
        badges.push(thread_action_count_badge(
            theme,
            AceIconName::PinFilled,
            thread.pinned_item_count,
            "Show pinned messages",
            move || {
                Box::new(crate::actions::OpenThreadRightPanelTab {
                    thread_id: thread_id.clone(),
                    tab: RightPanelTab::Pinned,
                })
            },
        ));
    }
    if thread.highlighted_count > 0 {
        badges.push(thread_count_badge(
            theme,
            AceIconName::Summary,
            thread.highlighted_count,
            "Highlighted timeline items",
        ));
    }
    if thread.open_todo_count > 0 {
        let thread_id = thread.id.clone();
        badges.push(thread_action_count_badge(
            theme,
            AceIconName::ListChecks,
            thread.open_todo_count,
            "Show todos",
            move || {
                Box::new(crate::actions::OpenThreadRightPanelTab {
                    thread_id: thread_id.clone(),
                    tab: RightPanelTab::Todos,
                })
            },
        ));
    } else if thread.todo_count > 0 {
        let thread_id = thread.id.clone();
        badges.push(thread_action_count_badge(
            theme,
            AceIconName::ListChecks,
            thread.todo_count,
            "Show todos",
            move || {
                Box::new(crate::actions::OpenThreadRightPanelTab {
                    thread_id: thread_id.clone(),
                    tab: RightPanelTab::Todos,
                })
            },
        ));
    }
    badges
}

fn thread_count_badge(
    theme: Theme,
    icon: AceIconName,
    count: usize,
    tooltip: &'static str,
) -> AnyElement {
    div()
        .id(tooltip)
        .h(px(18.0))
        .min_w(px(22.0))
        .rounded_md()
        .border_1()
        .border_color(theme.border_subtle)
        .bg(theme.panel_deep)
        .px_1()
        .flex()
        .flex_row()
        .items_center()
        .justify_center()
        .gap_1()
        .text_size(px(10.0))
        .text_color(theme.muted)
        .child(ace_icon_svg(icon, theme.muted_subtle))
        .child(count.to_string())
        .tooltip(move |window, cx| Tooltip::new(tooltip).build(window, cx))
        .into_any_element()
}

fn thread_action_count_badge<F>(
    theme: Theme,
    icon: AceIconName,
    count: usize,
    tooltip: &'static str,
    action: F,
) -> AnyElement
where
    F: Fn() -> Box<dyn gpui::Action> + 'static,
{
    div()
        .id(tooltip)
        .h(px(18.0))
        .min_w(px(22.0))
        .rounded_md()
        .border_1()
        .border_color(theme.border_subtle)
        .bg(theme.panel_deep)
        .px_1()
        .flex()
        .flex_row()
        .items_center()
        .justify_center()
        .gap_1()
        .text_size(px(10.0))
        .text_color(theme.muted)
        .hover(|this| this.bg(theme.button_hover).text_color(theme.foreground))
        .child(ace_icon_svg(icon, theme.muted_subtle))
        .child(count.to_string())
        .tooltip(move |window, cx| Tooltip::new(tooltip).build(window, cx))
        .on_mouse_up(MouseButton::Left, move |_, window, cx| {
            window.dispatch_action(action(), cx);
        })
        .into_any_element()
}

pub(super) fn thread_paging_row(
    theme: Theme,
    project_id: ace_core::ProjectId,
    more_count: usize,
    can_show_less: bool,
) -> AnyElement {
    div()
        .pl(px(38.0))
        .flex()
        .flex_row()
        .gap_2()
        .when(more_count > 0, |this| {
            this.child(thread_paging_button(
                theme,
                format!("Show {more_count} more"),
                move || Box::new(crate::actions::ShowMoreProjectThreads { project_id }),
            ))
        })
        .when(can_show_less, |this| {
            this.child(thread_paging_button(
                theme,
                "Show less".to_string(),
                move || Box::new(crate::actions::ShowLessProjectThreads { project_id }),
            ))
        })
        .into_any_element()
}

fn thread_status_icon(thread: &ThreadSummary, theme: Theme) -> AnyElement {
    let color = match thread.status {
        ThreadStatus::Error => theme.accent_danger,
        ThreadStatus::Completed => theme.accent_success,
        ThreadStatus::PendingApproval | ThreadStatus::AwaitingInput => theme.accent_warning,
        ThreadStatus::PlanReady => theme.accent_pink,
        ThreadStatus::Working | ThreadStatus::Connecting => theme.accent_blue,
        ThreadStatus::Draft | ThreadStatus::Idle | ThreadStatus::Archived => theme.muted_subtle,
    };
    let icon = match thread.status {
        ThreadStatus::Error => IconName::TriangleAlert,
        ThreadStatus::Completed => IconName::CircleCheck,
        ThreadStatus::PendingApproval | ThreadStatus::AwaitingInput => IconName::Info,
        ThreadStatus::PlanReady => IconName::Star,
        ThreadStatus::Working | ThreadStatus::Connecting => IconName::LoaderCircle,
        ThreadStatus::Draft | ThreadStatus::Idle | ThreadStatus::Archived => IconName::CircleUser,
    };
    div()
        .w(px(16.0))
        .h(px(16.0))
        .flex()
        .items_center()
        .justify_center()
        .child(icon_svg(icon, color))
        .into_any_element()
}

fn thread_paging_button<F>(theme: Theme, label: String, action: F) -> AnyElement
where
    F: Fn() -> Box<dyn gpui::Action> + 'static,
{
    div()
        .h(px(28.0))
        .rounded_md()
        .px_2()
        .text_size(px(11.0))
        .text_color(theme.muted_subtle)
        .hover(|this| this.bg(theme.button).text_color(theme.foreground))
        .flex()
        .items_center()
        .child(label)
        .on_mouse_up(MouseButton::Left, move |_, window, cx| {
            window.dispatch_action(action(), cx);
        })
        .into_any_element()
}

#[cfg(test)]
mod tests {
    use super::*;
    use ace_core::{ProjectId, ProviderKind, ThreadId};

    #[test]
    fn thread_hover_tooltip_uses_backed_thread_metadata() {
        let thread = ThreadSummary {
            id: ThreadId::new(),
            provider_thread_id: Some("provider-thread-1".to_string()),
            project_id: ProjectId::new(),
            title: "Fix sidebar metadata".to_string(),
            status: ThreadStatus::PendingApproval,
            provider: ProviderKind::Codex,
            model: Some("gpt-5.3-codex".to_string()),
            pinned: true,
            archived: false,
            pinned_item_count: 2,
            highlighted_count: 1,
            todo_count: 3,
            open_todo_count: 1,
            unseen_completion: true,
            latest_activity_at: "2026-06-30T10:00:00Z".to_string(),
            latest_message_preview: Some("Updated provider/model badges".to_string()),
            pending_approvals: 1,
            pending_user_inputs: 2,
            has_actionable_plan: true,
            branch: Some("feature/sidebar".to_string()),
            worktree_path: Some("/repo-worktrees/sidebar".to_string()),
        };

        let tooltip = thread_hover_tooltip("ace", &thread);

        assert!(tooltip.contains("Fix sidebar metadata"));
        assert!(tooltip.contains("Project: ace"));
        assert!(tooltip.contains("Branch: feature/sidebar"));
        assert!(tooltip.contains("Worktree: /repo-worktrees/sidebar"));
        assert!(tooltip.contains("Pending approvals: 1"));
        assert!(tooltip.contains("Waiting for input: 2"));
        assert!(tooltip.contains("Plan ready for implementation"));
        assert!(tooltip.contains("Unseen completion"));
        assert!(tooltip.contains("Updated provider/model badges"));
    }
}

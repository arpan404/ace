use crate::{
    actions::{
        CreateTodoFromLatestTimelineItem, PinLatestTimelineItem, RefreshReview,
        SelectBottomPanelTab, SelectRightPanelTab, StageReviewAll, ToggleBottomPanel,
        ToggleFirstOpenTodo, ToggleHighlightLatestTimelineItem, ToggleRightPanel, UnstageReviewAll,
    },
    stores::{
        DesktopProjection, ReviewFileProjection, ReviewProjection, ServiceReadiness, ServiceStatus,
        TodoStatus,
        ui::{BottomPanelTab, RightPanelTab},
    },
    ui::{components::*, layout::PanelLayout, theme::Theme},
};
use ace_protocol::terminal::TerminalSessionStatus;
use ace_runtime::chat::{ChatProjection, ThreadSummary};
use gpui::{
    AnyElement, IntoElement, MouseButton, StatefulInteractiveElement as _, div, prelude::*, px,
};
use gpui_component::{IconName, scroll::ScrollableElement as _, tooltip::Tooltip};

pub(super) fn right_panel(
    theme: Theme,
    layout: PanelLayout,
    active_tab: RightPanelTab,
    bottom_panel_visible: bool,
    resizing: bool,
    projection: DesktopProjection,
) -> AnyElement {
    div()
        .id("ace-right-panel")
        .w(layout.right_panel_width)
        .h_full()
        .bg(theme.background)
        .border_l_1()
        .border_color(if resizing {
            theme.foreground.opacity(0.72)
        } else {
            theme.border_subtle
        })
        .flex()
        .flex_col()
        .child(workbench_panel(
            theme,
            active_tab,
            bottom_panel_visible,
            &projection,
        ))
        .into_any_element()
}

pub(super) fn bottom_panel(
    theme: Theme,
    layout: PanelLayout,
    active_tab: BottomPanelTab,
    resizing: bool,
    projection: DesktopProjection,
) -> AnyElement {
    div()
        .id("ace-bottom-panel")
        .h(layout.bottom_panel_height)
        .border_t_1()
        .border_color(if resizing {
            theme.foreground.opacity(0.72)
        } else {
            theme.border_subtle
        })
        .bg(theme.panel_deep)
        .flex()
        .flex_col()
        .child(
            div()
                .h(px(48.0))
                .px_3()
                .border_b_1()
                .border_color(theme.border_subtle)
                .flex()
                .flex_row()
                .items_center()
                .gap_2()
                .child(bottom_tab(theme, active_tab, BottomPanelTab::Terminal))
                .child(div().flex_1()),
        )
        .child(terminal_body(theme, &projection))
        .into_any_element()
}

pub(super) fn environment_card(theme: Theme, thread: Option<&ThreadSummary>) -> AnyElement {
    let status = thread
        .map(ThreadSummary::status_label)
        .unwrap_or("No thread");
    let provider = thread
        .map(|thread| thread.provider.display_name())
        .unwrap_or("Codex");
    let model = thread
        .and_then(|thread| thread.model.as_deref())
        .unwrap_or("gpt-5.3-codex");
    let branch = thread
        .and_then(|thread| thread.branch.as_deref())
        .unwrap_or("No branch");
    let location = thread
        .and_then(|thread| thread.worktree_path.as_deref())
        .map(short_path)
        .unwrap_or_else(|| "Local workspace".to_string());

    div()
        .rounded_lg()
        .border_1()
        .border_color(theme.border)
        .bg(theme.background_elevated)
        .p_3()
        .flex()
        .flex_col()
        .gap_3()
        .child(
            div()
                .flex()
                .flex_row()
                .items_center()
                .justify_between()
                .child(
                    div()
                        .flex()
                        .flex_row()
                        .items_center()
                        .gap_2()
                        .text_size(px(13.0))
                        .text_color(theme.muted)
                        .child(ace_icon_svg(AceIconName::Environment, theme.muted))
                        .child("Environment"),
                )
                .child(
                    div()
                        .text_size(px(12.0))
                        .text_color(theme.foreground.opacity(0.70))
                        .child(status),
                ),
        )
        .child(environment_row(
            theme,
            IconName::Bot,
            "Provider",
            provider.to_string(),
            theme.foreground.opacity(0.84),
        ))
        .child(environment_row(
            theme,
            IconName::FolderOpen,
            "Branch",
            branch.to_string(),
            theme.foreground.opacity(0.78),
        ))
        .child(environment_row(
            theme,
            IconName::SquareTerminal,
            "Runtime",
            location,
            theme.foreground.opacity(0.78),
        ))
        .child(environment_row(
            theme,
            IconName::Settings2,
            "Model",
            model.to_string(),
            theme.muted,
        ))
        .into_any_element()
}

fn workbench_panel(
    theme: Theme,
    active_tab: RightPanelTab,
    bottom_panel_visible: bool,
    projection: &DesktopProjection,
) -> AnyElement {
    let services = &projection.services;
    div()
        .flex_1()
        .min_h_0()
        .bg(theme.background)
        .flex()
        .flex_col()
        .child(
            div()
                .h(px(48.0))
                .px_3()
                .border_b_1()
                .border_color(theme.border_subtle)
                .flex()
                .flex_row()
                .items_center()
                .gap_1()
                .child(right_tab(
                    theme,
                    active_tab,
                    RightPanelTab::Review,
                    &services.diff_review,
                ))
                .child(right_tab(
                    theme,
                    active_tab,
                    RightPanelTab::Browser,
                    &services.browser,
                ))
                .child(right_tab(
                    theme,
                    active_tab,
                    RightPanelTab::Editor,
                    &services.editor,
                ))
                .child(right_tab(
                    theme,
                    active_tab,
                    RightPanelTab::Summary,
                    &services.summary,
                ))
                .child(right_tab(
                    theme,
                    active_tab,
                    RightPanelTab::Pinned,
                    &services.summary,
                ))
                .child(right_tab(
                    theme,
                    active_tab,
                    RightPanelTab::Todos,
                    &services.summary,
                ))
                .child(div().flex_1())
                .child(ace_icon_toggle_button(
                    if bottom_panel_visible {
                        AceIconName::PanelBottomOpen
                    } else {
                        AceIconName::PanelBottomClosed
                    },
                    bottom_panel_visible,
                    theme,
                    "Toggle bottom panel",
                    ToggleBottomPanel,
                    || Box::new(ToggleBottomPanel),
                ))
                .child(ace_icon_toggle_button(
                    AceIconName::PanelRightOpen,
                    true,
                    theme,
                    "Toggle right panel",
                    ToggleRightPanel,
                    || Box::new(ToggleRightPanel),
                )),
        )
        .child(div().flex_1().min_h_0().p_3().child(match active_tab {
            RightPanelTab::Review => service_panel_body(
                theme,
                &services.diff_review,
                AceIconName::Review,
                "Review",
                || review_body(theme, &projection.chat, services, &projection.review),
            ),
            RightPanelTab::Browser => service_panel_body(
                theme,
                &services.browser,
                AceIconName::Browser,
                "Browser",
                || {
                    empty_panel_body(
                        theme,
                        AceIconName::Browser,
                        "Browser",
                        "No browser session is attached to this thread.",
                    )
                },
            ),
            RightPanelTab::Editor => service_panel_body(
                theme,
                &services.editor,
                AceIconName::Editor,
                "Editor",
                || {
                    empty_panel_body(
                        theme,
                        AceIconName::Editor,
                        "Editor",
                        "No editor buffer is attached to this thread.",
                    )
                },
            ),
            RightPanelTab::Summary => service_panel_body(
                theme,
                &services.summary,
                AceIconName::Summary,
                "Summary",
                || summary_body(theme, projection),
            ),
            RightPanelTab::Pinned => service_panel_body(
                theme,
                &services.summary,
                AceIconName::PinFilled,
                "Pinned",
                || pinned_body(theme, projection),
            ),
            RightPanelTab::Todos => service_panel_body(
                theme,
                &services.summary,
                AceIconName::ListChecks,
                "Todos",
                || todos_body(theme, projection),
            ),
        }))
        .into_any_element()
}

fn right_tab(
    theme: Theme,
    active: RightPanelTab,
    tab: RightPanelTab,
    status: &ServiceStatus,
) -> AnyElement {
    let selected = active == tab;
    let (icon, label) = right_tab_meta(tab);
    let enabled = status.is_ready();
    let reason = status.missing_reason();
    let color = if selected && enabled {
        theme.foreground.opacity(0.84)
    } else if enabled {
        theme.muted
    } else {
        theme.muted_subtle.opacity(0.56)
    };

    div()
        .id(right_tab_id(tab))
        .h(px(30.0))
        .rounded_lg()
        .px_2()
        .flex()
        .flex_row()
        .items_center()
        .gap_2()
        .bg(if selected && enabled {
            theme.button
        } else {
            theme.panel_deep.opacity(0.0)
        })
        .text_size(px(12.0))
        .text_color(color)
        .when(enabled, |this| this.hover(|this| this.bg(theme.button)))
        .child(header_ace_icon_svg(icon, color))
        .child(label)
        .when_some(reason, |this, reason| {
            this.tooltip(move |window, cx| Tooltip::new(reason).build(window, cx))
        })
        .when(enabled, |this| {
            this.on_mouse_up(MouseButton::Left, move |_, window, cx| {
                window.dispatch_action(Box::new(SelectRightPanelTab { tab }), cx);
            })
        })
        .into_any_element()
}

fn bottom_tab(theme: Theme, active: BottomPanelTab, tab: BottomPanelTab) -> AnyElement {
    let selected = active == tab;
    div()
        .h(px(30.0))
        .rounded_md()
        .px_2()
        .flex()
        .flex_row()
        .items_center()
        .gap_2()
        .bg(if selected {
            theme.button
        } else {
            theme.panel_deep.opacity(0.0)
        })
        .text_size(px(12.0))
        .text_color(if selected {
            theme.foreground.opacity(0.84)
        } else {
            theme.muted
        })
        .hover(|this| this.bg(theme.button))
        .child(header_ace_icon_svg(
            AceIconName::Terminal,
            if selected {
                theme.foreground.opacity(0.84)
            } else {
                theme.muted
            },
        ))
        .child("Terminal")
        .on_mouse_up(MouseButton::Left, move |_, window, cx| {
            window.dispatch_action(Box::new(SelectBottomPanelTab { tab }), cx);
        })
        .into_any_element()
}

fn right_tab_meta(tab: RightPanelTab) -> (AceIconName, &'static str) {
    match tab {
        RightPanelTab::Review => (AceIconName::Review, "Review"),
        RightPanelTab::Browser => (AceIconName::Browser, "Browser"),
        RightPanelTab::Editor => (AceIconName::Editor, "Editor"),
        RightPanelTab::Summary => (AceIconName::Summary, "Summary"),
        RightPanelTab::Pinned => (AceIconName::PinFilled, "Pinned"),
        RightPanelTab::Todos => (AceIconName::ListChecks, "Todos"),
    }
}

fn right_tab_id(tab: RightPanelTab) -> &'static str {
    match tab {
        RightPanelTab::Review => "right-tab-review",
        RightPanelTab::Browser => "right-tab-browser",
        RightPanelTab::Editor => "right-tab-editor",
        RightPanelTab::Summary => "right-tab-summary",
        RightPanelTab::Pinned => "right-tab-pinned",
        RightPanelTab::Todos => "right-tab-todos",
    }
}

fn service_panel_body<F>(
    theme: Theme,
    status: &ServiceStatus,
    icon: AceIconName,
    label: &'static str,
    ready: F,
) -> AnyElement
where
    F: FnOnce() -> AnyElement,
{
    if let Some(reason) = status.missing_reason() {
        return empty_panel_body(theme, icon, label, reason);
    }

    ready()
}

fn review_body(
    theme: Theme,
    chat: &ChatProjection,
    services: &ServiceReadiness,
    review: &ReviewProjection,
) -> AnyElement {
    let Some(thread) = chat.active_thread.as_ref() else {
        return empty_panel_body(
            theme,
            AceIconName::Review,
            "Review",
            "No active thread is selected.",
        );
    };

    let changed_count = review.files.len();
    div()
        .flex()
        .flex_col()
        .gap_3()
        .child(info_row(theme, "Status", thread.status_label()))
        .child(info_row(
            theme,
            "Git service",
            if services.diff_review.is_ready() {
                "Available"
            } else {
                "Unavailable"
            },
        ))
        .child(info_row(theme, "Changed files", &changed_count.to_string()))
        .child(info_row(
            theme,
            "Diff",
            if review.diff_truncated {
                "Preview truncated"
            } else if review.diff_preview.is_empty() {
                "No unstaged diff"
            } else {
                "Loaded"
            },
        ))
        .child(review_actions(theme, review))
        .when_some(review.error.as_deref(), |this, error| {
            this.child(
                div()
                    .rounded_md()
                    .border_1()
                    .border_color(theme.accent_danger.opacity(0.45))
                    .bg(theme.panel)
                    .px_2()
                    .py_2()
                    .text_size(px(12.0))
                    .text_color(theme.accent_danger)
                    .child(error.to_string()),
            )
        })
        .child(review_file_list(theme, review))
        .child(review_diff_preview(theme, review))
        .child(info_row(
            theme,
            "Pending approvals",
            &thread.pending_approvals.to_string(),
        ))
        .child(info_row(
            theme,
            "Pending input",
            &thread.pending_user_inputs.to_string(),
        ))
        .child(info_row(
            theme,
            "Actionable plan",
            if thread.has_actionable_plan {
                "Yes"
            } else {
                "No"
            },
        ))
        .into_any_element()
}

fn review_actions(theme: Theme, review: &ReviewProjection) -> AnyElement {
    div()
        .flex()
        .flex_row()
        .items_center()
        .gap_2()
        .child(action_button(IconName::Info, "Refresh", theme, || {
            Box::new(RefreshReview)
        }))
        .when(review.repo_path.is_some(), |this| {
            this.child(action_button(IconName::Plus, "Stage all", theme, || {
                Box::new(StageReviewAll)
            }))
            .child(action_button(IconName::Check, "Unstage all", theme, || {
                Box::new(UnstageReviewAll)
            }))
        })
        .into_any_element()
}

fn review_file_list(theme: Theme, review: &ReviewProjection) -> AnyElement {
    if review.files.is_empty() {
        return div()
            .rounded_md()
            .border_1()
            .border_color(theme.border_subtle)
            .bg(theme.panel)
            .px_2()
            .py_2()
            .text_size(px(12.0))
            .text_color(theme.muted)
            .child("No changed files")
            .into_any_element();
    }

    div()
        .rounded_md()
        .border_1()
        .border_color(theme.border_subtle)
        .bg(theme.panel)
        .p_2()
        .flex()
        .flex_col()
        .gap_1()
        .children(
            review
                .files
                .iter()
                .take(24)
                .map(|file| review_file_row(theme, file))
                .collect::<Vec<_>>(),
        )
        .when(review.files.len() > 24, |this| {
            this.child(
                div()
                    .pt_1()
                    .text_size(px(11.0))
                    .text_color(theme.muted_subtle)
                    .child(format!("{} more files", review.files.len() - 24)),
            )
        })
        .into_any_element()
}

fn review_file_row(theme: Theme, file: &ReviewFileProjection) -> AnyElement {
    let additions = file
        .additions
        .map(|value| format!("+{value}"))
        .unwrap_or_else(|| "+?".to_string());
    let deletions = file
        .deletions
        .map(|value| format!("-{value}"))
        .unwrap_or_else(|| "-?".to_string());

    div()
        .min_h(px(24.0))
        .flex()
        .flex_row()
        .items_center()
        .gap_2()
        .text_size(px(12.0))
        .child(
            div()
                .w(px(72.0))
                .text_color(theme.muted_subtle)
                .child(file.status.clone()),
        )
        .child(
            div()
                .flex_1()
                .min_w_0()
                .overflow_hidden()
                .text_ellipsis()
                .whitespace_nowrap()
                .text_color(theme.foreground.opacity(0.82))
                .child(file.path.clone()),
        )
        .child(div().text_color(theme.accent_success).child(additions))
        .child(div().text_color(theme.accent_danger).child(deletions))
        .into_any_element()
}

fn review_diff_preview(theme: Theme, review: &ReviewProjection) -> AnyElement {
    if review.diff_preview.is_empty() {
        return div().into_any_element();
    }

    div()
        .max_h(px(260.0))
        .rounded_md()
        .border_1()
        .border_color(theme.border_subtle)
        .bg(theme.panel_deep)
        .p_2()
        .font_family("Menlo")
        .text_size(px(11.0))
        .line_height(px(16.0))
        .text_color(theme.foreground.opacity(0.78))
        .children(
            review
                .diff_preview
                .lines()
                .take(220)
                .map(|line| {
                    let color = if line.starts_with('+') && !line.starts_with("+++") {
                        theme.accent_success
                    } else if line.starts_with('-') && !line.starts_with("---") {
                        theme.accent_danger
                    } else {
                        theme.foreground.opacity(0.78)
                    };
                    div()
                        .min_h(px(16.0))
                        .text_color(color)
                        .child(line.to_string())
                })
                .collect::<Vec<_>>(),
        )
        .when(review.diff_truncated, |this| {
            this.child(
                div()
                    .pt_2()
                    .font_family(theme.font_family)
                    .text_size(px(11.0))
                    .text_color(theme.muted_subtle)
                    .child("Diff preview truncated"),
            )
        })
        .overflow_y_scrollbar()
        .into_any_element()
}

fn summary_body(theme: Theme, projection: &DesktopProjection) -> AnyElement {
    let chat = &projection.chat;
    let Some(thread) = chat.active_thread.as_ref() else {
        return empty_panel_body(
            theme,
            AceIconName::Summary,
            "Summary",
            "No active thread is selected.",
        );
    };

    div()
        .flex()
        .flex_col()
        .gap_3()
        .child(info_row(theme, "Title", &thread.title))
        .child(info_row(theme, "Status", thread.status_label()))
        .child(info_row(theme, "Provider", thread.provider.display_name()))
        .child(info_row(
            theme,
            "Model",
            thread.model.as_deref().unwrap_or("No model selected"),
        ))
        .child(info_row(
            theme,
            "Latest activity",
            thread.latest_activity_at.as_str(),
        ))
        .child(info_row(
            theme,
            "Messages",
            &chat.messages.len().to_string(),
        ))
        .child(info_row(
            theme,
            "Changed files",
            &projection.review.files.len().to_string(),
        ))
        .child(info_row(
            theme,
            "Diff stat",
            &format!(
                "+{} -{}",
                projection.review.total_additions, projection.review.total_deletions
            ),
        ))
        .child(info_row(
            theme,
            "Terminal",
            terminal_summary_label(projection),
        ))
        .child(info_row(
            theme,
            "Providers",
            &projection.providers.providers.len().to_string(),
        ))
        .child(info_row(
            theme,
            "Slash commands",
            &projection.providers.total_slash_commands.to_string(),
        ))
        .child(info_row(
            theme,
            "Pinned",
            &projection.annotations.pinned_items.len().to_string(),
        ))
        .child(info_row(
            theme,
            "Highlighted",
            &projection.annotations.highlighted_items.len().to_string(),
        ))
        .child(info_row(
            theme,
            "Open todos",
            &projection.annotations.open_todo_count.to_string(),
        ))
        .child(summary_annotation_actions(theme, projection))
        .child(summary_provider_registry(theme, projection))
        .child(summary_pinned_items(theme, projection))
        .child(summary_highlighted_items(theme, projection))
        .child(summary_todos(theme, projection))
        .when(!chat.messages.is_empty(), |this| {
            this.child(summary_latest_message(theme, chat))
        })
        .into_any_element()
}

fn terminal_summary_label(projection: &DesktopProjection) -> &'static str {
    match projection
        .terminal
        .session
        .as_ref()
        .map(|session| &session.status)
    {
        Some(TerminalSessionStatus::Running) => "Running",
        Some(TerminalSessionStatus::Exited) => "Exited",
        Some(TerminalSessionStatus::Error) => "Error",
        Some(TerminalSessionStatus::Starting) => "Starting",
        None => "Not attached",
    }
}

fn summary_latest_message(theme: Theme, chat: &ChatProjection) -> AnyElement {
    let latest = chat
        .messages
        .iter()
        .rev()
        .find_map(|message| message.text.as_deref().or(message.title.as_deref()))
        .unwrap_or_default();

    div()
        .rounded_md()
        .border_1()
        .border_color(theme.border_subtle)
        .bg(theme.panel)
        .p_2()
        .flex()
        .flex_col()
        .gap_1()
        .child(
            div()
                .text_size(px(11.0))
                .text_color(theme.muted)
                .child("Latest timeline item"),
        )
        .child(
            div()
                .text_size(px(12.0))
                .line_height(px(18.0))
                .text_color(theme.foreground.opacity(0.80))
                .child(clamp_text(latest, 240)),
        )
        .into_any_element()
}

fn summary_provider_registry(theme: Theme, projection: &DesktopProjection) -> AnyElement {
    if projection.providers.providers.is_empty() && projection.providers.error.is_none() {
        return div().into_any_element();
    }

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
                .text_size(px(11.0))
                .text_color(theme.muted)
                .child("Provider registry"),
        )
        .when_some(projection.providers.error.as_deref(), |this, error| {
            this.child(
                div()
                    .rounded_md()
                    .border_1()
                    .border_color(theme.accent_warning.opacity(0.42))
                    .bg(theme.panel_deep)
                    .px_2()
                    .py_1()
                    .text_size(px(11.0))
                    .line_height(px(16.0))
                    .text_color(theme.accent_warning)
                    .child(clamp_text(error, 220)),
            )
        })
        .children(
            projection
                .providers
                .providers
                .iter()
                .take(5)
                .map(|provider| {
                    let status_color = if provider.ready {
                        theme.accent_success
                    } else {
                        theme.accent_warning
                    };
                    div()
                        .rounded_md()
                        .border_1()
                        .border_color(theme.border_subtle)
                        .bg(theme.panel_deep)
                        .p_2()
                        .flex()
                        .flex_col()
                        .gap_1()
                        .child(
                            div()
                                .flex()
                                .flex_row()
                                .items_center()
                                .gap_2()
                                .text_size(px(12.0))
                                .text_color(theme.foreground.opacity(0.82))
                                .child(div().w(px(6.0)).h(px(6.0)).rounded_full().bg(status_color))
                                .child(clamp_text(&provider.display_name, 80)),
                        )
                        .child(
                            div()
                                .text_size(px(11.0))
                                .text_color(theme.muted)
                                .child(format!(
                                    "{} · {} command{}",
                                    provider.health,
                                    provider.slash_commands,
                                    if provider.slash_commands == 1 {
                                        ""
                                    } else {
                                        "s"
                                    }
                                )),
                        )
                        .when(!provider.missing.is_empty(), |this| {
                            this.child(
                                div()
                                    .text_size(px(11.0))
                                    .line_height(px(16.0))
                                    .text_color(theme.muted_subtle)
                                    .child(clamp_text(&provider.missing.join(", "), 180)),
                            )
                        })
                        .when_some(provider.last_error.as_deref(), |this, error| {
                            this.child(
                                div()
                                    .text_size(px(11.0))
                                    .line_height(px(16.0))
                                    .text_color(theme.accent_danger)
                                    .child(clamp_text(error, 160)),
                            )
                        })
                })
                .collect::<Vec<_>>(),
        )
        .into_any_element()
}

fn summary_annotation_actions(theme: Theme, projection: &DesktopProjection) -> AnyElement {
    let has_message = !projection.chat.messages.is_empty();
    div()
        .flex()
        .flex_row()
        .items_center()
        .gap_2()
        .when(has_message, |this| {
            this.child(action_button(IconName::Star, "Pin latest", theme, || {
                Box::new(PinLatestTimelineItem)
            }))
            .child(action_button(
                IconName::Star,
                "Highlight latest",
                theme,
                || Box::new(ToggleHighlightLatestTimelineItem),
            ))
            .child(action_button(IconName::Plus, "Add todo", theme, || {
                Box::new(CreateTodoFromLatestTimelineItem)
            }))
        })
        .when(projection.annotations.open_todo_count > 0, |this| {
            this.child(action_button(
                IconName::CircleCheck,
                "Complete",
                theme,
                || Box::new(ToggleFirstOpenTodo),
            ))
        })
        .into_any_element()
}

fn summary_pinned_items(theme: Theme, projection: &DesktopProjection) -> AnyElement {
    if projection.annotations.pinned_items.is_empty() {
        return div().into_any_element();
    }

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
                .text_size(px(11.0))
                .text_color(theme.muted)
                .child("Pinned"),
        )
        .children(
            projection
                .annotations
                .pinned_items
                .iter()
                .take(6)
                .map(|item| {
                    div()
                        .text_size(px(12.0))
                        .line_height(px(17.0))
                        .text_color(theme.foreground.opacity(0.80))
                        .child(clamp_text(&item.display_excerpt, 160))
                })
                .collect::<Vec<_>>(),
        )
        .into_any_element()
}

fn summary_todos(theme: Theme, projection: &DesktopProjection) -> AnyElement {
    if projection.annotations.todos.is_empty() {
        return div().into_any_element();
    }

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
                .text_size(px(11.0))
                .text_color(theme.muted)
                .child(format!(
                    "Todos ({})",
                    projection.annotations.open_todo_count
                )),
        )
        .children(
            projection
                .annotations
                .todos
                .iter()
                .take(8)
                .map(|todo| {
                    let done = todo.status == TodoStatus::Done;
                    div()
                        .flex()
                        .flex_row()
                        .items_start()
                        .gap_2()
                        .text_size(px(12.0))
                        .line_height(px(17.0))
                        .child(icon_svg(
                            if done {
                                IconName::CircleCheck
                            } else {
                                IconName::Check
                            },
                            if done {
                                theme.accent_success
                            } else {
                                theme.muted
                            },
                        ))
                        .child(
                            div()
                                .flex_1()
                                .text_color(if done {
                                    theme.muted
                                } else {
                                    theme.foreground.opacity(0.82)
                                })
                                .child(clamp_text(&todo.title, 180)),
                        )
                })
                .collect::<Vec<_>>(),
        )
        .into_any_element()
}

fn summary_highlighted_items(theme: Theme, projection: &DesktopProjection) -> AnyElement {
    if projection.annotations.highlighted_items.is_empty() {
        return div().into_any_element();
    }

    div()
        .rounded_md()
        .border_1()
        .border_color(theme.accent_warning.opacity(0.42))
        .bg(theme.panel)
        .p_2()
        .flex()
        .flex_col()
        .gap_2()
        .child(
            div()
                .text_size(px(11.0))
                .text_color(theme.muted)
                .child("Highlighted"),
        )
        .children(
            projection
                .annotations
                .highlighted_items
                .iter()
                .take(6)
                .map(|item| {
                    div()
                        .text_size(px(12.0))
                        .line_height(px(17.0))
                        .text_color(theme.foreground.opacity(0.84))
                        .child(clamp_text(&item.display_excerpt, 160))
                })
                .collect::<Vec<_>>(),
        )
        .into_any_element()
}

fn pinned_body(theme: Theme, projection: &DesktopProjection) -> AnyElement {
    if projection.annotations.pinned_items.is_empty() {
        return annotation_empty_body(
            theme,
            AceIconName::PinFilled,
            "Pinned",
            "No pinned context yet.",
            IconName::Star,
            "Pin latest",
            || Box::new(PinLatestTimelineItem),
            !projection.chat.messages.is_empty(),
        );
    }

    div()
        .size_full()
        .flex()
        .flex_col()
        .gap_3()
        .child(
            div()
                .text_size(px(12.0))
                .text_color(theme.muted)
                .child(format!(
                    "{} pinned item{}",
                    projection.annotations.pinned_items.len(),
                    if projection.annotations.pinned_items.len() == 1 {
                        ""
                    } else {
                        "s"
                    }
                )),
        )
        .child(
            div()
                .flex_1()
                .min_h_0()
                .flex()
                .flex_col()
                .gap_2()
                .children(
                    projection
                        .annotations
                        .pinned_items
                        .iter()
                        .map(|item| {
                            annotation_card(
                                theme,
                                IconName::Star,
                                &item.display_title,
                                &item.display_excerpt,
                                &format!("Pinned {}", item.pinned_at),
                            )
                        })
                        .collect::<Vec<_>>(),
                )
                .overflow_y_scrollbar(),
        )
        .into_any_element()
}

fn todos_body(theme: Theme, projection: &DesktopProjection) -> AnyElement {
    if projection.annotations.todos.is_empty() {
        return annotation_empty_body(
            theme,
            AceIconName::ListChecks,
            "Todos",
            "No structured todos yet.",
            IconName::Plus,
            "Add todo",
            || Box::new(CreateTodoFromLatestTimelineItem),
            !projection.chat.messages.is_empty(),
        );
    }

    div()
        .size_full()
        .flex()
        .flex_col()
        .gap_3()
        .child(
            div()
                .flex()
                .flex_row()
                .items_center()
                .justify_between()
                .child(
                    div()
                        .text_size(px(12.0))
                        .text_color(theme.muted)
                        .child(format!(
                            "{} open of {} total",
                            projection.annotations.open_todo_count,
                            projection.annotations.todos.len()
                        )),
                )
                .child(action_button(
                    IconName::CircleCheck,
                    "Complete first",
                    theme,
                    || Box::new(ToggleFirstOpenTodo),
                )),
        )
        .child(
            div()
                .flex_1()
                .min_h_0()
                .flex()
                .flex_col()
                .gap_2()
                .children(
                    projection
                        .annotations
                        .todos
                        .iter()
                        .map(|todo| {
                            let done = todo.status == TodoStatus::Done;
                            annotation_card(
                                theme,
                                if done {
                                    IconName::CircleCheck
                                } else {
                                    IconName::Check
                                },
                                match todo.status {
                                    TodoStatus::Open => "Open",
                                    TodoStatus::InProgress => "In progress",
                                    TodoStatus::Blocked => "Blocked",
                                    TodoStatus::Done => "Done",
                                    TodoStatus::Canceled => "Canceled",
                                },
                                &todo.title,
                                &format!("Updated {}", todo.updated_at),
                            )
                        })
                        .collect::<Vec<_>>(),
                )
                .overflow_y_scrollbar(),
        )
        .into_any_element()
}

fn annotation_empty_body<A>(
    theme: Theme,
    icon: AceIconName,
    label: &'static str,
    message: &'static str,
    action_icon: IconName,
    action_label: &'static str,
    action: A,
    action_enabled: bool,
) -> AnyElement
where
    A: Fn() -> Box<dyn gpui::Action> + 'static,
{
    div()
        .size_full()
        .rounded_md()
        .border_1()
        .border_color(theme.border_subtle)
        .bg(theme.panel_deep)
        .flex()
        .flex_col()
        .items_center()
        .justify_center()
        .gap_3()
        .text_align(gpui::TextAlign::Center)
        .child(ace_icon_svg(icon, theme.muted))
        .child(
            div()
                .text_size(px(13.0))
                .text_color(theme.foreground.opacity(0.78))
                .child(label),
        )
        .child(
            div()
                .max_w(px(240.0))
                .text_size(px(12.0))
                .text_color(theme.muted)
                .child(message),
        )
        .when(action_enabled, |this| {
            this.child(action_button(action_icon, action_label, theme, action))
        })
        .into_any_element()
}

fn annotation_card(
    theme: Theme,
    icon: IconName,
    title: &str,
    excerpt: &str,
    meta: &str,
) -> AnyElement {
    div()
        .rounded_md()
        .border_1()
        .border_color(theme.border_subtle)
        .bg(theme.panel)
        .p_3()
        .flex()
        .flex_col()
        .gap_2()
        .child(
            div()
                .flex()
                .flex_row()
                .items_center()
                .gap_2()
                .text_size(px(11.0))
                .text_color(theme.muted)
                .child(icon_svg(icon, theme.muted))
                .child(clamp_text(title, 80)),
        )
        .child(
            div()
                .text_size(px(12.0))
                .line_height(px(18.0))
                .text_color(theme.foreground.opacity(0.82))
                .child(clamp_text(excerpt, 240)),
        )
        .child(
            div()
                .text_size(px(11.0))
                .text_color(theme.muted_subtle)
                .child(meta.to_string()),
        )
        .into_any_element()
}

fn terminal_body(theme: Theme, projection: &DesktopProjection) -> AnyElement {
    if let Some(reason) = projection.services.terminal.missing_reason() {
        return div()
            .flex_1()
            .min_h_0()
            .p_3()
            .child(empty_panel_body(
                theme,
                AceIconName::Terminal,
                "Terminal",
                reason,
            ))
            .into_any_element();
    }

    if projection.chat.active_thread.is_none() {
        return div()
            .flex_1()
            .min_h_0()
            .p_3()
            .child(empty_panel_body(
                theme,
                AceIconName::Terminal,
                "Terminal",
                "Select a thread to attach a PTY-backed terminal session.",
            ))
            .into_any_element();
    }

    div()
        .flex_1()
        .min_h_0()
        .p_3()
        .flex()
        .flex_col()
        .gap_2()
        .child(terminal_status_bar(theme, projection))
        .child(terminal_output(theme, projection))
        .child(terminal_input_row(theme, projection))
        .into_any_element()
}

fn terminal_status_bar(theme: Theme, projection: &DesktopProjection) -> AnyElement {
    let Some(session) = projection.terminal.session.as_ref() else {
        return div()
            .h(px(32.0))
            .rounded_md()
            .border_1()
            .border_color(theme.border_subtle)
            .bg(theme.panel)
            .px_2()
            .flex()
            .items_center()
            .gap_2()
            .text_size(px(12.0))
            .text_color(theme.muted)
            .child(ace_icon_svg(AceIconName::Terminal, theme.muted))
            .child("Opening PTY session...")
            .into_any_element();
    };

    let status = match session.status {
        TerminalSessionStatus::Starting => "Starting",
        TerminalSessionStatus::Running => "Running",
        TerminalSessionStatus::Exited => "Exited",
        TerminalSessionStatus::Error => "Error",
    };
    let pid = session
        .pid
        .map(|pid| format!("pid {pid}"))
        .unwrap_or_else(|| "no pid".to_string());

    div()
        .h(px(32.0))
        .rounded_md()
        .border_1()
        .border_color(theme.border_subtle)
        .bg(theme.panel)
        .px_2()
        .flex()
        .flex_row()
        .items_center()
        .gap_2()
        .text_size(px(12.0))
        .child(ace_icon_svg(AceIconName::Terminal, theme.muted))
        .child(
            div()
                .text_color(if session.status == TerminalSessionStatus::Running {
                    theme.accent_success
                } else {
                    theme.muted
                })
                .child(status),
        )
        .child(div().text_color(theme.muted_subtle).child(pid))
        .child(
            div()
                .flex_1()
                .min_w_0()
                .overflow_hidden()
                .text_ellipsis()
                .whitespace_nowrap()
                .text_color(theme.muted)
                .child(short_path(&session.cwd)),
        )
        .into_any_element()
}

fn terminal_output(theme: Theme, projection: &DesktopProjection) -> AnyElement {
    let history = projection
        .terminal
        .session
        .as_ref()
        .map(|session| session.history.as_str())
        .unwrap_or("");
    let lines = terminal_visible_lines(history);

    div()
        .flex_1()
        .min_h_0()
        .rounded_md()
        .border_1()
        .border_color(theme.border_subtle)
        .bg(theme.panel_deep)
        .p_3()
        .font_family("Menlo")
        .text_size(px(11.0))
        .line_height(px(16.0))
        .text_color(theme.foreground.opacity(0.82))
        .children(lines.into_iter().map(|line| {
            div().min_h(px(16.0)).child(if line.is_empty() {
                " ".to_string()
            } else {
                line
            })
        }))
        .when_some(projection.terminal.error.as_deref(), |this, error| {
            this.child(
                div()
                    .mt_2()
                    .text_color(theme.accent_danger)
                    .child(error.to_string()),
            )
        })
        .overflow_y_scrollbar()
        .into_any_element()
}

fn terminal_input_row(theme: Theme, projection: &DesktopProjection) -> AnyElement {
    let input = projection.terminal.input.as_str();
    let prompt = if input.is_empty() {
        "Type a command; Enter runs it in the PTY"
    } else {
        input
    };

    div()
        .min_h(px(36.0))
        .rounded_md()
        .border_1()
        .border_color(if projection.terminal.can_send {
            theme.border
        } else {
            theme.border_subtle
        })
        .bg(theme.background_elevated)
        .px_2()
        .flex()
        .flex_row()
        .items_center()
        .gap_2()
        .font_family("Menlo")
        .text_size(px(12.0))
        .child(div().text_color(theme.accent_success).child("$"))
        .child(
            div()
                .flex_1()
                .min_w_0()
                .overflow_hidden()
                .text_ellipsis()
                .whitespace_nowrap()
                .text_color(if input.is_empty() {
                    theme.muted_subtle
                } else {
                    theme.foreground
                })
                .child(prompt.to_string()),
        )
        .child(
            div()
                .text_color(theme.muted_subtle)
                .font_family(theme.font_family)
                .child("Enter"),
        )
        .into_any_element()
}

fn terminal_visible_lines(history: &str) -> Vec<String> {
    const MAX_TERMINAL_RENDER_LINES: usize = 240;
    let mut lines = history
        .lines()
        .rev()
        .take(MAX_TERMINAL_RENDER_LINES)
        .map(sanitize_terminal_line)
        .collect::<Vec<_>>();
    lines.reverse();
    if lines.is_empty() {
        lines.push("PTY session is attached. Shell output will appear here.".to_string());
    }
    lines
}

fn sanitize_terminal_line(line: &str) -> String {
    let mut clean = String::with_capacity(line.len());
    let mut chars = line.chars().peekable();
    while let Some(char) = chars.next() {
        if char == '\u{1b}' {
            for next in chars.by_ref() {
                if next.is_ascii_alphabetic() || next == '~' {
                    break;
                }
            }
            continue;
        }
        if !char.is_control() || char == '\t' {
            clean.push(char);
        }
    }
    clean
}

fn clamp_text(value: &str, limit: usize) -> String {
    if value.len() <= limit {
        return value.to_string();
    }

    let mut end = limit;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}...", &value[..end])
}

fn empty_panel_body(
    theme: Theme,
    icon: AceIconName,
    label: &'static str,
    message: &'static str,
) -> AnyElement {
    div()
        .size_full()
        .rounded_md()
        .border_1()
        .border_color(theme.border_subtle)
        .bg(theme.panel_deep)
        .flex()
        .flex_col()
        .items_center()
        .justify_center()
        .gap_2()
        .text_align(gpui::TextAlign::Center)
        .child(ace_icon_svg(icon, theme.muted))
        .child(
            div()
                .text_size(px(13.0))
                .text_color(theme.foreground.opacity(0.78))
                .child(label),
        )
        .child(
            div()
                .max_w(px(240.0))
                .text_size(px(12.0))
                .text_color(theme.muted)
                .child(message),
        )
        .into_any_element()
}

fn environment_row(
    theme: Theme,
    icon: IconName,
    label: &'static str,
    value: String,
    value_color: gpui::Hsla,
) -> AnyElement {
    div()
        .h(px(28.0))
        .flex()
        .flex_row()
        .items_center()
        .gap_2()
        .text_size(px(12.0))
        .child(icon_svg(icon, theme.muted))
        .child(div().w(px(64.0)).text_color(theme.muted).child(label))
        .child(
            div()
                .flex_1()
                .min_w_0()
                .overflow_hidden()
                .text_ellipsis()
                .whitespace_nowrap()
                .text_color(value_color)
                .child(value),
        )
        .into_any_element()
}

fn short_path(path: &str) -> String {
    path.rsplit('/')
        .next()
        .filter(|name| !name.is_empty())
        .unwrap_or(path)
        .to_string()
}

trait ThreadSummaryExt {
    fn status_label(&self) -> &'static str;
}

impl ThreadSummaryExt for ThreadSummary {
    fn status_label(&self) -> &'static str {
        self.status.label()
    }
}

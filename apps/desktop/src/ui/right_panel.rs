use crate::{
    actions::{
        ApproveProviderRequest, CommitReview, CreateReviewComment,
        CreateTodoFromLatestTimelineItem, CreateWorktree, DenyProviderRequest,
        LinkTodoToCurrentDiff, PinLatestTimelineItem, PushReview, RefreshApprovals, RefreshReview,
        RefreshWorktrees, RemoveWorktree, SelectBottomPanelTab, SelectRightPanelTab, SetCodeFont,
        SetThemeAccent, SetThemeDensity, SetThemeMotion, SetThemePreset, SetUiFont, StageReviewAll,
        StageReviewFile, ToggleBottomPanel, ToggleFirstOpenTodo, ToggleHighlightLatestTimelineItem,
        ToggleReviewCommentResolved, ToggleRightPanel, UnstageReviewAll, UnstageReviewFile,
        UpdateTodoAssignee, UpdateTodoPriority, UpdateTodoStatus,
    },
    stores::{
        ApprovalItemProjection, ApprovalRegistryProjection, BrowserActivityProjection,
        BrowserBridgeProjection, BrowserProjection, DesktopProjection, EditorFileProjection,
        EditorProjection, ModelProjection, ModelProviderProjection, ModelRegistryProjection,
        ReviewCommentItem, ReviewFileProjection, ReviewProjection, ServiceReadiness, ServiceStatus,
        SourceItemProjection, SummaryProjection, TodoAssignee, TodoItem, TodoPriority, TodoStatus,
        ToolRegistryEntryProjection, ToolRegistryProjection, WorktreeEntryProjection,
        WorktreeProjection,
        ui::{BottomPanelTab, RightPanelTab, UiState},
    },
    ui::{
        components::*,
        layout::PanelLayout,
        theme::{
            CodeFont, Theme, ThemeAccent, ThemeDensity, ThemeMotion, ThemePreset, ThemeSettings,
            UiFont,
        },
    },
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
    ui_state: &UiState,
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
            ui_state,
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
    ui_state: &UiState,
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
                .gap_2()
                .child(right_tab_strip(theme, active_tab, services))
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
                || review_body(theme, projection, services),
            ),
            RightPanelTab::Environment => service_panel_body(
                theme,
                &services.summary,
                AceIconName::Environment,
                "Environment",
                || environment_body(theme, projection),
            ),
            RightPanelTab::Terminal => service_panel_body(
                theme,
                &services.terminal,
                AceIconName::Terminal,
                "Terminal",
                || terminal_inspector_body(theme, projection),
            ),
            RightPanelTab::Worktrees => service_panel_body(
                theme,
                &services.worktrees,
                AceIconName::Review,
                "Worktrees",
                || worktrees_body(theme, projection),
            ),
            RightPanelTab::Approvals => service_panel_body(
                theme,
                &services.approvals,
                AceIconName::ListChecks,
                "Approvals",
                || approvals_body(theme, projection),
            ),
            RightPanelTab::Browser => service_panel_body(
                theme,
                &services.browser,
                AceIconName::Browser,
                "Browser",
                || browser_body(theme, &projection.browser),
            ),
            RightPanelTab::Editor => service_panel_body(
                theme,
                &services.editor,
                AceIconName::Editor,
                "Editor",
                || editor_body(theme, &projection.editor),
            ),
            RightPanelTab::Summary => service_panel_body(
                theme,
                &services.summary,
                AceIconName::Summary,
                "Summary",
                || summary_body(theme, projection),
            ),
            RightPanelTab::Sources => service_panel_body(
                theme,
                &services.summary,
                AceIconName::Box,
                "Sources",
                || sources_body(theme, projection),
            ),
            RightPanelTab::Providers => service_panel_body(
                theme,
                &services.providers,
                AceIconName::Code2,
                "Providers",
                || providers_body(theme, projection),
            ),
            RightPanelTab::Plugins => service_panel_body(
                theme,
                &services.plugins,
                AceIconName::Box,
                "Plugins",
                || {
                    tool_registry_body(
                        theme,
                        &projection.plugins,
                        AceIconName::Box,
                        "Plugins",
                        "No plugins are reported by the active provider runtime.",
                    )
                },
            ),
            RightPanelTab::Skills => service_panel_body(
                theme,
                &services.skills,
                AceIconName::FlaskConical,
                "Skills",
                || {
                    tool_registry_body(
                        theme,
                        &projection.skills,
                        AceIconName::FlaskConical,
                        "Skills",
                        "No skills are reported by the active provider runtime.",
                    )
                },
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
            RightPanelTab::Settings => settings_body(theme, &ui_state.theme),
        }))
        .into_any_element()
}

fn right_tab_strip(
    theme: Theme,
    active_tab: RightPanelTab,
    services: &ServiceReadiness,
) -> AnyElement {
    div()
        .id("right-panel-tab-strip")
        .flex_1()
        .min_w_0()
        .h(px(36.0))
        .flex()
        .flex_row()
        .items_center()
        .gap_1()
        .child(right_tab(
            theme,
            active_tab,
            RightPanelTab::Environment,
            &services.summary,
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
            RightPanelTab::Review,
            &services.diff_review,
        ))
        .child(right_tab(
            theme,
            active_tab,
            RightPanelTab::Terminal,
            &services.terminal,
        ))
        .child(right_tab(
            theme,
            active_tab,
            RightPanelTab::Worktrees,
            &services.worktrees,
        ))
        .child(right_tab(
            theme,
            active_tab,
            RightPanelTab::Approvals,
            &services.approvals,
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
            RightPanelTab::Sources,
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
        .child(right_tab(
            theme,
            active_tab,
            RightPanelTab::Providers,
            &services.providers,
        ))
        .child(right_tab(
            theme,
            active_tab,
            RightPanelTab::Plugins,
            &services.plugins,
        ))
        .child(right_tab(
            theme,
            active_tab,
            RightPanelTab::Skills,
            &services.skills,
        ))
        .child(right_tab_local(theme, active_tab, RightPanelTab::Settings))
        .child(right_tab(
            theme,
            active_tab,
            RightPanelTab::Editor,
            &services.editor,
        ))
        .overflow_x_scrollbar()
        .into_any_element()
}

fn right_tab_local(theme: Theme, active: RightPanelTab, tab: RightPanelTab) -> AnyElement {
    let selected = active == tab;
    let (icon, label) = right_tab_meta(tab);
    let color = if selected {
        theme.foreground.opacity(0.84)
    } else {
        theme.muted
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
        .bg(if selected {
            theme.button
        } else {
            theme.panel_deep.opacity(0.0)
        })
        .text_size(px(12.0))
        .text_color(color)
        .hover(|this| this.bg(theme.button))
        .child(header_ace_icon_svg(icon, color))
        .child(label)
        .on_mouse_up(MouseButton::Left, move |_, window, cx| {
            window.dispatch_action(Box::new(SelectRightPanelTab { tab }), cx);
        })
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
        RightPanelTab::Environment => (AceIconName::Environment, "Environment"),
        RightPanelTab::Terminal => (AceIconName::Terminal, "Terminal"),
        RightPanelTab::Worktrees => (AceIconName::Review, "Worktrees"),
        RightPanelTab::Approvals => (AceIconName::ListChecks, "Approvals"),
        RightPanelTab::Browser => (AceIconName::Browser, "Browser"),
        RightPanelTab::Editor => (AceIconName::Editor, "Editor"),
        RightPanelTab::Summary => (AceIconName::Summary, "Summary"),
        RightPanelTab::Sources => (AceIconName::Box, "Sources"),
        RightPanelTab::Providers => (AceIconName::Code2, "Providers"),
        RightPanelTab::Plugins => (AceIconName::Box, "Plugins"),
        RightPanelTab::Skills => (AceIconName::FlaskConical, "Skills"),
        RightPanelTab::Settings => (AceIconName::TablerSettings, "Settings"),
        RightPanelTab::Pinned => (AceIconName::PinFilled, "Pinned"),
        RightPanelTab::Todos => (AceIconName::ListChecks, "Todos"),
    }
}

fn right_tab_id(tab: RightPanelTab) -> &'static str {
    match tab {
        RightPanelTab::Review => "right-tab-review",
        RightPanelTab::Environment => "right-tab-environment",
        RightPanelTab::Terminal => "right-tab-terminal",
        RightPanelTab::Worktrees => "right-tab-worktrees",
        RightPanelTab::Approvals => "right-tab-approvals",
        RightPanelTab::Browser => "right-tab-browser",
        RightPanelTab::Editor => "right-tab-editor",
        RightPanelTab::Summary => "right-tab-summary",
        RightPanelTab::Sources => "right-tab-sources",
        RightPanelTab::Providers => "right-tab-providers",
        RightPanelTab::Plugins => "right-tab-plugins",
        RightPanelTab::Skills => "right-tab-skills",
        RightPanelTab::Settings => "right-tab-settings",
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

fn browser_body(theme: Theme, browser: &BrowserProjection) -> AnyElement {
    let Some(bridge) = browser.bridge.as_ref() else {
        return empty_panel_body(
            theme,
            AceIconName::Browser,
            "Browser",
            "Browser bridge status has not been loaded from the host runtime.",
        );
    };

    div()
        .flex()
        .flex_col()
        .gap_3()
        .child(info_row(theme, "Bridge", bridge_status_label(bridge)))
        .when_some(bridge.descriptor_name.as_deref(), |this, descriptor| {
            this.child(info_row(theme, "Descriptor", descriptor))
        })
        .child(info_row(theme, "Aliases", &join_or_empty(&bridge.aliases)))
        .child(info_row(
            theme,
            "Actions",
            &bridge.actions.len().to_string(),
        ))
        .child(browser_action_list(theme, bridge))
        .child(browser_activity_list(theme, &browser.activities))
        .when_some(browser.error.as_deref(), |this, error| {
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
        .when(browser.activities.is_empty(), |this| {
            this.child(
                div()
                    .rounded_md()
                    .border_1()
                    .border_color(theme.border_subtle)
                    .bg(theme.panel)
                    .px_2()
                    .py_2()
                    .text_size(px(12.0))
                    .line_height(px(17.0))
                    .text_color(theme.muted)
                    .child("No browser viewport session is attached yet. Provider tools can use the connected bridge; frame streaming will appear here once the host publishes BrowserFrame events."),
            )
        })
        .into_any_element()
}

fn browser_action_list(theme: Theme, bridge: &BrowserBridgeProjection) -> AnyElement {
    if bridge.actions.is_empty() {
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
        .gap_1()
        .child(
            div()
                .text_size(px(11.0))
                .font_weight(gpui::FontWeight::SEMIBOLD)
                .text_color(theme.muted)
                .child("Supported browser actions"),
        )
        .children(
            bridge
                .actions
                .iter()
                .take(14)
                .map(|action| {
                    div()
                        .min_h(px(20.0))
                        .flex()
                        .flex_row()
                        .items_center()
                        .gap_2()
                        .text_size(px(12.0))
                        .text_color(theme.foreground.opacity(0.78))
                        .child(icon_svg(IconName::Check, theme.accent_success))
                        .child(action.clone())
                })
                .collect::<Vec<_>>(),
        )
        .when(bridge.actions.len() > 14, |this| {
            this.child(
                div()
                    .pt_1()
                    .text_size(px(11.0))
                    .text_color(theme.muted_subtle)
                    .child(format!("{} more actions", bridge.actions.len() - 14)),
            )
        })
        .into_any_element()
}

fn browser_activity_list(theme: Theme, activities: &[BrowserActivityProjection]) -> AnyElement {
    if activities.is_empty() {
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
                .font_weight(gpui::FontWeight::SEMIBOLD)
                .text_color(theme.muted)
                .child("Recent browser activity"),
        )
        .children(
            activities
                .iter()
                .rev()
                .take(8)
                .map(|activity| browser_activity_card(theme, activity))
                .collect::<Vec<_>>(),
        )
        .into_any_element()
}

fn browser_activity_card(theme: Theme, activity: &BrowserActivityProjection) -> AnyElement {
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
                .child(icon_svg(IconName::Globe, theme.accent_blue))
                .child(clamp_text(&activity.title, 120)),
        )
        .child(
            div()
                .text_size(px(11.0))
                .line_height(px(16.0))
                .text_color(theme.muted)
                .child(clamp_text(&activity.detail, 180)),
        )
        .when_some(activity.target.as_deref(), |this, target| {
            this.child(
                div()
                    .font_family(theme.code_font_family)
                    .text_size(px(11.0))
                    .text_color(theme.muted_subtle)
                    .child(clamp_text(target, 160)),
            )
        })
        .child(
            div()
                .text_size(px(11.0))
                .text_color(theme.muted_subtle)
                .child(format!("{} · {}", activity.status, activity.observed_at)),
        )
        .into_any_element()
}

fn bridge_status_label(bridge: &BrowserBridgeProjection) -> &'static str {
    match bridge.status.as_str() {
        "connected" => "Connected",
        "unavailable" => "Unavailable",
        "missing" => "Missing",
        _ => "Unknown",
    }
}

fn join_or_empty(values: &[String]) -> String {
    if values.is_empty() {
        "None".to_string()
    } else {
        values.join(", ")
    }
}

fn editor_body(theme: Theme, editor: &EditorProjection) -> AnyElement {
    let Some(workspace_root) = editor.workspace_root.as_deref() else {
        return empty_panel_body(
            theme,
            AceIconName::Editor,
            "Editor",
            "No project workspace is available for this thread.",
        );
    };

    div()
        .flex()
        .flex_col()
        .gap_3()
        .child(info_row(theme, "Workspace", &short_path(workspace_root)))
        .child(info_row(
            theme,
            "Buffer sync",
            if editor.can_sync_buffers {
                "Available"
            } else {
                "Unavailable"
            },
        ))
        .child(info_row(theme, "Diagnostics", editor.diagnostics_topic))
        .child(info_row(
            theme,
            "Changed files",
            &editor.candidate_files.len().to_string(),
        ))
        .when_some(editor.error.as_deref(), |this, error| {
            this.child(registry_error_card(theme, error))
        })
        .child(editor_file_list(theme, &editor.candidate_files))
        .child(
            div()
                .rounded_md()
                .border_1()
                .border_color(theme.border_subtle)
                .bg(theme.panel)
                .px_2()
                .py_2()
                .text_size(px(12.0))
                .line_height(px(17.0))
                .text_color(theme.muted)
                .child("Editor RPC methods are available for buffer sync, diagnostics, symbols, hover, definitions, formatting, and code actions. The GPUI buffer surface will mount here when a file row opens a live buffer."),
        )
        .into_any_element()
}

fn editor_file_list(theme: Theme, files: &[EditorFileProjection]) -> AnyElement {
    if files.is_empty() {
        return div()
            .rounded_md()
            .border_1()
            .border_color(theme.border_subtle)
            .bg(theme.panel)
            .px_2()
            .py_2()
            .text_size(px(12.0))
            .text_color(theme.muted)
            .child("No changed files to sync")
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
        .child(
            div()
                .text_size(px(11.0))
                .font_weight(gpui::FontWeight::SEMIBOLD)
                .text_color(theme.muted)
                .child("Buffer candidates"),
        )
        .children(
            files
                .iter()
                .take(24)
                .map(|file| editor_file_row(theme, file))
                .collect::<Vec<_>>(),
        )
        .when(files.len() > 24, |this| {
            this.child(
                div()
                    .pt_1()
                    .text_size(px(11.0))
                    .text_color(theme.muted_subtle)
                    .child(format!("{} more files", files.len() - 24)),
            )
        })
        .into_any_element()
}

fn editor_file_row(theme: Theme, file: &EditorFileProjection) -> AnyElement {
    let stat = match (file.additions, file.deletions) {
        (Some(additions), Some(deletions)) => format!("+{additions} -{deletions}"),
        _ => "diff stat unavailable".to_string(),
    };

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
        .child(div().text_color(theme.muted).child(stat))
        .into_any_element()
}

fn review_body(
    theme: Theme,
    projection: &DesktopProjection,
    services: &ServiceReadiness,
) -> AnyElement {
    let review = &projection.review;
    let Some(thread) = projection.chat.active_thread.as_ref() else {
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
        .child(review_comments_list(
            theme,
            &projection.annotations.review_comments,
        ))
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
        .flex_col()
        .gap_2()
        .child(
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
                    .child(action_button(
                        IconName::Check,
                        "Unstage all",
                        theme,
                        || Box::new(UnstageReviewAll),
                    ))
                }),
        )
        .when(
            review.repo_path.is_some() && !review.files.is_empty(),
            |this| {
                this.child(
                    div()
                        .flex()
                        .flex_row()
                        .items_center()
                        .gap_2()
                        .child(action_button(
                            IconName::CircleCheck,
                            "Commit staged",
                            theme,
                            || Box::new(CommitReview),
                        ))
                        .child(action_button(IconName::ArrowUp, "Push", theme, || {
                            Box::new(PushReview)
                        })),
                )
            },
        )
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
        .child(review_file_action(
            theme,
            IconName::Plus,
            "Stage",
            file.path.clone(),
            true,
        ))
        .child(review_file_action(
            theme,
            IconName::Check,
            "Unstage",
            file.path.clone(),
            false,
        ))
        .child(review_comment_action(theme, file.path.clone()))
        .into_any_element()
}

fn review_file_action(
    theme: Theme,
    icon: IconName,
    label: &'static str,
    path: String,
    stage: bool,
) -> AnyElement {
    action_button(icon, label, theme, move || {
        let action: Box<dyn gpui::Action> = if stage {
            Box::new(StageReviewFile { path: path.clone() })
        } else {
            Box::new(UnstageReviewFile { path: path.clone() })
        };
        action
    })
}

fn review_comment_action(theme: Theme, path: String) -> AnyElement {
    action_button(IconName::Plus, "Comment", theme, move || {
        Box::new(CreateReviewComment { path: path.clone() })
    })
}

fn review_comments_list(theme: Theme, comments: &[ReviewCommentItem]) -> AnyElement {
    if comments.is_empty() {
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
                .flex()
                .flex_row()
                .items_center()
                .gap_2()
                .child(
                    div()
                        .text_size(px(11.0))
                        .font_weight(gpui::FontWeight::SEMIBOLD)
                        .text_color(theme.muted)
                        .child("Review comments"),
                )
                .child(
                    div()
                        .text_size(px(11.0))
                        .text_color(theme.muted_subtle)
                        .child(format!(
                            "{} open",
                            comments.iter().filter(|comment| !comment.resolved).count()
                        )),
                ),
        )
        .children(
            comments
                .iter()
                .take(12)
                .map(|comment| review_comment_row(theme, comment))
                .collect::<Vec<_>>(),
        )
        .when(comments.len() > 12, |this| {
            this.child(
                div()
                    .pt_1()
                    .text_size(px(11.0))
                    .text_color(theme.muted_subtle)
                    .child(format!("{} more comments", comments.len() - 12)),
            )
        })
        .into_any_element()
}

fn review_comment_row(theme: Theme, comment: &ReviewCommentItem) -> AnyElement {
    let resolved = comment.resolved;
    let status_color = if resolved {
        theme.accent_success
    } else {
        theme.accent_warning
    };
    div()
        .rounded_md()
        .border_1()
        .border_color(theme.border_subtle)
        .bg(if resolved {
            theme.panel_deep.opacity(0.62)
        } else {
            theme.panel_deep
        })
        .px_2()
        .py_2()
        .flex()
        .flex_col()
        .gap_1()
        .child(
            div()
                .flex()
                .flex_row()
                .items_center()
                .gap_2()
                .child(div().w(px(6.0)).h(px(6.0)).rounded_full().bg(status_color))
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .overflow_hidden()
                        .text_ellipsis()
                        .whitespace_nowrap()
                        .text_size(px(12.0))
                        .text_color(theme.foreground.opacity(if resolved { 0.56 } else { 0.84 }))
                        .child(comment.file_path.clone()),
                )
                .child(action_button(
                    if resolved {
                        IconName::Check
                    } else {
                        IconName::CircleCheck
                    },
                    if resolved { "Reopen" } else { "Resolve" },
                    theme,
                    {
                        let comment_id = comment.id.clone();
                        move || {
                            Box::new(ToggleReviewCommentResolved {
                                comment_id: comment_id.clone(),
                            })
                        }
                    },
                )),
        )
        .child(
            div()
                .text_size(px(12.0))
                .line_height(px(17.0))
                .text_color(theme.foreground.opacity(if resolved { 0.54 } else { 0.76 }))
                .child(comment.body.clone()),
        )
        .child(
            div()
                .text_size(px(11.0))
                .text_color(theme.muted_subtle)
                .child(format!("@review:{}", comment.id)),
        )
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
        .font_family(theme.code_font_family)
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
                    .font_family(theme.ui_font_family)
                    .text_size(px(11.0))
                    .text_color(theme.muted_subtle)
                    .child("Diff preview truncated"),
            )
        })
        .overflow_y_scrollbar()
        .into_any_element()
}

fn worktrees_body(theme: Theme, projection: &DesktopProjection) -> AnyElement {
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
    let branch = entry
        .branch
        .as_deref()
        .or(entry.head.as_deref())
        .unwrap_or("detached");
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

fn approvals_body(theme: Theme, projection: &DesktopProjection) -> AnyElement {
    let approvals = &projection.approvals;
    div()
        .size_full()
        .flex()
        .flex_col()
        .gap_3()
        .child(info_row(
            theme,
            "Pending",
            &approvals.pending.len().to_string(),
        ))
        .child(info_row(theme, "Resolved", &approvals.resolved.to_string()))
        .when_some(approvals.updated_at.as_deref(), |this, updated| {
            this.child(info_row(theme, "Updated", updated))
        })
        .child(approval_actions(theme))
        .when_some(approvals.error.as_deref(), |this, error| {
            this.child(registry_error_card(theme, error))
        })
        .child(approval_list(theme, approvals))
        .into_any_element()
}

fn approval_actions(theme: Theme) -> AnyElement {
    div()
        .flex()
        .flex_row()
        .items_center()
        .gap_2()
        .child(action_button(IconName::Info, "Refresh", theme, || {
            Box::new(RefreshApprovals)
        }))
        .into_any_element()
}

fn approval_list(theme: Theme, approvals: &ApprovalRegistryProjection) -> AnyElement {
    if approvals.pending.is_empty() {
        return div()
            .rounded_md()
            .border_1()
            .border_color(theme.border_subtle)
            .bg(theme.panel)
            .px_2()
            .py_2()
            .text_size(px(12.0))
            .text_color(theme.muted)
            .child("No pending approvals")
            .into_any_element();
    }

    div()
        .flex_1()
        .min_h_0()
        .flex()
        .flex_col()
        .gap_2()
        .children(
            approvals
                .pending
                .iter()
                .map(|approval| approval_card(theme, approval))
                .collect::<Vec<_>>(),
        )
        .overflow_y_scrollbar()
        .into_any_element()
}

fn approval_card(theme: Theme, approval: &ApprovalItemProjection) -> AnyElement {
    let provider = approval.provider.clone();
    let request_id = approval.request_id.clone();
    let deny_provider = provider.clone();
    let deny_request_id = request_id.clone();

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
                .child(icon_svg(IconName::Bell, theme.accent_warning))
                .child(clamp_text(&approval.title, 130)),
        )
        .child(
            div()
                .text_size(px(11.0))
                .line_height(px(16.0))
                .text_color(theme.foreground.opacity(0.74))
                .child(clamp_text(&approval.prompt, 220)),
        )
        .when_some(approval.detail.as_deref(), |this, detail| {
            this.child(
                div()
                    .font_family(theme.code_font_family)
                    .text_size(px(11.0))
                    .line_height(px(16.0))
                    .text_color(theme.muted)
                    .child(clamp_text(detail, 180)),
            )
        })
        .child(
            div()
                .text_size(px(11.0))
                .line_height(px(16.0))
                .text_color(theme.muted_subtle)
                .child(approval_meta(approval)),
        )
        .child(
            div()
                .flex()
                .flex_row()
                .items_center()
                .gap_2()
                .child(action_button(
                    IconName::ThumbsUp,
                    "Approve",
                    theme,
                    move || {
                        Box::new(ApproveProviderRequest {
                            provider: provider.clone(),
                            request_id: request_id.clone(),
                        })
                    },
                ))
                .child(action_button(
                    IconName::ThumbsDown,
                    "Deny",
                    theme,
                    move || {
                        Box::new(DenyProviderRequest {
                            provider: deny_provider.clone(),
                            request_id: deny_request_id.clone(),
                        })
                    },
                )),
        )
        .into_any_element()
}

fn approval_meta(approval: &ApprovalItemProjection) -> String {
    let mut parts = vec![
        approval.provider.clone(),
        approval.kind.clone(),
        approval.method.clone(),
    ];
    if let Some(scope) = approval.scope.as_deref() {
        parts.push(scope.to_string());
    }
    if let Some(policy) = approval.selected_policy.as_deref() {
        parts.push(policy.to_string());
    }
    parts.push(format!("request {}", approval.request_id));
    parts.join(" · ")
}

fn environment_body(theme: Theme, projection: &DesktopProjection) -> AnyElement {
    let Some(thread) = projection.chat.active_thread.as_ref() else {
        return empty_panel_body(
            theme,
            AceIconName::Environment,
            "Environment",
            "No active thread is selected.",
        );
    };

    let branch = thread.branch.as_deref().unwrap_or("No branch");
    let worktree = thread
        .worktree_path
        .as_deref()
        .map(short_path)
        .unwrap_or_else(|| "Project workspace".to_string());
    let terminal = terminal_summary_label(projection);
    let remote_hosts = remote_host_lines(projection);

    div()
        .size_full()
        .flex()
        .flex_col()
        .gap_3()
        .child(environment_card(theme, Some(thread)))
        .child(info_row(theme, "Host", &projection.host.label))
        .when_some(projection.host.endpoint.as_deref(), |this, endpoint| {
            this.child(info_row(theme, "Endpoint", endpoint))
        })
        .child(info_row(theme, "Branch", branch))
        .child(info_row(theme, "Worktree", &worktree))
        .child(info_row(
            theme,
            "Known worktrees",
            &projection.worktrees.entries.len().to_string(),
        ))
        .child(info_row(
            theme,
            "Changes",
            &format!(
                "{} files · +{} -{}",
                projection.review.files.len(),
                projection.review.total_additions,
                projection.review.total_deletions
            ),
        ))
        .child(info_row(theme, "Terminal", terminal))
        .child(info_row(
            theme,
            "Runtime state",
            &runtime_state_label(projection),
        ))
        .child(info_row(theme, "Remote", &runtime_remote_label(projection)))
        .child(summary_section(
            theme,
            "Remote hosts",
            &remote_hosts,
            "No remote host connections have been reported by the runtime.",
        ))
        .child(info_row(
            theme,
            "Handoffs",
            &projection.runtime_status.handoffs.to_string(),
        ))
        .child(info_row(
            theme,
            "Pending approvals",
            &projection.runtime_status.pending_approvals.to_string(),
        ))
        .child(info_row(
            theme,
            "Resolved approvals",
            &projection.approvals.resolved.to_string(),
        ))
        .child(info_row(
            theme,
            "Sources",
            &projection.sources.items.len().to_string(),
        ))
        .child(info_row(theme, "Provider", thread.provider.display_name()))
        .child(info_row(
            theme,
            "Model",
            thread.model.as_deref().unwrap_or("No model selected"),
        ))
        .child(info_row(
            theme,
            "Project default model",
            projection
                .active_project_default_model
                .as_deref()
                .unwrap_or("No project default"),
        ))
        .child(info_row(
            theme,
            "Open todos",
            &projection.annotations.open_todo_count.to_string(),
        ))
        .when_some(projection.runtime_status.error.as_deref(), |this, error| {
            this.child(registry_error_card(theme, error))
        })
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
        .child(summary_overview(theme, &projection.summary))
        .child(summary_section(
            theme,
            "Plan",
            &projection.summary.plan,
            "No actionable plan has been observed.",
        ))
        .child(summary_section(
            theme,
            "Todos",
            &projection.summary.todos,
            "No structured todos are attached.",
        ))
        .child(summary_section(
            theme,
            "Pinned context",
            &projection.summary.pinned_context,
            "No pinned context yet.",
        ))
        .child(summary_section(
            theme,
            "Highlighted context",
            &projection.summary.highlighted_context,
            "No highlighted context yet.",
        ))
        .child(summary_section(
            theme,
            "Files changed",
            &projection.summary.files_changed,
            "No changed files observed.",
        ))
        .child(summary_section(
            theme,
            "Commands run",
            &projection.summary.commands_run,
            "No terminal output observed.",
        ))
        .child(summary_section(
            theme,
            "Browser pages inspected",
            &projection.summary.browser_pages,
            "No browser activity observed.",
        ))
        .child(summary_section(
            theme,
            "Runtime relationships",
            &projection.summary.runtime_relationships,
            "No forks, side chats, subagents, or handoffs observed.",
        ))
        .child(summary_section(
            theme,
            "Runtime signals",
            &projection.summary.runtime_signals,
            "No runtime warnings, goal updates, reroutes, process exits, or realtime state observed.",
        ))
        .child(summary_section(
            theme,
            "Artifacts",
            &projection.summary.artifacts,
            "No provider artifacts observed.",
        ))
        .child(summary_section(
            theme,
            "Decisions made",
            &projection.summary.decisions,
            "No decisions recorded yet.",
        ))
        .child(summary_section(
            theme,
            "Blockers",
            &projection.summary.blockers,
            "No blockers observed.",
        ))
        .child(summary_annotation_actions(theme, projection))
        .child(summary_provider_registry(theme, projection))
        .when(!chat.messages.is_empty(), |this| {
            this.child(summary_latest_message(theme, chat))
        })
        .into_any_element()
}

fn summary_overview(theme: Theme, summary: &SummaryProjection) -> AnyElement {
    div()
        .rounded_md()
        .border_1()
        .border_color(theme.border_subtle)
        .bg(theme.panel)
        .p_2()
        .flex()
        .flex_col()
        .gap_2()
        .child(info_row(
            theme,
            "Current goal",
            summary
                .current_goal
                .as_deref()
                .unwrap_or("No explicit user goal observed."),
        ))
        .child(info_row(theme, "Current status", &summary.current_status))
        .when_some(summary.run_status.as_deref(), |this, run_status| {
            this.child(info_row(theme, "Run", run_status))
        })
        .when_some(
            summary.composer_status.as_deref(),
            |this, composer_status| this.child(info_row(theme, "Composer", composer_status)),
        )
        .when_some(summary.next_action.as_deref(), |this, next| {
            this.child(info_row(theme, "Next action", next))
        })
        .into_any_element()
}

fn summary_section(
    theme: Theme,
    title: &'static str,
    items: &[String],
    empty: &'static str,
) -> AnyElement {
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
                .font_weight(gpui::FontWeight::SEMIBOLD)
                .text_color(theme.muted)
                .child(title),
        )
        .when(items.is_empty(), |this| {
            this.child(
                div()
                    .text_size(px(12.0))
                    .line_height(px(17.0))
                    .text_color(theme.muted_subtle)
                    .child(empty),
            )
        })
        .children(
            items
                .iter()
                .take(10)
                .map(|item| {
                    div()
                        .text_size(px(12.0))
                        .line_height(px(17.0))
                        .text_color(theme.foreground.opacity(0.78))
                        .child(clamp_text(item, 220))
                })
                .collect::<Vec<_>>(),
        )
        .when(items.len() > 10, |this| {
            this.child(
                div()
                    .pt_1()
                    .text_size(px(11.0))
                    .text_color(theme.muted_subtle)
                    .child(format!("{} more", items.len() - 10)),
            )
        })
        .into_any_element()
}

fn sources_body(theme: Theme, projection: &DesktopProjection) -> AnyElement {
    if projection.sources.items.is_empty() {
        return empty_panel_body(
            theme,
            AceIconName::Box,
            "Sources",
            "No files, terminal sessions, or context annotations are attached yet.",
        );
    }

    div()
        .size_full()
        .flex()
        .flex_col()
        .gap_3()
        .child(info_row(
            theme,
            "Changed files",
            &projection.sources.changed_files.to_string(),
        ))
        .child(info_row(
            theme,
            "Terminal sessions",
            &projection.sources.terminal_sessions.to_string(),
        ))
        .child(info_row(
            theme,
            "Context items",
            &projection.sources.context_items.to_string(),
        ))
        .child(info_row(
            theme,
            "Artifacts",
            &projection.sources.artifacts.to_string(),
        ))
        .child(
            div()
                .flex_1()
                .min_h_0()
                .flex()
                .flex_col()
                .gap_2()
                .children(
                    projection
                        .sources
                        .items
                        .iter()
                        .map(|source| source_item_card(theme, source))
                        .collect::<Vec<_>>(),
                )
                .overflow_y_scrollbar(),
        )
        .into_any_element()
}

fn source_item_card(theme: Theme, source: &SourceItemProjection) -> AnyElement {
    let icon = match source.kind.as_str() {
        "file" => IconName::File,
        "terminal" => IconName::SquareTerminal,
        "artifact" => IconName::Inbox,
        "pinned" | "highlight" => IconName::Star,
        "todo" => IconName::Check,
        _ => IconName::Inbox,
    };
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
                .text_size(px(12.0))
                .text_color(theme.foreground.opacity(0.84))
                .child(icon_svg(icon, theme.muted))
                .child(clamp_text(&source.title, 140)),
        )
        .child(
            div()
                .text_size(px(11.0))
                .line_height(px(16.0))
                .text_color(theme.muted)
                .child(clamp_text(&source.detail, 220)),
        )
        .when(!source.added_at.is_empty(), |this| {
            this.child(
                div()
                    .text_size(px(11.0))
                    .text_color(theme.muted_subtle)
                    .child(format!("Observed {}", source.added_at)),
            )
        })
        .into_any_element()
}

fn remote_host_lines(projection: &DesktopProjection) -> Vec<String> {
    projection
        .host_options
        .iter()
        .map(|host| {
            let project_text = if host.project_count == 0 {
                "no projects".to_string()
            } else {
                format!(
                    "{} project{}",
                    host.project_count,
                    plural(host.project_count)
                )
            };
            format!(
                "{} · {} · {} · {}",
                host.label, host.status, project_text, host.detail
            )
        })
        .collect()
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

fn runtime_state_label(projection: &DesktopProjection) -> String {
    let runtime = &projection.runtime_status;
    if runtime.providers == 0 && runtime.threads == 0 && runtime.error.is_some() {
        return "Unavailable".to_string();
    }

    format!(
        "{} provider{} · {} active / {} thread{}",
        runtime.providers,
        plural(runtime.providers),
        runtime.active_threads,
        runtime.threads,
        plural(runtime.threads)
    )
}

fn runtime_remote_label(projection: &DesktopProjection) -> String {
    let runtime = &projection.runtime_status;
    if runtime.remote_connections == 0 {
        return "No remote connections".to_string();
    }

    format!(
        "{} connected / {} total · {} host{}",
        runtime.connected_remote_connections,
        runtime.remote_connections,
        runtime.remote_host_connections,
        plural(runtime.remote_host_connections)
    )
}

fn plural(count: usize) -> &'static str {
    if count == 1 { "" } else { "s" }
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

fn providers_body(theme: Theme, projection: &DesktopProjection) -> AnyElement {
    if projection.providers.providers.is_empty() && projection.providers.error.is_none() {
        return empty_panel_body(
            theme,
            AceIconName::Code2,
            "Providers",
            "No providers are reported by the active provider runtime.",
        );
    }

    div()
        .size_full()
        .flex()
        .flex_col()
        .gap_3()
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
            "Models",
            &projection.models.total_models.to_string(),
        ))
        .child(info_row(
            theme,
            "Runtime threads",
            &format!(
                "{} active / {} total",
                projection.runtime_status.active_threads, projection.runtime_status.threads
            ),
        ))
        .child(info_row(theme, "Remote", &runtime_remote_label(projection)))
        .child(info_row(
            theme,
            "Pending approvals",
            &projection.runtime_status.pending_approvals.to_string(),
        ))
        .when_some(
            projection.providers.updated_at.as_deref(),
            |this, updated| this.child(info_row(theme, "Updated", updated)),
        )
        .when_some(projection.runtime_status.error.as_deref(), |this, error| {
            this.child(registry_error_card(theme, error))
        })
        .child(summary_provider_registry(theme, projection))
        .child(model_registry_body(theme, &projection.models))
        .into_any_element()
}

fn settings_body(theme: Theme, settings: &ThemeSettings) -> AnyElement {
    div()
        .flex()
        .flex_col()
        .gap_3()
        .child(settings_header(theme))
        .child(settings_section(
            theme,
            "Appearance",
            vec![
                settings_option(
                    theme,
                    settings.preset == ThemePreset::AceDark,
                    IconName::Moon,
                    "Ace Dark",
                    "Default low-contrast workstation theme",
                    SetThemePreset {
                        preset: ThemePreset::AceDark,
                    },
                ),
                settings_option(
                    theme,
                    settings.preset == ThemePreset::HighContrast,
                    IconName::Sun,
                    "High Contrast",
                    "Sharper text, borders, and panels",
                    SetThemePreset {
                        preset: ThemePreset::HighContrast,
                    },
                ),
            ],
        ))
        .child(settings_section(
            theme,
            "Accent",
            vec![
                settings_option(
                    theme,
                    settings.accent == ThemeAccent::Sky,
                    IconName::Palette,
                    "Sky",
                    "Cool blue highlights and activity states",
                    SetThemeAccent {
                        accent: ThemeAccent::Sky,
                    },
                ),
                settings_option(
                    theme,
                    settings.accent == ThemeAccent::Emerald,
                    IconName::Palette,
                    "Emerald",
                    "Green highlights for calm review sessions",
                    SetThemeAccent {
                        accent: ThemeAccent::Emerald,
                    },
                ),
                settings_option(
                    theme,
                    settings.accent == ThemeAccent::Amber,
                    IconName::Palette,
                    "Amber",
                    "Warm highlights for high-signal monitoring",
                    SetThemeAccent {
                        accent: ThemeAccent::Amber,
                    },
                ),
                settings_option(
                    theme,
                    settings.accent == ThemeAccent::Rose,
                    IconName::Palette,
                    "Rose",
                    "High-contrast rose highlights",
                    SetThemeAccent {
                        accent: ThemeAccent::Rose,
                    },
                ),
            ],
        ))
        .child(settings_section(
            theme,
            "Density",
            vec![
                settings_option(
                    theme,
                    settings.density == ThemeDensity::Comfortable,
                    IconName::LayoutDashboard,
                    "Comfortable",
                    "Roomier panels and controls",
                    SetThemeDensity {
                        density: ThemeDensity::Comfortable,
                    },
                ),
                settings_option(
                    theme,
                    settings.density == ThemeDensity::Compact,
                    IconName::LayoutDashboard,
                    "Compact",
                    "Tighter panels for dense agent sessions",
                    SetThemeDensity {
                        density: ThemeDensity::Compact,
                    },
                ),
            ],
        ))
        .child(settings_section(
            theme,
            "Typography",
            vec![
                settings_option(
                    theme,
                    settings.ui_font == UiFont::System,
                    IconName::ALargeSmall,
                    "UI: System",
                    "Native app chrome and controls",
                    SetUiFont {
                        ui_font: UiFont::System,
                    },
                ),
                settings_option(
                    theme,
                    settings.ui_font == UiFont::Monospace,
                    IconName::ALargeSmall,
                    "UI: Monospace",
                    "Monospaced chrome for dense scanning",
                    SetUiFont {
                        ui_font: UiFont::Monospace,
                    },
                ),
                settings_option(
                    theme,
                    settings.code_font == CodeFont::SystemMono,
                    IconName::SquareTerminal,
                    "Code: SF Mono",
                    "Code snippets, diffs, editor, terminal",
                    SetCodeFont {
                        code_font: CodeFont::SystemMono,
                    },
                ),
                settings_option(
                    theme,
                    settings.code_font == CodeFont::Menlo,
                    IconName::SquareTerminal,
                    "Code: Menlo",
                    "Code snippets, diffs, editor, terminal",
                    SetCodeFont {
                        code_font: CodeFont::Menlo,
                    },
                ),
            ],
        ))
        .child(settings_section(
            theme,
            "Motion",
            vec![
                settings_option(
                    theme,
                    settings.motion == ThemeMotion::Standard,
                    IconName::Palette,
                    "Standard",
                    "Full hover and emphasis response",
                    SetThemeMotion {
                        motion: ThemeMotion::Standard,
                    },
                ),
                settings_option(
                    theme,
                    settings.motion == ThemeMotion::Reduced,
                    IconName::Palette,
                    "Reduced",
                    "Lower emphasis and motion intensity",
                    SetThemeMotion {
                        motion: ThemeMotion::Reduced,
                    },
                ),
            ],
        ))
        .into_any_element()
}

fn settings_header(theme: Theme) -> AnyElement {
    div()
        .flex()
        .flex_row()
        .items_center()
        .gap_2()
        .text_size(px(13.0))
        .text_color(theme.foreground.opacity(0.84))
        .child(ace_icon_svg(AceIconName::TablerSettings, theme.muted))
        .child("Settings")
        .into_any_element()
}

fn settings_section(theme: Theme, title: &'static str, options: Vec<AnyElement>) -> AnyElement {
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
                .font_weight(gpui::FontWeight::SEMIBOLD)
                .text_color(theme.muted)
                .child(title),
        )
        .children(options)
        .into_any_element()
}

fn settings_option<A>(
    theme: Theme,
    selected: bool,
    icon: IconName,
    label: &'static str,
    detail: &'static str,
    action: A,
) -> AnyElement
where
    A: gpui::Action + Clone + 'static,
{
    let color = if selected {
        theme.foreground.opacity(0.88)
    } else {
        theme.foreground.opacity(0.76)
    };

    div()
        .min_h(px(42.0))
        .rounded_md()
        .border_1()
        .border_color(if selected {
            theme.accent_blue.opacity(0.42)
        } else {
            theme.border_subtle
        })
        .bg(if selected {
            theme.button
        } else {
            theme.panel_deep
        })
        .px_2()
        .py_2()
        .flex()
        .flex_row()
        .items_center()
        .gap_2()
        .hover(|this| this.bg(theme.button_hover))
        .child(icon_svg(
            icon,
            if selected {
                theme.accent_blue
            } else {
                theme.muted
            },
        ))
        .child(
            div()
                .min_w_0()
                .flex_1()
                .flex()
                .flex_col()
                .gap_1()
                .child(div().text_size(px(12.0)).text_color(color).child(label))
                .child(
                    div()
                        .text_size(px(11.0))
                        .text_color(theme.muted_subtle)
                        .child(detail),
                ),
        )
        .when(selected, |this| {
            this.child(icon_svg(IconName::Check, theme.accent_success))
        })
        .on_mouse_up(MouseButton::Left, move |_, window, cx| {
            window.dispatch_action(Box::new(action.clone()), cx);
        })
        .into_any_element()
}

fn model_registry_body(theme: Theme, registry: &ModelRegistryProjection) -> AnyElement {
    if registry.providers.is_empty() && registry.error.is_none() {
        return div().into_any_element();
    }

    div()
        .flex()
        .flex_col()
        .gap_2()
        .when_some(registry.error.as_deref(), |this, error| {
            this.child(registry_error_card(theme, error))
        })
        .children(
            registry
                .providers
                .iter()
                .map(|provider| model_provider_card(theme, provider))
                .collect::<Vec<_>>(),
        )
        .into_any_element()
}

fn model_provider_card(theme: Theme, provider: &ModelProviderProjection) -> AnyElement {
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
                .justify_between()
                .gap_2()
                .text_size(px(12.0))
                .text_color(theme.foreground.opacity(0.84))
                .child(
                    div()
                        .flex()
                        .flex_row()
                        .items_center()
                        .gap_2()
                        .child(icon_svg(IconName::Bot, theme.muted))
                        .child(clamp_text(&provider.display_name, 120)),
                )
                .child(
                    div()
                        .text_size(px(11.0))
                        .text_color(theme.muted)
                        .child(format!(
                            "{} model{}",
                            provider.models.len(),
                            plural(provider.models.len())
                        )),
                ),
        )
        .children(
            provider
                .models
                .iter()
                .take(8)
                .map(|model| model_card(theme, model))
                .collect::<Vec<_>>(),
        )
        .when(provider.models.len() > 8, |this| {
            this.child(
                div()
                    .pt_1()
                    .text_size(px(11.0))
                    .text_color(theme.muted_subtle)
                    .child(format!("{} more models", provider.models.len() - 8)),
            )
        })
        .into_any_element()
}

fn model_card(theme: Theme, model: &ModelProjection) -> AnyElement {
    let mut capabilities = Vec::new();
    if model.supports_reasoning {
        capabilities.push("reasoning");
    }
    if model.supports_tools {
        capabilities.push("tools");
    }
    if model.supports_vision {
        capabilities.push("vision");
    }
    if model.supports_attachments {
        capabilities.push("attachments");
    }

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
                .child(clamp_text(&model.display_name, 130)),
        )
        .child(
            div()
                .text_size(px(11.0))
                .text_color(theme.muted)
                .child(model_meta(model)),
        )
        .when(!capabilities.is_empty(), |this| {
            this.child(
                div()
                    .text_size(px(11.0))
                    .text_color(theme.muted_subtle)
                    .child(capabilities.join(" · ")),
            )
        })
        .into_any_element()
}

fn model_meta(model: &ModelProjection) -> String {
    let mut parts = vec![model.id.clone()];
    if let Some(provider) = model.provider.as_deref() {
        parts.push(provider.to_string());
    }
    if let Some(family) = model.family.as_deref() {
        parts.push(family.to_string());
    }
    if let Some(context_window) = model.context_window {
        parts.push(format!("{}k context", context_window / 1_000));
    }
    if let Some(max_output_tokens) = model.max_output_tokens {
        parts.push(format!("{}k output", max_output_tokens / 1_000));
    }
    parts.join(" · ")
}

fn tool_registry_body(
    theme: Theme,
    registry: &ToolRegistryProjection,
    icon: AceIconName,
    label: &'static str,
    empty_message: &'static str,
) -> AnyElement {
    if registry.entries.is_empty() && registry.error.is_none() {
        return empty_panel_body(theme, icon, label, empty_message);
    }

    div()
        .size_full()
        .flex()
        .flex_col()
        .gap_3()
        .child(info_row(theme, "Source", registry.source))
        .child(info_row(
            theme,
            "Entries",
            &registry.entries.len().to_string(),
        ))
        .when_some(registry.updated_at.as_deref(), |this, updated| {
            this.child(info_row(theme, "Updated", updated))
        })
        .when_some(registry.error.as_deref(), |this, error| {
            this.child(registry_error_card(theme, error))
        })
        .child(
            div()
                .flex_1()
                .min_h_0()
                .flex()
                .flex_col()
                .gap_2()
                .children(
                    registry
                        .entries
                        .iter()
                        .take(80)
                        .map(|entry| tool_registry_entry_card(theme, entry))
                        .collect::<Vec<_>>(),
                )
                .when(registry.entries.len() > 80, |this| {
                    this.child(
                        div()
                            .pt_1()
                            .text_size(px(11.0))
                            .text_color(theme.muted_subtle)
                            .child(format!("{} more entries", registry.entries.len() - 80)),
                    )
                })
                .overflow_y_scrollbar(),
        )
        .into_any_element()
}

fn registry_error_card(theme: Theme, error: &str) -> AnyElement {
    div()
        .rounded_md()
        .border_1()
        .border_color(theme.accent_warning.opacity(0.42))
        .bg(theme.panel)
        .px_2()
        .py_2()
        .text_size(px(12.0))
        .line_height(px(17.0))
        .text_color(theme.accent_warning)
        .child(clamp_text(error, 280))
        .into_any_element()
}

fn tool_registry_entry_card(theme: Theme, entry: &ToolRegistryEntryProjection) -> AnyElement {
    let status_color = match entry.enabled {
        Some(true) => theme.accent_success,
        Some(false) => theme.muted_subtle,
        None if entry.status.eq_ignore_ascii_case("enabled")
            || entry.status.eq_ignore_ascii_case("installed")
            || entry.status.eq_ignore_ascii_case("available") =>
        {
            theme.accent_success
        }
        None if entry.status.eq_ignore_ascii_case("disabled")
            || entry.status.eq_ignore_ascii_case("unavailable") =>
        {
            theme.accent_warning
        }
        None => theme.muted,
    };

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
                .flex()
                .flex_row()
                .items_center()
                .gap_2()
                .text_size(px(12.0))
                .text_color(theme.foreground.opacity(0.84))
                .child(div().w(px(6.0)).h(px(6.0)).rounded_full().bg(status_color))
                .child(clamp_text(&entry.name, 120)),
        )
        .child(
            div()
                .text_size(px(11.0))
                .text_color(theme.muted)
                .child(registry_entry_meta(entry)),
        )
        .when_some(entry.description.as_deref(), |this, description| {
            this.child(
                div()
                    .text_size(px(11.0))
                    .line_height(px(16.0))
                    .text_color(theme.foreground.opacity(0.72))
                    .child(clamp_text(description, 180)),
            )
        })
        .into_any_element()
}

fn registry_entry_meta(entry: &ToolRegistryEntryProjection) -> String {
    let mut parts = vec![entry.status.clone()];
    if let Some(version) = entry.version.as_deref().filter(|value| !value.is_empty()) {
        parts.push(format!("v{version}"));
    }
    if let Some(source) = entry.source.as_deref().filter(|value| !value.is_empty()) {
        parts.push(source.to_string());
    }
    parts.join(" · ")
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

fn pinned_body(theme: Theme, projection: &DesktopProjection) -> AnyElement {
    if projection.annotations.pinned_items.is_empty() {
        return annotation_empty_body(
            theme,
            AnnotationEmptyState {
                icon: AceIconName::PinFilled,
                label: "Pinned",
                message: "No pinned context yet.",
                action_icon: IconName::Star,
                action_label: "Pin latest",
                action: || Box::new(PinLatestTimelineItem),
                action_enabled: !projection.chat.messages.is_empty(),
            },
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
            AnnotationEmptyState {
                icon: AceIconName::ListChecks,
                label: "Todos",
                message: "No structured todos yet.",
                action_icon: IconName::Plus,
                action_label: "Add todo",
                action: || Box::new(CreateTodoFromLatestTimelineItem),
                action_enabled: !projection.chat.messages.is_empty(),
            },
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
                .gap_3()
                .child(todo_section(
                    theme,
                    "Open",
                    TodoStatus::Open,
                    &projection.annotations.todos,
                ))
                .child(todo_section(
                    theme,
                    "In progress",
                    TodoStatus::InProgress,
                    &projection.annotations.todos,
                ))
                .child(todo_section(
                    theme,
                    "Blocked",
                    TodoStatus::Blocked,
                    &projection.annotations.todos,
                ))
                .child(todo_section(
                    theme,
                    "Done",
                    TodoStatus::Done,
                    &projection.annotations.todos,
                ))
                .child(todo_section(
                    theme,
                    "Canceled",
                    TodoStatus::Canceled,
                    &projection.annotations.todos,
                ))
                .overflow_y_scrollbar(),
        )
        .into_any_element()
}

fn todo_section(
    theme: Theme,
    label: &'static str,
    status: TodoStatus,
    todos: &[TodoItem],
) -> AnyElement {
    let items = todos
        .iter()
        .filter(|todo| todo.status == status)
        .collect::<Vec<_>>();
    if items.is_empty() {
        return div().into_any_element();
    }

    div()
        .flex()
        .flex_col()
        .gap_2()
        .child(
            div()
                .flex()
                .flex_row()
                .items_center()
                .justify_between()
                .text_size(px(11.0))
                .text_color(theme.muted)
                .child(label)
                .child(items.len().to_string()),
        )
        .children(
            items
                .into_iter()
                .map(|todo| todo_card(theme, todo))
                .collect::<Vec<_>>(),
        )
        .into_any_element()
}

fn todo_card(theme: Theme, todo: &TodoItem) -> AnyElement {
    let (icon, title, color) = match todo.status {
        TodoStatus::Open => (IconName::Check, "Open", theme.muted),
        TodoStatus::InProgress => (IconName::LoaderCircle, "In progress", theme.accent_success),
        TodoStatus::Blocked => (IconName::TriangleAlert, "Blocked", theme.accent_warning),
        TodoStatus::Done => (IconName::CircleCheck, "Done", theme.accent_success),
        TodoStatus::Canceled => (IconName::CircleX, "Canceled", theme.muted_subtle),
    };
    let todo_id = todo.id.clone();

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
                .items_start()
                .gap_2()
                .child(icon_svg(icon, color))
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .flex()
                        .flex_col()
                        .gap_1()
                        .child(
                            div()
                                .text_size(px(12.0))
                                .line_height(px(18.0))
                                .text_color(theme.foreground.opacity(0.82))
                                .child(clamp_text(&todo.title, 220)),
                        )
                        .child(
                            div()
                                .text_size(px(11.0))
                                .text_color(theme.muted)
                                .child(format!(
                                    "{title} · {} priority · assigned to {} · Updated {}",
                                    todo_priority_label(todo.priority),
                                    todo_assignee_label(todo.assigned_to),
                                    todo.updated_at
                                )),
                        ),
                ),
        )
        .when_some(todo.description.as_deref(), |this, description| {
            this.child(
                div()
                    .text_size(px(12.0))
                    .line_height(px(17.0))
                    .text_color(theme.foreground.opacity(0.70))
                    .child(clamp_text(description, 220)),
            )
        })
        .when(!todo.related_files.is_empty(), |this| {
            this.child(
                div()
                    .text_size(px(11.0))
                    .text_color(theme.muted_subtle)
                    .child(format!(
                        "{} related file{}",
                        todo.related_files.len(),
                        plural(todo.related_files.len())
                    )),
            )
        })
        .when(!todo.related_diff_comments.is_empty(), |this| {
            this.child(
                div()
                    .text_size(px(11.0))
                    .text_color(theme.muted_subtle)
                    .child(format!(
                        "{} diff comment{}",
                        todo.related_diff_comments.len(),
                        plural(todo.related_diff_comments.len())
                    )),
            )
        })
        .child(todo_status_actions(theme, &todo_id, todo.status))
        .child(todo_metadata_actions(
            theme,
            &todo_id,
            todo.priority,
            todo.assigned_to,
        ))
        .into_any_element()
}

fn todo_status_actions(theme: Theme, todo_id: &str, status: TodoStatus) -> AnyElement {
    let actions: Vec<(IconName, &'static str, TodoStatus)> = match status {
        TodoStatus::Open => vec![
            (IconName::LoaderCircle, "Start", TodoStatus::InProgress),
            (IconName::CircleCheck, "Done", TodoStatus::Done),
            (IconName::CircleX, "Cancel", TodoStatus::Canceled),
        ],
        TodoStatus::InProgress => vec![
            (IconName::TriangleAlert, "Block", TodoStatus::Blocked),
            (IconName::CircleCheck, "Done", TodoStatus::Done),
            (IconName::CircleX, "Cancel", TodoStatus::Canceled),
        ],
        TodoStatus::Blocked => vec![
            (IconName::LoaderCircle, "Start", TodoStatus::InProgress),
            (IconName::CircleCheck, "Done", TodoStatus::Done),
            (IconName::CircleX, "Cancel", TodoStatus::Canceled),
        ],
        TodoStatus::Done | TodoStatus::Canceled => vec![
            (IconName::Check, "Open", TodoStatus::Open),
            (IconName::LoaderCircle, "Start", TodoStatus::InProgress),
        ],
    };

    div()
        .flex()
        .flex_row()
        .items_center()
        .gap_1()
        .children(actions.into_iter().map(|(icon, label, status)| {
            let todo_id = todo_id.to_string();
            action_button(icon, label, theme, move || {
                Box::new(UpdateTodoStatus {
                    todo_id: todo_id.clone(),
                    status,
                })
            })
        }))
        .into_any_element()
}

fn todo_metadata_actions(
    theme: Theme,
    todo_id: &str,
    priority: TodoPriority,
    assignee: TodoAssignee,
) -> AnyElement {
    div()
        .flex()
        .flex_row()
        .items_center()
        .gap_1()
        .children(
            next_priority_actions(priority)
                .into_iter()
                .map(|(icon, label, priority)| {
                    let todo_id = todo_id.to_string();
                    action_button(icon, label, theme, move || {
                        Box::new(UpdateTodoPriority {
                            todo_id: todo_id.clone(),
                            priority,
                        })
                    })
                }),
        )
        .children(
            next_assignee_actions(assignee)
                .into_iter()
                .map(|(icon, label, assignee)| {
                    let todo_id = todo_id.to_string();
                    action_button(icon, label, theme, move || {
                        Box::new(UpdateTodoAssignee {
                            todo_id: todo_id.clone(),
                            assignee,
                        })
                    })
                }),
        )
        .child({
            let todo_id = todo_id.to_string();
            action_button(IconName::File, "Link diff", theme, move || {
                Box::new(LinkTodoToCurrentDiff {
                    todo_id: todo_id.clone(),
                })
            })
        })
        .into_any_element()
}

fn next_priority_actions(priority: TodoPriority) -> Vec<(IconName, &'static str, TodoPriority)> {
    match priority {
        TodoPriority::Low => vec![(IconName::ArrowUp, "Normal", TodoPriority::Normal)],
        TodoPriority::Normal => vec![
            (IconName::ArrowDown, "Low", TodoPriority::Low),
            (IconName::ArrowUp, "High", TodoPriority::High),
        ],
        TodoPriority::High => vec![(IconName::ArrowDown, "Normal", TodoPriority::Normal)],
    }
}

fn next_assignee_actions(assignee: TodoAssignee) -> Vec<(IconName, &'static str, TodoAssignee)> {
    match assignee {
        TodoAssignee::User => vec![
            (IconName::Bot, "Agent", TodoAssignee::Agent),
            (IconName::User, "Both", TodoAssignee::Both),
        ],
        TodoAssignee::Agent => vec![
            (IconName::User, "User", TodoAssignee::User),
            (IconName::User, "Both", TodoAssignee::Both),
        ],
        TodoAssignee::Both => vec![
            (IconName::User, "User", TodoAssignee::User),
            (IconName::Bot, "Agent", TodoAssignee::Agent),
        ],
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

struct AnnotationEmptyState<A>
where
    A: Fn() -> Box<dyn gpui::Action> + 'static,
{
    icon: AceIconName,
    label: &'static str,
    message: &'static str,
    action_icon: IconName,
    action_label: &'static str,
    action: A,
    action_enabled: bool,
}

fn annotation_empty_body<A>(theme: Theme, state: AnnotationEmptyState<A>) -> AnyElement
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
        .child(ace_icon_svg(state.icon, theme.muted))
        .child(
            div()
                .text_size(px(13.0))
                .text_color(theme.foreground.opacity(0.78))
                .child(state.label),
        )
        .child(
            div()
                .max_w(px(240.0))
                .text_size(px(12.0))
                .text_color(theme.muted)
                .child(state.message),
        )
        .when(state.action_enabled, |this| {
            this.child(action_button(
                state.action_icon,
                state.action_label,
                theme,
                state.action,
            ))
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
    div()
        .flex_1()
        .min_h_0()
        .p_3()
        .child(terminal_content(theme, projection))
        .into_any_element()
}

fn terminal_inspector_body(theme: Theme, projection: &DesktopProjection) -> AnyElement {
    terminal_content(theme, projection)
}

fn terminal_content(theme: Theme, projection: &DesktopProjection) -> AnyElement {
    if let Some(reason) = projection.services.terminal.missing_reason() {
        return empty_panel_body(theme, AceIconName::Terminal, "Terminal", reason);
    }

    if projection.chat.active_thread.is_none() {
        return empty_panel_body(
            theme,
            AceIconName::Terminal,
            "Terminal",
            "Select a thread to attach a PTY-backed terminal session.",
        );
    }

    div()
        .size_full()
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
        .font_family(theme.code_font_family)
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
        .font_family(theme.code_font_family)
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
                .font_family(theme.ui_font_family)
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

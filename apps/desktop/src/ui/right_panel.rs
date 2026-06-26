use crate::{
    actions::{SelectBottomPanelTab, SelectRightPanelTab, ToggleBottomPanel, ToggleRightPanel},
    stores::ui::{BottomPanelTab, RightPanelTab},
    ui::{components::*, layout::PanelLayout, theme::Theme},
};
use ace_runtime::chat::{ChatProjection, ThreadSummary};
use gpui::{AnyElement, IntoElement, MouseButton, div, prelude::*, px};
use gpui_component::IconName;

pub(super) fn right_panel(
    theme: Theme,
    layout: PanelLayout,
    active_tab: RightPanelTab,
    bottom_panel_visible: bool,
    resizing: bool,
    chat: ChatProjection,
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
            &chat,
        ))
        .into_any_element()
}

pub(super) fn bottom_panel(
    theme: Theme,
    layout: PanelLayout,
    active_tab: BottomPanelTab,
    resizing: bool,
    chat: ChatProjection,
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
        .child(terminal_body(theme, &chat))
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
        .unwrap_or("gpt-5-codex");
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
    chat: &ChatProjection,
) -> AnyElement {
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
                .child(right_tab(theme, active_tab, RightPanelTab::Review))
                .child(right_tab(theme, active_tab, RightPanelTab::Browser))
                .child(right_tab(theme, active_tab, RightPanelTab::Editor))
                .child(right_tab(theme, active_tab, RightPanelTab::Summary))
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
            RightPanelTab::Review => review_body(theme, chat),
            RightPanelTab::Browser => empty_panel_body(
                theme,
                AceIconName::Browser,
                "Browser",
                "No browser session is attached to this thread.",
            ),
            RightPanelTab::Editor => empty_panel_body(
                theme,
                AceIconName::Editor,
                "Editor",
                "No editor buffer is attached to this thread.",
            ),
            RightPanelTab::Summary => summary_body(theme, chat),
        }))
        .into_any_element()
}

fn right_tab(theme: Theme, active: RightPanelTab, tab: RightPanelTab) -> AnyElement {
    let selected = active == tab;
    let (icon, label) = right_tab_meta(tab);
    div()
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
        .text_color(if selected {
            theme.foreground.opacity(0.84)
        } else {
            theme.muted
        })
        .hover(|this| this.bg(theme.button))
        .child(header_ace_icon_svg(
            icon,
            if selected {
                theme.foreground.opacity(0.84)
            } else {
                theme.muted
            },
        ))
        .child(label)
        .on_mouse_up(MouseButton::Left, move |_, window, cx| {
            window.dispatch_action(Box::new(SelectRightPanelTab { tab }), cx);
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
    }
}

fn review_body(theme: Theme, chat: &ChatProjection) -> AnyElement {
    let Some(thread) = chat.active_thread.as_ref() else {
        return empty_panel_body(
            theme,
            AceIconName::Review,
            "Review",
            "No active thread is selected.",
        );
    };

    div()
        .flex()
        .flex_col()
        .gap_3()
        .child(info_row(theme, "Status", thread.status_label()))
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

fn summary_body(theme: Theme, chat: &ChatProjection) -> AnyElement {
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
        .child(info_row(theme, "Provider", thread.provider.display_name()))
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
        .into_any_element()
}

fn terminal_body(theme: Theme, chat: &ChatProjection) -> AnyElement {
    let message = if chat.active_thread.is_some() {
        "No terminal output has been recorded for this thread."
    } else {
        "Select a thread to view terminal output."
    };

    div()
        .flex_1()
        .min_h_0()
        .p_3()
        .child(empty_panel_body(
            theme,
            AceIconName::Terminal,
            "Terminal",
            message,
        ))
        .into_any_element()
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

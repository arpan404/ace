use crate::{state::DesktopProjection, theme::Theme};
use ace_runtime::chat::{
    ChatMessageRole, ChatProjection, SidebarProjection, ThreadStatus, ThreadSummary,
};
use gpui::{AnyElement, CursorStyle, IntoElement, MouseButton, div, prelude::*, px, rgb};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SplitterKind {
    Sidebar,
    RightPanel,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PanelLayout {
    pub sidebar_width: gpui::Pixels,
    pub right_panel_width: gpui::Pixels,
}

impl PanelLayout {
    pub fn new(theme: Theme) -> Self {
        Self {
            sidebar_width: theme.sidebar_width,
            right_panel_width: theme.right_panel_width,
        }
    }

    pub fn resize_sidebar(self, delta_x: gpui::Pixels, theme: Theme) -> Self {
        Self {
            sidebar_width: (self.sidebar_width + delta_x)
                .clamp(theme.sidebar_min_width, theme.sidebar_max_width),
            ..self
        }
    }

    pub fn resize_right_panel(self, delta_x: gpui::Pixels, theme: Theme) -> Self {
        Self {
            right_panel_width: (self.right_panel_width - delta_x)
                .clamp(theme.right_panel_min_width, theme.right_panel_max_width),
            ..self
        }
    }
}

pub fn shell_layout(
    theme: Theme,
    layout: PanelLayout,
    sidebar_collapsed: bool,
    projection: DesktopProjection,
) -> AnyElement {
    let sidebar = projection.sidebar.clone();
    let chat = projection.chat.clone();

    div()
        .id("ace-shell")
        .size_full()
        .flex()
        .flex_row()
        .bg(theme.background)
        .when(!sidebar_collapsed, |this| {
            this.child(sidebar_panel(theme, layout, sidebar))
                .child(vertical_splitter(
                    "sidebar-splitter",
                    SplitterKind::Sidebar,
                    theme,
                ))
        })
        .child(center_column(
            theme,
            layout,
            sidebar_collapsed,
            chat.clone(),
        ))
        .child(vertical_splitter(
            "right-panel-splitter",
            SplitterKind::RightPanel,
            theme,
        ))
        .child(right_panel(theme, layout, chat))
        .into_any_element()
}

fn sidebar_panel(theme: Theme, layout: PanelLayout, projection: SidebarProjection) -> AnyElement {
    div()
        .id("ace-sidebar")
        .w(layout.sidebar_width)
        .h_full()
        .bg(theme.sidebar)
        .border_r_1()
        .border_color(theme.border_subtle)
        .flex()
        .flex_col()
        .child(sidebar_header(theme))
        .child(scroll_y(
            div()
                .id("sidebar-project-list")
                .flex_1()
                .min_h_0()
                .px_3()
                .pt_1()
                .pb_3()
                .flex()
                .flex_col()
                .gap_2()
                .when(projection.projects.is_empty(), |this| {
                    this.child(empty_sidebar(theme))
                })
                .children(
                    projection
                        .projects
                        .into_iter()
                        .map(|group| {
                            let active_thread_id = projection.active_thread_id.clone();
                            div()
                                .flex()
                                .flex_col()
                                .gap_1()
                                .child(project_header(
                                    theme,
                                    group.project.id,
                                    group.project.name.clone(),
                                    group.project.workspace_root.clone(),
                                    group.project.icon.clone(),
                                    group.project.thread_count,
                                ))
                                .children(group.threads.into_iter().map(move |thread| {
                                    let active = active_thread_id.as_ref() == Some(&thread.id);
                                    thread_row(theme, thread, active)
                                }))
                        })
                        .collect::<Vec<_>>(),
                ),
        ))
        .child(sidebar_footer(theme, projection.total_thread_count))
        .into_any_element()
}

fn center_column(
    theme: Theme,
    _layout: PanelLayout,
    sidebar_collapsed: bool,
    chat: ChatProjection,
) -> AnyElement {
    div()
        .id("ace-center-column")
        .flex_1()
        .h_full()
        .min_w(px(420.0))
        .flex()
        .flex_col()
        .child(workspace_panel(theme, sidebar_collapsed, chat))
        .into_any_element()
}

fn workspace_panel(theme: Theme, sidebar_collapsed: bool, chat: ChatProjection) -> AnyElement {
    div()
        .id("ace-workspace")
        .flex_1()
        .min_h_0()
        .bg(theme.background)
        .flex()
        .flex_col()
        .child(workspace_chrome(theme, sidebar_collapsed))
        .child(
            div()
                .flex_1()
                .min_h_0()
                .flex()
                .flex_col()
                .child(message_timeline(theme, &chat))
                .child(chat_composer(theme, &chat)),
        )
        .into_any_element()
}

fn right_panel(theme: Theme, layout: PanelLayout, chat: ChatProjection) -> AnyElement {
    div()
        .id("ace-right-panel")
        .w(layout.right_panel_width)
        .h_full()
        .bg(theme.panel_deep)
        .border_l_1()
        .border_color(theme.border_subtle)
        .flex()
        .flex_col()
        .child(right_panel_header(theme))
        .child(right_panel_summary(theme, chat))
        .into_any_element()
}

fn sidebar_header(theme: Theme) -> AnyElement {
    div()
        .id("sidebar-header")
        .pt(px(56.0))
        .px_3()
        .pb_3()
        .flex()
        .flex_col()
        .gap_3()
        .child(
            div()
                .h(px(28.0))
                .flex()
                .flex_row()
                .items_center()
                .gap_2()
                .text_color(theme.muted)
                .child(nav_button("Back", theme))
                .child(nav_button("Forward", theme))
                .child(div().flex_1())
                .child(nav_button("Menu", theme)),
        )
        .child(
            div()
                .flex()
                .flex_col()
                .gap_2()
                .child(sidebar_command_row("N", "New chat", None, theme, || {
                    Box::new(crate::app::NewThread)
                }))
                .child(sidebar_search(theme)),
        )
        .into_any_element()
}

fn sidebar_search(theme: Theme) -> AnyElement {
    div()
        .h(px(34.0))
        .rounded_md()
        .px_2()
        .flex()
        .flex_row()
        .items_center()
        .justify_between()
        .text_size(px(13.0))
        .text_color(theme.muted)
        .hover(|this| this.bg(theme.button))
        .child(
            div()
                .flex()
                .flex_row()
                .items_center()
                .gap_2()
                .child(icon_tile("S", theme))
                .child("Search"),
        )
        .child(kbd("⌘K", theme))
        .into_any_element()
}

fn sidebar_footer(theme: Theme, total_thread_count: usize) -> AnyElement {
    div()
        .h(px(104.0))
        .border_t_1()
        .border_color(theme.border_subtle)
        .px_3()
        .py_3()
        .flex()
        .flex_col()
        .gap_2()
        .child(
            div()
                .h(px(22.0))
                .flex()
                .flex_row()
                .items_center()
                .justify_between()
                .text_size(px(12.0))
                .text_color(theme.muted_subtle)
                .child("PROJECTS")
                .child(format!("{total_thread_count} threads")),
        )
        .child(sidebar_command_row(
            "A",
            "Add current project",
            None,
            theme,
            || Box::new(crate::app::AddCurrentDirectoryProject),
        ))
        .child(sidebar_command_row("S", "Settings", None, theme, || {
            Box::new(crate::app::ToggleSidebar)
        }))
        .into_any_element()
}

fn sidebar_command_row<F>(
    icon: &'static str,
    label: &'static str,
    suffix: Option<&'static str>,
    theme: Theme,
    action: F,
) -> AnyElement
where
    F: Fn() -> Box<dyn gpui::Action> + 'static,
{
    div()
        .h(px(34.0))
        .rounded_md()
        .px_3()
        .flex()
        .flex_row()
        .items_center()
        .justify_between()
        .text_size(px(13.0))
        .text_color(theme.foreground.opacity(0.78))
        .hover(|this| this.bg(theme.button))
        .child(
            div()
                .flex()
                .flex_row()
                .items_center()
                .gap_2()
                .child(icon_tile(icon, theme))
                .child(label),
        )
        .when_some(suffix, |this, value| this.child(kbd(value, theme)))
        .on_mouse_up(MouseButton::Left, move |_, window, cx| {
            window.dispatch_action(action(), cx);
        })
        .into_any_element()
}

fn empty_sidebar(theme: Theme) -> AnyElement {
    div()
        .rounded_md()
        .border_1()
        .border_color(theme.border)
        .bg(theme.panel)
        .p_3()
        .text_size(px(12.0))
        .text_color(theme.muted)
        .child("Add a project to start a Codex chat.")
        .into_any_element()
}

fn project_header(
    theme: Theme,
    project_id: ace_core::ProjectId,
    project_name: String,
    workspace_root: String,
    icon: Option<String>,
    thread_count: usize,
) -> AnyElement {
    div()
        .mt_1()
        .rounded_md()
        .px_2()
        .py_2()
        .hover(|this| this.bg(theme.button))
        .flex()
        .flex_col()
        .gap_1()
        .child(
            div()
                .h(px(28.0))
                .flex()
                .flex_row()
                .items_center()
                .justify_between()
                .text_size(px(13.0))
                .text_color(theme.foreground.opacity(0.80))
                .child(
                    div()
                        .flex()
                        .flex_row()
                        .items_center()
                        .gap_2()
                        .child(disclosure_icon(theme))
                        .child(project_icon(icon, &project_name, theme))
                        .child(project_name),
                )
                .child(
                    div()
                        .flex()
                        .flex_row()
                        .items_center()
                        .gap_1()
                        .child(project_action_button("+", theme, move || {
                            Box::new(crate::app::NewThreadForProject { project_id })
                        }))
                        .child(project_action_button("-", theme, move || {
                            Box::new(crate::app::ArchiveProject { project_id })
                        }))
                        .child(
                            div()
                                .w(px(24.0))
                                .text_size(px(11.0))
                                .text_color(theme.muted_subtle)
                                .child(format!("{thread_count}")),
                        ),
                ),
        )
        .child(
            div()
                .pl(px(38.0))
                .text_size(px(11.0))
                .text_color(theme.muted_subtle)
                .child(workspace_root),
        )
        .into_any_element()
}

fn thread_row(theme: Theme, thread: ThreadSummary, active: bool) -> AnyElement {
    let id = thread.id.clone();
    let preview = thread
        .latest_message_preview
        .clone()
        .unwrap_or_else(|| "Draft conversation".to_string());
    div()
        .id("thread-row")
        .h(px(54.0))
        .rounded_md()
        .px_2()
        .bg(if active {
            theme.selection
        } else {
            theme.sidebar
        })
        .hover(|this| this.bg(theme.button))
        .flex()
        .flex_row()
        .items_center()
        .gap_2()
        .child(
            div()
                .w(px(22.0))
                .flex()
                .items_center()
                .justify_center()
                .child(status_dot(thread.status, theme)),
        )
        .child(
            div()
                .flex_1()
                .min_w_0()
                .overflow_hidden()
                .flex()
                .flex_col()
                .gap_1()
                .child(
                    div()
                        .text_size(px(12.0))
                        .text_color(if active {
                            theme.foreground
                        } else {
                            theme.foreground.opacity(0.72)
                        })
                        .child(thread.title.clone()),
                )
                .child(
                    div()
                        .text_size(px(10.0))
                        .text_color(theme.muted_subtle)
                        .child(preview),
                ),
        )
        .child(
            div()
                .text_size(px(10.0))
                .text_color(theme.muted_subtle)
                .child(relative_time_label(&thread.latest_activity_at)),
        )
        .when(thread.pinned, |this| {
            this.child(div().text_color(theme.accent_warning).child("pin"))
        })
        .on_mouse_up(MouseButton::Left, move |_, window, cx| {
            window.dispatch_action(
                Box::new(crate::app::OpenThread {
                    thread_id: id.clone(),
                }),
                cx,
            );
        })
        .into_any_element()
}

fn workspace_chrome(theme: Theme, sidebar_collapsed: bool) -> AnyElement {
    div()
        .id("workspace-chrome")
        .h(px(46.0))
        .border_b_1()
        .border_color(theme.border_subtle)
        .px_3()
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
                .when(sidebar_collapsed, |this| {
                    this.child(collapse_button("☰", theme))
                })
                .child(icon_button("⌘", theme)),
        )
        .child(
            div()
                .flex()
                .flex_row()
                .items_center()
                .gap_1()
                .child(icon_button("⊕", theme))
                .child(icon_button("⤢", theme))
                .child(icon_button("▭", theme)),
        )
        .into_any_element()
}

fn message_timeline(theme: Theme, chat: &ChatProjection) -> AnyElement {
    div()
        .id("chat-timeline")
        .flex_1()
        .min_h_0()
        .overflow_hidden()
        .px_5()
        .pt_5()
        .pb_4()
        .flex()
        .flex_col()
        .gap_3()
        .when(chat.messages.is_empty(), |this| {
            this.child(new_thread_landing(theme))
        })
        .children(
            chat.messages
                .iter()
                .map(|message| {
                    let label = match message.role {
                        ChatMessageRole::User => "You",
                        ChatMessageRole::Assistant => "Codex",
                        ChatMessageRole::Tool => "Tool",
                        ChatMessageRole::Plan => "Plan",
                        ChatMessageRole::Activity => "Activity",
                    };
                    div()
                        .max_w(px(760.0))
                        .rounded_md()
                        .border_1()
                        .border_color(theme.border_subtle)
                        .bg(theme.panel)
                        .p_3()
                        .flex()
                        .flex_col()
                        .gap_1()
                        .child(
                            div()
                                .text_size(px(11.0))
                                .text_color(theme.muted)
                                .child(label),
                        )
                        .child(
                            message
                                .text
                                .clone()
                                .or(message.title.clone())
                                .unwrap_or_default(),
                        )
                })
                .collect::<Vec<_>>(),
        )
        .into_any_element()
}

fn new_thread_landing(theme: Theme) -> AnyElement {
    div()
        .size_full()
        .flex()
        .items_center()
        .justify_center()
        .child(
            div()
                .w(px(760.0))
                .flex()
                .flex_col()
                .gap_5()
                .child(
                    div()
                        .text_size(px(30.0))
                        .font_weight(gpui::FontWeight::MEDIUM)
                        .text_color(theme.foreground.opacity(0.86))
                        .child("What should we build in ace?"),
                )
                .child(landing_composer(theme)),
        )
        .into_any_element()
}

fn landing_composer(theme: Theme) -> AnyElement {
    div()
        .rounded_lg()
        .border_1()
        .border_color(theme.border)
        .bg(theme.background_elevated)
        .flex()
        .flex_col()
        .child(
            div()
                .min_h(px(98.0))
                .p_4()
                .flex()
                .flex_col()
                .justify_between()
                .child(
                    div()
                        .text_size(px(14.0))
                        .text_color(theme.muted_subtle)
                        .child("Do anything"),
                )
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
                                .gap_3()
                                .child(icon_button("+", theme))
                                .child(access_chip(theme)),
                        )
                        .child(
                            div()
                                .flex()
                                .flex_row()
                                .items_center()
                                .gap_3()
                                .child(model_chip(theme, "GPT-5.5", "Medium"))
                                .child(send_button(theme)),
                        ),
                ),
        )
        .child(
            div()
                .border_t_1()
                .border_color(theme.border_subtle)
                .h(px(48.0))
                .px_4()
                .flex()
                .flex_row()
                .items_center()
                .gap_4()
                .text_size(px(13.0))
                .text_color(theme.muted)
                .child(meta_chip("◇", "ace", theme))
                .child(meta_chip("▭", "Locally", theme))
                .child(meta_chip("⑂", "fix/heavy-load-optimization", theme))
                .child(div().flex_1())
                .child(meta_chip("◉", "GitHub", theme)),
        )
        .into_any_element()
}

fn chat_composer(theme: Theme, chat: &ChatProjection) -> AnyElement {
    if chat.messages.is_empty() {
        return div().into_any_element();
    }

    let prompt = chat
        .composer
        .as_ref()
        .map(|draft| draft.prompt.clone())
        .unwrap_or_default();
    div()
        .id("chat-composer")
        .border_t_1()
        .border_color(theme.border_subtle)
        .p_3()
        .bg(theme.background)
        .child(
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
                        .min_h(px(56.0))
                        .text_size(px(14.0))
                        .text_color(if prompt.is_empty() {
                            theme.muted_subtle
                        } else {
                            theme.foreground
                        })
                        .child(if prompt.is_empty() {
                            "Do anything".to_string()
                        } else {
                            prompt
                        }),
                )
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
                                .child(icon_button("+", theme))
                                .child(access_chip(theme))
                                .child(meta_chip("▭", "Locally", theme)),
                        )
                        .child(
                            div()
                                .flex()
                                .flex_row()
                                .items_center()
                                .gap_2()
                                .when(chat.can_interrupt, |this| {
                                    this.child(action_button("■", "Interrupt", theme, || {
                                        Box::new(crate::app::InterruptActiveTurn)
                                    }))
                                })
                                .child(action_button("↑", "Send", theme, || {
                                    Box::new(crate::app::SendActiveComposer)
                                })),
                        ),
                ),
        )
        .into_any_element()
}

fn right_panel_header(theme: Theme) -> AnyElement {
    div()
        .h(px(48.0))
        .border_b_1()
        .border_color(theme.border_subtle)
        .px_3()
        .flex()
        .flex_row()
        .items_center()
        .gap_2()
        .child(panel_tab("☷", "Thread", true, theme))
        .child(div().flex_1())
        .child(collapse_button("▮", theme))
        .into_any_element()
}

fn right_panel_summary(theme: Theme, chat: ChatProjection) -> AnyElement {
    let status = chat
        .active_thread
        .as_ref()
        .map(|thread| thread.status.label())
        .unwrap_or("No Thread");
    let provider = chat
        .active_thread
        .as_ref()
        .map(|thread| thread.provider.display_name())
        .unwrap_or("Codex");
    let model = chat
        .active_thread
        .as_ref()
        .and_then(|thread| thread.model.as_deref())
        .unwrap_or("gpt-5-codex")
        .to_string();

    div()
        .flex_1()
        .min_h_0()
        .p_4()
        .flex()
        .flex_col()
        .gap_3()
        .child(section_label("THREAD"))
        .child(info_row(theme, "Provider", provider))
        .child(info_row(theme, "Status", status))
        .child(info_row(theme, "Model", &model))
        .child(section_label("ACTIONS"))
        .child(action_button("✎", "New chat", theme, || {
            Box::new(crate::app::NewThread)
        }))
        .child(action_button("⌖", "Pin active chat", theme, || {
            Box::new(crate::app::TogglePinActiveThread)
        }))
        .child(action_button("×", "Archive active chat", theme, || {
            Box::new(crate::app::ArchiveActiveThread)
        }))
        .into_any_element()
}

fn access_chip(theme: Theme) -> AnyElement {
    div()
        .h(px(28.0))
        .rounded_md()
        .px_2()
        .flex()
        .flex_row()
        .items_center()
        .gap_1()
        .text_size(px(12.0))
        .text_color(theme.accent_warning)
        .hover(|this| this.bg(theme.button))
        .child("♜")
        .child("Full access")
        .child("⌄")
        .into_any_element()
}

fn model_chip(theme: Theme, model: &'static str, effort: &'static str) -> AnyElement {
    div()
        .h(px(28.0))
        .rounded_md()
        .px_2()
        .flex()
        .flex_row()
        .items_center()
        .gap_1()
        .text_size(px(12.0))
        .text_color(theme.muted)
        .hover(|this| this.bg(theme.button))
        .child("◌")
        .child(model)
        .child(effort)
        .child("⌄")
        .into_any_element()
}

fn meta_chip(icon: &'static str, label: &'static str, theme: Theme) -> AnyElement {
    div()
        .h(px(24.0))
        .rounded_md()
        .px_1()
        .flex()
        .flex_row()
        .items_center()
        .gap_2()
        .text_size(px(12.0))
        .text_color(theme.muted)
        .child(icon)
        .child(label)
        .child("⌄")
        .into_any_element()
}

fn send_button(theme: Theme) -> AnyElement {
    div()
        .w(px(28.0))
        .h(px(28.0))
        .rounded_md()
        .bg(theme.button)
        .hover(|this| this.bg(theme.button_hover))
        .flex()
        .items_center()
        .justify_center()
        .text_color(theme.foreground.opacity(0.70))
        .child("↑")
        .on_mouse_up(MouseButton::Left, |_, window, cx| {
            window.dispatch_action(Box::new(crate::app::SendActiveComposer), cx);
        })
        .into_any_element()
}

fn status_dot(status: ThreadStatus, theme: Theme) -> AnyElement {
    let color = status_color(status, theme);
    div()
        .w(px(6.0))
        .h(px(6.0))
        .rounded_full()
        .bg(color)
        .into_any_element()
}

fn status_color(status: ThreadStatus, theme: Theme) -> gpui::Hsla {
    match status {
        ThreadStatus::Error => rgb(0xff6b6b).into(),
        ThreadStatus::Working | ThreadStatus::Connecting => theme.accent,
        ThreadStatus::PendingApproval | ThreadStatus::AwaitingInput | ThreadStatus::PlanReady => {
            theme.accent_warning
        }
        ThreadStatus::Completed => theme.accent_success,
        ThreadStatus::Draft => theme.accent_purple,
        ThreadStatus::Idle | ThreadStatus::Archived => theme.muted_subtle,
    }
}

fn scroll_y(element: gpui::Stateful<gpui::Div>) -> gpui::Stateful<gpui::Div> {
    element.overflow_y_scroll().scrollbar_width(px(8.0))
}

fn nav_button(label: &'static str, theme: Theme) -> AnyElement {
    let icon = match label {
        "Back" => "<",
        "Forward" => ">",
        "Menu" => "M",
        _ => label,
    };
    div()
        .w(px(28.0))
        .h(px(28.0))
        .rounded_md()
        .flex()
        .items_center()
        .justify_center()
        .text_size(px(12.0))
        .text_color(theme.muted)
        .hover(|this| this.bg(theme.button).text_color(theme.foreground))
        .child(icon)
        .into_any_element()
}

fn icon_tile(label: &'static str, theme: Theme) -> AnyElement {
    div()
        .w(px(18.0))
        .h(px(18.0))
        .rounded_md()
        .border_1()
        .border_color(theme.border_subtle)
        .bg(theme.panel_deep)
        .flex()
        .items_center()
        .justify_center()
        .text_size(px(10.0))
        .text_color(theme.muted)
        .child(label)
        .into_any_element()
}

fn disclosure_icon(theme: Theme) -> AnyElement {
    div()
        .w(px(16.0))
        .h(px(18.0))
        .flex()
        .items_center()
        .justify_center()
        .text_size(px(11.0))
        .text_color(theme.muted)
        .child("v")
        .into_any_element()
}

fn project_action_button<F>(label: &'static str, theme: Theme, action: F) -> AnyElement
where
    F: Fn() -> Box<dyn gpui::Action> + 'static,
{
    div()
        .w(px(22.0))
        .h(px(22.0))
        .rounded_md()
        .flex()
        .items_center()
        .justify_center()
        .text_size(px(12.0))
        .text_color(theme.muted)
        .hover(|this| this.bg(theme.button_hover).text_color(theme.foreground))
        .child(label)
        .on_mouse_up(MouseButton::Left, move |_, window, cx| {
            window.dispatch_action(action(), cx);
        })
        .into_any_element()
}

fn project_icon(icon: Option<String>, project_name: &str, theme: Theme) -> AnyElement {
    let label = icon
        .and_then(|value| value.chars().find(|ch| ch.is_ascii_alphanumeric()))
        .or_else(|| project_name.chars().find(|ch| ch.is_ascii_alphanumeric()))
        .map(|ch| ch.to_ascii_uppercase().to_string())
        .unwrap_or_else(|| "P".to_string());
    div()
        .w(px(24.0))
        .h(px(24.0))
        .rounded_md()
        .bg(theme.background_elevated)
        .border_1()
        .border_color(theme.border)
        .flex()
        .items_center()
        .justify_center()
        .text_size(px(11.0))
        .text_color(theme.accent_pink)
        .child(label)
        .into_any_element()
}

fn info_row(theme: Theme, label: &'static str, value: &str) -> AnyElement {
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
        .justify_between()
        .child(
            div()
                .text_color(theme.muted)
                .text_size(px(12.0))
                .child(label),
        )
        .child(div().text_size(px(12.0)).child(value.to_string()))
        .into_any_element()
}

fn panel_tab(icon: &'static str, label: &'static str, active: bool, theme: Theme) -> AnyElement {
    div()
        .h(px(30.0))
        .rounded_md()
        .px_2()
        .bg(if active {
            theme.button
        } else {
            theme.panel_deep
        })
        .border_1()
        .border_color(if active {
            theme.border
        } else {
            theme.border.opacity(0.0)
        })
        .flex()
        .flex_row()
        .items_center()
        .gap_2()
        .text_size(px(12.0))
        .text_color(if active {
            theme.foreground.opacity(0.84)
        } else {
            theme.muted
        })
        .child(icon)
        .child(label)
        .into_any_element()
}

fn icon_button(icon: &'static str, theme: Theme) -> AnyElement {
    div()
        .w(px(28.0))
        .h(px(28.0))
        .rounded_md()
        .flex()
        .items_center()
        .justify_center()
        .text_size(px(14.0))
        .text_color(theme.muted)
        .hover(|this| this.bg(theme.button).text_color(theme.foreground))
        .child(icon)
        .into_any_element()
}

fn action_button<F>(icon: &'static str, label: &'static str, theme: Theme, action: F) -> AnyElement
where
    F: Fn() -> Box<dyn gpui::Action> + 'static,
{
    div()
        .h(px(30.0))
        .rounded_md()
        .border_1()
        .border_color(theme.border)
        .bg(theme.button)
        .px_2()
        .flex()
        .flex_row()
        .items_center()
        .gap_2()
        .text_size(px(12.0))
        .hover(|this| this.bg(theme.button_hover))
        .child(icon)
        .child(label)
        .on_mouse_up(MouseButton::Left, move |_, window, cx| {
            window.dispatch_action(action(), cx);
        })
        .into_any_element()
}

fn vertical_splitter(id: &'static str, kind: SplitterKind, theme: Theme) -> AnyElement {
    splitter(id, kind, theme)
        .w(px(4.0))
        .h_full()
        .cursor(CursorStyle::ResizeLeftRight)
        .into_any_element()
}

fn splitter(id: &'static str, kind: SplitterKind, theme: Theme) -> gpui::Stateful<gpui::Div> {
    div()
        .id(id)
        .bg(theme.border_subtle)
        .hover(|this| this.bg(theme.accent.opacity(0.65)))
        .on_mouse_down(MouseButton::Left, move |event, window, cx| {
            window.dispatch_action(
                Box::new(crate::app::BeginPanelResize {
                    kind,
                    position: event.position,
                }),
                cx,
            );
        })
}

fn collapse_button(label: &'static str, theme: Theme) -> AnyElement {
    div()
        .id("sidebar-toggle")
        .w(px(28.0))
        .h(px(28.0))
        .rounded_md()
        .flex()
        .items_center()
        .justify_center()
        .text_color(theme.muted)
        .hover(|this| this.bg(theme.button).text_color(theme.foreground))
        .child(label)
        .on_mouse_up(MouseButton::Left, |_, window, cx| {
            window.dispatch_action(Box::new(crate::app::ToggleSidebar), cx);
        })
        .into_any_element()
}

fn kbd(label: &'static str, theme: Theme) -> AnyElement {
    div()
        .rounded_md()
        .border_1()
        .border_color(theme.border_subtle)
        .bg(theme.panel_deep)
        .px_1()
        .py_1()
        .text_size(px(10.0))
        .text_color(theme.muted_subtle)
        .child(label)
        .into_any_element()
}

fn section_label(label: &'static str) -> AnyElement {
    div()
        .mt_2()
        .text_size(px(11.0))
        .text_color(gpui::white().opacity(0.50))
        .child(label)
        .into_any_element()
}

fn relative_time_label(timestamp: &str) -> String {
    if timestamp.len() > 10 {
        return "now".to_string();
    }
    "recent".to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_collapsed_and_expanded_shell_states() {
        let theme = Theme::default();
        let layout = PanelLayout::new(theme);
        let projection = crate::state::DesktopStore::new().projection();
        let _ = shell_layout(theme, layout, false, projection.clone());
        let _ = shell_layout(theme, layout, true, projection);
    }

    #[test]
    fn panel_resize_clamps_to_theme_limits() {
        let theme = Theme::default();
        let layout = PanelLayout::new(theme);

        assert_eq!(
            layout.resize_sidebar(px(-1000.0), theme).sidebar_width,
            theme.sidebar_min_width
        );
        assert_eq!(
            layout
                .resize_right_panel(px(-1000.0), theme)
                .right_panel_width,
            theme.right_panel_max_width
        );
    }
}

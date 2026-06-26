use crate::ui::{components::*, layout::PanelLayout, theme::Theme};
use ace_runtime::chat::{SidebarProjection, ThreadStatus, ThreadSummary};
use gpui::{AnyElement, IntoElement, MouseButton, div, prelude::*, px};
use gpui_component::IconName;

pub(super) fn sidebar_panel(
    theme: Theme,
    layout: PanelLayout,
    projection: SidebarProjection,
    resizing: bool,
    reserve_titlebar_controls: bool,
) -> AnyElement {
    div()
        .id("ace-sidebar")
        .w(layout.sidebar_width)
        .h_full()
        .bg(theme.sidebar)
        .border_r_1()
        .border_color(if resizing {
            theme.foreground.opacity(0.72)
        } else {
            theme.border_subtle
        })
        .flex()
        .flex_col()
        .child(sidebar_header(theme, reserve_titlebar_controls))
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
                .gap_1()
                .children(
                    projection
                        .projects
                        .into_iter()
                        .map(|group| {
                            let active_thread_id = projection.active_thread_id.clone();
                            let total = group.project.thread_count;
                            let loaded = group.threads.len();
                            let can_show_less = loaded > 5;
                            let project = group.project;
                            let project_id = project.id;
                            div()
                                .flex()
                                .flex_col()
                                .gap(px(2.0))
                                .child(project_header(
                                    theme,
                                    project.id,
                                    project.name,
                                    project.icon,
                                    project.icon_color,
                                ))
                                .children(group.threads.into_iter().map(move |thread| {
                                    let active = active_thread_id.as_ref() == Some(&thread.id);
                                    thread_row(theme, thread, active)
                                }))
                                .when(total > loaded || can_show_less, |this| {
                                    this.child(thread_paging_row(
                                        theme,
                                        project_id,
                                        total.saturating_sub(loaded).min(5),
                                        can_show_less,
                                    ))
                                })
                        })
                        .collect::<Vec<_>>(),
                ),
        ))
        .child(sidebar_footer(theme))
        .into_any_element()
}

fn sidebar_header(theme: Theme, reserve_titlebar_controls: bool) -> AnyElement {
    div()
        .id("sidebar-header")
        .pb_3()
        .flex()
        .flex_col()
        .gap_3()
        .child(
            div()
                .h(px(48.0))
                .px_3()
                .flex()
                .flex_row()
                .items_center()
                .gap_2()
                .text_color(theme.muted)
                .when(reserve_titlebar_controls, |this| {
                    this.child(div().w(px(64.0)))
                })
                .child(ace_icon_toggle_button(
                    AceIconName::PanelLeftClosed,
                    false,
                    theme,
                    "Toggle sidebar",
                    crate::actions::ToggleSidebar,
                    || Box::new(crate::actions::ToggleSidebar),
                ))
                .child(nav_button(IconName::ChevronLeft, theme))
                .child(nav_button(IconName::ChevronRight, theme))
                .child(div().flex_1()),
        )
        .child(
            div()
                .px_3()
                .flex()
                .flex_col()
                .gap_2()
                .child(sidebar_command_row(
                    IconName::Plus,
                    "New chat",
                    None,
                    theme,
                    || Box::new(crate::actions::NewThread),
                ))
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
                .child(icon_tile(IconName::Search, theme))
                .child("Search"),
        )
        .child(kbd("⌘K", theme))
        .on_mouse_up(MouseButton::Left, |_, window, cx| {
            window.dispatch_action(Box::new(crate::actions::OpenSearchPalette), cx);
        })
        .into_any_element()
}

fn sidebar_footer(theme: Theme) -> AnyElement {
    div()
        .px_3()
        .pt_2()
        .pb_3()
        .flex()
        .flex_col()
        .gap_2()
        .child(sidebar_ace_command_row(
            AceIconName::TablerSettings,
            "Settings",
            None,
            theme,
            || Box::new(crate::actions::ToggleSidebar),
        ))
        .into_any_element()
}

fn sidebar_ace_command_row<F>(
    icon: AceIconName,
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
        .rounded_lg()
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
                .child(ace_icon_tile(icon, theme))
                .child(label),
        )
        .when_some(suffix, |this, value| this.child(kbd(value, theme)))
        .on_mouse_up(MouseButton::Left, move |_, window, cx| {
            window.dispatch_action(action(), cx);
        })
        .into_any_element()
}

fn sidebar_command_row<F>(
    icon: IconName,
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

fn project_header(
    theme: Theme,
    project_id: ace_core::ProjectId,
    project_name: String,
    icon: Option<String>,
    icon_color: Option<String>,
) -> AnyElement {
    div()
        .mt(px(2.0))
        .rounded_md()
        .px_1()
        .py_1()
        .hover(|this| this.bg(theme.button))
        .flex()
        .flex_col()
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
                        .child(project_icon(icon, icon_color, &project_name, theme))
                        .child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .overflow_hidden()
                                .text_ellipsis()
                                .whitespace_nowrap()
                                .child(project_name),
                        ),
                )
                .child(
                    div()
                        .flex()
                        .flex_row()
                        .items_center()
                        .gap_1()
                        .child(project_action_button(IconName::Plus, theme, move || {
                            Box::new(crate::actions::NewThreadForProject { project_id })
                        }))
                        .child(project_ace_action_button(
                            AceIconName::Archive,
                            theme,
                            move || Box::new(crate::actions::ArchiveProject { project_id }),
                        )),
                ),
        )
        .into_any_element()
}

fn thread_row(theme: Theme, thread: ThreadSummary, active: bool) -> AnyElement {
    let id = thread.id.clone();
    div()
        .id("thread-row")
        .h(px(28.0))
        .rounded_md()
        .pl(px(24.0))
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
        .when_some(thread.branch.clone(), |this, branch| {
            this.child(
                div()
                    .max_w(px(74.0))
                    .overflow_hidden()
                    .text_ellipsis()
                    .whitespace_nowrap()
                    .text_size(px(10.0))
                    .text_color(theme.muted_subtle)
                    .child(branch),
            )
        })
        .on_mouse_up(MouseButton::Left, move |_, window, cx| {
            window.dispatch_action(
                Box::new(crate::actions::OpenThread {
                    thread_id: id.clone(),
                }),
                cx,
            );
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
        ThreadStatus::Draft => theme.muted_subtle,
        ThreadStatus::Idle | ThreadStatus::Archived => theme.muted_subtle,
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

fn project_ace_action_button<F>(icon: AceIconName, theme: Theme, action: F) -> AnyElement
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
        .text_color(theme.muted)
        .hover(|this| this.bg(theme.button_hover).text_color(theme.foreground))
        .child(ace_icon_svg(icon, theme.muted))
        .on_mouse_up(MouseButton::Left, move |_, window, cx| {
            window.dispatch_action(action(), cx);
        })
        .into_any_element()
}

fn thread_paging_row(
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

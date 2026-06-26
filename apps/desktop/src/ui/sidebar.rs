use crate::ui::{components::*, layout::PanelLayout, theme::Theme};
use ace_runtime::chat::{SidebarProjection, ThreadSummary};
use gpui::{AnyElement, IntoElement, MouseButton, div, prelude::*, px};
use gpui_component::IconName;

pub(super) fn sidebar_panel(
    theme: Theme,
    layout: PanelLayout,
    projection: SidebarProjection,
) -> AnyElement {
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
                            let total = group.project.thread_count;
                            let loaded = group.threads.len();
                            let can_show_less = loaded > 5;
                            let visible_threads = group.threads.into_iter().collect::<Vec<_>>();
                            div()
                                .flex()
                                .flex_col()
                                .gap_1()
                                .child(project_header(
                                    theme,
                                    group.project.id,
                                    group.project.name.clone(),
                                    group.project.icon.clone(),
                                    group.project.thread_count,
                                ))
                                .children(visible_threads.into_iter().map(move |thread| {
                                    let active = active_thread_id.as_ref() == Some(&thread.id);
                                    thread_row(theme, thread, active)
                                }))
                                .when(total > loaded || can_show_less, |this| {
                                    this.child(thread_paging_row(
                                        theme,
                                        group.project.id,
                                        total.saturating_sub(loaded).min(5),
                                        can_show_less,
                                    ))
                                })
                        })
                        .collect::<Vec<_>>(),
                ),
        ))
        .child(sidebar_footer(theme, projection.total_thread_count))
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
                .child(nav_button(IconName::ChevronLeft, theme))
                .child(nav_button(IconName::ChevronRight, theme))
                .child(div().flex_1())
                .child(nav_button(IconName::Menu, theme)),
        )
        .child(
            div()
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
            IconName::Plus,
            "Add current project",
            None,
            theme,
            || Box::new(crate::actions::AddCurrentDirectoryProject),
        ))
        .child(sidebar_command_row(
            IconName::Settings,
            "Settings",
            None,
            theme,
            || Box::new(crate::actions::ToggleSidebar),
        ))
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
                        .child(project_icon(icon, &project_name, theme))
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
                        .child(project_action_button(IconName::Minus, theme, move || {
                            Box::new(crate::actions::ArchiveProject { project_id })
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
        .into_any_element()
}

fn thread_row(theme: Theme, thread: ThreadSummary, active: bool) -> AnyElement {
    let id = thread.id.clone();
    div()
        .id("thread-row")
        .h(px(32.0))
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
                .pl(px(30.0))
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

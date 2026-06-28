mod header;
mod project;
mod thread;

use crate::ui::{
    components::scroll_y,
    layout::PanelLayout,
    sidebar::header::{sidebar_footer, sidebar_header},
    sidebar::project::project_header,
    sidebar::thread::{thread_paging_row, thread_row},
    theme::Theme,
};
use ace_runtime::chat::SidebarProjection;
use gpui::{AnyElement, IntoElement, div, prelude::*};

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
                                .gap(gpui::px(2.0))
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

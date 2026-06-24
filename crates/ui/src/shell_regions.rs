use crate::{
    components::{ButtonSize, ButtonVariant, button, icon_button, panel_title, sidebar_row},
    icons::{IconKind, icon},
    panels,
    shell::{AppShell, ShellViewModel},
    state::FocusedField,
    theme::{colors, metrics},
};
use gpui::{
    AnyElement, Context, FontWeight, InteractiveElement, IntoElement, ParentElement,
    StatefulInteractiveElement, Styled, div, px, rgb,
};

pub(super) fn sidebar(shell: &AppShell, cx: &mut Context<AppShell>) -> AnyElement {
    div()
        .id("ace-sidebar")
        .w(px(metrics::SIDEBAR_WIDTH))
        .min_w(px(metrics::SIDEBAR_WIDTH))
        .h_full()
        .flex()
        .flex_col()
        .border_r_1()
        .border_color(rgb(colors::BORDER))
        .bg(rgb(colors::SIDEBAR))
        .child(sidebar_header())
        .child(sidebar_nav(cx))
        .child(sidebar_threads(shell, cx))
        .child(sidebar_footer())
        .into_any_element()
}

pub(super) fn workbench(
    model: &ShellViewModel,
    shell: &AppShell,
    cx: &mut Context<AppShell>,
) -> AnyElement {
    div()
        .id("ace-workbench")
        .flex()
        .flex_1()
        .min_w_0()
        .min_h_0()
        .flex_col()
        .bg(rgb(colors::APP))
        .child(panels::chat_workspace(shell, cx))
        .child(panels::terminal_panel(model))
        .into_any_element()
}

fn sidebar_header() -> AnyElement {
    div()
        .h(px(52.0))
        .flex()
        .items_center()
        .justify_between()
        .px(px(12.0))
        .child(
            div()
                .flex()
                .items_center()
                .gap(px(10.0))
                .child(dot(colors::DANGER))
                .child(dot(colors::WARNING))
                .child(dot(colors::SUCCESS)),
        )
        .child(button("Update", ButtonVariant::Primary, ButtonSize::Small))
        .into_any_element()
}

fn sidebar_nav(cx: &mut Context<AppShell>) -> AnyElement {
    div()
        .px(px(6.0))
        .pb(px(12.0))
        .flex()
        .flex_col()
        .gap(px(2.0))
        .child(
            div()
                .id("sidebar-new-chat")
                .on_click(cx.listener(|this, _, _, cx| this.create_thread(cx)))
                .child(sidebar_row(
                    "New chat",
                    None,
                    false,
                    Some(IconKind::NewChat),
                )),
        )
        .child(sidebar_row("Search", None, false, Some(IconKind::Search)))
        .child(sidebar_row("Plugins", None, false, Some(IconKind::Plugin)))
        .child(sidebar_row(
            "Automations",
            None,
            false,
            Some(IconKind::Automation),
        ))
        .into_any_element()
}

fn sidebar_threads(shell: &AppShell, cx: &mut Context<AppShell>) -> AnyElement {
    let state = shell.state();
    let project_focused = state.focused_field == FocusedField::ProjectPath;
    div()
        .flex_1()
        .min_h_0()
        .px(px(6.0))
        .flex()
        .flex_col()
        .gap(px(2.0))
        .child(panel_title("Pinned"))
        .children(
            state
                .threads
                .iter()
                .take(7)
                .enumerate()
                .map(|(index, thread)| {
                    let thread_id = thread.id.clone();
                    div()
                        .id(("sidebar-thread", index))
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.select_thread(thread_id.clone(), cx);
                        }))
                        .child(sidebar_row(
                            &thread.title,
                            Some(&thread.updated),
                            state.selected_thread_id.as_deref() == Some(thread.id.as_str()),
                            None,
                        ))
                        .into_any_element()
                }),
        )
        .child(panel_title("Projects"))
        .child(project_input(
            &state.project_path_text,
            project_focused,
            shell.project_focus(),
            cx,
        ))
        .children(state.projects.iter().enumerate().map(|(index, project)| {
            let root = project.workspace_root.clone();
            div()
                .id(("sidebar-project", index))
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.select_project(root.clone(), cx);
                }))
                .child(project_row(
                    &project.title,
                    state.selected_project_root.as_deref() == Some(project.workspace_root.as_str()),
                ))
                .into_any_element()
        }))
        .children(state.threads.iter().filter_map(|thread| {
            let root = state.selected_project_root.as_ref()?;
            if thread.project_root.as_deref() != Some(root.as_str()) {
                return None;
            }
            Some(project_thread(&thread.title, &thread.updated))
        }))
        .child(status_line(state.status.as_str(), state.error.as_deref()))
        .into_any_element()
}

fn sidebar_footer() -> AnyElement {
    div()
        .h(px(52.0))
        .px(px(6.0))
        .flex()
        .items_center()
        .border_t_1()
        .border_color(rgb(colors::BORDER_SUBTLE))
        .child(sidebar_row(
            "Settings",
            None,
            false,
            Some(IconKind::Settings),
        ))
        .into_any_element()
}

fn project_input(
    value: &str,
    focused: bool,
    focus: gpui::FocusHandle,
    cx: &mut Context<AppShell>,
) -> AnyElement {
    div()
        .h(px(38.0))
        .mb(px(6.0))
        .px(px(7.0))
        .flex()
        .items_center()
        .gap(px(8.0))
        .rounded(px(8.0))
        .border_1()
        .border_color(rgb(if focused {
            colors::ACCENT
        } else {
            colors::BORDER
        }))
        .bg(rgb(colors::PANE))
        .id("project-path-input")
        .track_focus(&focus)
        .on_click(cx.listener(|this, _, window, cx| this.focus_project_path(window, cx)))
        .child(icon(IconKind::Add))
        .child(
            div()
                .min_w_0()
                .flex_1()
                .text_color(rgb(if value.is_empty() {
                    colors::TEXT_SUBTLE
                } else {
                    colors::TEXT
                }))
                .child(if value.is_empty() {
                    "Add project path".to_owned()
                } else {
                    value.to_owned()
                }),
        )
        .child(
            div()
                .id("project-add-submit")
                .on_click(cx.listener(|this, _, _, cx| this.add_project(cx)))
                .child(icon_button(IconKind::Send)),
        )
        .into_any_element()
}

fn project_row(label: &str, active: bool) -> AnyElement {
    div()
        .h(px(32.0))
        .flex()
        .items_center()
        .gap(px(8.0))
        .px(px(7.0))
        .rounded(px(8.0))
        .bg(rgb(if active {
            colors::SELECTED
        } else {
            colors::SIDEBAR
        }))
        .text_color(rgb(colors::TEXT_MUTED))
        .child(icon(IconKind::Folder))
        .child(div().font_weight(FontWeight(600.0)).child(label.to_owned()))
        .into_any_element()
}

fn project_thread(label: &str, meta: &str) -> AnyElement {
    div()
        .ml(px(28.0))
        .child(sidebar_row(label, Some(meta), false, None))
        .into_any_element()
}

fn status_line(status: &str, error: Option<&str>) -> AnyElement {
    div()
        .mt(px(8.0))
        .px(px(7.0))
        .text_size(px(12.0))
        .text_color(rgb(if error.is_some() {
            colors::DANGER
        } else {
            colors::TEXT_SUBTLE
        }))
        .child(error.unwrap_or(status).to_owned())
        .into_any_element()
}

fn dot(color: u32) -> AnyElement {
    div()
        .size(px(12.0))
        .rounded_full()
        .bg(rgb(color))
        .into_any_element()
}

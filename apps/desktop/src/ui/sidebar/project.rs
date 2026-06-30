use crate::{
    stores::ui::RightPanelTab,
    ui::{components::*, theme::Theme},
};
use gpui::{AnyElement, IntoElement, MouseButton, div, prelude::*, px};
use gpui_component::{IconName, tooltip::Tooltip};

pub(super) fn project_header(
    theme: Theme,
    project_id: ace_core::ProjectId,
    project_name: String,
    icon: Option<String>,
    icon_color: Option<String>,
) -> AnyElement {
    div()
        .mt(px(2.0))
        .rounded_lg()
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
                        .child(project_icon(icon, icon_color, theme))
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
                        .child(ace_action_button(
                            AceIconName::Terminal,
                            "Open project terminal",
                            theme,
                            move || {
                                Box::new(crate::actions::OpenProjectRightPanelTab {
                                    project_id,
                                    tab: RightPanelTab::Terminal,
                                })
                            },
                        ))
                        .child(ace_action_button(
                            AceIconName::Browser,
                            "Open project browser preview",
                            theme,
                            move || {
                                Box::new(crate::actions::OpenProjectRightPanelTab {
                                    project_id,
                                    tab: RightPanelTab::Browser,
                                })
                            },
                        ))
                        .child(ace_action_button(
                            AceIconName::Review,
                            "Show project worktrees",
                            theme,
                            move || {
                                Box::new(crate::actions::OpenProjectRightPanelTab {
                                    project_id,
                                    tab: RightPanelTab::Worktrees,
                                })
                            },
                        ))
                        .child(ace_action_button(
                            AceIconName::SquarePen,
                            "New thread in project",
                            theme,
                            move || Box::new(crate::actions::NewThreadForProject { project_id }),
                        )),
                ),
        )
        .into_any_element()
}

fn ace_action_button<F>(
    icon: AceIconName,
    tooltip: &'static str,
    theme: Theme,
    action: F,
) -> AnyElement
where
    F: Fn() -> Box<dyn gpui::Action> + 'static,
{
    button(theme, ace_icon_svg(icon, theme.muted), tooltip, action)
}

fn button<F>(theme: Theme, icon: AnyElement, tooltip: &'static str, action: F) -> AnyElement
where
    F: Fn() -> Box<dyn gpui::Action> + 'static,
{
    div()
        .id(tooltip)
        .w(px(20.0))
        .h(px(20.0))
        .rounded_lg()
        .flex()
        .items_center()
        .justify_center()
        .text_color(theme.muted)
        .hover(|this| this.bg(theme.button_hover).text_color(theme.foreground))
        .child(icon)
        .tooltip(move |window, cx| Tooltip::new(tooltip).build(window, cx))
        .on_mouse_up(MouseButton::Left, move |_, window, cx| {
            window.dispatch_action(action(), cx);
        })
        .into_any_element()
}

fn project_icon(icon: Option<String>, icon_color: Option<String>, theme: Theme) -> AnyElement {
    let color = theme.project_icon_color(icon_color.as_deref());
    div()
        .w(px(10.0))
        .h(px(10.0))
        .flex()
        .items_center()
        .justify_center()
        .child(project_glyph(icon.as_deref(), color))
        .into_any_element()
}

fn project_glyph(glyph: Option<&str>, color: gpui::Hsla) -> AnyElement {
    match glyph {
        Some("terminal") => ace_icon_svg(AceIconName::TablerTerminal, color),
        Some("code") => ace_icon_svg(AceIconName::Code2, color),
        Some("flask") => ace_icon_svg(AceIconName::FlaskConical, color),
        Some("rocket") => ace_icon_svg(AceIconName::Rocket, color),
        Some("package") => ace_icon_svg(AceIconName::Box, color),
        Some("github") => icon_svg(IconName::GitHub, color),
        Some("globe") => icon_svg(IconName::Globe, color),
        Some("bot") => icon_svg(IconName::Bot, color),
        _ => icon_svg(IconName::Folder, color),
    }
}

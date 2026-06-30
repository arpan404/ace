use crate::ui::{components::*, theme::Theme};
use gpui::{AnyElement, IntoElement, MouseButton, div, prelude::*, px};
use gpui_component::IconName;

pub(super) fn sidebar_header(theme: Theme, reserve_titlebar_controls: bool) -> AnyElement {
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
                .child(div().flex_1()),
        )
        .child(
            div()
                .px_3()
                .flex()
                .flex_col()
                .gap_2()
                .child(command_row(IconName::Plus, "New chat", None, theme, || {
                    Box::new(crate::actions::NewThread)
                }))
                .child(sidebar_search(theme)),
        )
        .child(
            div()
                .px_3()
                .flex()
                .flex_col()
                .gap_1()
                .child(command_row(
                    IconName::Calendar,
                    "Scheduled",
                    None,
                    theme,
                    || {
                        Box::new(crate::actions::SelectRightPanelTab {
                            tab: crate::stores::ui::RightPanelTab::Scheduled,
                        })
                    },
                ))
                .child(ace_command_row(
                    AceIconName::Box,
                    "Plugins",
                    None,
                    theme,
                    || {
                        Box::new(crate::actions::SelectRightPanelTab {
                            tab: crate::stores::ui::RightPanelTab::Plugins,
                        })
                    },
                ))
                .child(ace_command_row(
                    AceIconName::FlaskConical,
                    "Skills",
                    None,
                    theme,
                    || {
                        Box::new(crate::actions::SelectRightPanelTab {
                            tab: crate::stores::ui::RightPanelTab::Skills,
                        })
                    },
                ))
                .child(ace_command_row(
                    AceIconName::Code2,
                    "Providers",
                    None,
                    theme,
                    || {
                        Box::new(crate::actions::SelectRightPanelTab {
                            tab: crate::stores::ui::RightPanelTab::Providers,
                        })
                    },
                )),
        )
        .into_any_element()
}

pub(super) fn sidebar_footer(theme: Theme) -> AnyElement {
    div()
        .px_3()
        .pt_2()
        .pb_3()
        .flex()
        .flex_col()
        .gap_2()
        .child(ace_command_row(
            AceIconName::TablerSettings,
            "Settings",
            None,
            theme,
            || {
                Box::new(crate::actions::SelectRightPanelTab {
                    tab: crate::stores::ui::RightPanelTab::Settings,
                })
            },
        ))
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

fn ace_command_row<F>(
    icon: AceIconName,
    label: &'static str,
    suffix: Option<&'static str>,
    theme: Theme,
    action: F,
) -> AnyElement
where
    F: Fn() -> Box<dyn gpui::Action> + 'static,
{
    row(theme, label, suffix, ace_icon_tile(icon, theme), action)
}

fn command_row<F>(
    icon: IconName,
    label: &'static str,
    suffix: Option<&'static str>,
    theme: Theme,
    action: F,
) -> AnyElement
where
    F: Fn() -> Box<dyn gpui::Action> + 'static,
{
    row(theme, label, suffix, icon_tile(icon, theme), action)
}

fn row<F>(
    theme: Theme,
    label: &'static str,
    suffix: Option<&'static str>,
    icon: AnyElement,
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
                .child(icon)
                .child(label),
        )
        .when_some(suffix, |this, value| this.child(kbd(value, theme)))
        .on_mouse_up(MouseButton::Left, move |_, window, cx| {
            window.dispatch_action(action(), cx);
        })
        .into_any_element()
}

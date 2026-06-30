use crate::{
    stores::ui::RightPanelTab,
    ui::{components::*, theme::Theme},
};
use gpui::{AnyElement, IntoElement, MouseButton, div, prelude::*, px};
use gpui_component::{IconName, tooltip::Tooltip};

#[derive(Clone, Debug, Default)]
pub(in crate::ui) struct SidebarHeaderMetrics {
    pub plugin_count: usize,
    pub skill_count: usize,
    pub provider_count: usize,
    pub model_count: usize,
    pub active_right_tab: Option<RightPanelTab>,
}

pub(super) fn sidebar_header(
    theme: Theme,
    reserve_titlebar_controls: bool,
    metrics: SidebarHeaderMetrics,
) -> AnyElement {
    let plugin_suffix = count_badge(metrics.plugin_count);
    let skill_suffix = count_badge(metrics.skill_count);
    let provider_model_suffix = provider_model_badge(metrics.provider_count, metrics.model_count);

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
                .child(command_row(
                    IconName::Plus,
                    "New chat",
                    None,
                    false,
                    "Create a new thread",
                    theme,
                    || Box::new(crate::actions::NewThread),
                ))
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
                    nav_tab_active(metrics.active_right_tab, RightPanelTab::Scheduled),
                    "Open scheduled tasks",
                    theme,
                    || {
                        Box::new(crate::actions::SelectRightPanelTab {
                            tab: RightPanelTab::Scheduled,
                        })
                    },
                ))
                .child(ace_command_row(
                    AceIconName::Box,
                    "Plugins",
                    plugin_suffix,
                    nav_tab_active(metrics.active_right_tab, RightPanelTab::Plugins),
                    "Manage plugin registry entries",
                    theme,
                    || {
                        Box::new(crate::actions::SelectRightPanelTab {
                            tab: RightPanelTab::Plugins,
                        })
                    },
                ))
                .child(ace_command_row(
                    AceIconName::FlaskConical,
                    "Skills",
                    skill_suffix,
                    nav_tab_active(metrics.active_right_tab, RightPanelTab::Skills),
                    "Manage skill registry entries",
                    theme,
                    || {
                        Box::new(crate::actions::SelectRightPanelTab {
                            tab: RightPanelTab::Skills,
                        })
                    },
                ))
                .child(ace_command_row(
                    AceIconName::Code2,
                    "Providers/Models",
                    provider_model_suffix,
                    nav_tab_active(metrics.active_right_tab, RightPanelTab::Providers),
                    "Configure providers and select models",
                    theme,
                    || {
                        Box::new(crate::actions::SelectRightPanelTab {
                            tab: RightPanelTab::Providers,
                        })
                    },
                )),
        )
        .into_any_element()
}

pub(super) fn sidebar_footer(theme: Theme, active_right_tab: Option<RightPanelTab>) -> AnyElement {
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
            nav_tab_active(active_right_tab, RightPanelTab::Settings),
            "Open appearance and workspace settings",
            theme,
            || {
                Box::new(crate::actions::SelectRightPanelTab {
                    tab: RightPanelTab::Settings,
                })
            },
        ))
        .into_any_element()
}

fn sidebar_search(theme: Theme) -> AnyElement {
    div()
        .id("sidebar-search")
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
        .tooltip(move |window, cx| Tooltip::new("Open command palette").build(window, cx))
        .on_mouse_up(MouseButton::Left, |_, window, cx| {
            window.dispatch_action(Box::new(crate::actions::OpenSearchPalette), cx);
        })
        .into_any_element()
}

fn ace_command_row<F>(
    icon: AceIconName,
    label: &'static str,
    suffix: Option<String>,
    active: bool,
    tooltip: &'static str,
    theme: Theme,
    action: F,
) -> AnyElement
where
    F: Fn() -> Box<dyn gpui::Action> + 'static,
{
    row(
        theme,
        label,
        suffix,
        active,
        tooltip,
        ace_icon_tile(icon, theme),
        action,
    )
}

fn command_row<F>(
    icon: IconName,
    label: &'static str,
    suffix: Option<String>,
    active: bool,
    tooltip: &'static str,
    theme: Theme,
    action: F,
) -> AnyElement
where
    F: Fn() -> Box<dyn gpui::Action> + 'static,
{
    row(
        theme,
        label,
        suffix,
        active,
        tooltip,
        icon_tile(icon, theme),
        action,
    )
}

fn row<F>(
    theme: Theme,
    label: &'static str,
    suffix: Option<String>,
    active: bool,
    tooltip: &'static str,
    icon: AnyElement,
    action: F,
) -> AnyElement
where
    F: Fn() -> Box<dyn gpui::Action> + 'static,
{
    div()
        .id(label)
        .h(px(34.0))
        .rounded_md()
        .px_3()
        .flex()
        .flex_row()
        .items_center()
        .justify_between()
        .text_size(px(13.0))
        .text_color(if active {
            theme.foreground
        } else {
            theme.foreground.opacity(0.78)
        })
        .bg(if active {
            theme.selection
        } else {
            theme.sidebar
        })
        .hover(move |this| {
            this.bg(if active {
                theme.selection
            } else {
                theme.button
            })
        })
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
        .tooltip(move |window, cx| Tooltip::new(tooltip).build(window, cx))
        .on_mouse_up(MouseButton::Left, move |_, window, cx| {
            window.dispatch_action(action(), cx);
        })
        .into_any_element()
}

fn nav_tab_active(active_right_tab: Option<RightPanelTab>, tab: RightPanelTab) -> bool {
    active_right_tab == Some(tab)
}

fn count_badge(count: usize) -> Option<String> {
    (count > 0).then(|| count.to_string())
}

fn provider_model_badge(provider_count: usize, model_count: usize) -> Option<String> {
    match (provider_count, model_count) {
        (0, 0) => None,
        (_, 0) => Some(provider_count.to_string()),
        (0, _) => Some(format!("0/{model_count}")),
        _ => Some(format!("{provider_count}/{model_count}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_model_badge_summarizes_backed_registry_counts() {
        assert_eq!(provider_model_badge(0, 0), None);
        assert_eq!(provider_model_badge(2, 0), Some("2".to_string()));
        assert_eq!(provider_model_badge(0, 8), Some("0/8".to_string()));
        assert_eq!(provider_model_badge(2, 37), Some("2/37".to_string()));
    }

    #[test]
    fn global_nav_active_state_tracks_visible_right_panel_tab() {
        assert!(nav_tab_active(
            Some(RightPanelTab::Providers),
            RightPanelTab::Providers
        ));
        assert!(!nav_tab_active(
            Some(RightPanelTab::Providers),
            RightPanelTab::Skills
        ));
        assert!(!nav_tab_active(None, RightPanelTab::Settings));
    }
}

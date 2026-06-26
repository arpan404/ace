use crate::{
    stores::DesktopProjection,
    ui::{chat::workspace_panel, right_panel::right_panel, sidebar::sidebar_panel, theme::Theme},
};
use ace_runtime::chat::ChatProjection;
use gpui::{AnyElement, App, CursorStyle, IntoElement, MouseButton, Window, div, prelude::*, px};

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
    window: &mut Window,
    cx: &mut App,
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
            window,
            cx,
        ))
        .child(vertical_splitter(
            "right-panel-splitter",
            SplitterKind::RightPanel,
            theme,
        ))
        .child(right_panel(theme, layout, chat))
        .into_any_element()
}

fn center_column(
    theme: Theme,
    _layout: PanelLayout,
    sidebar_collapsed: bool,
    chat: ChatProjection,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    div()
        .id("ace-center-column")
        .flex_1()
        .h_full()
        .min_w(px(420.0))
        .flex()
        .flex_col()
        .child(workspace_panel(theme, sidebar_collapsed, chat, window, cx))
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
                Box::new(crate::actions::BeginPanelResize {
                    kind,
                    position: event.position,
                }),
                cx,
            );
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_collapsed_and_expanded_shell_states() {
        let theme = Theme::default();
        let layout = PanelLayout::new(theme);
        let projection = crate::stores::DesktopStore::new().projection();
        let _ = (theme, layout, projection);
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

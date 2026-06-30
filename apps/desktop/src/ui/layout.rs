use crate::{
    stores::{DesktopProjection, ui::UiState},
    ui::{
        chat::workspace_panel,
        right_panel::{bottom_panel, right_panel},
        sidebar::sidebar_panel,
        theme::Theme,
    },
};
use gpui::{AnyElement, App, CursorStyle, IntoElement, MouseButton, Window, div, prelude::*, px};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SplitterKind {
    Sidebar,
    RightPanel,
    BottomPanel,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PanelLayout {
    pub bottom_panel_height: gpui::Pixels,
    pub sidebar_width: gpui::Pixels,
    pub right_panel_width: gpui::Pixels,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ShellChrome {
    pub active_splitter: Option<SplitterKind>,
    pub reserve_titlebar_controls: bool,
}

impl PanelLayout {
    pub fn new(theme: Theme) -> Self {
        Self {
            bottom_panel_height: theme.bottom_panel_height,
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

    pub fn resize_bottom_panel(self, delta_y: gpui::Pixels, theme: Theme) -> Self {
        Self {
            bottom_panel_height: (self.bottom_panel_height - delta_y)
                .clamp(theme.bottom_panel_min_height, theme.bottom_panel_max_height),
            ..self
        }
    }
}

pub fn shell_layout(
    theme: Theme,
    layout: PanelLayout,
    ui_state: UiState,
    projection: DesktopProjection,
    chrome: ShellChrome,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let sidebar = projection.sidebar.clone();

    div()
        .id("ace-shell")
        .size_full()
        .flex()
        .flex_row()
        .bg(theme.background)
        .when(!ui_state.sidebar_collapsed, |this| {
            this.child(sidebar_panel(
                theme,
                layout,
                sidebar,
                chrome.active_splitter == Some(SplitterKind::Sidebar),
                chrome.reserve_titlebar_controls,
            ))
            .child(vertical_splitter(
                "sidebar-splitter",
                SplitterKind::Sidebar,
                theme,
                chrome.active_splitter == Some(SplitterKind::Sidebar),
            ))
        })
        .child(main_column(
            theme,
            layout,
            ui_state.clone(),
            projection,
            chrome,
            window,
            cx,
        ))
        .into_any_element()
}

fn main_column(
    theme: Theme,
    layout: PanelLayout,
    ui_state: UiState,
    projection: DesktopProjection,
    chrome: ShellChrome,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let bottom_tab = ui_state.bottom_panel_tab;
    div()
        .id("ace-main-column")
        .flex_1()
        .h_full()
        .min_w(px(420.0))
        .flex()
        .flex_col()
        .child(main_content_row(
            theme,
            layout,
            ui_state.clone(),
            projection.clone(),
            chrome,
            window,
            cx,
        ))
        .when(ui_state.bottom_panel_visible, |this| {
            this.child(horizontal_splitter(
                "bottom-panel-splitter",
                SplitterKind::BottomPanel,
                theme,
                chrome.active_splitter == Some(SplitterKind::BottomPanel),
            ))
            .child(bottom_panel(
                theme,
                layout,
                bottom_tab,
                chrome.active_splitter == Some(SplitterKind::BottomPanel),
                projection,
            ))
        })
        .into_any_element()
}

fn main_content_row(
    theme: Theme,
    layout: PanelLayout,
    ui_state: UiState,
    projection: DesktopProjection,
    chrome: ShellChrome,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    div()
        .id("ace-main-content-row")
        .flex_1()
        .min_h_0()
        .flex()
        .flex_row()
        .child(center_column(
            theme,
            ui_state.clone(),
            projection.clone(),
            chrome.reserve_titlebar_controls,
            window,
            cx,
        ))
        .when(ui_state.right_panel_visible, |this| {
            this.child(vertical_splitter(
                "right-panel-splitter",
                SplitterKind::RightPanel,
                theme,
                chrome.active_splitter == Some(SplitterKind::RightPanel),
            ))
            .child(right_panel(
                theme,
                layout,
                ui_state.right_panel_tab,
                ui_state.bottom_panel_visible,
                chrome.active_splitter == Some(SplitterKind::RightPanel),
                projection,
            ))
        })
        .into_any_element()
}

fn center_column(
    theme: Theme,
    ui_state: UiState,
    projection: DesktopProjection,
    reserve_titlebar_controls: bool,
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
        .child(workspace_panel(
            theme,
            &ui_state,
            projection,
            reserve_titlebar_controls,
            window,
            cx,
        ))
        .into_any_element()
}

fn vertical_splitter(
    id: &'static str,
    kind: SplitterKind,
    theme: Theme,
    active: bool,
) -> AnyElement {
    div()
        .id(id)
        .relative()
        .w(px(0.0))
        .h_full()
        .child(splitter_hit_target(kind, theme, active).w(px(8.0)).h_full())
        .into_any_element()
}

fn horizontal_splitter(
    id: &'static str,
    kind: SplitterKind,
    theme: Theme,
    active: bool,
) -> AnyElement {
    div()
        .id(id)
        .relative()
        .w_full()
        .h(px(0.0))
        .child(splitter_hit_target(kind, theme, active).w_full().h(px(8.0)))
        .into_any_element()
}

fn splitter_hit_target(kind: SplitterKind, _theme: Theme, _active: bool) -> gpui::Div {
    let cursor = match kind {
        SplitterKind::BottomPanel => CursorStyle::ResizeUpDown,
        SplitterKind::Sidebar | SplitterKind::RightPanel => CursorStyle::ResizeLeftRight,
    };
    div()
        .absolute()
        .top(px(-4.0))
        .left(px(-4.0))
        .cursor(cursor)
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
        assert_eq!(
            layout
                .resize_bottom_panel(px(-1000.0), theme)
                .bottom_panel_height,
            theme.bottom_panel_max_height
        );
    }
}

use crate::{
    app::{
        AddCurrentDirectoryProject, ArchiveActiveThread, ArchiveProject, BeginPanelResize,
        InterruptActiveTurn, NewThread, NewThreadForProject, OpenThread, SendActiveComposer,
        TogglePinActiveThread, ToggleSidebar,
    },
    layout::{PanelLayout, SplitterKind, shell_layout},
    state::DesktopStore,
    theme::Theme,
};
use gpui::{
    Context, FocusHandle, IntoElement, MouseMoveEvent, MouseUpEvent, Pixels, Point, Render, Window,
    div, prelude::*,
};

pub struct RootView {
    focus_handle: FocusHandle,
    panel_layout: PanelLayout,
    store: DesktopStore,
    resize_drag: Option<ResizeDrag>,
    sidebar_collapsed: bool,
}

#[derive(Clone, Copy, Debug)]
struct ResizeDrag {
    kind: SplitterKind,
    start_layout: PanelLayout,
    start_position: Point<Pixels>,
}

impl RootView {
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let focus_handle = cx.focus_handle();
        focus_handle.focus(window);
        let theme = Theme::default();
        Self {
            focus_handle,
            panel_layout: PanelLayout::new(theme),
            store: DesktopStore::load_from_ace_db().unwrap_or_else(|error| {
                tracing::warn!(%error, "failed to load ace db");
                DesktopStore::new()
            }),
            resize_drag: None,
            sidebar_collapsed: false,
        }
    }

    fn begin_panel_resize(
        &mut self,
        event: &BeginPanelResize,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.resize_drag = Some(ResizeDrag {
            kind: event.kind,
            start_layout: self.panel_layout,
            start_position: event.position,
        });
        cx.notify();
    }

    fn resize_panels(&mut self, event: &MouseMoveEvent, _: &mut Window, cx: &mut Context<Self>) {
        let Some(drag) = self.resize_drag else {
            return;
        };

        if !event.dragging() {
            self.resize_drag = None;
            cx.notify();
            return;
        }

        let theme = Theme::default();
        let delta_x = event.position.x - drag.start_position.x;
        self.panel_layout = match drag.kind {
            SplitterKind::Sidebar => drag.start_layout.resize_sidebar(delta_x, theme),
            SplitterKind::RightPanel => drag.start_layout.resize_right_panel(delta_x, theme),
        };
        cx.notify();
    }

    fn finish_panel_resize(&mut self, _: &MouseUpEvent, _: &mut Window, cx: &mut Context<Self>) {
        if self.resize_drag.take().is_some() {
            cx.notify();
        }
    }

    fn toggle_sidebar(&mut self, _: &ToggleSidebar, _: &mut Window, cx: &mut Context<Self>) {
        self.sidebar_collapsed = !self.sidebar_collapsed;
        cx.notify();
    }

    fn new_thread(&mut self, _: &NewThread, _: &mut Window, cx: &mut Context<Self>) {
        self.store.new_thread_for_first_project();
        cx.notify();
    }

    fn new_thread_for_project(
        &mut self,
        event: &NewThreadForProject,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.store.new_thread(event.project_id);
        cx.notify();
    }

    fn add_current_directory_project(
        &mut self,
        _: &AddCurrentDirectoryProject,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.store.add_current_directory_project();
        cx.notify();
    }

    fn open_thread(&mut self, event: &OpenThread, _: &mut Window, cx: &mut Context<Self>) {
        self.store.open_thread(event.thread_id.clone());
        cx.notify();
    }

    fn send_active_composer(
        &mut self,
        _: &SendActiveComposer,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.store.send_active_composer();
        cx.notify();
    }

    fn interrupt_active_turn(
        &mut self,
        _: &InterruptActiveTurn,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.store.interrupt_active_turn();
        cx.notify();
    }

    fn toggle_pin_active_thread(
        &mut self,
        _: &TogglePinActiveThread,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.store.toggle_pin_active_thread();
        cx.notify();
    }

    fn archive_active_thread(
        &mut self,
        _: &ArchiveActiveThread,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.store.archive_active_thread();
        cx.notify();
    }

    fn archive_project(&mut self, event: &ArchiveProject, _: &mut Window, cx: &mut Context<Self>) {
        self.store.archive_or_delete_project(event.project_id);
        cx.notify();
    }
}

impl Render for RootView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = Theme::default();

        div()
            .id("ace-root")
            .track_focus(&self.focus_handle)
            .on_action(cx.listener(Self::begin_panel_resize))
            .on_action(cx.listener(Self::toggle_sidebar))
            .on_action(cx.listener(Self::new_thread))
            .on_action(cx.listener(Self::new_thread_for_project))
            .on_action(cx.listener(Self::add_current_directory_project))
            .on_action(cx.listener(Self::open_thread))
            .on_action(cx.listener(Self::send_active_composer))
            .on_action(cx.listener(Self::interrupt_active_turn))
            .on_action(cx.listener(Self::toggle_pin_active_thread))
            .on_action(cx.listener(Self::archive_active_thread))
            .on_action(cx.listener(Self::archive_project))
            .on_mouse_move(cx.listener(Self::resize_panels))
            .on_mouse_up(
                gpui::MouseButton::Left,
                cx.listener(Self::finish_panel_resize),
            )
            .size_full()
            .bg(theme.background)
            .text_color(theme.foreground)
            .font_family(theme.font_family)
            .child(shell_layout(
                theme,
                self.panel_layout,
                self.sidebar_collapsed,
                self.store.projection(),
            ))
    }
}

use crate::{
    actions::{
        AddCurrentDirectoryProject, ArchiveActiveThread, ArchiveProject, BeginPanelResize,
        InterruptActiveTurn, NewThread, NewThreadForProject, OpenThread, SendActiveComposer,
        ShowLessProjectThreads, ShowMoreProjectThreads, TogglePinActiveThread, ToggleSidebar,
    },
    persistence::PersistenceService,
    stores::{DesktopStore, UiStore},
    ui::{
        layout::{PanelLayout, SplitterKind, shell_layout},
        theme::Theme,
    },
};
use gpui::{
    Context, FocusHandle, IntoElement, MouseMoveEvent, MouseUpEvent, Pixels, Point, Render, Window,
    div, prelude::*,
};

pub struct RootView {
    focus_handle: FocusHandle,
    persistence: Option<PersistenceService>,
    store: DesktopStore,
    ui_store: UiStore,
    resize_drag: Option<ResizeDrag>,
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
        let persistence = PersistenceService::ui_state()
            .inspect_err(|error| tracing::warn!(%error, "failed to open ui state persistence"))
            .ok();
        let ui_store = persistence
            .as_ref()
            .map(PersistenceService::load_store)
            .unwrap_or_default();
        Self {
            focus_handle,
            persistence,
            store: DesktopStore::load_from_ace_db().unwrap_or_else(|error| {
                tracing::warn!(%error, "failed to load ace db");
                DesktopStore::new()
            }),
            ui_store,
            resize_drag: None,
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
            start_layout: self.ui_store.panel_layout(),
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
        let layout = match drag.kind {
            SplitterKind::Sidebar => drag.start_layout.resize_sidebar(delta_x, theme),
            SplitterKind::RightPanel => drag.start_layout.resize_right_panel(delta_x, theme),
        };
        self.ui_store.set_panel_layout(layout);
        cx.notify();
    }

    fn finish_panel_resize(&mut self, _: &MouseUpEvent, _: &mut Window, cx: &mut Context<Self>) {
        if self.resize_drag.take().is_some() {
            self.save_ui_state();
            cx.notify();
        }
    }

    fn toggle_sidebar(&mut self, _: &ToggleSidebar, _: &mut Window, cx: &mut Context<Self>) {
        self.ui_store.toggle_sidebar();
        self.save_ui_state();
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

    fn show_more_project_threads(
        &mut self,
        event: &ShowMoreProjectThreads,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.store.show_more_project_threads(event.project_id);
        cx.notify();
    }

    fn show_less_project_threads(
        &mut self,
        event: &ShowLessProjectThreads,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.store.show_less_project_threads(event.project_id);
        cx.notify();
    }

    fn save_ui_state(&self) {
        if let Some(persistence) = &self.persistence
            && let Err(error) = persistence.save_store(&self.ui_store)
        {
            tracing::warn!(%error, "failed to save ui state");
        }
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
            .on_action(cx.listener(Self::show_more_project_threads))
            .on_action(cx.listener(Self::show_less_project_threads))
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
                self.ui_store.panel_layout(),
                self.ui_store.state().sidebar_collapsed,
                self.store.projection(),
                _window,
                cx,
            ))
    }
}

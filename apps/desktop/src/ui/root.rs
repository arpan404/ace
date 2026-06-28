use crate::{
    actions::{
        AddCurrentDirectoryProject, ArchiveActiveThread, ArchiveProject, BeginPanelResize,
        CloseSearchPalette, CreateTodoFromLatestTimelineItem, CreateTodoFromTimelineItem,
        InterruptActiveTurn, NewThread, NewThreadForProject, OpenSearchPalette, OpenThread,
        PinLatestTimelineItem, PinTimelineItem, RefreshReview, SelectBottomPanelTab,
        SelectRightPanelTab, SelectSearchPaletteItem, SendActiveComposer, ShowLessProjectThreads,
        ShowMoreProjectThreads, StageReviewAll, StageReviewFile, ToggleBottomPanel,
        ToggleEnvironmentPanel, ToggleFirstOpenTodo, ToggleHighlightLatestTimelineItem,
        ToggleHighlightTimelineItem, TogglePinActiveThread, ToggleRightPanel, ToggleSidebar,
        UnstageReviewAll, UnstageReviewFile,
    },
    backend::{BackendHostClient, DesktopBackend, HostId},
    persistence::PersistenceService,
    stores::{
        DesktopStore, ThreadAnnotationsSnapshot, UiStore,
        ui::{BottomPanelTab, RightPanelTab},
    },
    ui::{
        layout::{PanelLayout, ShellChrome, SplitterKind, shell_layout},
        search_palette::{
            SearchPaletteItem, SearchPaletteMode, SearchPaletteState, palette_items,
            search_palette_overlay,
        },
        theme::Theme,
    },
};
use ace_protocol::{
    provider_runtime::{PROVIDER_RUNTIME_EVENT_TOPIC, ProviderRuntimeEventBatch},
    terminal::{SequencedTerminalEvent, TERMINAL_EVENT_TOPIC},
};
use gpui::{
    AsyncApp, Context, FocusHandle, IntoElement, KeyDownEvent, MouseMoveEvent, MouseUpEvent,
    Pixels, Point, Render, Task, WeakEntity, Window, div, prelude::*, px,
};
use std::collections::HashMap;

const THREAD_ANNOTATIONS_KEY: &str = "thread-annotations";

pub struct RootView {
    focus_handle: FocusHandle,
    _backend: Option<DesktopBackend>,
    active_host: Option<BackendHostClient>,
    host_stores: HashMap<HostId, DesktopStore>,
    fallback_store: DesktopStore,
    persistence: Option<PersistenceService>,
    ui_store: UiStore,
    resize_drag: Option<ResizeDrag>,
    search_palette: SearchPaletteState,
    _provider_events_task: Option<Task<()>>,
    _terminal_events_task: Option<Task<()>>,
}

#[derive(Clone, Copy, Debug)]
struct ResizeDrag {
    kind: SplitterKind,
    start_layout: PanelLayout,
    start_position: Point<Pixels>,
}

impl RootView {
    pub fn new(
        window: &mut Window,
        cx: &mut Context<Self>,
        backend: Option<DesktopBackend>,
    ) -> Self {
        let focus_handle = cx.focus_handle();
        focus_handle.focus(window);
        let persistence = PersistenceService::ui_state()
            .inspect_err(|error| tracing::warn!(%error, "failed to open ui state persistence"))
            .ok();
        let ui_store: UiStore = persistence
            .as_ref()
            .map(PersistenceService::load_store)
            .unwrap_or_default();
        let annotations = persistence
            .as_ref()
            .map(|persistence| {
                persistence.load_snapshot::<ThreadAnnotationsSnapshot>(THREAD_ANNOTATIONS_KEY)
            })
            .unwrap_or_default();
        let active_host = backend.as_ref().map(DesktopBackend::active_host);
        let mut host_stores = HashMap::new();
        if let Some(host) = &active_host {
            match DesktopStore::load_from_host(host) {
                Ok(mut store) => {
                    store.restore_annotations(annotations.clone());
                    store.refresh_developer_registries(Some(host));
                    if ui_store.state().right_panel_tab == RightPanelTab::Review {
                        store.refresh_active_review(Some(host));
                    }
                    host_stores.insert(host.id().clone(), store);
                }
                Err(error) => {
                    tracing::warn!(%error, "failed to load desktop store from active backend host");
                }
            }
        }
        let provider_events_task = active_host.clone().map(|host| {
            cx.spawn(async move |view: WeakEntity<RootView>, cx: &mut AsyncApp| {
                let Ok(mut events) = host.subscribe_provider_runtime_events() else {
                    return;
                };
                while let Ok(event) = events.recv().await {
                    if event.topic != PROVIDER_RUNTIME_EVENT_TOPIC {
                        continue;
                    }
                    let Ok(batch) = serde_json::from_value::<ProviderRuntimeEventBatch>(event.body)
                    else {
                        continue;
                    };
                    let _ = view.update(cx, |view, cx| {
                        view.active_store_mut()
                            .apply_provider_runtime_event_batch(batch);
                        cx.notify();
                    });
                }
            })
        });
        let terminal_events_task = active_host.clone().map(|host| {
            cx.spawn(async move |view: WeakEntity<RootView>, cx: &mut AsyncApp| {
                let Ok(mut events) = host.subscribe_terminal_events() else {
                    return;
                };
                while let Ok(event) = events.recv().await {
                    if event.topic != TERMINAL_EVENT_TOPIC {
                        continue;
                    }
                    let Ok(event) = serde_json::from_value::<SequencedTerminalEvent>(event.body)
                    else {
                        continue;
                    };
                    let _ = view.update(cx, |view, cx| {
                        view.active_store_mut().apply_terminal_event(event);
                        cx.notify();
                    });
                }
            })
        });
        Self {
            focus_handle,
            active_host,
            host_stores,
            fallback_store: {
                let mut store = DesktopStore::new();
                store.restore_annotations(annotations);
                store
            },
            _backend: backend,
            persistence,
            ui_store,
            resize_drag: None,
            search_palette: SearchPaletteState::default(),
            _provider_events_task: provider_events_task,
            _terminal_events_task: terminal_events_task,
        }
    }

    fn active_store(&self) -> &DesktopStore {
        self.active_host
            .as_ref()
            .and_then(|host| self.host_stores.get(host.id()))
            .unwrap_or(&self.fallback_store)
    }

    fn active_store_mut(&mut self) -> &mut DesktopStore {
        if let Some(host) = &self.active_host {
            self.host_stores
                .entry(host.id().clone())
                .or_insert_with(DesktopStore::new)
        } else {
            &mut self.fallback_store
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
        let delta_y = event.position.y - drag.start_position.y;
        let layout = match drag.kind {
            SplitterKind::Sidebar => drag.start_layout.resize_sidebar(delta_x, theme),
            SplitterKind::RightPanel => drag.start_layout.resize_right_panel(delta_x, theme),
            SplitterKind::BottomPanel => drag.start_layout.resize_bottom_panel(delta_y, theme),
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

    fn open_search_palette(
        &mut self,
        _: &OpenSearchPalette,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.search_palette.open();
        self.focus_handle.focus(window);
        cx.notify();
    }

    fn close_search_palette(
        &mut self,
        _: &CloseSearchPalette,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.search_palette.close();
        cx.notify();
    }

    fn toggle_right_panel(&mut self, _: &ToggleRightPanel, _: &mut Window, cx: &mut Context<Self>) {
        self.ui_store.toggle_right_panel();
        self.save_ui_state();
        cx.notify();
    }

    fn toggle_bottom_panel(
        &mut self,
        _: &ToggleBottomPanel,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.ui_store.toggle_bottom_panel();
        if self.ui_store.state().bottom_panel_visible {
            self.ensure_active_terminal();
        }
        self.save_ui_state();
        cx.notify();
    }

    fn toggle_environment_panel(
        &mut self,
        _: &ToggleEnvironmentPanel,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.ui_store.toggle_environment_panel();
        self.save_ui_state();
        cx.notify();
    }

    fn select_right_panel_tab(
        &mut self,
        event: &SelectRightPanelTab,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.ui_store.select_right_panel_tab(event.tab);
        match event.tab {
            RightPanelTab::Review => self.refresh_active_review(),
            RightPanelTab::Summary | RightPanelTab::Providers => self.refresh_provider_registry(),
            RightPanelTab::Plugins => self.refresh_plugin_registry(),
            RightPanelTab::Skills => self.refresh_skill_registry(),
            RightPanelTab::Browser
            | RightPanelTab::Editor
            | RightPanelTab::Pinned
            | RightPanelTab::Todos => {}
        }
        self.save_ui_state();
        cx.notify();
    }

    fn select_bottom_panel_tab(
        &mut self,
        event: &SelectBottomPanelTab,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.ui_store.select_bottom_panel_tab(event.tab);
        if event.tab == BottomPanelTab::Terminal {
            self.ensure_active_terminal();
        }
        self.save_ui_state();
        cx.notify();
    }

    fn select_search_palette_item(
        &mut self,
        event: &SelectSearchPaletteItem,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.activate_search_palette_item(event.item.clone());
        cx.notify();
    }

    fn handle_key_down(&mut self, event: &KeyDownEvent, _: &mut Window, cx: &mut Context<Self>) {
        if !self.search_palette.open {
            if self.terminal_owns_keyboard() && self.handle_terminal_key_down(event) {
                cx.notify();
                return;
            }
            self.handle_composer_key_down(event, cx);
            return;
        }

        let key = event.keystroke.key.as_str();
        match key {
            "escape" => {
                self.search_palette.close();
                cx.notify();
            }
            "up" => {
                self.search_palette.active_index =
                    self.search_palette.active_index.saturating_sub(1);
                cx.notify();
            }
            "down" => {
                let items = palette_items(
                    &self.active_store().projection().sidebar,
                    self.search_palette.mode,
                    &self.search_palette.query,
                );
                if !items.is_empty() {
                    self.search_palette.active_index =
                        (self.search_palette.active_index + 1).min(items.len() - 1);
                }
                cx.notify();
            }
            "enter" => {
                let items = palette_items(
                    &self.active_store().projection().sidebar,
                    self.search_palette.mode,
                    &self.search_palette.query,
                );
                if let Some(item) = items
                    .get(
                        self.search_palette
                            .active_index
                            .min(items.len().saturating_sub(1)),
                    )
                    .cloned()
                {
                    self.activate_search_palette_item(item);
                }
                cx.notify();
            }
            "backspace" => {
                if self.search_palette.query.is_empty()
                    && self.search_palette.mode == SearchPaletteMode::NewThreadProject
                {
                    self.search_palette.back();
                } else {
                    self.search_palette.query.pop();
                    self.search_palette.active_index = 0;
                }
                cx.notify();
            }
            _ => {
                if !event.keystroke.modifiers.modified()
                    && let Some(input) = &event.keystroke.key_char
                    && !input.chars().any(char::is_control)
                {
                    self.search_palette.query.push_str(input);
                    self.search_palette.active_index = 0;
                    cx.notify();
                }
            }
        }
    }

    fn handle_composer_key_down(&mut self, event: &KeyDownEvent, cx: &mut Context<Self>) {
        let key = event.keystroke.key.as_str();
        match key {
            "enter" if !event.keystroke.modifiers.shift => {
                self.active_store_mut().send_active_composer();
                cx.notify();
            }
            "enter" => {
                self.active_store_mut().push_active_composer_input("\n");
                cx.notify();
            }
            "backspace" => {
                self.active_store_mut().pop_active_composer_input();
                cx.notify();
            }
            _ => {
                if !event.keystroke.modifiers.modified()
                    && let Some(input) = &event.keystroke.key_char
                    && !input.chars().any(char::is_control)
                {
                    self.active_store_mut().push_active_composer_input(input);
                    cx.notify();
                }
            }
        }
    }

    fn handle_terminal_key_down(&mut self, event: &KeyDownEvent) -> bool {
        if event.keystroke.modifiers.modified() {
            return false;
        }

        let active_host = self.active_host.clone();
        match event.keystroke.key.as_str() {
            "enter" => {
                self.active_store_mut()
                    .send_active_terminal_input(active_host.as_ref());
                true
            }
            "backspace" => {
                self.active_store_mut().pop_active_terminal_input();
                true
            }
            _ => {
                let Some(input) = &event.keystroke.key_char else {
                    return false;
                };
                if input.chars().any(char::is_control) {
                    return false;
                }
                self.active_store_mut().push_active_terminal_input(input);
                true
            }
        }
    }

    fn terminal_owns_keyboard(&self) -> bool {
        self.ui_store.state().bottom_panel_visible
            && self.ui_store.state().bottom_panel_tab == BottomPanelTab::Terminal
            && self
                .active_store()
                .projection()
                .chat
                .active_thread
                .is_some()
    }

    fn activate_search_palette_item(&mut self, item: SearchPaletteItem) {
        match item {
            SearchPaletteItem::NewThread => {
                self.search_palette.mode = SearchPaletteMode::NewThreadProject;
                self.search_palette.query.clear();
                self.search_palette.active_index = 0;
            }
            SearchPaletteItem::NewProject => {
                self.search_palette.close();
                let active_host = self.active_host.clone();
                self.active_store_mut()
                    .add_current_directory_project(active_host.as_ref());
            }
            SearchPaletteItem::OpenSettings => {
                self.search_palette.close();
                self.ui_store.select_right_panel_tab(RightPanelTab::Summary);
                self.save_ui_state();
            }
            SearchPaletteItem::OpenTerminals => {
                self.search_palette.close();
                self.ui_store
                    .select_bottom_panel_tab(BottomPanelTab::Terminal);
                self.ensure_active_terminal();
                self.save_ui_state();
            }
            SearchPaletteItem::Project { project_id, .. } => {
                let mode = self.search_palette.mode;
                self.search_palette.close();
                if mode == SearchPaletteMode::NewThreadProject {
                    self.active_store_mut().new_thread(project_id);
                } else {
                    self.open_project_or_create_thread(project_id);
                }
            }
            SearchPaletteItem::Thread { thread_id, .. } => {
                self.search_palette.close();
                self.active_store_mut().open_thread(thread_id);
                if self.terminal_owns_keyboard() {
                    self.ensure_active_terminal();
                }
                if self.ui_store.state().right_panel_tab == RightPanelTab::Review {
                    self.refresh_active_review();
                }
            }
        }
    }

    fn open_project_or_create_thread(&mut self, project_id: ace_core::ProjectId) {
        let projection = self.active_store().projection();
        let thread_id = projection
            .sidebar
            .projects
            .iter()
            .find(|group| group.project.id == project_id)
            .and_then(|group| group.threads.first())
            .map(|thread| thread.id.clone());
        if let Some(thread_id) = thread_id {
            self.active_store_mut().open_thread(thread_id);
        } else {
            self.active_store_mut().new_thread(project_id);
        }
    }

    fn ensure_active_terminal(&mut self) {
        let active_host = self.active_host.clone();
        self.active_store_mut()
            .ensure_active_terminal(active_host.as_ref());
    }

    fn refresh_active_review(&mut self) {
        let active_host = self.active_host.clone();
        self.active_store_mut()
            .refresh_active_review(active_host.as_ref());
    }

    fn refresh_provider_registry(&mut self) {
        let active_host = self.active_host.clone();
        self.active_store_mut()
            .refresh_provider_registry(active_host.as_ref());
    }

    fn refresh_plugin_registry(&mut self) {
        let active_host = self.active_host.clone();
        self.active_store_mut()
            .refresh_plugin_registry(active_host.as_ref());
    }

    fn refresh_skill_registry(&mut self) {
        let active_host = self.active_host.clone();
        self.active_store_mut()
            .refresh_skill_registry(active_host.as_ref());
    }

    fn refresh_review(&mut self, _: &RefreshReview, _: &mut Window, cx: &mut Context<Self>) {
        self.refresh_active_review();
        cx.notify();
    }

    fn stage_review_all(&mut self, _: &StageReviewAll, _: &mut Window, cx: &mut Context<Self>) {
        let active_host = self.active_host.clone();
        self.active_store_mut()
            .stage_active_review_all(active_host.as_ref());
        cx.notify();
    }

    fn unstage_review_all(&mut self, _: &UnstageReviewAll, _: &mut Window, cx: &mut Context<Self>) {
        let active_host = self.active_host.clone();
        self.active_store_mut()
            .unstage_active_review_all(active_host.as_ref());
        cx.notify();
    }

    fn stage_review_file(
        &mut self,
        event: &StageReviewFile,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let active_host = self.active_host.clone();
        self.active_store_mut()
            .stage_active_review_file(active_host.as_ref(), event.path.clone());
        cx.notify();
    }

    fn unstage_review_file(
        &mut self,
        event: &UnstageReviewFile,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let active_host = self.active_host.clone();
        self.active_store_mut()
            .unstage_active_review_file(active_host.as_ref(), event.path.clone());
        cx.notify();
    }

    fn new_thread(&mut self, _: &NewThread, _: &mut Window, cx: &mut Context<Self>) {
        self.active_store_mut().new_thread_for_first_project();
        if self.terminal_owns_keyboard() {
            self.ensure_active_terminal();
        }
        cx.notify();
    }

    fn new_thread_for_project(
        &mut self,
        event: &NewThreadForProject,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.active_store_mut().new_thread(event.project_id);
        if self.terminal_owns_keyboard() {
            self.ensure_active_terminal();
        }
        cx.notify();
    }

    fn add_current_directory_project(
        &mut self,
        _: &AddCurrentDirectoryProject,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let active_host = self.active_host.clone();
        self.active_store_mut()
            .add_current_directory_project(active_host.as_ref());
        cx.notify();
    }

    fn open_thread(&mut self, event: &OpenThread, _: &mut Window, cx: &mut Context<Self>) {
        self.active_store_mut().open_thread(event.thread_id.clone());
        if self.terminal_owns_keyboard() {
            self.ensure_active_terminal();
        }
        if self.ui_store.state().right_panel_tab == RightPanelTab::Review {
            self.refresh_active_review();
        }
        cx.notify();
    }

    fn send_active_composer(
        &mut self,
        _: &SendActiveComposer,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.active_store_mut().send_active_composer();
        cx.notify();
    }

    fn interrupt_active_turn(
        &mut self,
        _: &InterruptActiveTurn,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.active_store_mut().interrupt_active_turn();
        cx.notify();
    }

    fn toggle_pin_active_thread(
        &mut self,
        _: &TogglePinActiveThread,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.active_store_mut().toggle_pin_active_thread();
        cx.notify();
    }

    fn pin_latest_timeline_item(
        &mut self,
        _: &PinLatestTimelineItem,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.active_store_mut().pin_latest_timeline_item();
        self.save_thread_annotations();
        cx.notify();
    }

    fn pin_timeline_item(
        &mut self,
        event: &PinTimelineItem,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.active_store_mut()
            .pin_timeline_item(event.thread_id.clone(), &event.message_id);
        self.save_thread_annotations();
        cx.notify();
    }

    fn create_todo_from_latest_timeline_item(
        &mut self,
        _: &CreateTodoFromLatestTimelineItem,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.active_store_mut()
            .create_todo_from_latest_timeline_item();
        self.save_thread_annotations();
        cx.notify();
    }

    fn create_todo_from_timeline_item(
        &mut self,
        event: &CreateTodoFromTimelineItem,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.active_store_mut()
            .create_todo_from_timeline_item(event.thread_id.clone(), &event.message_id);
        self.save_thread_annotations();
        cx.notify();
    }

    fn toggle_highlight_latest_timeline_item(
        &mut self,
        _: &ToggleHighlightLatestTimelineItem,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.active_store_mut()
            .toggle_highlight_latest_timeline_item();
        self.save_thread_annotations();
        cx.notify();
    }

    fn toggle_highlight_timeline_item(
        &mut self,
        event: &ToggleHighlightTimelineItem,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.active_store_mut()
            .toggle_highlight_timeline_item(event.thread_id.clone(), &event.message_id);
        self.save_thread_annotations();
        cx.notify();
    }

    fn toggle_first_open_todo(
        &mut self,
        _: &ToggleFirstOpenTodo,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.active_store_mut().toggle_first_open_todo();
        self.save_thread_annotations();
        cx.notify();
    }

    fn archive_active_thread(
        &mut self,
        _: &ArchiveActiveThread,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.active_store_mut().archive_active_thread();
        cx.notify();
    }

    fn archive_project(&mut self, event: &ArchiveProject, _: &mut Window, cx: &mut Context<Self>) {
        let active_host = self.active_host.clone();
        self.active_store_mut()
            .archive_or_delete_project(event.project_id, active_host.as_ref());
        cx.notify();
    }

    fn show_more_project_threads(
        &mut self,
        event: &ShowMoreProjectThreads,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.active_store_mut()
            .show_more_project_threads(event.project_id);
        cx.notify();
    }

    fn show_less_project_threads(
        &mut self,
        event: &ShowLessProjectThreads,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.active_store_mut()
            .show_less_project_threads(event.project_id);
        cx.notify();
    }

    fn save_ui_state(&self) {
        if let Some(persistence) = &self.persistence
            && let Err(error) = persistence.save_store(&self.ui_store)
        {
            tracing::warn!(%error, "failed to save ui state");
        }
    }

    fn save_thread_annotations(&self) {
        if let Some(persistence) = &self.persistence {
            let snapshot = self.active_store().annotations_snapshot();
            if let Err(error) = persistence.save_snapshot(THREAD_ANNOTATIONS_KEY, &snapshot) {
                tracing::warn!(%error, "failed to save thread annotations");
            }
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
            .on_action(cx.listener(Self::open_search_palette))
            .on_action(cx.listener(Self::close_search_palette))
            .on_action(cx.listener(Self::toggle_environment_panel))
            .on_action(cx.listener(Self::toggle_right_panel))
            .on_action(cx.listener(Self::toggle_bottom_panel))
            .on_action(cx.listener(Self::select_right_panel_tab))
            .on_action(cx.listener(Self::select_bottom_panel_tab))
            .on_action(cx.listener(Self::select_search_palette_item))
            .on_action(cx.listener(Self::new_thread))
            .on_action(cx.listener(Self::new_thread_for_project))
            .on_action(cx.listener(Self::add_current_directory_project))
            .on_action(cx.listener(Self::open_thread))
            .on_action(cx.listener(Self::send_active_composer))
            .on_action(cx.listener(Self::interrupt_active_turn))
            .on_action(cx.listener(Self::toggle_pin_active_thread))
            .on_action(cx.listener(Self::pin_latest_timeline_item))
            .on_action(cx.listener(Self::pin_timeline_item))
            .on_action(cx.listener(Self::toggle_highlight_latest_timeline_item))
            .on_action(cx.listener(Self::toggle_highlight_timeline_item))
            .on_action(cx.listener(Self::create_todo_from_latest_timeline_item))
            .on_action(cx.listener(Self::create_todo_from_timeline_item))
            .on_action(cx.listener(Self::toggle_first_open_todo))
            .on_action(cx.listener(Self::refresh_review))
            .on_action(cx.listener(Self::stage_review_all))
            .on_action(cx.listener(Self::unstage_review_all))
            .on_action(cx.listener(Self::stage_review_file))
            .on_action(cx.listener(Self::unstage_review_file))
            .on_action(cx.listener(Self::archive_active_thread))
            .on_action(cx.listener(Self::archive_project))
            .on_action(cx.listener(Self::show_more_project_threads))
            .on_action(cx.listener(Self::show_less_project_threads))
            .on_mouse_move(cx.listener(Self::resize_panels))
            .on_mouse_up(
                gpui::MouseButton::Left,
                cx.listener(Self::finish_panel_resize),
            )
            .on_key_down(cx.listener(Self::handle_key_down))
            .size_full()
            .bg(theme.background)
            .text_color(theme.foreground)
            .text_size(px(12.0))
            .font_family(theme.font_family)
            .child(shell_layout(
                theme,
                self.ui_store.panel_layout(),
                self.ui_store.state().clone(),
                self.active_store().projection(),
                ShellChrome {
                    active_splitter: self.resize_drag.map(|drag| drag.kind),
                    reserve_titlebar_controls: !_window.is_fullscreen(),
                },
                _window,
                cx,
            ))
            .child(search_palette_overlay(
                theme,
                &self.search_palette,
                &self.active_store().projection().sidebar,
            ))
    }
}

use crate::{
    actions::SelectSearchPaletteItem,
    stores::{DesktopProjection, ui::BottomPanelTab},
    ui::{components::*, theme::Theme},
};
use ace_core::{ProjectId, ThreadId};
use gpui::{AnyElement, IntoElement, MouseButton, div, prelude::*, px};
use gpui_component::{IconName, scroll::ScrollableElement as _};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SearchPaletteMode {
    Root,
    NewThreadProject,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SearchPaletteItem {
    NewThread,
    NewProject,
    OpenSettings,
    OpenTerminals,
    Panel {
        tab: crate::stores::ui::RightPanelTab,
        label: String,
        description: String,
        result_kind: SearchPaletteResultKind,
    },
    Project {
        project_id: ProjectId,
        label: String,
        description: String,
    },
    Thread {
        thread_id: ThreadId,
        label: String,
        description: String,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SearchPaletteResultKind {
    Source,
    Context,
    Registry,
}

impl SearchPaletteItem {
    fn label(&self) -> &str {
        match self {
            Self::NewThread => "New thread in...",
            Self::NewProject => "New project",
            Self::OpenSettings => "Open settings",
            Self::OpenTerminals => "Open terminals",
            Self::Panel { label, .. } => label,
            Self::Project { label, .. } | Self::Thread { label, .. } => label,
        }
    }

    fn description(&self) -> &str {
        match self {
            Self::NewThread => "Choose a project for a new thread.",
            Self::NewProject => "Add the current workspace as a project.",
            Self::OpenSettings => "Settings",
            Self::OpenTerminals => "Manage running terminal processes.",
            Self::Panel { description, .. } => description,
            Self::Project { description, .. } | Self::Thread { description, .. } => description,
        }
    }

    fn kind(&self) -> PaletteItemKind {
        match self {
            Self::NewThread | Self::NewProject | Self::OpenSettings | Self::OpenTerminals => {
                PaletteItemKind::Action
            }
            Self::Panel { result_kind, .. } => match result_kind {
                SearchPaletteResultKind::Source => PaletteItemKind::Source,
                SearchPaletteResultKind::Context => PaletteItemKind::Context,
                SearchPaletteResultKind::Registry => PaletteItemKind::Registry,
            },
            Self::Project { .. } => PaletteItemKind::Project,
            Self::Thread { .. } => PaletteItemKind::Thread,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PaletteItemKind {
    Action,
    Project,
    Thread,
    Source,
    Context,
    Registry,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SearchPaletteState {
    pub open: bool,
    pub mode: SearchPaletteMode,
    pub query: String,
    pub active_index: usize,
}

impl Default for SearchPaletteState {
    fn default() -> Self {
        Self {
            open: false,
            mode: SearchPaletteMode::Root,
            query: String::new(),
            active_index: 0,
        }
    }
}

impl SearchPaletteState {
    pub fn open(&mut self) {
        self.open = true;
        self.mode = SearchPaletteMode::Root;
        self.query.clear();
        self.active_index = 0;
    }

    pub fn close(&mut self) {
        *self = Self::default();
    }

    pub fn back(&mut self) {
        self.mode = SearchPaletteMode::Root;
        self.query.clear();
        self.active_index = 0;
    }
}

pub fn palette_items(
    projection: &DesktopProjection,
    mode: SearchPaletteMode,
    query: &str,
) -> Vec<SearchPaletteItem> {
    let normalized = query.trim().to_lowercase();
    let mut project_items = Vec::new();
    let mut thread_items = Vec::new();
    let mut source_items = Vec::new();
    let mut context_items = Vec::new();
    let mut registry_items = Vec::new();

    for group in &projection.sidebar.projects {
        project_items.push(SearchPaletteItem::Project {
            project_id: group.project.id,
            label: group.project.name.clone(),
            description: group.project.workspace_root.clone(),
        });

        for thread in &group.threads {
            thread_items.push(SearchPaletteItem::Thread {
                thread_id: thread.id.clone(),
                label: thread.title.clone(),
                description: group.project.name.clone(),
            });
        }
    }

    for source in &projection.sources.items {
        source_items.push(SearchPaletteItem::Panel {
            tab: crate::stores::ui::RightPanelTab::Sources,
            label: source.title.clone(),
            description: format!("{} · {}", source.kind, source.detail),
            result_kind: SearchPaletteResultKind::Source,
        });
    }

    for item in &projection.annotations.pinned_items {
        context_items.push(SearchPaletteItem::Panel {
            tab: crate::stores::ui::RightPanelTab::Pinned,
            label: item.display_title.clone(),
            description: item.display_excerpt.clone(),
            result_kind: SearchPaletteResultKind::Context,
        });
    }
    for item in &projection.annotations.highlighted_items {
        context_items.push(SearchPaletteItem::Panel {
            tab: crate::stores::ui::RightPanelTab::Summary,
            label: item.display_title.clone(),
            description: format!("Highlighted · {}", item.display_excerpt),
            result_kind: SearchPaletteResultKind::Context,
        });
    }
    for todo in &projection.annotations.todos {
        context_items.push(SearchPaletteItem::Panel {
            tab: crate::stores::ui::RightPanelTab::Todos,
            label: todo.title.clone(),
            description: format!("Todo · {:?}", todo.status),
            result_kind: SearchPaletteResultKind::Context,
        });
    }

    registry_items.push(SearchPaletteItem::Panel {
        tab: crate::stores::ui::RightPanelTab::Environment,
        label: projection.host.label.clone(),
        description: projection
            .host
            .endpoint
            .clone()
            .unwrap_or_else(|| "Host runtime is not connected".to_string()),
        result_kind: SearchPaletteResultKind::Registry,
    });

    if projection.runtime_status.providers > 0
        || projection.runtime_status.threads > 0
        || projection.runtime_status.error.is_some()
    {
        registry_items.push(SearchPaletteItem::Panel {
            tab: crate::stores::ui::RightPanelTab::Environment,
            label: "Runtime status".to_string(),
            description: format!(
                "{} provider{} · {} active thread{} · {} warning{}",
                projection.runtime_status.providers,
                plural(projection.runtime_status.providers),
                projection.runtime_status.active_threads,
                plural(projection.runtime_status.active_threads),
                projection.runtime_status.warnings,
                plural(projection.runtime_status.warnings)
            ),
            result_kind: SearchPaletteResultKind::Registry,
        });
    }
    if projection.runtime_status.remote_connections > 0 {
        registry_items.push(SearchPaletteItem::Panel {
            tab: crate::stores::ui::RightPanelTab::Environment,
            label: "Remote connections".to_string(),
            description: format!(
                "{} connected / {} total · {} remote host{}",
                projection.runtime_status.connected_remote_connections,
                projection.runtime_status.remote_connections,
                projection.runtime_status.remote_host_connections,
                plural(projection.runtime_status.remote_host_connections)
            ),
            result_kind: SearchPaletteResultKind::Registry,
        });
    }
    if projection.runtime_status.pending_approvals > 0 {
        registry_items.push(SearchPaletteItem::Panel {
            tab: crate::stores::ui::RightPanelTab::Environment,
            label: "Pending approvals".to_string(),
            description: format!(
                "{} runtime approval{} awaiting action",
                projection.runtime_status.pending_approvals,
                plural(projection.runtime_status.pending_approvals)
            ),
            result_kind: SearchPaletteResultKind::Registry,
        });
    }
    if projection.runtime_status.handoffs > 0 {
        registry_items.push(SearchPaletteItem::Panel {
            tab: crate::stores::ui::RightPanelTab::Environment,
            label: "Runtime handoffs".to_string(),
            description: format!(
                "{} handoff{} recorded",
                projection.runtime_status.handoffs,
                plural(projection.runtime_status.handoffs)
            ),
            result_kind: SearchPaletteResultKind::Registry,
        });
    }

    for provider in &projection.providers.providers {
        registry_items.push(SearchPaletteItem::Panel {
            tab: crate::stores::ui::RightPanelTab::Providers,
            label: provider.display_name.clone(),
            description: format!("Provider · {}", provider.health),
            result_kind: SearchPaletteResultKind::Registry,
        });
    }
    for plugin in &projection.plugins.entries {
        registry_items.push(SearchPaletteItem::Panel {
            tab: crate::stores::ui::RightPanelTab::Plugins,
            label: plugin.name.clone(),
            description: plugin
                .description
                .clone()
                .unwrap_or_else(|| format!("Plugin · {}", plugin.status)),
            result_kind: SearchPaletteResultKind::Registry,
        });
    }
    for skill in &projection.skills.entries {
        registry_items.push(SearchPaletteItem::Panel {
            tab: crate::stores::ui::RightPanelTab::Skills,
            label: skill.name.clone(),
            description: skill
                .description
                .clone()
                .unwrap_or_else(|| format!("Skill · {}", skill.status)),
            result_kind: SearchPaletteResultKind::Registry,
        });
    }

    project_items.sort_by(|left, right| left.label().cmp(right.label()));
    thread_items.sort_by(|left, right| right.label().cmp(left.label()));
    source_items.sort_by(|left, right| left.label().cmp(right.label()));
    context_items.sort_by(|left, right| left.label().cmp(right.label()));
    registry_items.sort_by(|left, right| left.label().cmp(right.label()));

    let matches = |item: &SearchPaletteItem| {
        normalized.is_empty()
            || item.label().to_lowercase().contains(&normalized)
            || item.description().to_lowercase().contains(&normalized)
    };

    if mode == SearchPaletteMode::NewThreadProject {
        return project_items
            .into_iter()
            .filter(matches)
            .take(if normalized.is_empty() { 12 } else { 24 })
            .collect();
    }

    let actions = [
        SearchPaletteItem::NewThread,
        SearchPaletteItem::NewProject,
        SearchPaletteItem::OpenSettings,
        SearchPaletteItem::OpenTerminals,
    ];

    if normalized.is_empty() {
        return actions
            .into_iter()
            .chain(project_items.into_iter().take(8))
            .chain(thread_items.into_iter().take(8))
            .collect();
    }

    actions
        .into_iter()
        .chain(project_items)
        .chain(thread_items)
        .chain(source_items)
        .chain(context_items)
        .chain(registry_items)
        .filter(matches)
        .take(40)
        .collect()
}

fn plural(count: usize) -> &'static str {
    if count == 1 { "" } else { "s" }
}

pub(super) fn search_palette_overlay(
    theme: Theme,
    state: &SearchPaletteState,
    projection: &DesktopProjection,
) -> AnyElement {
    if !state.open {
        return div().into_any_element();
    }

    let items = palette_items(projection, state.mode, &state.query);
    let active_index = state.active_index.min(items.len().saturating_sub(1));
    let normalized_empty = state.query.trim().is_empty();
    let mut rendered_index = 0usize;

    div()
        .absolute()
        .top(px(0.0))
        .left(px(0.0))
        .right(px(0.0))
        .bottom(px(0.0))
        .bg(theme.background.opacity(0.66))
        .flex()
        .items_start()
        .justify_center()
        .pt(px(96.0))
        .child(
            div()
                .w(px(720.0))
                .max_w(px(720.0))
                .max_h(px(560.0))
                .rounded_xl()
                .border_1()
                .border_color(theme.border)
                .bg(theme.background_elevated.opacity(0.98))
                .shadow_lg()
                .overflow_hidden()
                .flex()
                .flex_col()
                .child(palette_header(theme, state))
                .child(
                    div()
                        .flex_1()
                        .min_h(px(300.0))
                        .max_h(px(420.0))
                        .overflow_y_scrollbar()
                        .px_4()
                        .py_3()
                        .children(section(
                            theme,
                            "Actions",
                            PaletteItemKind::Action,
                            &items,
                            &mut rendered_index,
                            active_index,
                            normalized_empty,
                            state.mode,
                        ))
                        .children(section(
                            theme,
                            if state.mode == SearchPaletteMode::NewThreadProject {
                                "Projects"
                            } else if normalized_empty {
                                "Recent Projects"
                            } else {
                                "Projects"
                            },
                            PaletteItemKind::Project,
                            &items,
                            &mut rendered_index,
                            active_index,
                            normalized_empty,
                            state.mode,
                        ))
                        .children(section(
                            theme,
                            if normalized_empty {
                                "Recent Threads"
                            } else {
                                "Threads"
                            },
                            PaletteItemKind::Thread,
                            &items,
                            &mut rendered_index,
                            active_index,
                            normalized_empty,
                            state.mode,
                        ))
                        .children(section(
                            theme,
                            "Sources",
                            PaletteItemKind::Source,
                            &items,
                            &mut rendered_index,
                            active_index,
                            normalized_empty,
                            state.mode,
                        ))
                        .children(section(
                            theme,
                            "Pinned & Todos",
                            PaletteItemKind::Context,
                            &items,
                            &mut rendered_index,
                            active_index,
                            normalized_empty,
                            state.mode,
                        ))
                        .children(section(
                            theme,
                            "Registries",
                            PaletteItemKind::Registry,
                            &items,
                            &mut rendered_index,
                            active_index,
                            normalized_empty,
                            state.mode,
                        ))
                        .when(items.is_empty(), |this| {
                            this.child(
                                div()
                                    .h(px(160.0))
                                    .flex()
                                    .items_center()
                                    .justify_center()
                                    .text_size(px(13.0))
                                    .text_color(theme.muted)
                                    .child("No matching results"),
                            )
                        }),
                )
                .child(palette_footer(theme)),
        )
        .into_any_element()
}

fn palette_header(theme: Theme, state: &SearchPaletteState) -> AnyElement {
    let display_text = if state.query.is_empty() {
        if state.mode == SearchPaletteMode::NewThreadProject {
            "Select project for a new thread...".to_string()
        } else {
            "Search commands, projects, threads, sources, and registries...".to_string()
        }
    } else {
        state.query.clone()
    };

    div()
        .h(px(72.0))
        .border_b_1()
        .border_color(theme.border_subtle)
        .px_5()
        .flex()
        .items_center()
        .gap_3()
        .child(if state.mode == SearchPaletteMode::NewThreadProject {
            ace_icon_svg(AceIconName::PanelLeftOpen, theme.muted)
        } else {
            icon_svg(IconName::Search, theme.muted)
        })
        .child(
            div()
                .h(px(40.0))
                .flex_1()
                .rounded_lg()
                .border_1()
                .border_color(if state.open {
                    theme.accent_blue.opacity(0.62)
                } else {
                    theme.border
                })
                .bg(theme.panel)
                .px_3()
                .flex()
                .items_center()
                .text_size(px(18.0))
                .text_color(theme.foreground)
                .child(display_text),
        )
        .into_any_element()
}

#[allow(clippy::too_many_arguments)]
fn section(
    theme: Theme,
    title: &'static str,
    kind: PaletteItemKind,
    items: &[SearchPaletteItem],
    rendered_index: &mut usize,
    active_index: usize,
    normalized_empty: bool,
    mode: SearchPaletteMode,
) -> Vec<AnyElement> {
    if mode == SearchPaletteMode::NewThreadProject && kind != PaletteItemKind::Project {
        return Vec::new();
    }

    let section_items = items
        .iter()
        .filter(|item| item.kind() == kind)
        .cloned()
        .collect::<Vec<_>>();
    if section_items.is_empty() {
        return Vec::new();
    }
    if kind == PaletteItemKind::Action && !normalized_empty {
        // Keep filtered actions visually grouped only when they are present.
    }

    let mut children = vec![
        div()
            .pt(if *rendered_index == 0 {
                px(0.0)
            } else {
                px(14.0)
            })
            .pb_2()
            .text_size(px(11.0))
            .font_weight(gpui::FontWeight::SEMIBOLD)
            .text_color(theme.muted_subtle)
            .child(title)
            .into_any_element(),
    ];

    for item in section_items {
        let index = *rendered_index;
        *rendered_index += 1;
        children.push(palette_row(theme, item, index == active_index));
    }

    children
}

fn palette_row(theme: Theme, item: SearchPaletteItem, active: bool) -> AnyElement {
    let action_item = item.clone();
    div()
        .h(px(46.0))
        .rounded_lg()
        .px_3()
        .flex()
        .items_center()
        .gap_3()
        .bg(if active {
            theme.button_hover
        } else {
            theme.background_elevated
        })
        .text_color(if active {
            theme.foreground
        } else {
            theme.foreground.opacity(0.78)
        })
        .hover(|this| this.bg(theme.button))
        .child(palette_icon(theme, &item, active))
        .child(
            div()
                .min_w_0()
                .flex_1()
                .flex()
                .flex_col()
                .child(
                    div()
                        .text_size(px(14.0))
                        .line_height(px(18.0))
                        .child(item.label().to_string()),
                )
                .when(item.kind() != PaletteItemKind::Action, |this| {
                    this.child(
                        div()
                            .text_size(px(12.0))
                            .line_height(px(16.0))
                            .text_color(theme.muted)
                            .child(item.description().to_string()),
                    )
                }),
        )
        .on_mouse_up(MouseButton::Left, move |_, window, cx| {
            window.dispatch_action(
                Box::new(SelectSearchPaletteItem {
                    item: action_item.clone(),
                }),
                cx,
            );
        })
        .into_any_element()
}

fn palette_icon(theme: Theme, item: &SearchPaletteItem, active: bool) -> AnyElement {
    let color = if active {
        theme.accent_blue
    } else {
        theme.muted
    };
    match item {
        SearchPaletteItem::NewThread | SearchPaletteItem::Thread { .. } => {
            ace_icon_svg(AceIconName::Editor, color)
        }
        SearchPaletteItem::NewProject | SearchPaletteItem::Project { .. } => {
            icon_svg(IconName::Folder, color)
        }
        SearchPaletteItem::OpenSettings => ace_icon_svg(AceIconName::TablerSettings, color),
        SearchPaletteItem::OpenTerminals => ace_icon_svg(AceIconName::Terminal, color),
        SearchPaletteItem::Panel { result_kind, .. } => match result_kind {
            SearchPaletteResultKind::Source => icon_svg(IconName::File, color),
            SearchPaletteResultKind::Context => icon_svg(IconName::Star, color),
            SearchPaletteResultKind::Registry => ace_icon_svg(AceIconName::Box, color),
        },
    }
}

fn palette_footer(theme: Theme) -> AnyElement {
    div()
        .h(px(44.0))
        .border_t_1()
        .border_color(theme.border_subtle)
        .px_4()
        .flex()
        .items_center()
        .gap_4()
        .text_size(px(12.0))
        .text_color(theme.muted)
        .child(hint("↑ ↓", "Navigate", theme))
        .child(hint("Enter", "Select", theme))
        .child(hint("Esc", "Close", theme))
        .into_any_element()
}

fn hint(keys: &'static str, label: &'static str, theme: Theme) -> AnyElement {
    div()
        .flex()
        .items_center()
        .gap_2()
        .child(kbd(keys, theme))
        .child(label)
        .into_any_element()
}

#[allow(dead_code)]
fn _bottom_panel_tab_reference(_: BottomPanelTab) {}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::stores::desktop::{ComposerPayload, DesktopStore};

    #[test]
    fn palette_search_includes_persisted_context_results() {
        let mut store = DesktopStore::new();
        let project_id = store.add_project("/tmp/project".to_string());
        let thread_id = store.new_thread(project_id);
        store.send_message(
            thread_id.clone(),
            ComposerPayload {
                prompt: "Keep this context".to_string(),
            },
        );
        let user_message_id = store.projection().chat.messages[0].id.clone();
        store.pin_timeline_item(thread_id, &user_message_id);

        let items = palette_items(&store.projection(), SearchPaletteMode::Root, "context");
        assert!(items.iter().any(|item| matches!(
            item,
            SearchPaletteItem::Panel {
                result_kind: SearchPaletteResultKind::Context,
                ..
            }
        )));
    }
}

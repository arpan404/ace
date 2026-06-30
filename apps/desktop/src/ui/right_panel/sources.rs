use crate::{
    actions::{SelectRightPanelTab, ToggleComposerContext},
    stores::{DesktopProjection, SourceItemProjection, ui::RightPanelTab},
    ui::{components::*, theme::Theme},
};
use ace_runtime::chat::ComposerContextKind;
use gpui::{AnyElement, IntoElement, div, prelude::*, px};
use gpui_component::{IconName, scroll::ScrollableElement as _};

use super::{clamp_text, empty_panel_body, info_row};

pub(super) fn sources_body(theme: Theme, projection: &DesktopProjection) -> AnyElement {
    if projection.sources.items.is_empty() {
        return empty_panel_body(
            theme,
            AceIconName::Box,
            "Sources",
            "No files, terminal sessions, or context annotations are attached yet.",
        );
    }

    div()
        .size_full()
        .flex()
        .flex_col()
        .gap_3()
        .child(info_row(
            theme,
            "Changed files",
            &projection.sources.changed_files.to_string(),
        ))
        .child(info_row(
            theme,
            "Terminal sessions",
            &projection.sources.terminal_sessions.to_string(),
        ))
        .child(info_row(
            theme,
            "Context items",
            &projection.sources.context_items.to_string(),
        ))
        .child(info_row(
            theme,
            "Artifacts",
            &projection.sources.artifacts.to_string(),
        ))
        .child(
            div()
                .flex_1()
                .min_h_0()
                .flex()
                .flex_col()
                .gap_2()
                .children(
                    projection
                        .sources
                        .items
                        .iter()
                        .map(|source| source_item_card(theme, projection, source))
                        .collect::<Vec<_>>(),
                )
                .overflow_y_scrollbar(),
        )
        .into_any_element()
}

fn source_item_card(
    theme: Theme,
    projection: &DesktopProjection,
    source: &SourceItemProjection,
) -> AnyElement {
    let icon = match source.kind.as_str() {
        "file" => IconName::File,
        "terminal" => IconName::SquareTerminal,
        "artifact" => IconName::Inbox,
        "pinned" | "highlight" => IconName::Star,
        "todo" => IconName::Check,
        "diff_comment" => IconName::File,
        _ => IconName::Inbox,
    };
    let context = source_context_kind(source.kind.as_str());
    let context_selected = context.is_some_and(|context| {
        projection
            .chat
            .composer
            .as_ref()
            .is_some_and(|draft| draft.context.contains(&context))
    });
    let mut actions = Vec::new();
    if let Some(tab) = source_panel_tab(source.kind.as_str()) {
        actions.push(action_button(
            source_panel_icon(tab),
            source_panel_label(tab),
            theme,
            move || Box::new(SelectRightPanelTab { tab }),
        ));
    }
    if let Some(context) = context {
        actions.push(action_button(
            IconName::Plus,
            source_context_action_label(context_selected),
            theme,
            move || Box::new(ToggleComposerContext { context }),
        ));
    }

    div()
        .rounded_md()
        .border_1()
        .border_color(theme.border_subtle)
        .bg(theme.panel)
        .p_3()
        .flex()
        .flex_col()
        .gap_2()
        .child(
            div()
                .flex()
                .flex_row()
                .items_center()
                .gap_2()
                .text_size(px(12.0))
                .text_color(theme.foreground.opacity(0.84))
                .child(icon_svg(icon, theme.muted))
                .child(clamp_text(&source.title, 140)),
        )
        .child(
            div()
                .text_size(px(11.0))
                .line_height(px(16.0))
                .text_color(theme.muted)
                .child(clamp_text(&source.detail, 220)),
        )
        .child(
            div()
                .flex()
                .flex_row()
                .items_center()
                .gap_2()
                .text_size(px(11.0))
                .text_color(theme.muted_subtle)
                .child(source_type_label(source.kind.as_str()))
                .child("·")
                .child(clamp_text(&source.used_by, 96)),
        )
        .when(!source.added_at.is_empty(), |this| {
            this.child(
                div()
                    .text_size(px(11.0))
                    .text_color(theme.muted_subtle)
                    .child(format!("Observed {}", source.added_at)),
            )
        })
        .when(!actions.is_empty(), |this| {
            this.child(
                div()
                    .pt_1()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap_2()
                    .children(actions),
            )
        })
        .into_any_element()
}

fn source_type_label(kind: &str) -> &'static str {
    match kind {
        "file" => "File",
        "terminal" => "Terminal",
        "artifact" => "Artifact",
        "pinned" => "Pinned",
        "highlight" => "Highlight",
        "todo" => "Todo",
        "diff_comment" => "Review comment",
        _ => "Source",
    }
}

fn source_panel_tab(kind: &str) -> Option<RightPanelTab> {
    match kind {
        "file" | "diff_comment" => Some(RightPanelTab::Review),
        "terminal" => Some(RightPanelTab::Terminal),
        "pinned" | "highlight" => Some(RightPanelTab::Pinned),
        "todo" => Some(RightPanelTab::Todos),
        _ => None,
    }
}

fn source_panel_icon(tab: RightPanelTab) -> IconName {
    match tab {
        RightPanelTab::Review => IconName::File,
        RightPanelTab::Terminal => IconName::SquareTerminal,
        RightPanelTab::Pinned => IconName::Star,
        RightPanelTab::Todos => IconName::Check,
        _ => IconName::Inbox,
    }
}

fn source_panel_label(tab: RightPanelTab) -> &'static str {
    match tab {
        RightPanelTab::Review => "Open review",
        RightPanelTab::Terminal => "Open terminal",
        RightPanelTab::Pinned => "Open pinned",
        RightPanelTab::Todos => "Open todos",
        _ => "Open",
    }
}

fn source_context_kind(kind: &str) -> Option<ComposerContextKind> {
    match kind {
        "terminal" => Some(ComposerContextKind::Terminal),
        "pinned" => Some(ComposerContextKind::Pinned),
        "highlight" => Some(ComposerContextKind::Highlights),
        "todo" => Some(ComposerContextKind::Todos),
        _ => None,
    }
}

fn source_context_action_label(selected: bool) -> &'static str {
    if selected {
        "Remove context"
    } else {
        "Add context"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_cards_route_to_backed_panels() {
        assert_eq!(source_panel_tab("file"), Some(RightPanelTab::Review));
        assert_eq!(
            source_panel_tab("diff_comment"),
            Some(RightPanelTab::Review)
        );
        assert_eq!(source_panel_tab("terminal"), Some(RightPanelTab::Terminal));
        assert_eq!(source_panel_tab("pinned"), Some(RightPanelTab::Pinned));
        assert_eq!(source_panel_tab("highlight"), Some(RightPanelTab::Pinned));
        assert_eq!(source_panel_tab("todo"), Some(RightPanelTab::Todos));
        assert_eq!(source_panel_tab("artifact"), None);
    }

    #[test]
    fn source_cards_label_source_types() {
        assert_eq!(source_type_label("file"), "File");
        assert_eq!(source_type_label("terminal"), "Terminal");
        assert_eq!(source_type_label("artifact"), "Artifact");
        assert_eq!(source_type_label("pinned"), "Pinned");
        assert_eq!(source_type_label("highlight"), "Highlight");
        assert_eq!(source_type_label("todo"), "Todo");
        assert_eq!(source_type_label("diff_comment"), "Review comment");
        assert_eq!(source_type_label("unknown"), "Source");
    }

    #[test]
    fn source_cards_toggle_only_available_composer_contexts() {
        assert_eq!(
            source_context_kind("terminal"),
            Some(ComposerContextKind::Terminal)
        );
        assert_eq!(
            source_context_kind("pinned"),
            Some(ComposerContextKind::Pinned)
        );
        assert_eq!(
            source_context_kind("highlight"),
            Some(ComposerContextKind::Highlights)
        );
        assert_eq!(
            source_context_kind("todo"),
            Some(ComposerContextKind::Todos)
        );
        assert_eq!(source_context_kind("file"), None);
        assert_eq!(source_context_kind("diff_comment"), None);
        assert_eq!(source_context_kind("artifact"), None);
        assert_eq!(source_context_action_label(false), "Add context");
        assert_eq!(source_context_action_label(true), "Remove context");
    }
}

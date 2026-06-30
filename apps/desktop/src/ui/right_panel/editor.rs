use crate::{
    stores::{EditorFileProjection, EditorProjection},
    ui::{components::*, theme::Theme},
};
use gpui::{AnyElement, IntoElement, div, prelude::*, px};

use super::{empty_panel_body, info_row, registry_error_card, short_path};

pub(super) fn editor_body(theme: Theme, editor: &EditorProjection) -> AnyElement {
    let Some(workspace_root) = editor.workspace_root.as_deref() else {
        return empty_panel_body(
            theme,
            AceIconName::Editor,
            "Editor",
            "No project workspace is available for this thread.",
        );
    };

    div()
        .flex()
        .flex_col()
        .gap_3()
        .child(info_row(theme, "Workspace", &short_path(workspace_root)))
        .child(info_row(
            theme,
            "Buffer sync",
            if editor.can_sync_buffers {
                "Available"
            } else {
                "Unavailable"
            },
        ))
        .child(info_row(theme, "Diagnostics", editor.diagnostics_topic))
        .child(info_row(
            theme,
            "Changed files",
            &editor.candidate_files.len().to_string(),
        ))
        .when_some(editor.error.as_deref(), |this, error| {
            this.child(registry_error_card(theme, error))
        })
        .child(editor_file_list(theme, &editor.candidate_files))
        .child(
            div()
                .rounded_md()
                .border_1()
                .border_color(theme.border_subtle)
                .bg(theme.panel)
                .px_2()
                .py_2()
                .text_size(px(12.0))
                .line_height(px(17.0))
                .text_color(theme.muted)
                .child(editor_capability_notice(editor)),
        )
        .into_any_element()
}

fn editor_capability_notice(editor: &EditorProjection) -> &'static str {
    if editor.can_sync_buffers {
        "Editor RPC is available for buffer sync, diagnostics, symbols, hover, definitions, formatting, and code actions. Live GPUI buffer rendering is disabled because no desktop editor-buffer client is attached yet."
    } else {
        "Editor RPC is unavailable for this thread. Select a project on a connected host before syncing buffers or requesting diagnostics."
    }
}

fn editor_file_list(theme: Theme, files: &[EditorFileProjection]) -> AnyElement {
    if files.is_empty() {
        return div()
            .rounded_md()
            .border_1()
            .border_color(theme.border_subtle)
            .bg(theme.panel)
            .px_2()
            .py_2()
            .text_size(px(12.0))
            .text_color(theme.muted)
            .child("No changed files to sync")
            .into_any_element();
    }

    div()
        .rounded_md()
        .border_1()
        .border_color(theme.border_subtle)
        .bg(theme.panel)
        .p_2()
        .flex()
        .flex_col()
        .gap_1()
        .child(
            div()
                .text_size(px(11.0))
                .font_weight(gpui::FontWeight::SEMIBOLD)
                .text_color(theme.muted)
                .child("Buffer candidates"),
        )
        .children(
            files
                .iter()
                .take(24)
                .map(|file| editor_file_row(theme, file))
                .collect::<Vec<_>>(),
        )
        .when(files.len() > 24, |this| {
            this.child(
                div()
                    .pt_1()
                    .text_size(px(11.0))
                    .text_color(theme.muted_subtle)
                    .child(format!("{} more files", files.len() - 24)),
            )
        })
        .into_any_element()
}

fn editor_file_row(theme: Theme, file: &EditorFileProjection) -> AnyElement {
    let stat = match (file.additions, file.deletions) {
        (Some(additions), Some(deletions)) => format!("+{additions} -{deletions}"),
        _ => "diff stat unavailable".to_string(),
    };

    div()
        .min_h(px(24.0))
        .flex()
        .flex_row()
        .items_center()
        .gap_2()
        .text_size(px(12.0))
        .child(
            div()
                .w(px(72.0))
                .text_color(theme.muted_subtle)
                .child(file.status.clone()),
        )
        .child(
            div()
                .flex_1()
                .min_w_0()
                .overflow_hidden()
                .text_ellipsis()
                .whitespace_nowrap()
                .font_family(theme.code_font_family)
                .text_color(theme.foreground.opacity(0.82))
                .child(file.path.clone()),
        )
        .child(
            div()
                .font_family(theme.code_font_family)
                .text_color(theme.muted)
                .child(stat),
        )
        .into_any_element()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn editor_capability_notice_names_missing_desktop_buffer_client() {
        let available = EditorProjection {
            can_sync_buffers: true,
            ..EditorProjection::default()
        };
        assert!(editor_capability_notice(&available).contains("Editor RPC is available"));
        assert!(editor_capability_notice(&available).contains("no desktop editor-buffer client"));

        let unavailable = EditorProjection::default();
        assert!(editor_capability_notice(&unavailable).contains("Editor RPC is unavailable"));
        assert!(editor_capability_notice(&unavailable).contains("connected host"));
    }
}

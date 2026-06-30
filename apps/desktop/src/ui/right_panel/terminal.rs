use crate::{
    stores::DesktopProjection,
    ui::{components::*, theme::Theme},
};
use ace_protocol::terminal::TerminalSessionStatus;
use gpui::{AnyElement, IntoElement, div, prelude::*, px};
use gpui_component::scroll::ScrollableElement as _;

use super::{empty_panel_body, short_path};

pub(super) fn terminal_body(theme: Theme, projection: &DesktopProjection) -> AnyElement {
    div()
        .flex_1()
        .min_h_0()
        .p_3()
        .child(terminal_content(theme, projection))
        .into_any_element()
}

pub(super) fn terminal_inspector_body(theme: Theme, projection: &DesktopProjection) -> AnyElement {
    terminal_content(theme, projection)
}

fn terminal_content(theme: Theme, projection: &DesktopProjection) -> AnyElement {
    if let Some(reason) = projection.services.terminal.missing_reason() {
        return empty_panel_body(theme, AceIconName::Terminal, "Terminal", reason);
    }

    if projection.chat.active_thread.is_none() {
        return empty_panel_body(
            theme,
            AceIconName::Terminal,
            "Terminal",
            "Select a thread to attach a PTY-backed terminal session.",
        );
    }

    div()
        .size_full()
        .flex()
        .flex_col()
        .gap_2()
        .child(terminal_status_bar(theme, projection))
        .child(terminal_output(theme, projection))
        .child(terminal_input_row(theme, projection))
        .into_any_element()
}

fn terminal_status_bar(theme: Theme, projection: &DesktopProjection) -> AnyElement {
    let Some(session) = projection.terminal.session.as_ref() else {
        return div()
            .h(px(32.0))
            .rounded_md()
            .border_1()
            .border_color(theme.border_subtle)
            .bg(theme.panel)
            .px_2()
            .flex()
            .items_center()
            .gap_2()
            .text_size(px(12.0))
            .text_color(theme.muted)
            .child(ace_icon_svg(AceIconName::Terminal, theme.muted))
            .child("Opening PTY session...")
            .into_any_element();
    };

    let status = match session.status {
        TerminalSessionStatus::Starting => "Starting",
        TerminalSessionStatus::Running => "Running",
        TerminalSessionStatus::Exited => "Exited",
        TerminalSessionStatus::Error => "Error",
    };
    let pid = session
        .pid
        .map(|pid| format!("pid {pid}"))
        .unwrap_or_else(|| "no pid".to_string());

    div()
        .h(px(32.0))
        .rounded_md()
        .border_1()
        .border_color(theme.border_subtle)
        .bg(theme.panel)
        .px_2()
        .flex()
        .flex_row()
        .items_center()
        .gap_2()
        .text_size(px(12.0))
        .child(ace_icon_svg(AceIconName::Terminal, theme.muted))
        .child(
            div()
                .text_color(if session.status == TerminalSessionStatus::Running {
                    theme.accent_success
                } else {
                    theme.muted
                })
                .child(status),
        )
        .child(div().text_color(theme.muted_subtle).child(pid))
        .child(
            div()
                .flex_1()
                .min_w_0()
                .overflow_hidden()
                .text_ellipsis()
                .whitespace_nowrap()
                .text_color(theme.muted)
                .child(short_path(&session.cwd)),
        )
        .into_any_element()
}

fn terminal_output(theme: Theme, projection: &DesktopProjection) -> AnyElement {
    let history = projection
        .terminal
        .session
        .as_ref()
        .map(|session| session.history.as_str())
        .unwrap_or("");
    let lines = terminal_visible_lines(history);

    div()
        .flex_1()
        .min_h_0()
        .rounded_md()
        .border_1()
        .border_color(theme.border_subtle)
        .bg(theme.panel_deep)
        .p_3()
        .font_family(theme.code_font_family)
        .text_size(px(11.0))
        .line_height(px(16.0))
        .text_color(theme.foreground.opacity(0.82))
        .children(lines.into_iter().map(|line| {
            div().min_h(px(16.0)).child(if line.is_empty() {
                " ".to_string()
            } else {
                line
            })
        }))
        .when_some(projection.terminal.error.as_deref(), |this, error| {
            this.child(
                div()
                    .mt_2()
                    .text_color(theme.accent_danger)
                    .child(error.to_string()),
            )
        })
        .overflow_y_scrollbar()
        .into_any_element()
}

fn terminal_input_row(theme: Theme, projection: &DesktopProjection) -> AnyElement {
    let input = projection.terminal.input.as_str();
    let prompt = if input.is_empty() {
        "Type a command; Enter runs it in the PTY"
    } else {
        input
    };

    div()
        .min_h(px(36.0))
        .rounded_md()
        .border_1()
        .border_color(if projection.terminal.can_send {
            theme.border
        } else {
            theme.border_subtle
        })
        .bg(theme.background_elevated)
        .px_2()
        .flex()
        .flex_row()
        .items_center()
        .gap_2()
        .font_family(theme.code_font_family)
        .text_size(px(12.0))
        .child(div().text_color(theme.accent_success).child("$"))
        .child(
            div()
                .flex_1()
                .min_w_0()
                .overflow_hidden()
                .text_ellipsis()
                .whitespace_nowrap()
                .text_color(if input.is_empty() {
                    theme.muted_subtle
                } else {
                    theme.foreground
                })
                .child(prompt.to_string()),
        )
        .child(
            div()
                .text_color(theme.muted_subtle)
                .font_family(theme.ui_font_family)
                .child("Enter"),
        )
        .into_any_element()
}

fn terminal_visible_lines(history: &str) -> Vec<String> {
    const MAX_TERMINAL_RENDER_LINES: usize = 240;
    let mut lines = history
        .lines()
        .rev()
        .take(MAX_TERMINAL_RENDER_LINES)
        .map(sanitize_terminal_line)
        .collect::<Vec<_>>();
    lines.reverse();
    if lines.is_empty() {
        lines.push("PTY session is attached. No shell output has been received yet.".to_string());
    }
    lines
}

fn sanitize_terminal_line(line: &str) -> String {
    let mut clean = String::with_capacity(line.len());
    let mut chars = line.chars().peekable();
    while let Some(char) = chars.next() {
        if char == '\u{1b}' {
            for next in chars.by_ref() {
                if next.is_ascii_alphabetic() || next == '~' {
                    break;
                }
            }
            continue;
        }
        if !char.is_control() || char == '\t' {
            clean.push(char);
        }
    }
    clean
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terminal_visible_lines_reports_empty_attached_session() {
        assert_eq!(
            terminal_visible_lines(""),
            vec!["PTY session is attached. No shell output has been received yet.".to_string()]
        );
    }
}

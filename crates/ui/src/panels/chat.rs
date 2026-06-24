use crate::{
    components::{code_pill, composer, icon_button, tab},
    icons::IconKind,
    shell::AppShell,
    state::{FocusedField, MessageRole, UiMessage},
    theme::{colors, metrics},
};
use gpui::{
    AnyElement, Context, FontWeight, InteractiveElement, IntoElement, ParentElement,
    StatefulInteractiveElement, Styled, div, px, rgb,
};

pub(super) fn chat_workspace(shell: &AppShell, cx: &mut Context<AppShell>) -> AnyElement {
    div()
        .id("ace-chat-workspace")
        .flex()
        .flex_1()
        .min_h_0()
        .border_b_1()
        .border_color(rgb(colors::BORDER))
        .child(chat_pane_left(shell, cx))
        .child(chat_pane_right(shell, cx))
        .into_any_element()
}

fn chat_pane_left(shell: &AppShell, cx: &mut Context<AppShell>) -> AnyElement {
    let state = shell.state();
    div()
        .id("ace-left-thread")
        .flex()
        .flex_1()
        .min_w_0()
        .h_full()
        .flex_col()
        .border_r_1()
        .border_color(rgb(colors::BORDER))
        .bg(rgb(colors::PANE))
        .child(left_thread_header(state.selected_thread_id.as_deref()))
        .child(thread_body(&state.messages))
        .child(
            div()
                .px(px(36.0))
                .pb(px(16.0))
                .id("left-composer")
                .track_focus(&shell.composer_focus())
                .on_click(cx.listener(|this, _, window, cx| this.focus_composer(window, cx)))
                .child(composer(
                    &state.composer_text,
                    state.focused_field == FocusedField::Composer,
                    "Full access",
                    "5.5",
                )),
        )
        .into_any_element()
}

fn chat_pane_right(shell: &AppShell, cx: &mut Context<AppShell>) -> AnyElement {
    let state = shell.state();
    div()
        .id("ace-right-thread")
        .flex()
        .flex_1()
        .min_w_0()
        .h_full()
        .flex_col()
        .bg(rgb(colors::PANE))
        .child(right_thread_tabs(cx))
        .child(working_context(state.selected_project_root.as_deref()))
        .child(
            div()
                .px(px(120.0))
                .pb(px(16.0))
                .id("right-composer")
                .track_focus(&shell.composer_focus())
                .on_click(cx.listener(|this, _, window, cx| this.focus_composer(window, cx)))
                .child(composer(
                    &state.composer_text,
                    state.focused_field == FocusedField::Composer,
                    "Full access",
                    "5.5 Medium",
                )),
        )
        .into_any_element()
}

fn left_thread_header(thread_id: Option<&str>) -> AnyElement {
    div()
        .h(px(metrics::CHAT_HEADER_HEIGHT))
        .flex()
        .items_center()
        .justify_between()
        .px(px(18.0))
        .border_b_1()
        .border_color(rgb(colors::BORDER))
        .child(
            div()
                .flex()
                .items_center()
                .gap(px(12.0))
                .child(icon_button(IconKind::Back))
                .child(icon_button(IconKind::Forward))
                .child(
                    div()
                        .font_weight(FontWeight(700.0))
                        .child(thread_id.unwrap_or("New chat").to_owned()),
                ),
        )
        .child(icon_button(IconKind::Menu))
        .into_any_element()
}

fn right_thread_tabs(cx: &mut Context<AppShell>) -> AnyElement {
    div()
        .h(px(metrics::CHAT_HEADER_HEIGHT))
        .flex()
        .items_center()
        .gap(px(8.0))
        .px(px(14.0))
        .border_b_1()
        .border_color(rgb(colors::BORDER))
        .bg(rgb(colors::PANE))
        .child(tab("Workspace", true))
        .child(tab("Files", false))
        .child(tab("Activity", false))
        .child(
            div()
                .id("tabs-new-chat")
                .on_click(cx.listener(|this, _, _, cx| this.create_thread(cx)))
                .child(icon_button(IconKind::Add)),
        )
        .into_any_element()
}

fn thread_body(messages: &[UiMessage]) -> AnyElement {
    let body = div()
        .flex_1()
        .min_h_0()
        .overflow_hidden()
        .px(px(36.0))
        .py(px(28.0))
        .flex()
        .flex_col()
        .gap(px(16.0));

    if messages.is_empty() {
        return body.child(empty_thread()).into_any_element();
    }

    body.children(messages.iter().map(message_row))
        .into_any_element()
}

fn empty_thread() -> AnyElement {
    div()
        .flex_1()
        .flex()
        .items_center()
        .justify_center()
        .text_color(rgb(colors::TEXT_SUBTLE))
        .child("Start a thread from the composer or select an existing chat.")
        .into_any_element()
}

fn message_row(message: &UiMessage) -> AnyElement {
    match message.role {
        MessageRole::User => user_bubble(message),
        MessageRole::Assistant | MessageRole::System => assistant_bubble(message),
    }
}

fn user_bubble(message: &UiMessage) -> AnyElement {
    div()
        .flex()
        .justify_end()
        .child(
            div()
                .max_w(px(480.0))
                .px(px(16.0))
                .py(px(12.0))
                .rounded(px(16.0))
                .bg(rgb(colors::CARD))
                .text_color(rgb(if message.pending {
                    colors::TEXT_MUTED
                } else {
                    colors::TEXT
                }))
                .child(message.text.clone()),
        )
        .into_any_element()
}

fn assistant_bubble(message: &UiMessage) -> AnyElement {
    div()
        .max_w(px(720.0))
        .flex()
        .flex_col()
        .gap(px(8.0))
        .child(
            div()
                .text_color(rgb(colors::TEXT))
                .child(message.text.clone()),
        )
        .into_any_element()
}

fn working_context(project_root: Option<&str>) -> AnyElement {
    div()
        .flex_1()
        .min_h_0()
        .overflow_hidden()
        .px(px(120.0))
        .py(px(40.0))
        .flex()
        .flex_col()
        .gap(px(18.0))
        .child(
            div()
                .font_weight(FontWeight(700.0))
                .child("Workspace context"),
        )
        .child(
            div()
                .text_color(rgb(colors::TEXT_MUTED))
                .child(project_root.unwrap_or("No project selected").to_owned()),
        )
        .child(
            div()
                .flex()
                .items_center()
                .gap(px(8.0))
                .text_color(rgb(colors::TEXT_MUTED))
                .child("Active APIs")
                .child(code_pill("projects.list"))
                .child(code_pill("codex.thread.start"))
                .child(code_pill("codex.turn.start")),
        )
        .into_any_element()
}

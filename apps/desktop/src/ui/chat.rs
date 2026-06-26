use crate::ui::{components::*, theme::Theme};
use ace_runtime::chat::{ChatMessageProjection, ChatMessageRole, ChatProjection};
use gpui::{AnyElement, App, IntoElement, Window, div, prelude::*, px};
use gpui_component::{IconName, scroll::ScrollableElement as _, text::TextView};

pub(super) fn workspace_panel(
    theme: Theme,
    sidebar_collapsed: bool,
    chat: ChatProjection,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    div()
        .id("ace-workspace")
        .flex_1()
        .min_h_0()
        .bg(theme.background)
        .flex()
        .flex_col()
        .child(workspace_chrome(theme, sidebar_collapsed))
        .child(
            div()
                .flex_1()
                .min_h_0()
                .flex()
                .flex_col()
                .child(message_timeline(theme, &chat, window, cx))
                .child(chat_composer(theme, &chat)),
        )
        .into_any_element()
}

fn workspace_chrome(theme: Theme, sidebar_collapsed: bool) -> AnyElement {
    div()
        .id("workspace-chrome")
        .h(px(46.0))
        .border_b_1()
        .border_color(theme.border_subtle)
        .px_3()
        .flex()
        .flex_row()
        .items_center()
        .justify_between()
        .child(
            div()
                .flex()
                .flex_row()
                .items_center()
                .gap_2()
                .when(sidebar_collapsed, |this| {
                    this.child(collapse_button(IconName::PanelLeftOpen, theme))
                })
                .child(icon_button(IconName::Bot, theme)),
        )
        .child(
            div()
                .flex()
                .flex_row()
                .items_center()
                .gap_1()
                .child(icon_button(IconName::Plus, theme))
                .child(icon_button(IconName::Maximize, theme))
                .child(icon_button(IconName::PanelRight, theme)),
        )
        .into_any_element()
}

fn message_timeline(
    theme: Theme,
    chat: &ChatProjection,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    const MAX_RENDERED_MESSAGES: usize = 200;
    let skipped = chat.messages.len().saturating_sub(MAX_RENDERED_MESSAGES);

    div()
        .id("chat-timeline")
        .flex_1()
        .min_h_0()
        .px_5()
        .pt_5()
        .pb_4()
        .flex()
        .flex_col()
        .when(chat.messages.is_empty(), |this| {
            this.child(new_thread_landing(theme))
        })
        .when(skipped > 0, |this| {
            this.child(
                div()
                    .rounded_md()
                    .border_1()
                    .border_color(theme.border_subtle)
                    .bg(theme.panel_deep)
                    .px_3()
                    .py_2()
                    .text_size(px(12.0))
                    .text_color(theme.muted)
                    .child(format!("Showing latest {MAX_RENDERED_MESSAGES} messages")),
            )
        })
        .children(
            chat.messages
                .iter()
                .skip(skipped)
                .enumerate()
                .map(|(index, message)| {
                    let previous_role = index
                        .checked_sub(1)
                        .and_then(|previous_index| chat.messages.get(skipped + previous_index))
                        .map(|message| message.role);

                    timeline_message_card(theme, previous_role, message, window, cx)
                })
                .collect::<Vec<_>>(),
        )
        .overflow_y_scrollbar()
        .into_any_element()
}

fn timeline_message_card(
    theme: Theme,
    previous_role: Option<ChatMessageRole>,
    message: &ChatMessageProjection,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let text = message
        .text
        .clone()
        .or(message.title.clone())
        .unwrap_or_default();
    let top_spacing = message_top_spacing(previous_role, message.role);

    match message.role {
        ChatMessageRole::User => div()
            .w_full()
            .flex()
            .justify_end()
            .when(top_spacing >= 5, |this| this.mt_5())
            .when(top_spacing == 3, |this| this.mt_3())
            .child(
                div()
                    .max_w(px(720.0))
                    .rounded_lg()
                    .bg(theme.background_elevated)
                    .border_1()
                    .border_color(theme.border)
                    .px_4()
                    .py_3()
                    .child(markdown_render(stable_id(&message.id), &text, window, cx)),
            )
            .into_any_element(),
        ChatMessageRole::Assistant => div()
            .max_w(px(820.0))
            .flex()
            .flex_col()
            .px_1()
            .when(top_spacing >= 5, |this| this.mt_5())
            .when(top_spacing == 3, |this| this.mt_3())
            .child(markdown_render(stable_id(&message.id), &text, window, cx))
            .into_any_element(),
        ChatMessageRole::Tool => tool_call_card(
            theme,
            message.title.as_deref().unwrap_or("Tool"),
            &text,
            message.id.as_str(),
            window,
            cx,
        ),
        ChatMessageRole::Plan => div()
            .max_w(px(820.0))
            .rounded_lg()
            .border_1()
            .border_color(theme.accent_warning.opacity(0.45))
            .bg(theme.panel)
            .p_3()
            .flex()
            .flex_col()
            .gap_2()
            .when(top_spacing >= 5, |this| this.mt_5())
            .when(top_spacing == 3, |this| this.mt_3())
            .child(message_label(theme, "Plan"))
            .child(markdown_render(stable_id(&message.id), &text, window, cx))
            .into_any_element(),
        ChatMessageRole::Activity => div()
            .max_w(px(720.0))
            .rounded_md()
            .border_1()
            .border_color(theme.border_subtle)
            .bg(theme.panel_deep)
            .px_3()
            .py_2()
            .text_size(px(12.0))
            .text_color(theme.muted)
            .when(top_spacing >= 5, |this| this.mt_5())
            .when(top_spacing == 3, |this| this.mt_3())
            .child(text)
            .into_any_element(),
    }
}

fn message_top_spacing(
    previous_role: Option<ChatMessageRole>,
    current_role: ChatMessageRole,
) -> usize {
    match (previous_role, current_role) {
        (None, _) | (Some(ChatMessageRole::Assistant), ChatMessageRole::Assistant) => 0,
        (Some(ChatMessageRole::User), ChatMessageRole::Assistant)
        | (Some(ChatMessageRole::Assistant), ChatMessageRole::User) => 5,
        _ => 3,
    }
}

fn message_label(theme: Theme, label: &'static str) -> AnyElement {
    div()
        .text_size(px(11.0))
        .text_color(theme.muted)
        .child(label)
        .into_any_element()
}

fn tool_call_card(
    theme: Theme,
    title: &str,
    text: &str,
    id: &str,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    div()
        .max_w(px(820.0))
        .rounded_lg()
        .border_1()
        .border_color(theme.border_subtle)
        .bg(theme.panel_deep)
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
                .text_color(theme.foreground.opacity(0.78))
                .child(icon_tile(IconName::SquareTerminal, theme))
                .child(title.to_string()),
        )
        .when(!text.trim().is_empty(), |this| {
            this.child(markdown_render(stable_id(id), text, window, cx))
        })
        .into_any_element()
}

fn markdown_render(id: u64, text: &str, window: &mut Window, cx: &mut App) -> AnyElement {
    TextView::markdown(("markdown", id), text.to_string(), window, cx)
        .selectable(true)
        .into_any_element()
}

fn stable_id(value: &str) -> u64 {
    value.bytes().fold(0xcbf29ce484222325, |hash, byte| {
        (hash ^ u64::from(byte)).wrapping_mul(0x100000001b3)
    })
}

fn new_thread_landing(theme: Theme) -> AnyElement {
    div()
        .size_full()
        .flex()
        .items_center()
        .justify_center()
        .child(
            div()
                .w(px(760.0))
                .flex()
                .flex_col()
                .gap_5()
                .child(
                    div()
                        .text_size(px(30.0))
                        .font_weight(gpui::FontWeight::MEDIUM)
                        .text_color(theme.foreground.opacity(0.86))
                        .child("What should we build in ace?"),
                )
                .child(landing_composer(theme)),
        )
        .into_any_element()
}

fn landing_composer(theme: Theme) -> AnyElement {
    div()
        .rounded_lg()
        .border_1()
        .border_color(theme.border)
        .bg(theme.background_elevated)
        .flex()
        .flex_col()
        .child(
            div()
                .min_h(px(98.0))
                .p_4()
                .flex()
                .flex_col()
                .justify_between()
                .child(
                    div()
                        .text_size(px(14.0))
                        .text_color(theme.muted_subtle)
                        .child("Do anything"),
                )
                .child(
                    div()
                        .flex()
                        .flex_row()
                        .items_center()
                        .justify_between()
                        .child(
                            div()
                                .flex()
                                .flex_row()
                                .items_center()
                                .gap_3()
                                .child(icon_button(IconName::Plus, theme))
                                .child(access_chip(theme)),
                        )
                        .child(
                            div()
                                .flex()
                                .flex_row()
                                .items_center()
                                .gap_3()
                                .child(model_chip(theme, "GPT-5.5", "Medium"))
                                .child(send_button(theme)),
                        ),
                ),
        )
        .child(
            div()
                .border_t_1()
                .border_color(theme.border_subtle)
                .h(px(48.0))
                .px_4()
                .flex()
                .flex_row()
                .items_center()
                .gap_4()
                .text_size(px(13.0))
                .text_color(theme.muted)
                .child(meta_chip(IconName::Bot, "ace", theme))
                .child(meta_chip(IconName::SquareTerminal, "Locally", theme))
                .child(meta_chip(
                    IconName::GitHub,
                    "fix/heavy-load-optimization",
                    theme,
                ))
                .child(div().flex_1())
                .child(meta_chip(IconName::Globe, "GitHub", theme)),
        )
        .into_any_element()
}

fn chat_composer(theme: Theme, chat: &ChatProjection) -> AnyElement {
    if chat.messages.is_empty() {
        return div().into_any_element();
    }

    let prompt = chat
        .composer
        .as_ref()
        .map(|draft| draft.prompt.clone())
        .unwrap_or_default();
    div()
        .id("chat-composer")
        .border_t_1()
        .border_color(theme.border_subtle)
        .p_3()
        .bg(theme.background)
        .child(
            div()
                .rounded_lg()
                .border_1()
                .border_color(theme.border)
                .bg(theme.background_elevated)
                .p_3()
                .flex()
                .flex_col()
                .gap_3()
                .child(
                    div()
                        .min_h(px(56.0))
                        .text_size(px(14.0))
                        .text_color(if prompt.is_empty() {
                            theme.muted_subtle
                        } else {
                            theme.foreground
                        })
                        .child(if prompt.is_empty() {
                            "Do anything".to_string()
                        } else {
                            prompt
                        }),
                )
                .child(
                    div()
                        .flex()
                        .flex_row()
                        .items_center()
                        .justify_between()
                        .child(
                            div()
                                .flex()
                                .flex_row()
                                .items_center()
                                .gap_2()
                                .child(icon_button(IconName::Plus, theme))
                                .child(access_chip(theme))
                                .child(meta_chip(IconName::SquareTerminal, "Locally", theme)),
                        )
                        .child(
                            div()
                                .flex()
                                .flex_row()
                                .items_center()
                                .gap_2()
                                .when(chat.can_interrupt, |this| {
                                    this.child(action_button(
                                        IconName::CircleX,
                                        "Interrupt",
                                        theme,
                                        || Box::new(crate::actions::InterruptActiveTurn),
                                    ))
                                })
                                .child(action_button(IconName::ArrowUp, "Send", theme, || {
                                    Box::new(crate::actions::SendActiveComposer)
                                })),
                        ),
                ),
        )
        .into_any_element()
}

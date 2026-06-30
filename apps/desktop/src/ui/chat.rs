use crate::{
    actions::{
        CreateTodoFromTimelineItem, PinTimelineItem, ToggleBottomPanel, ToggleEnvironmentPanel,
        ToggleHighlightTimelineItem, ToggleRightPanel, ToggleSidebar,
    },
    stores::{DesktopProjection, ThreadAnnotationsProjection, TodoStatus, ui::UiState},
    ui::{components::*, right_panel::environment_card, theme::Theme},
};
use ace_runtime::chat::{
    ChatMessageProjection, ChatMessageRole, ChatProjection, InteractionMode, RuntimeMode,
};
use gpui::{AnyElement, App, IntoElement, Window, div, prelude::*, px};
use gpui_component::{IconName, scroll::ScrollableElement as _, text::TextView};

pub(super) fn workspace_panel(
    theme: Theme,
    ui_state: &UiState,
    projection: DesktopProjection,
    reserve_titlebar_controls: bool,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let show_inline_environment_card = has_room_for_environment_card(theme, ui_state, window);
    let chat = &projection.chat;
    div()
        .id("ace-workspace")
        .relative()
        .flex_1()
        .min_h_0()
        .bg(theme.background)
        .flex()
        .flex_col()
        .child(workspace_chrome(
            theme,
            ui_state,
            &projection,
            reserve_titlebar_controls,
            show_inline_environment_card,
        ))
        .when(
            ui_state.environment_panel_visible && show_inline_environment_card,
            |this| {
                this.child(
                    div().px_6().pt_3().flex().justify_end().child(
                        div()
                            .w(theme.environment_card_width)
                            .child(environment_card(theme, chat.active_thread.as_ref())),
                    ),
                )
            },
        )
        .when(
            ui_state.environment_panel_visible && !show_inline_environment_card,
            |this| {
                this.child(
                    div()
                        .absolute()
                        .top(theme.environment_card_floating_top)
                        .right(theme.environment_card_floating_right)
                        .w(theme.environment_card_width)
                        .child(environment_card(theme, chat.active_thread.as_ref())),
                )
            },
        )
        .child(
            div()
                .relative()
                .flex_1()
                .min_h_0()
                .flex()
                .flex_col()
                .child(message_timeline(
                    theme,
                    chat,
                    &projection.annotations,
                    window,
                    cx,
                ))
                .child(chat_composer(theme, chat)),
        )
        .into_any_element()
}

fn workspace_chrome(
    theme: Theme,
    ui_state: &UiState,
    projection: &DesktopProjection,
    reserve_titlebar_controls: bool,
    _show_inline_environment_card: bool,
) -> AnyElement {
    let chat = &projection.chat;
    let title = chat
        .active_thread
        .as_ref()
        .map(|thread| thread.title.as_str())
        .unwrap_or("New chat");
    let project = active_project_label(projection);
    let branch = composer_branch_label(chat);
    let mode = composer_mode_label(chat);
    let status = thread_status_label(chat);
    let todos = todo_progress_label(&projection.annotations);
    let provider = composer_provider_label(chat);
    let model = composer_model_label(chat);
    let host = projection.host.label.as_str();
    div()
        .id("workspace-chrome")
        .h(theme.center_header_height)
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
                .when(ui_state.sidebar_collapsed, |this| {
                    this.when(reserve_titlebar_controls, |this| {
                        this.child(div().w(theme.titlebar_control_reserve_width))
                    })
                    .child(ace_icon_toggle_button(
                        AceIconName::PanelLeftOpen,
                        false,
                        theme,
                        "Toggle sidebar",
                        ToggleSidebar,
                        || Box::new(ToggleSidebar),
                    ))
                })
                .child(icon_tile(IconName::Bot, theme))
                .child(
                    div()
                        .min_w_0()
                        .max_w(theme.center_header_title_max_width)
                        .flex()
                        .flex_col()
                        .gap_1()
                        .child(
                            div()
                                .overflow_hidden()
                                .text_ellipsis()
                                .whitespace_nowrap()
                                .text_size(px(13.0))
                                .text_color(theme.foreground.opacity(0.86))
                                .child(title.to_string()),
                        )
                        .child(
                            div()
                                .min_w_0()
                                .flex()
                                .flex_row()
                                .items_center()
                                .gap_2()
                                .child(header_meta_chip(theme, IconName::FolderOpen, project))
                                .child(header_meta_chip(theme, IconName::SquareTerminal, mode))
                                .child(header_meta_chip(theme, IconName::FolderOpen, branch))
                                .child(header_meta_chip(theme, IconName::Check, status))
                                .child(header_meta_chip(theme, IconName::Check, todos))
                                .child(header_meta_chip(
                                    theme,
                                    IconName::Bot,
                                    format!("{provider} · {model}"),
                                ))
                                .child(header_meta_chip(theme, IconName::Globe, host.to_string())),
                        ),
                ),
        )
        .child(
            div()
                .flex()
                .flex_row()
                .items_center()
                .gap_1()
                .child(ace_icon_toggle_button(
                    AceIconName::Environment,
                    ui_state.environment_panel_visible,
                    theme,
                    "Toggle environment",
                    ToggleEnvironmentPanel,
                    || Box::new(ToggleEnvironmentPanel),
                ))
                .when(!ui_state.right_panel_visible, |this| {
                    this.child(ace_icon_toggle_button(
                        if ui_state.bottom_panel_visible {
                            AceIconName::PanelBottomOpen
                        } else {
                            AceIconName::PanelBottomClosed
                        },
                        ui_state.bottom_panel_visible,
                        theme,
                        "Toggle bottom panel",
                        ToggleBottomPanel,
                        || Box::new(ToggleBottomPanel),
                    ))
                    .child(ace_icon_toggle_button(
                        AceIconName::PanelRightClosed,
                        false,
                        theme,
                        "Toggle right panel",
                        ToggleRightPanel,
                        || Box::new(ToggleRightPanel),
                    ))
                }),
        )
        .into_any_element()
}

fn header_meta_chip(theme: Theme, icon: IconName, label: impl Into<String>) -> AnyElement {
    let meta_opacity = theme.micro_interaction_opacity();
    div()
        .min_w_0()
        .max_w(theme.center_header_meta_max_width)
        .h(theme.center_header_meta_height)
        .flex()
        .flex_row()
        .items_center()
        .gap_1()
        .text_size(px(11.0))
        .text_color(theme.muted.opacity(meta_opacity))
        .child(icon_svg(icon, theme.muted_subtle.opacity(meta_opacity)))
        .child(
            div()
                .min_w_0()
                .overflow_hidden()
                .text_ellipsis()
                .whitespace_nowrap()
                .child(label.into()),
        )
        .into_any_element()
}

fn active_project_label(projection: &DesktopProjection) -> String {
    projection
        .chat
        .active_thread
        .as_ref()
        .and_then(|thread| {
            projection
                .sidebar
                .projects
                .iter()
                .find(|group| group.project.id == thread.project_id)
                .map(|group| group.project.name.clone())
        })
        .unwrap_or_else(|| "No project".to_string())
}

fn thread_status_label(chat: &ChatProjection) -> String {
    chat.active_thread
        .as_ref()
        .map(|thread| thread.status.label().to_string())
        .unwrap_or_else(|| "Draft".to_string())
}

fn todo_progress_label(annotations: &ThreadAnnotationsProjection) -> String {
    let total = annotations.todos.len();
    if total == 0 {
        return "0 todos".to_string();
    }

    let completed = annotations
        .todos
        .iter()
        .filter(|todo| matches!(todo.status, TodoStatus::Done | TodoStatus::Canceled))
        .count();
    format!("{completed}/{total} todos")
}

fn has_room_for_environment_card(theme: Theme, ui_state: &UiState, window: &Window) -> bool {
    let mut available_width = f32::from(window.bounds().size.width);
    if !ui_state.sidebar_collapsed {
        available_width -= ui_state.sidebar_width + theme.panel_gutter_width;
    }
    if ui_state.right_panel_visible {
        available_width -= ui_state.right_panel_width + theme.panel_gutter_width;
    }
    available_width >= theme.environment_card_inline_min_width
}

fn message_timeline(
    theme: Theme,
    chat: &ChatProjection,
    annotations: &ThreadAnnotationsProjection,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let max_rendered_messages = theme.timeline_max_rendered_messages;
    let skipped = chat.messages.len().saturating_sub(max_rendered_messages);
    let active_thread_id = chat.active_thread.as_ref().map(|thread| thread.id.clone());

    div()
        .id("chat-timeline")
        .flex_1()
        .min_h_0()
        .px_6()
        .pt_5()
        .pb_4()
        .flex()
        .flex_col()
        .when(chat.messages.is_empty(), |this| {
            this.child(new_thread_landing(theme, chat))
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
                    .child(format!("Showing latest {max_rendered_messages} messages")),
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

                    let pinned = annotations
                        .pinned_items
                        .iter()
                        .any(|item| item.message_id == message.id);
                    let highlighted = annotations
                        .highlighted_items
                        .iter()
                        .any(|item| item.message_id == message.id);
                    let todo_count = annotations
                        .todos
                        .iter()
                        .filter(|todo| {
                            todo.source_message_id.as_deref() == Some(message.id.as_str())
                        })
                        .count();

                    div()
                        .flex()
                        .flex_col()
                        .when(pinned || highlighted || todo_count > 0, |this| {
                            this.child(message_annotation_bar(
                                theme,
                                pinned,
                                highlighted,
                                todo_count,
                            ))
                        })
                        .child(timeline_message_card(
                            theme,
                            previous_role,
                            message,
                            window,
                            cx,
                        ))
                        .when_some(active_thread_id.clone(), |this, thread_id| {
                            this.child(message_actions(theme, thread_id, message.id.clone()))
                        })
                })
                .collect::<Vec<_>>(),
        )
        .overflow_y_scrollbar()
        .into_any_element()
}

fn message_actions(theme: Theme, thread_id: ace_core::ThreadId, message_id: String) -> AnyElement {
    div()
        .mt_1()
        .mb_1()
        .flex()
        .flex_row()
        .items_center()
        .gap_1()
        .text_color(theme.muted)
        .child(action_button(IconName::Star, "Pin", theme, {
            let thread_id = thread_id.clone();
            let message_id = message_id.clone();
            move || {
                Box::new(PinTimelineItem {
                    thread_id: thread_id.clone(),
                    message_id: message_id.clone(),
                })
            }
        }))
        .child(action_button(IconName::Star, "Highlight", theme, {
            let thread_id = thread_id.clone();
            let message_id = message_id.clone();
            move || {
                Box::new(ToggleHighlightTimelineItem {
                    thread_id: thread_id.clone(),
                    message_id: message_id.clone(),
                })
            }
        }))
        .child(action_button(IconName::Plus, "Todo", theme, move || {
            Box::new(CreateTodoFromTimelineItem {
                thread_id: thread_id.clone(),
                message_id: message_id.clone(),
            })
        }))
        .into_any_element()
}

fn message_annotation_bar(
    theme: Theme,
    pinned: bool,
    highlighted: bool,
    todo_count: usize,
) -> AnyElement {
    div()
        .mt_3()
        .mb_1()
        .flex()
        .flex_row()
        .items_center()
        .gap_2()
        .text_size(px(11.0))
        .text_color(theme.muted)
        .when(pinned, |this| {
            this.child(annotation_chip(theme, IconName::Star, "Pinned"))
        })
        .when(highlighted, |this| {
            this.child(annotation_chip(theme, IconName::Star, "Highlighted"))
        })
        .when(todo_count > 0, |this| {
            this.child(annotation_chip(theme, IconName::Check, "Todo"))
        })
        .into_any_element()
}

fn annotation_chip(theme: Theme, icon: IconName, label: &'static str) -> AnyElement {
    div()
        .h(px(22.0))
        .rounded_md()
        .border_1()
        .border_color(theme.border_subtle)
        .bg(theme.panel)
        .px_2()
        .flex()
        .flex_row()
        .items_center()
        .gap_1()
        .child(icon_svg(icon, theme.muted))
        .child(label)
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
                    .child(markdown_render(
                        theme,
                        stable_id(&message.id),
                        &text,
                        window,
                        cx,
                    )),
            )
            .into_any_element(),
        ChatMessageRole::Assistant => div()
            .max_w(px(820.0))
            .flex()
            .flex_col()
            .px_1()
            .when(top_spacing >= 5, |this| this.mt_5())
            .when(top_spacing == 3, |this| this.mt_3())
            .child(markdown_render(
                theme,
                stable_id(&message.id),
                &text,
                window,
                cx,
            ))
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
            .child(markdown_render(
                theme,
                stable_id(&message.id),
                &text,
                window,
                cx,
            ))
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
            this.child(markdown_render(theme, stable_id(id), text, window, cx))
        })
        .into_any_element()
}

fn markdown_render(
    theme: Theme,
    id: u64,
    text: &str,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    if !needs_markdown_renderer(text) {
        return plain_text_render(theme, text);
    }

    TextView::markdown(("markdown", id), text.to_string(), window, cx)
        .selectable(true)
        .font_family(theme.ui_font_family)
        .into_any_element()
}

fn plain_text_render(theme: Theme, text: &str) -> AnyElement {
    div()
        .text_size(px(12.0))
        .line_height(px(18.0))
        .font_family(if looks_like_code_text(text) {
            theme.code_font_family
        } else {
            theme.ui_font_family
        })
        .children(text.lines().map(|line| div().child(line.to_string())))
        .into_any_element()
}

fn needs_markdown_renderer(text: &str) -> bool {
    text.contains("```")
        || text.contains('`')
        || text.contains('[')
        || text.contains('<')
        || text.contains('|')
        || text.lines().any(|line| {
            let trimmed = line.trim_start();
            trimmed.starts_with("# ")
                || trimmed.starts_with("##")
                || trimmed.starts_with("> ")
                || trimmed.starts_with("- ")
                || trimmed.starts_with("* ")
                || trimmed.starts_with("+ ")
                || trimmed.starts_with("---")
                || trimmed
                    .chars()
                    .next()
                    .is_some_and(|first| first.is_ascii_digit() && trimmed.contains(". "))
        })
}

fn looks_like_code_text(text: &str) -> bool {
    text.contains("```")
        || text
            .lines()
            .any(|line| line.starts_with("    ") || line.starts_with('\t'))
}

fn stable_id(value: &str) -> u64 {
    value.bytes().fold(0xcbf29ce484222325, |hash, byte| {
        (hash ^ u64::from(byte)).wrapping_mul(0x100000001b3)
    })
}

fn new_thread_landing(theme: Theme, chat: &ChatProjection) -> AnyElement {
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
                .child(landing_composer(theme, chat)),
        )
        .into_any_element()
}

fn landing_composer(theme: Theme, chat: &ChatProjection) -> AnyElement {
    let prompt = composer_prompt(chat);
    let provider = composer_provider_label(chat);
    let model = composer_model_label(chat);
    let mode = composer_mode_label(chat);
    let branch = composer_branch_label(chat);
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
                        .text_color(if prompt.is_empty() {
                            theme.muted_subtle
                        } else {
                            theme.foreground
                        })
                        .child(if prompt.is_empty() {
                            "Do anything".to_string()
                        } else {
                            prompt.clone()
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
                                .gap_3()
                                .child(access_chip(theme)),
                        )
                        .child(
                            div()
                                .flex()
                                .flex_row()
                                .items_center()
                                .gap_3()
                                .child(model_chip(theme, &model, &provider))
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
                .child(meta_chip(IconName::Bot, &provider, theme))
                .child(meta_chip(IconName::SquareTerminal, mode, theme))
                .child(meta_chip(IconName::FolderOpen, &branch, theme))
                .child(div().flex_1())
                .child(meta_chip(IconName::Globe, "This computer", theme)),
        )
        .into_any_element()
}

fn composer_prompt(chat: &ChatProjection) -> String {
    chat.composer
        .as_ref()
        .map(|draft| draft.prompt.clone())
        .unwrap_or_default()
}

fn composer_provider_label(chat: &ChatProjection) -> String {
    chat.composer
        .as_ref()
        .map(|draft| draft.model_selection.provider.display_name().to_string())
        .or_else(|| {
            chat.active_thread
                .as_ref()
                .map(|thread| thread.provider.display_name().to_string())
        })
        .unwrap_or_else(|| "Codex".to_string())
}

fn composer_model_label(chat: &ChatProjection) -> String {
    chat.composer
        .as_ref()
        .map(|draft| draft.model_selection.model.clone())
        .or_else(|| {
            chat.active_thread
                .as_ref()
                .and_then(|thread| thread.model.clone())
        })
        .unwrap_or_else(|| "gpt-5.3-codex".to_string())
}

fn composer_mode_label(chat: &ChatProjection) -> &'static str {
    let runtime_mode = chat
        .composer
        .as_ref()
        .map(|draft| draft.runtime_mode)
        .unwrap_or_else(|| {
            if chat
                .active_thread
                .as_ref()
                .and_then(|thread| thread.worktree_path.as_ref())
                .is_some()
            {
                RuntimeMode::Worktree
            } else {
                RuntimeMode::Normal
            }
        });
    let interaction_mode = chat
        .composer
        .as_ref()
        .map(|draft| draft.interaction_mode)
        .unwrap_or(InteractionMode::Chat);

    match (runtime_mode, interaction_mode) {
        (RuntimeMode::Worktree, _) => "Worktree",
        (RuntimeMode::Local, _) => "Local",
        (RuntimeMode::Normal, InteractionMode::Plan) => "Plan",
        (RuntimeMode::Normal, InteractionMode::Chat) => "Chat",
    }
}

fn composer_branch_label(chat: &ChatProjection) -> String {
    chat.active_thread
        .as_ref()
        .and_then(|thread| thread.branch.clone())
        .or_else(|| {
            chat.active_thread
                .as_ref()
                .and_then(|thread| thread.worktree_path.clone())
                .map(|path| {
                    path.rsplit('/')
                        .next()
                        .filter(|name| !name.is_empty())
                        .unwrap_or("Worktree")
                        .to_string()
                })
        })
        .unwrap_or_else(|| "No branch".to_string())
}

fn chat_composer(theme: Theme, chat: &ChatProjection) -> AnyElement {
    if chat.messages.is_empty() {
        return div().into_any_element();
    }

    let prompt = composer_prompt(chat);
    let provider = composer_provider_label(chat);
    let model = composer_model_label(chat);
    let mode = composer_mode_label(chat);
    div()
        .id("chat-composer")
        .border_t_1()
        .border_color(theme.border_subtle)
        .px_6()
        .py_4()
        .bg(theme.background)
        .child(
            div()
                .rounded_lg()
                .border_1()
                .border_color(theme.border)
                .bg(theme.background_elevated)
                .max_w(px(860.0))
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
                                .child(access_chip(theme))
                                .child(meta_chip(IconName::SquareTerminal, mode, theme))
                                .child(model_chip(theme, &model, &provider)),
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::stores::desktop::{ComposerPayload, DesktopStore};

    #[test]
    fn center_header_labels_use_active_thread_projection() {
        let mut store = DesktopStore::new();
        let project_id = store.add_project("/tmp/ace".to_string());
        let thread_id = store.new_thread(project_id);
        store.send_message(
            thread_id,
            ComposerPayload {
                prompt: "Build the workstation".to_string(),
            },
        );

        let projection = store.projection();

        assert_eq!(active_project_label(&projection), "ace");
        assert_eq!(thread_status_label(&projection.chat), "Completed");
        assert_eq!(composer_mode_label(&projection.chat), "Chat");
        assert_eq!(composer_branch_label(&projection.chat), "No branch");
    }

    #[test]
    fn center_header_todo_progress_counts_completed_items() {
        let mut store = DesktopStore::new();
        let project_id = store.add_project("/tmp/ace".to_string());
        let thread_id = store.new_thread(project_id);
        store.send_message(
            thread_id.clone(),
            ComposerPayload {
                prompt: "Track this".to_string(),
            },
        );
        let message_id = store.projection().chat.messages[0].id.clone();
        store.create_todo_from_timeline_item(thread_id, &message_id);
        let todo_id = store.projection().annotations.todos[0].id.clone();

        assert_eq!(
            todo_progress_label(&store.projection().annotations),
            "0/1 todos"
        );

        store.update_todo_status(&todo_id, TodoStatus::Done);

        assert_eq!(
            todo_progress_label(&store.projection().annotations),
            "1/1 todos"
        );
    }
}

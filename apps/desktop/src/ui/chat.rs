use crate::{
    actions::{
        CompleteComposerToken, CreateTodoFromTimelineItem, PinTimelineItem, SelectComposerHost,
        SelectComposerModel, SetComposerInteractionMode, SetComposerPermission,
        SetComposerReasoning, SetComposerRuntimeMode, ToggleBottomPanel, ToggleComposerContext,
        ToggleComposerTrait, ToggleEnvironmentPanel, ToggleHighlightTimelineItem, ToggleRightPanel,
        ToggleSidebar,
    },
    stores::{
        DesktopProjection, HostOptionProjection, ModelProjection, ModelProviderProjection,
        ModelRegistryProjection, ProviderSlashCommandProjection, ThreadAnnotationsProjection,
        TodoStatus, ToolRegistryEntryProjection, ui::UiState,
    },
    ui::{components::*, right_panel::environment_card, theme::Theme},
};
use ace_core::ProviderKind;
use ace_runtime::chat::{
    ChatMessageProjection, ChatMessageRole, ChatProjection, ComposerContextKind, ComposerDraft,
    ComposerPermissionMode, ComposerTrait, InteractionMode, ReasoningEffort, RuntimeMode,
};
use gpui::{
    AnyElement, App, IntoElement, MouseButton, StatefulInteractiveElement as _, Window, div,
    prelude::*, px,
};
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
                    &projection,
                    &projection.annotations,
                    window,
                    cx,
                ))
                .child(chat_composer(theme, &projection)),
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
    projection: &DesktopProjection,
    annotations: &ThreadAnnotationsProjection,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let chat = &projection.chat;
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
            this.child(new_thread_landing(theme, projection))
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

fn new_thread_landing(theme: Theme, projection: &DesktopProjection) -> AnyElement {
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
                .child(landing_composer(theme, projection)),
        )
        .into_any_element()
}

fn landing_composer(theme: Theme, projection: &DesktopProjection) -> AnyElement {
    let chat = &projection.chat;
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
                            "Ask for follow-up changes".to_string()
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
                                .child(permission_chip(theme, chat)),
                        )
                        .child(
                            div()
                                .flex()
                                .flex_row()
                                .items_center()
                                .gap_3()
                                .child(composer_disabled_icon_button(
                                    IconName::File,
                                    "Attach context or image",
                                    composer_attachment_tooltip(projection, chat),
                                    theme,
                                ))
                                .child(composer_disabled_icon_button(
                                    IconName::Bot,
                                    "Voice input",
                                    "Voice input needs a desktop audio capture and realtime transcription service.",
                                    theme,
                                ))
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
        .child(composer_selector_surface(theme, projection, false))
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
        (RuntimeMode::Remote, _) => "Remote",
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

fn permission_chip(theme: Theme, chat: &ChatProjection) -> AnyElement {
    let permission = chat
        .composer
        .as_ref()
        .map(|draft| draft.permission_mode)
        .unwrap_or_default();
    div()
        .h(px(28.0))
        .rounded_md()
        .px_2()
        .flex()
        .flex_row()
        .items_center()
        .gap_1()
        .text_size(px(12.0))
        .text_color(theme.muted)
        .child(icon_svg(IconName::TriangleAlert, theme.muted))
        .child(permission.label())
        .into_any_element()
}

fn composer_selector_surface(
    theme: Theme,
    projection: &DesktopProjection,
    compact: bool,
) -> AnyElement {
    let Some(draft) = projection.chat.composer.as_ref() else {
        return div().into_any_element();
    };

    div()
        .border_t_1()
        .border_color(theme.border_subtle)
        .px_3()
        .py_3()
        .flex()
        .flex_col()
        .gap_3()
        .font_family(theme.ui_font_family)
        .when_some(
            composer_command_suggestions(theme, projection, draft),
            |this, suggestions| this.child(suggestions),
        )
        .child(composer_mode_selector(theme, projection, draft))
        .child(composer_host_selector(theme, projection, draft))
        .child(composer_permission_selector(theme, draft))
        .child(model_selector(theme, &projection.models, draft, compact))
        .when(
            selected_model_supports_reasoning(projection, draft),
            |this| this.child(reasoning_selector(theme, draft)),
        )
        .child(traits_selector(theme, draft))
        .when(has_available_context(projection), |this| {
            this.child(context_selector(theme, projection, draft))
        })
        .into_any_element()
}

#[derive(Clone)]
struct ComposerCommandSuggestion {
    label: String,
    detail: String,
    completion: String,
    icon: IconName,
}

fn composer_command_suggestions(
    theme: Theme,
    projection: &DesktopProjection,
    draft: &ComposerDraft,
) -> Option<AnyElement> {
    let token = active_composer_token(&draft.prompt)?;
    let trigger = token.chars().next()?;
    if !matches!(trigger, '/' | '$' | '@') {
        return None;
    }

    let normalized = token.to_ascii_lowercase();
    let suggestions = composer_suggestions_for_trigger(projection, trigger)
        .into_iter()
        .filter(|suggestion| {
            suggestion
                .completion
                .to_ascii_lowercase()
                .starts_with(&normalized)
        })
        .take(6)
        .collect::<Vec<_>>();

    if suggestions.is_empty() {
        return None;
    }

    Some(
        div()
            .rounded_md()
            .border_1()
            .border_color(theme.border_subtle)
            .bg(theme.panel_deep)
            .p_2()
            .flex()
            .flex_col()
            .gap_1()
            .child(
                div()
                    .text_size(px(11.0))
                    .font_weight(gpui::FontWeight::SEMIBOLD)
                    .text_color(theme.muted_subtle)
                    .child(match trigger {
                        '/' => "Slash commands",
                        '$' => "Skills",
                        '@' => "Plugins",
                        _ => "Suggestions",
                    }),
            )
            .children(
                suggestions
                    .into_iter()
                    .map(|suggestion| composer_suggestion_row(theme, suggestion))
                    .collect::<Vec<_>>(),
            )
            .into_any_element(),
    )
}

fn composer_suggestions_for_trigger(
    projection: &DesktopProjection,
    trigger: char,
) -> Vec<ComposerCommandSuggestion> {
    match trigger {
        '/' => projection
            .providers
            .commands
            .iter()
            .map(provider_command_suggestion)
            .collect(),
        '$' => projection
            .skills
            .entries
            .iter()
            .map(|entry| registry_suggestion('$', entry, IconName::Star))
            .collect(),
        '@' => {
            let mut suggestions = projection
                .plugins
                .entries
                .iter()
                .map(|entry| registry_suggestion('@', entry, IconName::Bot))
                .collect::<Vec<_>>();
            suggestions.extend(composer_context_mention_suggestions(projection));
            suggestions
        }
        _ => Vec::new(),
    }
}

fn composer_context_mention_suggestions(
    projection: &DesktopProjection,
) -> Vec<ComposerCommandSuggestion> {
    let mut suggestions = Vec::new();
    suggestions.extend(projection.annotations.todos.iter().take(8).map(|todo| {
        ComposerCommandSuggestion {
            label: format!("@todo {}", todo.title),
            detail: format!("{} · {}", todo_status_text(todo.status), todo.id),
            completion: format!("@todo:{}", todo.id),
            icon: IconName::Check,
        }
    }));
    suggestions.extend(
        projection
            .annotations
            .pinned_items
            .iter()
            .take(8)
            .map(|item| ComposerCommandSuggestion {
                label: format!("@pin {}", item.display_title),
                detail: item.display_excerpt.clone(),
                completion: format!("@pin:{}", item.id),
                icon: IconName::Star,
            }),
    );
    suggestions.extend(
        projection
            .annotations
            .highlighted_items
            .iter()
            .take(8)
            .map(|item| ComposerCommandSuggestion {
                label: format!("@highlight {}", item.display_title),
                detail: item.display_excerpt.clone(),
                completion: format!("@highlight:{}", item.id),
                icon: IconName::Star,
            }),
    );
    suggestions.extend(
        projection
            .annotations
            .review_comments
            .iter()
            .take(8)
            .map(|comment| ComposerCommandSuggestion {
                label: format!("@review {}", comment.file_path),
                detail: format!(
                    "{} · {}",
                    if comment.resolved { "resolved" } else { "open" },
                    comment.body
                ),
                completion: format!("@review:{}", comment.id),
                icon: IconName::File,
            }),
    );
    if let Some(session) = projection
        .terminal
        .session
        .as_ref()
        .filter(|session| !session.history.trim().is_empty())
    {
        suggestions.push(ComposerCommandSuggestion {
            label: "@terminal".to_string(),
            detail: format!("Recent terminal output · {}", session.cwd),
            completion: "@terminal".to_string(),
            icon: IconName::SquareTerminal,
        });
    }
    if !projection.review.files.is_empty() {
        suggestions.push(ComposerCommandSuggestion {
            label: "@diff".to_string(),
            detail: format!(
                "{} files · +{} -{}",
                projection.review.files.len(),
                projection.review.total_additions,
                projection.review.total_deletions
            ),
            completion: "@diff".to_string(),
            icon: IconName::File,
        });
    }
    suggestions
}

fn provider_command_suggestion(
    command: &ProviderSlashCommandProjection,
) -> ComposerCommandSuggestion {
    let completion = command
        .prompt_prefix
        .clone()
        .unwrap_or_else(|| format!("/{}", command.name));
    let detail = command.input_hint.as_ref().map_or_else(
        || format!("{} · {}", command.provider, command.description),
        |hint| format!("{} · {} · {}", command.provider, command.description, hint),
    );
    ComposerCommandSuggestion {
        label: completion.clone(),
        detail,
        completion,
        icon: IconName::SquareTerminal,
    }
}

fn registry_suggestion(
    trigger: char,
    entry: &ToolRegistryEntryProjection,
    icon: IconName,
) -> ComposerCommandSuggestion {
    let completion = format!("{trigger}{}", entry.name);
    ComposerCommandSuggestion {
        label: completion.clone(),
        detail: entry.description.clone().unwrap_or_else(|| {
            format!(
                "{} · {}",
                entry.source.as_deref().unwrap_or("registry"),
                entry.status
            )
        }),
        completion,
        icon,
    }
}

fn composer_suggestion_row(theme: Theme, suggestion: ComposerCommandSuggestion) -> AnyElement {
    div()
        .id(("composer-suggestion", stable_id(&suggestion.completion)))
        .min_h(px(34.0))
        .rounded_md()
        .px_2()
        .flex()
        .flex_row()
        .items_center()
        .gap_2()
        .hover(|this| this.bg(theme.button_hover))
        .child(icon_svg(suggestion.icon, theme.accent_blue))
        .child(
            div()
                .min_w_0()
                .flex_1()
                .flex()
                .flex_col()
                .child(
                    div()
                        .text_size(px(12.0))
                        .text_color(theme.foreground.opacity(0.84))
                        .child(suggestion.label),
                )
                .child(
                    div()
                        .text_size(px(11.0))
                        .text_color(theme.muted)
                        .overflow_hidden()
                        .text_ellipsis()
                        .whitespace_nowrap()
                        .child(suggestion.detail),
                ),
        )
        .on_mouse_up(MouseButton::Left, move |_, window, cx| {
            window.dispatch_action(
                Box::new(CompleteComposerToken {
                    completion: suggestion.completion.clone(),
                }),
                cx,
            );
        })
        .into_any_element()
}

fn active_composer_token(prompt: &str) -> Option<&str> {
    let start = prompt
        .char_indices()
        .rev()
        .find(|(_, ch)| ch.is_whitespace())
        .map_or(0, |(index, ch)| index + ch.len_utf8());
    let token = prompt[start..].trim();
    (!token.is_empty()).then_some(token)
}

fn composer_mode_selector(
    theme: Theme,
    projection: &DesktopProjection,
    draft: &ComposerDraft,
) -> AnyElement {
    let has_connected_remote = projection.host_options.iter().any(|host| host.connected);
    div()
        .flex()
        .flex_row()
        .items_center()
        .gap_2()
        .child(selector_label(theme, "Mode"))
        .child(composer_action_pill(
            theme,
            draft.interaction_mode == InteractionMode::Chat,
            IconName::Bot,
            "Chat",
            "General implementation and Q&A",
            SetComposerInteractionMode {
                interaction_mode: InteractionMode::Chat,
            },
        ))
        .child(composer_action_pill(
            theme,
            draft.interaction_mode == InteractionMode::Plan,
            IconName::Check,
            "Plan",
            "Plan first before implementation",
            SetComposerInteractionMode {
                interaction_mode: InteractionMode::Plan,
            },
        ))
        .child(composer_action_pill(
            theme,
            draft.runtime_mode == RuntimeMode::Normal,
            IconName::Globe,
            "Normal",
            "Use the active thread context",
            SetComposerRuntimeMode {
                runtime_mode: RuntimeMode::Normal,
            },
        ))
        .child(composer_action_pill(
            theme,
            draft.runtime_mode == RuntimeMode::Local,
            IconName::SquareTerminal,
            "Local",
            "Run on this project host",
            SetComposerRuntimeMode {
                runtime_mode: RuntimeMode::Local,
            },
        ))
        .child(composer_action_pill(
            theme,
            draft.runtime_mode == RuntimeMode::Worktree,
            IconName::FolderOpen,
            "Worktree",
            "Prefer the thread worktree",
            SetComposerRuntimeMode {
                runtime_mode: RuntimeMode::Worktree,
            },
        ))
        .child(if has_connected_remote {
            composer_action_pill(
                theme,
                draft.runtime_mode == RuntimeMode::Remote,
                IconName::Globe,
                "Remote",
                "Run on the selected remote host",
                SetComposerRuntimeMode {
                    runtime_mode: RuntimeMode::Remote,
                },
            )
        } else {
            composer_disabled_pill(
                theme,
                IconName::Globe,
                "Remote",
                "No connected remote host is available yet.",
            )
        })
        .into_any_element()
}

fn composer_host_selector(
    theme: Theme,
    projection: &DesktopProjection,
    draft: &ComposerDraft,
) -> AnyElement {
    div()
        .flex()
        .flex_row()
        .items_center()
        .gap_2()
        .child(selector_label(theme, "Host"))
        .child(composer_host_pill(
            theme,
            draft.host_selection.is_none(),
            true,
            IconName::SquareTerminal,
            "This computer".to_string(),
            projection.host.label.clone(),
            None,
        ))
        .children(
            projection
                .host_options
                .iter()
                .map(|host| composer_remote_host_pill(theme, host, draft))
                .collect::<Vec<_>>(),
        )
        .when(projection.host_options.is_empty(), |this| {
            this.child(
                div()
                    .h(px(26.0))
                    .rounded_md()
                    .border_1()
                    .border_color(theme.border_subtle)
                    .bg(theme.panel_deep)
                    .px_2()
                    .flex()
                    .items_center()
                    .text_size(px(11.0))
                    .text_color(theme.muted_subtle)
                    .child("No remote hosts"),
            )
        })
        .into_any_element()
}

fn composer_remote_host_pill(
    theme: Theme,
    host: &HostOptionProjection,
    draft: &ComposerDraft,
) -> AnyElement {
    let selected = draft.host_selection.as_ref().is_some_and(|selection| {
        selection.provider == host.provider && selection.host_id == host.host_id
    });
    composer_host_pill(
        theme,
        selected,
        host.connected,
        IconName::Globe,
        host.label.clone(),
        host.detail.clone(),
        Some((host.provider.clone(), host.host_id.clone())),
    )
}

fn composer_permission_selector(theme: Theme, draft: &ComposerDraft) -> AnyElement {
    div()
        .flex()
        .flex_row()
        .items_center()
        .gap_2()
        .child(selector_label(theme, "Permissions"))
        .children(ComposerPermissionMode::ALL.iter().map(|permission| {
            composer_action_pill(
                theme,
                draft.permission_mode == *permission,
                IconName::TriangleAlert,
                permission.label(),
                permission.detail(),
                SetComposerPermission {
                    permission: *permission,
                },
            )
        }))
        .into_any_element()
}

fn model_selector(
    theme: Theme,
    registry: &ModelRegistryProjection,
    draft: &ComposerDraft,
    compact: bool,
) -> AnyElement {
    if registry.providers.is_empty() {
        return selector_notice(
            theme,
            "Models",
            registry
                .error
                .as_deref()
                .unwrap_or("Model registry has not returned any models yet."),
        );
    }

    div()
        .flex()
        .flex_col()
        .gap_2()
        .child(selector_label(theme, "Models"))
        .child(
            div()
                .max_h(if compact { px(118.0) } else { px(148.0) })
                .flex()
                .flex_row()
                .gap_2()
                .overflow_x_scrollbar()
                .children(
                    registry
                        .providers
                        .iter()
                        .map(|provider| model_provider_group(theme, provider, draft))
                        .collect::<Vec<_>>(),
                ),
        )
        .into_any_element()
}

fn model_provider_group(
    theme: Theme,
    provider: &ModelProviderProjection,
    draft: &ComposerDraft,
) -> AnyElement {
    let provider_kind = ProviderKind::from_runtime_id(&provider.runtime_id);
    let send_ready = provider_kind == Some(ProviderKind::Codex);
    div()
        .min_w(px(240.0))
        .rounded_md()
        .border_1()
        .border_color(theme.border_subtle)
        .bg(theme.panel_deep)
        .p_2()
        .flex()
        .flex_col()
        .gap_2()
        .child(
            div()
                .flex()
                .flex_row()
                .items_center()
                .justify_between()
                .text_size(px(11.0))
                .text_color(theme.muted)
                .child(provider.display_name.clone())
                .child(if send_ready { "Ready" } else { "Inspect only" }),
        )
        .children(
            provider
                .models
                .iter()
                .map(|model| {
                    model_row(
                        theme,
                        provider.runtime_id.as_str(),
                        provider_kind,
                        send_ready,
                        model,
                        draft,
                    )
                })
                .collect::<Vec<_>>(),
        )
        .into_any_element()
}

fn model_row(
    theme: Theme,
    provider_id: &str,
    provider: Option<ProviderKind>,
    send_ready: bool,
    model: &ModelProjection,
    draft: &ComposerDraft,
) -> AnyElement {
    let selected =
        provider == Some(draft.model_selection.provider) && draft.model_selection.model == model.id;
    let mut row = div()
        .id((
            "composer-model",
            stable_id(&format!("{provider_id}:{}", model.id)),
        ))
        .min_h(px(56.0))
        .rounded_md()
        .border_1()
        .border_color(if selected {
            theme.accent_blue.opacity(0.45)
        } else {
            theme.border_subtle
        })
        .bg(if selected { theme.button } else { theme.panel })
        .px_2()
        .py_2()
        .flex()
        .flex_col()
        .gap_2()
        .hover(|this| {
            if send_ready {
                this.bg(theme.button_hover)
            } else {
                this
            }
        })
        .child(
            div()
                .flex()
                .flex_row()
                .items_center()
                .justify_between()
                .gap_2()
                .child(
                    div()
                        .min_w_0()
                        .text_size(px(12.0))
                        .text_color(if send_ready {
                            theme.foreground.opacity(0.82)
                        } else {
                            theme.muted_subtle
                        })
                        .overflow_hidden()
                        .text_ellipsis()
                        .whitespace_nowrap()
                        .child(model.display_name.clone()),
                )
                .when(selected, |this| {
                    this.child(icon_svg(IconName::Check, theme.accent_success))
                }),
        )
        .child(model_capability_badges(theme, model, send_ready));

    if let Some(provider) = provider.filter(|_| send_ready) {
        let model_id = model.id.clone();
        row = row.on_mouse_up(MouseButton::Left, move |_, window, cx| {
            window.dispatch_action(
                Box::new(SelectComposerModel {
                    provider,
                    model: model_id.clone(),
                }),
                cx,
            );
        });
    } else if !send_ready {
        row = row.tooltip(|window, cx| {
            gpui_component::tooltip::Tooltip::new(
                "This provider is visible in the catalog, but desktop send routing currently uses the Codex runtime.",
            )
            .build(window, cx)
        });
    }

    row.into_any_element()
}

fn model_capability_badges(theme: Theme, model: &ModelProjection, enabled: bool) -> AnyElement {
    let color_active = if enabled {
        theme.accent_success
    } else {
        theme.muted_subtle
    };
    div()
        .flex()
        .flex_row()
        .gap_1()
        .child(capability_badge(
            theme,
            "Tools",
            model.supports_tools,
            color_active,
        ))
        .child(capability_badge(
            theme,
            "Vision",
            model.supports_vision,
            color_active,
        ))
        .child(capability_badge(
            theme,
            "Reason",
            model.supports_reasoning,
            color_active,
        ))
        .when(
            model.context_window.is_some_and(|window| window >= 128_000),
            |this| this.child(capability_badge(theme, "Long", true, color_active)),
        )
        .into_any_element()
}

fn capability_badge(
    theme: Theme,
    label: &'static str,
    active: bool,
    color: gpui::Hsla,
) -> AnyElement {
    div()
        .h(px(17.0))
        .rounded_md()
        .border_1()
        .border_color(theme.border_subtle)
        .px_1()
        .text_size(px(10.0))
        .text_color(if active { color } else { theme.muted_subtle })
        .child(label)
        .into_any_element()
}

fn reasoning_selector(theme: Theme, draft: &ComposerDraft) -> AnyElement {
    div()
        .flex()
        .flex_row()
        .items_center()
        .gap_2()
        .child(selector_label(theme, "Reasoning"))
        .children(ReasoningEffort::ALL.iter().map(|effort| {
            composer_action_pill(
                theme,
                draft.reasoning_effort == Some(*effort),
                IconName::Check,
                effort.label(),
                "Controls reasoning intensity for models that support it",
                SetComposerReasoning {
                    effort: Some(*effort),
                },
            )
        }))
        .into_any_element()
}

fn traits_selector(theme: Theme, draft: &ComposerDraft) -> AnyElement {
    div()
        .flex()
        .flex_row()
        .items_center()
        .gap_2()
        .child(selector_label(theme, "Traits"))
        .children(ComposerTrait::ALL.iter().map(|trait_kind| {
            composer_action_pill(
                theme,
                draft.traits.contains(trait_kind),
                IconName::Palette,
                trait_kind.label(),
                trait_kind.detail(),
                ToggleComposerTrait {
                    trait_kind: *trait_kind,
                },
            )
        }))
        .into_any_element()
}

fn context_selector(
    theme: Theme,
    projection: &DesktopProjection,
    draft: &ComposerDraft,
) -> AnyElement {
    div()
        .flex()
        .flex_row()
        .items_center()
        .gap_2()
        .child(selector_label(theme, "Context"))
        .children(
            ComposerContextKind::ALL
                .iter()
                .filter(|context| composer_context_count(projection, **context) > 0)
                .map(|context| {
                    let count = composer_context_count(projection, *context);
                    composer_action_pill(
                        theme,
                        draft.context.contains(context),
                        IconName::Plus,
                        context.label(),
                        context_count_detail(count),
                        ToggleComposerContext { context: *context },
                    )
                })
                .collect::<Vec<_>>(),
        )
        .into_any_element()
}

fn composer_host_pill(
    theme: Theme,
    selected: bool,
    enabled: bool,
    icon: IconName,
    label: String,
    detail: String,
    selection: Option<(String, String)>,
) -> AnyElement {
    let tooltip = if enabled {
        detail.clone()
    } else {
        format!("{detail}. Remote host is not connected.")
    };
    let color = if selected {
        theme.foreground.opacity(0.88)
    } else if enabled {
        theme.muted
    } else {
        theme.muted_subtle
    };
    let mut pill = div()
        .id(("composer-host", stable_id(&format!("{label}:{detail}"))))
        .max_w(px(164.0))
        .h(px(26.0))
        .rounded_md()
        .border_1()
        .border_color(if selected {
            theme.accent_blue.opacity(0.46)
        } else {
            theme.border_subtle
        })
        .bg(if selected {
            theme.button
        } else {
            theme.panel_deep
        })
        .px_2()
        .flex()
        .flex_row()
        .items_center()
        .gap_1()
        .text_size(px(11.0))
        .text_color(color)
        .child(icon_svg(
            icon,
            if selected {
                theme.accent_blue
            } else {
                theme.muted_subtle
            },
        ))
        .child(
            div()
                .min_w_0()
                .overflow_hidden()
                .text_ellipsis()
                .whitespace_nowrap()
                .child(label),
        )
        .tooltip(move |window, cx| {
            gpui_component::tooltip::Tooltip::new(tooltip.clone()).build(window, cx)
        });

    if enabled {
        pill = pill.hover(|this| this.bg(theme.button_hover));
        pill = pill.on_mouse_up(MouseButton::Left, move |_, window, cx| {
            let (provider, host_id) = selection
                .clone()
                .map_or((None, None), |(provider, host_id)| {
                    (Some(provider), Some(host_id))
                });
            window.dispatch_action(Box::new(SelectComposerHost { provider, host_id }), cx);
        });
    }

    pill.into_any_element()
}

fn composer_disabled_pill(
    theme: Theme,
    icon: IconName,
    label: &'static str,
    detail: &'static str,
) -> AnyElement {
    div()
        .id(("composer-disabled-pill", stable_id(label)))
        .min_w(px(54.0))
        .h(px(26.0))
        .rounded_md()
        .border_1()
        .border_color(theme.border_subtle)
        .bg(theme.panel_deep)
        .px_2()
        .flex()
        .flex_row()
        .items_center()
        .gap_1()
        .text_size(px(11.0))
        .text_color(theme.muted_subtle)
        .child(icon_svg(icon, theme.muted_subtle))
        .child(label)
        .tooltip(move |window, cx| gpui_component::tooltip::Tooltip::new(detail).build(window, cx))
        .into_any_element()
}

fn composer_action_pill<A>(
    theme: Theme,
    selected: bool,
    icon: IconName,
    label: &'static str,
    detail: &'static str,
    action: A,
) -> AnyElement
where
    A: gpui::Action + Clone + 'static,
{
    let color = if selected {
        theme.foreground.opacity(0.88)
    } else {
        theme.muted
    };
    div()
        .id(("composer-pill", stable_id(&format!("{label}:{detail}"))))
        .min_w(px(54.0))
        .h(px(26.0))
        .rounded_md()
        .border_1()
        .border_color(if selected {
            theme.accent_blue.opacity(0.46)
        } else {
            theme.border_subtle
        })
        .bg(if selected {
            theme.button
        } else {
            theme.panel_deep
        })
        .px_2()
        .flex()
        .flex_row()
        .items_center()
        .gap_1()
        .text_size(px(11.0))
        .text_color(color)
        .hover(|this| this.bg(theme.button_hover))
        .child(icon_svg(
            icon,
            if selected {
                theme.accent_blue
            } else {
                theme.muted_subtle
            },
        ))
        .child(label)
        .tooltip(move |window, cx| gpui_component::tooltip::Tooltip::new(detail).build(window, cx))
        .on_mouse_up(MouseButton::Left, move |_, window, cx| {
            window.dispatch_action(Box::new(action.clone()), cx);
        })
        .into_any_element()
}

fn selector_label(theme: Theme, label: &'static str) -> AnyElement {
    div()
        .w(px(74.0))
        .text_size(px(11.0))
        .font_weight(gpui::FontWeight::SEMIBOLD)
        .text_color(theme.muted_subtle)
        .child(label)
        .into_any_element()
}

fn selector_notice(theme: Theme, label: &'static str, message: &str) -> AnyElement {
    div()
        .flex()
        .flex_row()
        .items_center()
        .gap_2()
        .child(selector_label(theme, label))
        .child(
            div()
                .h(px(28.0))
                .rounded_md()
                .border_1()
                .border_color(theme.border_subtle)
                .bg(theme.panel_deep)
                .px_2()
                .flex()
                .items_center()
                .text_size(px(11.0))
                .text_color(theme.muted_subtle)
                .child(message.to_string()),
        )
        .into_any_element()
}

fn selected_model_supports_reasoning(
    projection: &DesktopProjection,
    draft: &ComposerDraft,
) -> bool {
    selected_model(projection, draft).is_some_and(|model| model.supports_reasoning)
}

fn selected_model<'a>(
    projection: &'a DesktopProjection,
    draft: &ComposerDraft,
) -> Option<&'a ModelProjection> {
    projection
        .models
        .providers
        .iter()
        .find(|provider| {
            ProviderKind::from_runtime_id(&provider.runtime_id)
                == Some(draft.model_selection.provider)
        })
        .and_then(|provider| {
            provider
                .models
                .iter()
                .find(|model| model.id == draft.model_selection.model)
        })
}

fn has_available_context(projection: &DesktopProjection) -> bool {
    ComposerContextKind::ALL
        .iter()
        .any(|context| composer_context_count(projection, *context) > 0)
}

fn composer_context_count(projection: &DesktopProjection, context: ComposerContextKind) -> usize {
    match context {
        ComposerContextKind::Pinned => projection.annotations.pinned_items.len(),
        ComposerContextKind::Highlights => projection.annotations.highlighted_items.len(),
        ComposerContextKind::Todos => projection.annotations.todos.len(),
        ComposerContextKind::Terminal => projection
            .terminal
            .session
            .as_ref()
            .filter(|session| !session.history.trim().is_empty())
            .map(|_| 1)
            .unwrap_or(0),
    }
}

fn context_count_detail(count: usize) -> &'static str {
    match count {
        0 => "No context available",
        1 => "Attach 1 context item",
        _ => "Attach available context items",
    }
}

fn todo_status_text(status: TodoStatus) -> &'static str {
    match status {
        TodoStatus::Open => "open",
        TodoStatus::InProgress => "in progress",
        TodoStatus::Blocked => "blocked",
        TodoStatus::Done => "done",
        TodoStatus::Canceled => "canceled",
    }
}

fn composer_attachment_tooltip(
    projection: &DesktopProjection,
    chat: &ChatProjection,
) -> &'static str {
    let Some(draft) = chat.composer.as_ref() else {
        return "Select a thread before attaching context.";
    };
    if selected_model(projection, draft)
        .is_some_and(|model| model.supports_vision || model.supports_attachments)
    {
        "Image and file attachments need a host upload service and desktop file picker."
    } else {
        "The selected model does not advertise vision or attachment support."
    }
}

fn composer_disabled_icon_button(
    icon: IconName,
    label: &'static str,
    detail: &'static str,
    theme: Theme,
) -> AnyElement {
    div()
        .id(("composer-disabled-icon", stable_id(label)))
        .w(px(28.0))
        .h(px(28.0))
        .rounded_md()
        .border_1()
        .border_color(theme.border_subtle)
        .bg(theme.panel_deep)
        .flex()
        .items_center()
        .justify_center()
        .text_color(theme.muted_subtle)
        .child(icon_svg(icon, theme.muted_subtle))
        .tooltip(move |window, cx| gpui_component::tooltip::Tooltip::new(detail).build(window, cx))
        .into_any_element()
}

fn chat_composer(theme: Theme, projection: &DesktopProjection) -> AnyElement {
    let chat = &projection.chat;
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
                            "Ask for follow-up changes".to_string()
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
                                .child(permission_chip(theme, chat))
                                .child(meta_chip(IconName::SquareTerminal, mode, theme))
                                .child(model_chip(theme, &model, &provider)),
                        )
                        .child(
                            div()
                                .flex()
                                .flex_row()
                                .items_center()
                                .gap_2()
                                .child(composer_disabled_icon_button(
                                    IconName::File,
                                    "Attach context or image",
                                    composer_attachment_tooltip(projection, chat),
                                    theme,
                                ))
                                .child(composer_disabled_icon_button(
                                    IconName::Bot,
                                    "Voice input",
                                    "Voice input needs a desktop audio capture and realtime transcription service.",
                                    theme,
                                ))
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
                )
                .child(composer_selector_surface(theme, projection, true)),
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

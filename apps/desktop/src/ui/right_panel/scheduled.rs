use super::{
    AnnotationEmptyState, action_button, annotation_empty_body, todo_card,
    todo_context_action_label,
};
use crate::{
    actions::{CreateTodoFromLatestTimelineItem, ToggleComposerContext, ToggleFirstOpenTodo},
    stores::desktop::{DesktopProjection, TodoPriority, TodoStatus},
    ui::{components::AceIconName, theme::Theme},
};
use ace_runtime::chat::ComposerContextKind;
use gpui::{AnyElement, IntoElement, div, prelude::*, px};
use gpui_component::{IconName, scroll::ScrollableElement as _};

pub(super) fn scheduled_body(theme: Theme, projection: &DesktopProjection) -> AnyElement {
    let mut scheduled = projection
        .annotations
        .todos
        .iter()
        .filter(|todo| {
            matches!(
                todo.status,
                TodoStatus::Open | TodoStatus::InProgress | TodoStatus::Blocked
            )
        })
        .collect::<Vec<_>>();
    scheduled.sort_by(|left, right| {
        todo_priority_rank(right.priority)
            .cmp(&todo_priority_rank(left.priority))
            .then_with(|| right.updated_at.cmp(&left.updated_at))
            .then_with(|| left.title.cmp(&right.title))
    });

    if scheduled.is_empty() {
        return annotation_empty_body(
            theme,
            AnnotationEmptyState {
                icon: AceIconName::ListChecks,
                label: "Scheduled",
                message: "No active todos are queued for this thread.",
                action_icon: IconName::Plus,
                action_label: "Add todo",
                action: || Box::new(CreateTodoFromLatestTimelineItem),
                action_enabled: !projection.chat.messages.is_empty(),
            },
        );
    }

    let blocked_count = scheduled
        .iter()
        .filter(|todo| todo.status == TodoStatus::Blocked)
        .count();

    div()
        .size_full()
        .flex()
        .flex_col()
        .gap_3()
        .child(
            div()
                .flex()
                .flex_row()
                .items_center()
                .justify_between()
                .child(
                    div()
                        .text_size(px(12.0))
                        .text_color(theme.muted)
                        .child(format!(
                            "{} active · {} blocked",
                            scheduled.len(),
                            blocked_count
                        )),
                )
                .child(scheduled_panel_actions(theme, projection)),
        )
        .child(
            div()
                .flex_1()
                .min_h_0()
                .flex()
                .flex_col()
                .gap_3()
                .children(scheduled.into_iter().map(|todo| todo_card(theme, todo)))
                .overflow_y_scrollbar(),
        )
        .into_any_element()
}

fn scheduled_panel_actions(theme: Theme, projection: &DesktopProjection) -> AnyElement {
    let todo_context_selected = projection
        .chat
        .composer
        .as_ref()
        .is_some_and(|draft| draft.context.contains(&ComposerContextKind::Todos));

    div()
        .flex()
        .flex_row()
        .items_center()
        .gap_2()
        .when(!projection.chat.messages.is_empty(), |this| {
            this.child(action_button(IconName::Plus, "New todo", theme, || {
                Box::new(CreateTodoFromLatestTimelineItem)
            }))
        })
        .child(action_button(
            IconName::Plus,
            todo_context_action_label(todo_context_selected),
            theme,
            || {
                Box::new(ToggleComposerContext {
                    context: ComposerContextKind::Todos,
                })
            },
        ))
        .child(action_button(
            IconName::CircleCheck,
            "Complete first",
            theme,
            || Box::new(ToggleFirstOpenTodo),
        ))
        .into_any_element()
}

fn todo_priority_rank(priority: TodoPriority) -> u8 {
    match priority {
        TodoPriority::Low => 0,
        TodoPriority::Normal => 1,
        TodoPriority::High => 2,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scheduled_priority_rank_orders_highest_first() {
        assert!(todo_priority_rank(TodoPriority::High) > todo_priority_rank(TodoPriority::Normal));
        assert!(todo_priority_rank(TodoPriority::Normal) > todo_priority_rank(TodoPriority::Low));
    }

    #[test]
    fn scheduled_context_label_uses_shared_todo_state() {
        assert_eq!(todo_context_action_label(false), "Add context");
        assert_eq!(todo_context_action_label(true), "Remove context");
    }
}

use crate::ui::{components::*, theme::Theme};
use ace_runtime::chat::{ThreadStatus, ThreadSummary};
use gpui::{AnyElement, IntoElement, MouseButton, div, prelude::*, px};
use gpui_component::IconName;

pub(super) fn thread_row(theme: Theme, thread: ThreadSummary, active: bool) -> AnyElement {
    let id = thread.id.clone();
    div()
        .id("thread-row")
        .h(px(28.0))
        .rounded_lg()
        .pl_2()
        .pr_2()
        .bg(if active {
            theme.selection
        } else {
            theme.sidebar
        })
        .hover(|this| this.bg(theme.button))
        .flex()
        .flex_row()
        .items_center()
        .gap_1()
        .child(thread_status_icon(&thread, theme))
        .when(thread.pinned, |this| {
            this.child(ace_icon_svg(
                AceIconName::PinFilled,
                if active {
                    theme.foreground
                } else {
                    theme.muted_subtle
                },
            ))
        })
        .child(
            div()
                .flex_1()
                .min_w_0()
                .overflow_hidden()
                .text_ellipsis()
                .whitespace_nowrap()
                .text_size(px(12.0))
                .text_color(if active {
                    theme.foreground
                } else {
                    theme.foreground.opacity(0.72)
                })
                .child(thread.title.clone()),
        )
        .on_mouse_up(MouseButton::Left, move |_, window, cx| {
            window.dispatch_action(
                Box::new(crate::actions::OpenThread {
                    thread_id: id.clone(),
                }),
                cx,
            );
        })
        .into_any_element()
}

pub(super) fn thread_paging_row(
    theme: Theme,
    project_id: ace_core::ProjectId,
    more_count: usize,
    can_show_less: bool,
) -> AnyElement {
    div()
        .pl(px(38.0))
        .flex()
        .flex_row()
        .gap_2()
        .when(more_count > 0, |this| {
            this.child(thread_paging_button(
                theme,
                format!("Show {more_count} more"),
                move || Box::new(crate::actions::ShowMoreProjectThreads { project_id }),
            ))
        })
        .when(can_show_less, |this| {
            this.child(thread_paging_button(
                theme,
                "Show less".to_string(),
                move || Box::new(crate::actions::ShowLessProjectThreads { project_id }),
            ))
        })
        .into_any_element()
}

fn thread_status_icon(thread: &ThreadSummary, theme: Theme) -> AnyElement {
    let color = match thread.status {
        ThreadStatus::Error => theme.accent_danger,
        ThreadStatus::Completed => theme.accent_success,
        ThreadStatus::PendingApproval | ThreadStatus::AwaitingInput => theme.accent_warning,
        ThreadStatus::PlanReady => theme.accent_pink,
        ThreadStatus::Working | ThreadStatus::Connecting => theme.accent_blue,
        ThreadStatus::Draft | ThreadStatus::Idle | ThreadStatus::Archived => theme.muted_subtle,
    };
    let icon = match thread.status {
        ThreadStatus::Error => IconName::TriangleAlert,
        ThreadStatus::Completed => IconName::CircleCheck,
        ThreadStatus::PendingApproval | ThreadStatus::AwaitingInput => IconName::Info,
        ThreadStatus::PlanReady => IconName::Star,
        ThreadStatus::Working | ThreadStatus::Connecting => IconName::LoaderCircle,
        ThreadStatus::Draft | ThreadStatus::Idle | ThreadStatus::Archived => IconName::CircleUser,
    };
    div()
        .w(px(16.0))
        .h(px(16.0))
        .flex()
        .items_center()
        .justify_center()
        .child(icon_svg(icon, color))
        .into_any_element()
}

fn thread_paging_button<F>(theme: Theme, label: String, action: F) -> AnyElement
where
    F: Fn() -> Box<dyn gpui::Action> + 'static,
{
    div()
        .h(px(28.0))
        .rounded_md()
        .px_2()
        .text_size(px(11.0))
        .text_color(theme.muted_subtle)
        .hover(|this| this.bg(theme.button).text_color(theme.foreground))
        .flex()
        .items_center()
        .child(label)
        .on_mouse_up(MouseButton::Left, move |_, window, cx| {
            window.dispatch_action(action(), cx);
        })
        .into_any_element()
}

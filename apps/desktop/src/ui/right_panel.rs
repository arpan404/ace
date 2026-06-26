use crate::ui::{components::*, layout::PanelLayout, theme::Theme};
use ace_runtime::chat::ChatProjection;
use gpui::{AnyElement, IntoElement, div, prelude::*, px};
use gpui_component::IconName;

pub(super) fn right_panel(theme: Theme, layout: PanelLayout, chat: ChatProjection) -> AnyElement {
    div()
        .id("ace-right-panel")
        .w(layout.right_panel_width)
        .h_full()
        .bg(theme.panel_deep)
        .border_l_1()
        .border_color(theme.border_subtle)
        .flex()
        .flex_col()
        .child(right_panel_header(theme))
        .child(right_panel_summary(theme, chat))
        .into_any_element()
}

fn right_panel_header(theme: Theme) -> AnyElement {
    div()
        .h(px(48.0))
        .border_b_1()
        .border_color(theme.border_subtle)
        .px_3()
        .flex()
        .flex_row()
        .items_center()
        .gap_2()
        .child(panel_tab(IconName::PanelRight, "Thread", true, theme))
        .child(div().flex_1())
        .child(collapse_button(IconName::PanelLeftClose, theme))
        .into_any_element()
}

fn right_panel_summary(theme: Theme, chat: ChatProjection) -> AnyElement {
    let status = chat
        .active_thread
        .as_ref()
        .map(|thread| thread.status.label())
        .unwrap_or("No Thread");
    let provider = chat
        .active_thread
        .as_ref()
        .map(|thread| thread.provider.display_name())
        .unwrap_or("Codex");
    let model = chat
        .active_thread
        .as_ref()
        .and_then(|thread| thread.model.as_deref())
        .unwrap_or("gpt-5-codex")
        .to_string();

    div()
        .flex_1()
        .min_h_0()
        .p_4()
        .flex()
        .flex_col()
        .gap_3()
        .child(section_label("THREAD"))
        .child(info_row(theme, "Provider", provider))
        .child(info_row(theme, "Status", status))
        .child(info_row(theme, "Model", &model))
        .child(section_label("ACTIONS"))
        .child(action_button(IconName::Plus, "New chat", theme, || {
            Box::new(crate::actions::NewThread)
        }))
        .child(action_button(
            IconName::Star,
            "Pin active chat",
            theme,
            || Box::new(crate::actions::TogglePinActiveThread),
        ))
        .child(action_button(
            IconName::Delete,
            "Archive active chat",
            theme,
            || Box::new(crate::actions::ArchiveActiveThread),
        ))
        .into_any_element()
}

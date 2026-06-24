use crate::{
    icons::{IconKind, icon},
    theme::{colors, metrics},
};
use gpui::{AnyElement, FontWeight, IntoElement, ParentElement, Styled, div, px, rgb};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ButtonVariant {
    Primary,
    Secondary,
    Ghost,
    Destructive,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ButtonSize {
    Small,
    Medium,
    Icon,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AlertTone {
    Info,
    Success,
    Warning,
    Error,
}

pub fn button(label: &str, variant: ButtonVariant, size: ButtonSize) -> AnyElement {
    let (bg, text, border) = match variant {
        ButtonVariant::Primary => (colors::BLUE, colors::TEXT, colors::BLUE),
        ButtonVariant::Secondary => (colors::CARD, colors::TEXT, colors::BORDER),
        ButtonVariant::Ghost => (colors::PANE, colors::TEXT_MUTED, colors::PANE),
        ButtonVariant::Destructive => (0x2a1517, colors::DANGER, 0x4a2428),
    };
    let (height, padding) = match size {
        ButtonSize::Small => (24.0, 10.0),
        ButtonSize::Medium => (30.0, 12.0),
        ButtonSize::Icon => (30.0, 0.0),
    };

    div()
        .h(px(height))
        .min_w(px(if size == ButtonSize::Icon {
            height
        } else {
            0.0
        }))
        .flex()
        .items_center()
        .justify_center()
        .px(px(padding))
        .rounded(px(metrics::RADIUS))
        .border_1()
        .border_color(rgb(border))
        .bg(rgb(bg))
        .text_color(rgb(text))
        .font_weight(FontWeight(600.0))
        .child(label.to_owned())
        .into_any_element()
}

pub fn badge(label: &str) -> AnyElement {
    div()
        .px(px(9.0))
        .py(px(4.0))
        .rounded(px(6.0))
        .bg(rgb(colors::CARD_SOFT))
        .text_color(rgb(colors::TEXT_MUTED))
        .child(label.to_owned())
        .into_any_element()
}

pub fn alert(title: &str, message: &str, tone: AlertTone) -> AnyElement {
    let accent = match tone {
        AlertTone::Info => colors::BLUE,
        AlertTone::Success => colors::SUCCESS,
        AlertTone::Warning => colors::WARNING,
        AlertTone::Error => colors::DANGER,
    };

    div()
        .p(px(10.0))
        .rounded(px(metrics::RADIUS))
        .border_1()
        .border_color(rgb(accent))
        .bg(rgb(colors::CARD_SOFT))
        .flex()
        .flex_col()
        .gap(px(4.0))
        .child(div().font_weight(FontWeight(600.0)).child(title.to_owned()))
        .child(
            div()
                .text_color(rgb(colors::TEXT_SUBTLE))
                .text_size(px(12.0))
                .child(message.to_owned()),
        )
        .into_any_element()
}

pub fn panel_title(title: &str) -> AnyElement {
    div()
        .h(px(32.0))
        .flex()
        .items_center()
        .px(px(6.0))
        .text_color(rgb(colors::TEXT_SUBTLE))
        .text_size(px(13.0))
        .child(title.to_owned())
        .into_any_element()
}

pub fn card(title: &str, detail: &str) -> AnyElement {
    div()
        .mb(px(8.0))
        .p(px(10.0))
        .rounded(px(metrics::RADIUS))
        .border_1()
        .border_color(rgb(colors::BORDER))
        .bg(rgb(colors::CARD_SOFT))
        .flex()
        .flex_col()
        .gap(px(4.0))
        .child(div().font_weight(FontWeight(600.0)).child(title.to_owned()))
        .child(
            div()
                .text_size(px(12.0))
                .text_color(rgb(colors::TEXT_SUBTLE))
                .child(detail.to_owned()),
        )
        .into_any_element()
}

pub fn tab(label: &str, active: bool) -> AnyElement {
    div()
        .h(px(34.0))
        .min_w(px(144.0))
        .flex()
        .items_center()
        .justify_center()
        .px(px(12.0))
        .rounded(px(9.0))
        .bg(rgb(if active { colors::CARD } else { colors::PANE }))
        .text_color(rgb(if active {
            colors::TEXT
        } else {
            colors::TEXT_SUBTLE
        }))
        .child(label.to_owned())
        .into_any_element()
}

pub fn icon_button(kind: IconKind) -> AnyElement {
    div()
        .size(px(30.0))
        .flex()
        .items_center()
        .justify_center()
        .rounded(px(8.0))
        .text_color(rgb(colors::TEXT_MUTED))
        .child(icon(kind))
        .into_any_element()
}

pub fn sidebar_row(
    label: &str,
    meta: Option<&str>,
    active: bool,
    icon_kind: Option<IconKind>,
) -> AnyElement {
    div()
        .h(px(38.0))
        .flex()
        .items_center()
        .justify_between()
        .px(px(7.0))
        .rounded(px(8.0))
        .bg(rgb(if active {
            colors::SELECTED
        } else {
            colors::SIDEBAR
        }))
        .text_color(rgb(if active {
            colors::TEXT
        } else {
            colors::TEXT_MUTED
        }))
        .child(
            div()
                .min_w_0()
                .flex()
                .items_center()
                .gap(px(9.0))
                .children(icon_kind.map(icon))
                .child(label.to_owned()),
        )
        .child(
            div()
                .text_color(rgb(colors::TEXT_SUBTLE))
                .text_size(px(12.0))
                .child(meta.unwrap_or("").to_owned()),
        )
        .into_any_element()
}

pub fn code_pill(label: &str) -> AnyElement {
    div()
        .px(px(8.0))
        .py(px(2.0))
        .rounded(px(5.0))
        .bg(rgb(colors::CARD))
        .text_color(rgb(colors::TEXT))
        .child(label.to_owned())
        .into_any_element()
}

pub fn composer(input: &str, focused: bool, access: &str, model: &str) -> AnyElement {
    div()
        .h(px(metrics::COMPOSER_HEIGHT))
        .rounded(px(18.0))
        .border_1()
        .border_color(rgb(if focused {
            colors::ACCENT
        } else {
            colors::CARD
        }))
        .bg(rgb(colors::CARD))
        .flex()
        .flex_col()
        .justify_between()
        .p(px(14.0))
        .child(
            div()
                .min_h(px(32.0))
                .text_color(rgb(if input.is_empty() {
                    colors::TEXT_SUBTLE
                } else {
                    colors::TEXT
                }))
                .child(if input.is_empty() {
                    "Ask for follow-up changes".to_owned()
                } else {
                    input.to_owned()
                }),
        )
        .child(
            div()
                .flex()
                .items_center()
                .justify_between()
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(10.0))
                        .child(icon_button(IconKind::Add))
                        .child(
                            div()
                                .text_color(rgb(colors::ACCENT))
                                .font_weight(FontWeight(600.0))
                                .child(access.to_owned()),
                        ),
                )
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(10.0))
                        .text_color(rgb(colors::TEXT_MUTED))
                        .child(model.to_owned())
                        .child(icon_button(IconKind::ChevronDown)),
                ),
        )
        .into_any_element()
}

use crate::theme::{colors, metrics};
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
        ButtonVariant::Primary => (colors::BORDER_ACTIVE, colors::TEXT, colors::BORDER_ACTIVE),
        ButtonVariant::Secondary => (colors::ELEVATED, colors::TEXT, colors::BORDER),
        ButtonVariant::Ghost => (colors::APP, colors::TEXT_MUTED, colors::APP),
        ButtonVariant::Destructive => (0x2a1517, colors::DANGER, 0x4a2428),
    };
    let (height, padding) = match size {
        ButtonSize::Small => (24.0, 8.0),
        ButtonSize::Medium => (30.0, 10.0),
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
        .rounded(px(metrics::RADIUS))
        .border_1()
        .border_color(rgb(colors::BORDER))
        .bg(rgb(colors::ELEVATED))
        .text_color(rgb(colors::TEXT_MUTED))
        .child(label.to_owned())
        .into_any_element()
}

pub fn alert(title: &str, message: &str, tone: AlertTone) -> AnyElement {
    let accent = match tone {
        AlertTone::Info => colors::BORDER_ACTIVE,
        AlertTone::Success => colors::SUCCESS,
        AlertTone::Warning => colors::WARNING,
        AlertTone::Error => colors::DANGER,
    };

    div()
        .p(px(10.0))
        .rounded(px(metrics::RADIUS))
        .border_1()
        .border_color(rgb(accent))
        .bg(rgb(colors::SURFACE_2))
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
        .h(px(36.0))
        .flex()
        .items_center()
        .px(px(12.0))
        .text_color(rgb(colors::TEXT_MUTED))
        .font_weight(FontWeight(700.0))
        .child(title.to_owned())
        .into_any_element()
}

pub fn card(title: &str, detail: &str) -> AnyElement {
    div()
        .mx(px(10.0))
        .mb(px(8.0))
        .p(px(10.0))
        .rounded(px(metrics::RADIUS))
        .border_1()
        .border_color(rgb(colors::BORDER))
        .bg(rgb(colors::SURFACE_2))
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
        .h(px(30.0))
        .min_w(px(104.0))
        .flex()
        .items_center()
        .px(px(12.0))
        .bg(rgb(if active {
            colors::SURFACE_3
        } else {
            colors::SURFACE_2
        }))
        .text_color(rgb(if active {
            colors::TEXT
        } else {
            colors::TEXT_MUTED
        }))
        .child(label.to_owned())
        .into_any_element()
}

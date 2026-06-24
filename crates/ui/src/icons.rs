use crate::theme::colors;
use gpui::{AnyElement, IntoElement, ParentElement, Styled, div, px, rgb};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IconKind {
    NewChat,
    Search,
    Plugin,
    Automation,
    Folder,
    Settings,
    Add,
    Send,
    Terminal,
    Back,
    Forward,
    Menu,
    ChevronDown,
}

pub fn icon(kind: IconKind) -> AnyElement {
    let base = div()
        .size(px(16.0))
        .flex()
        .items_center()
        .justify_center()
        .text_color(rgb(colors::TEXT_MUTED));

    match kind {
        IconKind::NewChat => base.child(box_icon(true)).into_any_element(),
        IconKind::Search => base.child(search_icon()).into_any_element(),
        IconKind::Plugin => base.child(grid_icon()).into_any_element(),
        IconKind::Automation => base.child(clock_icon()).into_any_element(),
        IconKind::Folder => base.child(folder_icon()).into_any_element(),
        IconKind::Settings => base.child(gear_icon()).into_any_element(),
        IconKind::Add => base.child(plus_icon()).into_any_element(),
        IconKind::Send => base.child(arrow_icon(true)).into_any_element(),
        IconKind::Terminal => base.child(terminal_icon()).into_any_element(),
        IconKind::Back => base.child(arrow_icon(false)).into_any_element(),
        IconKind::Forward => base.child(arrow_icon(true)).into_any_element(),
        IconKind::Menu => base.child(menu_icon()).into_any_element(),
        IconKind::ChevronDown => base.child(chevron_icon()).into_any_element(),
    }
}

fn stroke() -> u32 {
    colors::TEXT_MUTED
}

fn box_icon(with_corner: bool) -> AnyElement {
    let mut root = div()
        .size(px(14.0))
        .rounded(px(3.0))
        .border_1()
        .border_color(rgb(stroke()));
    if with_corner {
        root = root.child(
            div()
                .ml(px(8.0))
                .mt(px(2.0))
                .size(px(4.0))
                .border_t_1()
                .border_l_1()
                .border_color(rgb(stroke())),
        );
    }
    root.into_any_element()
}

fn search_icon() -> AnyElement {
    div()
        .size(px(13.0))
        .rounded_full()
        .border_1()
        .border_color(rgb(stroke()))
        .child(
            div()
                .ml(px(10.0))
                .mt(px(10.0))
                .w(px(5.0))
                .h(px(1.0))
                .bg(rgb(stroke())),
        )
        .into_any_element()
}

fn grid_icon() -> AnyElement {
    div()
        .size(px(14.0))
        .flex()
        .flex_wrap()
        .gap(px(2.0))
        .children((0..4).map(|_| {
            div()
                .size(px(5.0))
                .rounded(px(2.0))
                .border_1()
                .border_color(rgb(stroke()))
        }))
        .into_any_element()
}

fn clock_icon() -> AnyElement {
    div()
        .size(px(14.0))
        .rounded_full()
        .border_1()
        .border_color(rgb(stroke()))
        .child(
            div()
                .ml(px(6.0))
                .mt(px(3.0))
                .w(px(1.0))
                .h(px(5.0))
                .bg(rgb(stroke())),
        )
        .child(
            div()
                .ml(px(6.0))
                .mt(px(0.0))
                .w(px(4.0))
                .h(px(1.0))
                .bg(rgb(stroke())),
        )
        .into_any_element()
}

fn folder_icon() -> AnyElement {
    div()
        .w(px(15.0))
        .h(px(11.0))
        .mt(px(2.0))
        .rounded(px(2.0))
        .border_1()
        .border_color(rgb(stroke()))
        .child(
            div()
                .ml(px(1.0))
                .mt(px(-3.0))
                .w(px(7.0))
                .h(px(4.0))
                .border_1()
                .border_color(rgb(stroke())),
        )
        .into_any_element()
}

fn gear_icon() -> AnyElement {
    div()
        .size(px(14.0))
        .rounded_full()
        .border_1()
        .border_color(rgb(stroke()))
        .child(
            div()
                .m(px(4.0))
                .size(px(4.0))
                .rounded_full()
                .border_1()
                .border_color(rgb(stroke())),
        )
        .into_any_element()
}

fn plus_icon() -> AnyElement {
    div()
        .size(px(14.0))
        .child(div().ml(px(6.0)).w(px(1.0)).h(px(14.0)).bg(rgb(stroke())))
        .child(div().mt(px(-8.0)).w(px(14.0)).h(px(1.0)).bg(rgb(stroke())))
        .into_any_element()
}

fn arrow_icon(right: bool) -> AnyElement {
    let mut root = div().w(px(14.0)).h(px(10.0));
    if right {
        root = root
            .child(div().mt(px(5.0)).w(px(12.0)).h(px(1.0)).bg(rgb(stroke())))
            .child(
                div()
                    .ml(px(8.0))
                    .mt(px(-5.0))
                    .w(px(6.0))
                    .h(px(1.0))
                    .bg(rgb(stroke())),
            )
            .child(
                div()
                    .ml(px(8.0))
                    .mt(px(5.0))
                    .w(px(6.0))
                    .h(px(1.0))
                    .bg(rgb(stroke())),
            );
    } else {
        root = root
            .child(
                div()
                    .ml(px(2.0))
                    .mt(px(5.0))
                    .w(px(12.0))
                    .h(px(1.0))
                    .bg(rgb(stroke())),
            )
            .child(
                div()
                    .ml(px(0.0))
                    .mt(px(-5.0))
                    .w(px(6.0))
                    .h(px(1.0))
                    .bg(rgb(stroke())),
            )
            .child(
                div()
                    .ml(px(0.0))
                    .mt(px(5.0))
                    .w(px(6.0))
                    .h(px(1.0))
                    .bg(rgb(stroke())),
            );
    }
    root.into_any_element()
}

fn terminal_icon() -> AnyElement {
    div()
        .size(px(14.0))
        .rounded(px(3.0))
        .border_1()
        .border_color(rgb(stroke()))
        .child(
            div()
                .ml(px(3.0))
                .mt(px(4.0))
                .w(px(4.0))
                .h(px(1.0))
                .bg(rgb(stroke())),
        )
        .child(
            div()
                .ml(px(8.0))
                .mt(px(3.0))
                .w(px(3.0))
                .h(px(1.0))
                .bg(rgb(stroke())),
        )
        .into_any_element()
}

fn menu_icon() -> AnyElement {
    div()
        .w(px(14.0))
        .flex()
        .flex_col()
        .gap(px(3.0))
        .children((0..3).map(|_| div().w(px(14.0)).h(px(1.0)).bg(rgb(stroke()))))
        .into_any_element()
}

fn chevron_icon() -> AnyElement {
    div()
        .w(px(10.0))
        .h(px(6.0))
        .child(div().w(px(6.0)).h(px(1.0)).bg(rgb(stroke())))
        .child(
            div()
                .ml(px(4.0))
                .mt(px(3.0))
                .w(px(6.0))
                .h(px(1.0))
                .bg(rgb(stroke())),
        )
        .into_any_element()
}

use gpui::{Hsla, Pixels, SharedString, px, rgb, size};

#[derive(Clone, Copy, Debug)]
pub struct Theme {
    pub background: Hsla,
    pub background_elevated: Hsla,
    pub border: Hsla,
    pub border_subtle: Hsla,
    pub button: Hsla,
    pub button_hover: Hsla,
    pub accent: Hsla,
    pub accent_warning: Hsla,
    pub accent_success: Hsla,
    pub accent_pink: Hsla,
    pub accent_purple: Hsla,
    pub foreground: Hsla,
    pub muted: Hsla,
    pub muted_subtle: Hsla,
    pub panel: Hsla,
    pub panel_deep: Hsla,
    pub selection: Hsla,
    pub sidebar: Hsla,
    pub right_panel_max_width: Pixels,
    pub right_panel_min_width: Pixels,
    pub right_panel_width: Pixels,
    pub sidebar_max_width: Pixels,
    pub sidebar_min_width: Pixels,
    pub sidebar_width: Pixels,
    pub font_family: &'static str,
}

impl Default for Theme {
    fn default() -> Self {
        Self {
            background: rgb(0x111111).into(),
            background_elevated: rgb(0x202020).into(),
            border: rgb(0x2e2e2e).into(),
            border_subtle: rgb(0x202020).into(),
            button: rgb(0x242424).into(),
            button_hover: rgb(0x303030).into(),
            accent: rgb(0x8ab4f8).into(),
            accent_warning: rgb(0xf0b429).into(),
            accent_success: rgb(0x66d19e).into(),
            accent_pink: rgb(0xf2a2b8).into(),
            accent_purple: rgb(0xb79cff).into(),
            foreground: rgb(0xe7e7e7).into(),
            muted: rgb(0x9a9a9a).into(),
            muted_subtle: rgb(0x6f6f6f).into(),
            panel: rgb(0x151515).into(),
            panel_deep: rgb(0x0f0f0f).into(),
            selection: rgb(0x252525).into(),
            sidebar: rgb(0x191919).into(),
            right_panel_max_width: px(620.0),
            right_panel_min_width: px(320.0),
            right_panel_width: px(430.0),
            sidebar_max_width: px(520.0),
            sidebar_min_width: px(260.0),
            sidebar_width: px(330.0),
            font_family: ".AppleSystemUIFont",
        }
    }
}

impl Theme {
    pub fn default_window_size() -> gpui::Size<Pixels> {
        size(px(1440.0), px(920.0))
    }

    pub fn app_name() -> SharedString {
        "Ace".into()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_layout_sizes_are_stable() {
        let theme = Theme::default();
        assert_eq!(theme.sidebar_width, px(330.0));
        assert_eq!(theme.right_panel_width, px(430.0));
        assert_eq!(Theme::default_window_size().width, px(1440.0));
        assert_eq!(Theme::app_name().as_ref(), "Ace");
    }
}

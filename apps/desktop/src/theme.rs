use gpui::{Hsla, Pixels, SharedString, px, rgb, size};

#[derive(Clone, Copy, Debug)]
pub struct Theme {
    pub background: Hsla,
    pub border: Hsla,
    pub foreground: Hsla,
    pub sidebar: Hsla,
    pub sidebar_width: Pixels,
    pub font_family: &'static str,
}

impl Default for Theme {
    fn default() -> Self {
        Self {
            background: rgb(0x111111).into(),
            border: rgb(0x2a2a2a).into(),
            foreground: rgb(0xf2f2f2).into(),
            sidebar: rgb(0x181818).into(),
            sidebar_width: px(280.0),
            font_family: ".AppleSystemUIFont",
        }
    }
}

impl Theme {
    pub fn default_window_size() -> gpui::Size<Pixels> {
        size(px(1280.0), px(820.0))
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
        assert_eq!(theme.sidebar_width, px(280.0));
        assert_eq!(Theme::default_window_size().width, px(1280.0));
        assert_eq!(Theme::app_name().as_ref(), "Ace");
    }
}

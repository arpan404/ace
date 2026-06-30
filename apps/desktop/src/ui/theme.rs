use gpui::{Hsla, Pixels, SharedString, px, rgb, size};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ThemePreset {
    #[default]
    AceDark,
    HighContrast,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ThemeDensity {
    Compact,
    #[default]
    Comfortable,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UiFont {
    #[default]
    System,
    Monospace,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CodeFont {
    #[default]
    SystemMono,
    Menlo,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ThemeMotion {
    Reduced,
    #[default]
    Standard,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ThemeAccent {
    #[default]
    Sky,
    Emerald,
    Amber,
    Rose,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ThemeSettings {
    #[serde(default)]
    pub preset: ThemePreset,
    #[serde(default)]
    pub density: ThemeDensity,
    #[serde(default)]
    pub ui_font: UiFont,
    #[serde(default)]
    pub code_font: CodeFont,
    #[serde(default)]
    pub motion: ThemeMotion,
    #[serde(default)]
    pub accent: ThemeAccent,
}

#[derive(Clone, Copy, Debug)]
pub struct Theme {
    pub background: Hsla,
    pub background_elevated: Hsla,
    pub bottom_panel_height: Pixels,
    pub bottom_panel_max_height: Pixels,
    pub bottom_panel_min_height: Pixels,
    pub border: Hsla,
    pub border_subtle: Hsla,
    pub button: Hsla,
    pub button_hover: Hsla,
    pub center_header_height: Pixels,
    pub center_header_title_max_width: Pixels,
    pub center_header_meta_max_width: Pixels,
    pub center_header_meta_height: Pixels,
    pub environment_card_width: Pixels,
    pub environment_card_floating_top: Pixels,
    pub environment_card_floating_right: Pixels,
    pub environment_card_inline_min_width: f32,
    pub titlebar_control_reserve_width: Pixels,
    pub panel_gutter_width: f32,
    pub timeline_max_rendered_messages: usize,
    pub motion_fast_ms: u64,
    pub motion_standard_ms: u64,
    pub accent_blue: Hsla,
    pub accent_danger: Hsla,
    pub accent_success: Hsla,
    pub accent_warning: Hsla,
    pub accent_pink: Hsla,
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
    pub ui_font_family: &'static str,
    pub code_font_family: &'static str,
}

impl Default for Theme {
    fn default() -> Self {
        Self {
            background: rgb(0x111111).into(),
            background_elevated: rgb(0x202020).into(),
            bottom_panel_height: px(260.0),
            bottom_panel_max_height: px(560.0),
            bottom_panel_min_height: px(160.0),
            border: rgb(0x2e2e2e).into(),
            border_subtle: rgb(0x202020).into(),
            button: rgb(0x242424).into(),
            button_hover: rgb(0x303030).into(),
            center_header_height: px(58.0),
            center_header_title_max_width: px(920.0),
            center_header_meta_max_width: px(150.0),
            center_header_meta_height: px(18.0),
            environment_card_width: px(360.0),
            environment_card_floating_top: px(60.0),
            environment_card_floating_right: px(16.0),
            environment_card_inline_min_width: 980.0,
            titlebar_control_reserve_width: px(64.0),
            panel_gutter_width: 4.0,
            timeline_max_rendered_messages: 120,
            motion_fast_ms: 90,
            motion_standard_ms: 160,
            accent_blue: rgb(0x38bdf8).into(),
            accent_danger: rgb(0xfb7185).into(),
            accent_success: rgb(0x34d399).into(),
            accent_warning: rgb(0xf0b429).into(),
            accent_pink: rgb(0xf2a2b8).into(),
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
            ui_font_family: ".AppleSystemUIFont",
            code_font_family: "SF Mono",
        }
    }
}

impl Theme {
    pub fn from_settings(settings: &ThemeSettings) -> Self {
        let mut theme = match settings.preset {
            ThemePreset::AceDark => Self::default(),
            ThemePreset::HighContrast => Self {
                background: rgb(0x050505).into(),
                background_elevated: rgb(0x181818).into(),
                border: rgb(0x454545).into(),
                border_subtle: rgb(0x303030).into(),
                button: rgb(0x2c2c2c).into(),
                button_hover: rgb(0x3a3a3a).into(),
                foreground: rgb(0xf5f5f5).into(),
                muted: rgb(0xb5b5b5).into(),
                muted_subtle: rgb(0x8a8a8a).into(),
                panel: rgb(0x0d0d0d).into(),
                panel_deep: rgb(0x050505).into(),
                selection: rgb(0x333333).into(),
                sidebar: rgb(0x0b0b0b).into(),
                ..Self::default()
            },
        };

        match settings.density {
            ThemeDensity::Comfortable => {}
            ThemeDensity::Compact => {
                theme.center_header_height = px(52.0);
                theme.center_header_meta_height = px(16.0);
                theme.bottom_panel_height = px(220.0);
                theme.right_panel_width = px(390.0);
                theme.sidebar_width = px(300.0);
            }
        }

        match settings.ui_font {
            UiFont::System => theme.ui_font_family = ".AppleSystemUIFont",
            UiFont::Monospace => theme.ui_font_family = "SF Mono",
        }

        match settings.code_font {
            CodeFont::SystemMono => theme.code_font_family = "SF Mono",
            CodeFont::Menlo => theme.code_font_family = "Menlo",
        }

        match settings.motion {
            ThemeMotion::Standard => {}
            ThemeMotion::Reduced => {
                theme.motion_fast_ms = 0;
                theme.motion_standard_ms = 1;
            }
        }

        match settings.accent {
            ThemeAccent::Sky => {}
            ThemeAccent::Emerald => {
                theme.accent_blue = rgb(0x34d399).into();
                theme.accent_success = rgb(0x22c55e).into();
                theme.accent_warning = rgb(0xfacc15).into();
                theme.accent_pink = rgb(0x5eead4).into();
                theme.selection = rgb(0x1d2f2a).into();
                theme.button_hover = rgb(0x24362f).into();
            }
            ThemeAccent::Amber => {
                theme.accent_blue = rgb(0xf59e0b).into();
                theme.accent_success = rgb(0x84cc16).into();
                theme.accent_warning = rgb(0xfbbf24).into();
                theme.accent_pink = rgb(0xfb923c).into();
                theme.selection = rgb(0x332a18).into();
                theme.button_hover = rgb(0x3a2f1d).into();
            }
            ThemeAccent::Rose => {
                theme.accent_blue = rgb(0xfb7185).into();
                theme.accent_success = rgb(0x2dd4bf).into();
                theme.accent_warning = rgb(0xfbbf24).into();
                theme.accent_pink = rgb(0xf472b6).into();
                theme.selection = rgb(0x331f26).into();
                theme.button_hover = rgb(0x3a2430).into();
            }
        }

        theme
    }

    pub fn default_window_size() -> gpui::Size<Pixels> {
        size(px(1440.0), px(920.0))
    }

    pub fn app_name() -> SharedString {
        "Ace".into()
    }

    pub fn micro_interaction_opacity(self) -> f32 {
        let ratio = if self.motion_standard_ms == 0 {
            1.0
        } else {
            self.motion_fast_ms as f32 / self.motion_standard_ms as f32
        };
        (0.72 + ratio.clamp(0.0, 1.0) * 0.12).clamp(0.72, 0.84)
    }

    pub fn project_icon_color(self, color: Option<&str>) -> Hsla {
        match color {
            Some("blue") => self.accent_blue,
            Some("violet") => self.accent_pink,
            Some("emerald") => self.accent_success,
            Some("amber") => self.accent_warning,
            Some("rose") => self.accent_danger,
            Some("slate") => self.foreground.opacity(0.72),
            _ => self.muted,
        }
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
        assert_eq!(theme.bottom_panel_height, px(260.0));
        assert_eq!(theme.center_header_height, px(58.0));
        assert_eq!(theme.center_header_meta_height, px(18.0));
        assert_eq!(theme.environment_card_width, px(360.0));
        assert_eq!(theme.timeline_max_rendered_messages, 120);
        assert_eq!(theme.motion_fast_ms, 90);
        assert_eq!(theme.motion_standard_ms, 160);
        assert!((theme.micro_interaction_opacity() - 0.7875).abs() < 0.0001);
        assert_eq!(Theme::default_window_size().width, px(1440.0));
        assert_eq!(Theme::app_name().as_ref(), "Ace");
    }

    #[test]
    fn theme_settings_adjust_preset_density_font_and_motion() {
        let theme = Theme::from_settings(&ThemeSettings {
            preset: ThemePreset::HighContrast,
            density: ThemeDensity::Compact,
            ui_font: UiFont::Monospace,
            code_font: CodeFont::Menlo,
            motion: ThemeMotion::Reduced,
            accent: ThemeAccent::Emerald,
        });

        assert_eq!(theme.center_header_height, px(52.0));
        assert_eq!(theme.sidebar_width, px(300.0));
        assert_eq!(theme.ui_font_family, "SF Mono");
        assert_eq!(theme.code_font_family, "Menlo");
        assert_eq!(theme.accent_blue, rgb(0x34d399).into());
        assert_eq!(theme.selection, rgb(0x1d2f2a).into());
        assert_eq!(theme.motion_fast_ms, 0);
        assert_eq!(theme.motion_standard_ms, 1);
        assert_eq!(theme.background, rgb(0x050505).into());
    }

    #[test]
    fn accent_palettes_recolor_theme_tokens_centrally() {
        let sky = Theme::from_settings(&ThemeSettings {
            accent: ThemeAccent::Sky,
            ..ThemeSettings::default()
        });
        let rose = Theme::from_settings(&ThemeSettings {
            accent: ThemeAccent::Rose,
            ..ThemeSettings::default()
        });

        assert_ne!(sky.accent_blue, rose.accent_blue);
        assert_eq!(rose.accent_blue, rgb(0xfb7185).into());
        assert_eq!(rose.accent_pink, rgb(0xf472b6).into());
    }

    #[test]
    fn project_icon_colors_follow_theme_tokens() {
        let theme = Theme::from_settings(&ThemeSettings {
            accent: ThemeAccent::Amber,
            ..ThemeSettings::default()
        });

        assert_eq!(theme.project_icon_color(Some("blue")), theme.accent_blue);
        assert_eq!(
            theme.project_icon_color(Some("emerald")),
            theme.accent_success
        );
        assert_eq!(
            theme.project_icon_color(Some("amber")),
            theme.accent_warning
        );
        assert_eq!(theme.project_icon_color(Some("rose")), theme.accent_danger);
        assert_eq!(theme.project_icon_color(None), theme.muted);
    }
}

pub mod colors {
    pub const APP: u32 = 0x111111;
    pub const SIDEBAR: u32 = 0x2b2b2b;
    pub const PANE: u32 = 0x171717;
    pub const PANE_ALT: u32 = 0x1d1d1d;
    pub const CARD: u32 = 0x2e2e2e;
    pub const CARD_SOFT: u32 = 0x252525;
    pub const SELECTED: u32 = 0x424242;
    pub const HOVER: u32 = 0x353535;
    pub const TERMINAL: u32 = 0x121212;
    pub const BORDER: u32 = 0x333333;
    pub const BORDER_SUBTLE: u32 = 0x242424;
    pub const BORDER_ACTIVE: u32 = 0x3f9cff;
    pub const TEXT: u32 = 0xe9e9e9;
    pub const TEXT_MUTED: u32 = 0xb7b7b7;
    pub const TEXT_SUBTLE: u32 = 0x828282;
    pub const ACCENT: u32 = 0xff8a3d;
    pub const SUCCESS: u32 = 0x28c840;
    pub const WARNING: u32 = 0xffbd2e;
    pub const DANGER: u32 = 0xff5f57;
    pub const BLUE: u32 = 0x2f9bff;
    pub const SHELL_BLACK: u32 = 0x050505;
}

pub mod metrics {
    pub const SIDEBAR_WIDTH: f32 = 345.0;
    pub const CHAT_HEADER_HEIGHT: f32 = 54.0;
    pub const TERMINAL_HEIGHT: f32 = 334.0;
    pub const COMPOSER_HEIGHT: f32 = 124.0;
    pub const RADIUS: f32 = 8.0;
}

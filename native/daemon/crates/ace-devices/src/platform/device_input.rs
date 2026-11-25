// SPDX-License-Identifier: Apache-2.0
//! `@ace/protocol/devices`' `DeviceInput`, as the decisions here read it (D3.2). One shape for
//! every platform: a point, a timed gesture, typed text, or a hardware key.

use ace_json::JsString;
use serde::{Deserialize, Serialize};

/// One finger's phase, as `DeviceInput` names it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Phase {
    Down,
    Move,
    Up,
    Cancel,
}

/// A hardware key ace can press on a device.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Key {
    Home,
    Back,
    Rotate,
    Enter,
    Power,
    Recents,
    VolumeUp,
    VolumeDown,
    Action,
    Side,
    Keyboard,
}

/// The key's name in a message the person reads (`iOS Simulator has no ${key} key`).
impl Key {
    pub fn name(self) -> &'static str {
        match self {
            Self::Home => "home",
            Self::Back => "back",
            Self::Rotate => "rotate",
            Self::Enter => "enter",
            Self::Power => "power",
            Self::Recents => "recents",
            Self::VolumeUp => "volumeUp",
            Self::VolumeDown => "volumeDown",
            Self::Action => "action",
            Self::Side => "side",
            Self::Keyboard => "keyboard",
        }
    }
}

/// One device input, parsed before any backend sees it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum DeviceInput {
    Tap {
        x: f64,
        y: f64,
    },
    Pointer {
        phase: Phase,
        x: f64,
        y: f64,
        #[serde(rename = "pointerId", default)]
        pointer_id: Option<u32>,
    },
    LongPress {
        x: f64,
        y: f64,
        #[serde(rename = "durationMs", default = "default_duration")]
        duration_ms: f64,
    },
    Swipe {
        x: f64,
        y: f64,
        #[serde(rename = "toX")]
        to_x: f64,
        #[serde(rename = "toY")]
        to_y: f64,
        #[serde(rename = "durationMs", default = "default_duration")]
        duration_ms: f64,
    },
    Type {
        text: JsString,
    },
    Key {
        key: Key,
    },
}

fn default_duration() -> f64 {
    500.0
}

impl DeviceInput {
    /// Which finger the input belongs to, as `scrcpy-input.ts` reads `pointerId ?? 0`.
    pub fn pointer_id(&self) -> u32 {
        match self {
            Self::Pointer { pointer_id, .. } => pointer_id.unwrap_or(0),
            _ => 0,
        }
    }
}

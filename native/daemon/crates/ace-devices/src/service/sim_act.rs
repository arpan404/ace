// SPDX-License-Identifier: Apache-2.0
//! One `sim_act` call's decisions (`packages/devices/src/sim-act.ts`): the refusals
//! a ref proves before anything is sent, the label a message names, and the point a
//! tap falls back to.
//!
//! Sans-IO: the re-read, the device operations and the waits are the shell's; this
//! module decides what they must be and what the agent is told when they can't.

use ace_json::JsString;

use super::cowork::Point;
use super::sim_refs::SimElement;
use super::words;
use crate::error::{DeviceError, DeviceErrorCode};

/// The deepest, widest read the platforms allow, so a ref is never lost to a read
/// budget (`sim-act.ts:14`).
pub const FULL_READ_DEPTH: u16 = 16;
pub const FULL_READ_NODES: u32 = 512;

/// The label a message names an element by: `@e3 (Button "Save")`, in the SDK's
/// UTF-16 units so a lone surrogate the platform printed survives.
pub fn label(reference: &str, element: &SimElement) -> JsString {
    let mut units: Vec<u16> = Vec::new();
    units.push(u16::from(b'@'));
    units.extend(super::sim_refs::bare(reference).encode_utf16());
    units.extend(" (".encode_utf16());
    units.extend(element.role.units());
    if !element.name.as_str().is_empty() {
        units.extend(" ".encode_utf16());
        let quoted = ace_json::to_string(&ace_json::Value::String(element.name.slice_units(0, 60)));
        units.extend(quoted.encode_utf16());
    }
    units.extend(")".encode_utf16());
    JsString::from_units(&units)
}

/// The point a tap falls back to when the element has no `press` action: its
/// middle, rounded and never negative (`sim-act.ts:72`-`:75`).
pub fn centre(element: &SimElement) -> Point {
    Point {
        x: (element.bounds.x + element.bounds.w / 2.0).round().max(0.0),
        y: (element.bounds.y + element.bounds.h / 2.0).round().max(0.0),
    }
}

/// Whether a tap presses the element, or falls back to a point.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Tap {
    Press,
    Point(Point),
}

/// `tap`: press it when it takes a press, else tap its middle.
pub fn tap(element: &SimElement) -> Tap {
    if element.actions.iter().any(|action| action == "press") {
        Tap::Press
    } else {
        Tap::Point(centre(element))
    }
}

/// The refusal `ui` without a ref gets (`sim-act.ts:20`-`:25`).
pub fn ui_needs_ref() -> DeviceError {
    words::refusal("uiNeedsRef")
}

/// The refusal a ref this agent was never given gets (`sim-act.ts:116`-`:121`).
pub fn unknown_ref(reference: &str, device_id: &str) -> DeviceError {
    DeviceError::coded(
        DeviceErrorCode::StaleRef,
        format!("{reference} is not a ref from your sim_ui reads of {device_id}"),
        words::tool_hint("simRefUnknownHint"),
    )
}

/// The refusal an element that has left the screen gets (`sim-act.ts:126`-`:130`).
pub fn vanished(reference: &str, element: &SimElement) -> DeviceError {
    let mut units: Vec<u16> = label(reference, element).units().collect();
    units.extend(" is no longer on screen".encode_utf16());
    DeviceError::coded(
        DeviceErrorCode::StaleRef,
        JsString::from_units(&units),
        words::tool_hint("simStaleRefHint"),
    )
}

/// The refusal a UI action the element does not support gets
/// (`sim-act.ts:143`-`:149`).
pub fn unsupported_ui_action(reference: &str, element: &SimElement, action: &str) -> DeviceError {
    let mut units: Vec<u16> = label(reference, element).units().collect();
    units.extend(format!(" supports {}, not {action}", element.actions.join(", ")).encode_utf16());
    DeviceError::coded(
        DeviceErrorCode::NotSupported,
        JsString::from_units(&units),
        words::tool_hint("simActionUnsupportedHint"),
    )
}

/// The refusal an action that takes no ref gets (`sim-act.ts:170`-`:175`).
pub fn takes_no_ref(action: &str) -> DeviceError {
    DeviceError::coded(
        DeviceErrorCode::NotSupported,
        format!("{action} does not take a ref"),
        words::tool_hint("simActionNoRefHint"),
    )
}

#[cfg(test)]
mod tests;

// SPDX-License-Identifier: Apache-2.0
//! One queued device mutation's plan (`packages/devices/src/actions.ts`): the
//! refusals it proves before anything reaches the device, and which backend
//! does the work.
//!
//! Every mutation shares the queue's dispatch guard, so the shell runs each step
//! with its guard and this module decides what the steps are.

use crate::platform::device_input::{DeviceInput, Key};
use crate::platform::keys::key_refusal;

use super::words;
use crate::error::{DeviceError, DeviceErrorCode};

/// The device facts a queued action reads.
#[derive(Debug, Clone, Copy)]
pub struct DeviceFacts<'a> {
    pub ios: bool,
    pub name: &'a str,
}

/// What the session's capture can do, if it has one.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CaptureFacts {
    pub input: bool,
    pub clipboard: bool,
    pub multi_touch: bool,
    pub screen_session_id: Option<String>,
}

/// One queued mutation (`DeviceOperation`'s cases `performDeviceAction` handles).
#[derive(Debug, Clone, PartialEq)]
pub enum QueuedAction {
    ClipboardGet,
    ClipboardSet {
        text: String,
    },
    Boot,
    Install {
        path: String,
    },
    OpenApp {
        app_id: String,
    },
    OpenUrl {
        url: String,
    },
    Posture,
    Configure,
    Input(DeviceInput),
    /// An operation the queue does not run.
    Unsupported,
}

/// One step the shell performs, in order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Step {
    /// The capture's clipboard; its read is bounded (`boundedClipboard`).
    CaptureClipboard,
    /// The platform's clipboard.
    PlatformClipboard,
    /// The capture's input.
    CaptureInput,
    /// The platform's input, with the capture's screen session when it has one.
    PlatformInput { screen_session_id: Option<String> },
    /// Restart the capture after the input, with the guard re-proved first.
    RestartCapture,
    /// The platform call this operation names.
    Platform(&'static str),
    /// Read the posture back into the session and return it.
    Posture,
}

/// `performDeviceAction`: the refusals first, then the steps.
pub fn plan(
    action: &QueuedAction,
    capture: &CaptureFacts,
    device: DeviceFacts<'_>,
) -> Result<Vec<Step>, DeviceError> {
    let clipboard = || {
        if capture.clipboard {
            Step::CaptureClipboard
        } else {
            Step::PlatformClipboard
        }
    };
    Ok(match action {
        QueuedAction::ClipboardGet | QueuedAction::ClipboardSet { .. } => vec![clipboard()],
        QueuedAction::Boot => vec![Step::Platform("boot")],
        QueuedAction::Install { .. } => vec![Step::Platform("install")],
        QueuedAction::OpenApp { .. } => vec![Step::Platform("open_app")],
        QueuedAction::OpenUrl { .. } => vec![Step::Platform("open_url")],
        QueuedAction::Configure => vec![Step::Platform("configure")],
        QueuedAction::Posture => vec![Step::Posture],
        QueuedAction::Unsupported => return Err(words::refusal("unsupportedAction")),
        QueuedAction::Input(input) => {
            if let DeviceInput::Key { key } = input
                && let Some(refusal) = key_refusal(device.ios, device.name, *key)
            {
                return Err(from_platform_error(refusal));
            }
            // `pointerId` is read by truthiness: finger 0 is not a second finger.
            if let DeviceInput::Pointer { pointer_id, .. } = input
                && pointer_id.is_some_and(|id| id != 0)
                && !capture.multi_touch
            {
                return Err(words::refusal("inputOneFinger"));
            }
            if capture.input {
                vec![Step::CaptureInput]
            } else {
                let mut steps = vec![Step::PlatformInput {
                    screen_session_id: capture.screen_session_id.clone(),
                }];
                if matches!(input, DeviceInput::Key { key: Key::Rotate }) {
                    steps.push(Step::RestartCapture);
                }
                steps
            }
        }
    })
}

/// A `platform` error as the crate's typed error.
fn from_platform_error(error: crate::platform::Error) -> DeviceError {
    match error {
        crate::platform::Error::Refused(refusal) => DeviceError::Coded {
            code: DeviceErrorCode::parse(refusal.code.as_str())
                .unwrap_or(DeviceErrorCode::CommandFailed),
            message: refusal.message.into(),
            hint: refusal.hint.into(),
            permission: None,
        },
        crate::platform::Error::Failed(failure) => DeviceError::Coded {
            code: DeviceErrorCode::parse(failure.code.as_str())
                .unwrap_or(DeviceErrorCode::CommandFailed),
            message: failure.message.into(),
            hint: failure.hint.into(),
            permission: None,
        },
        crate::platform::Error::Invalid(message) => DeviceError::InvalidInput(message),
    }
}

#[cfg(test)]
mod tests;

// SPDX-License-Identifier: Apache-2.0
//! `device-images.ts`: device pictures through ace-media (ADR 0208). Every job has a deadline,
//! so a device call never waits on ace-media past it, and a failed job becomes the failure an
//! agent or person can act on.

use crate::platform::{Code, Failure};

/// A screenshot an agent waits on, and a look that is drawn once and cached.
pub const SHOT_DEADLINE_MS: u64 = 10_000;
pub const LOOK_DEADLINE_MS: u64 = 15_000;

/// A failed image job as a device failure. `reason` is ace-media's `ImageError.reason`; a
/// failure that isn't an image job at all passes none.
pub fn device_image_error(what: &str, reason: Option<&str>, message: Option<&str>) -> Failure {
    let detail = message.unwrap_or_default();
    let (code, text, hint) = match reason {
        None => (
            Code::InvalidData,
            format!("{what} could not be read"),
            "Retry; if it persists, restart the device.",
        ),
        Some("busy") => (
            Code::Busy,
            format!("{what}: {detail}"),
            "Retry in a moment.",
        ),
        Some("deadline") | Some("cancelled") => (
            Code::Timeout,
            format!("{what}: {detail}"),
            "Retry in a moment.",
        ),
        Some("unavailable") | Some("exited") | Some("shutdown") => (
            Code::ToolMissing,
            format!("{what}: {detail}"),
            "ace-media makes device pictures; run `ace doctor` to see why it isn't running.",
        ),
        Some(_) => (
            Code::InvalidData,
            format!("{what} could not be read: {detail}"),
            "Retry; if it persists, restart the device.",
        ),
    };
    Failure {
        code,
        message: text,
        hint: hint.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_failure_that_is_not_an_image_job_could_not_be_read() {
        let failure = device_image_error("The Simulator body", None, Some("EOF"));
        assert_eq!(failure.code, Code::InvalidData);
        assert_eq!(failure.message, "The Simulator body could not be read");
        assert_eq!(failure.hint, "Retry; if it persists, restart the device.");
    }

    #[test]
    fn a_busy_pipeline_says_so_and_a_deadline_is_a_timeout() {
        let busy = device_image_error("A screenshot", Some("busy"), Some("four jobs are running"));
        assert_eq!(busy.code, Code::Busy);
        assert_eq!(busy.message, "A screenshot: four jobs are running");
        assert_eq!(busy.hint, "Retry in a moment.");
        assert_eq!(
            device_image_error("A look", Some("deadline"), Some("15 s")).code,
            Code::Timeout
        );
        assert_eq!(
            device_image_error("A look", Some("cancelled"), Some("withdrawn")).code,
            Code::Timeout
        );
    }

    #[test]
    fn a_missing_ace_media_is_a_missing_tool_with_the_doctor_hint() {
        for reason in ["unavailable", "exited", "shutdown"] {
            let failure = device_image_error("A screenshot", Some(reason), Some("no process"));
            assert_eq!(failure.code, Code::ToolMissing, "{reason}");
            assert_eq!(
                failure.hint,
                "ace-media makes device pictures; run `ace doctor` to see why it isn't running."
            );
        }
    }

    #[test]
    fn any_other_image_reason_keeps_what_ace_media_said() {
        let failure = device_image_error("A look", Some("decode"), Some("bad PNG"));
        assert_eq!(failure.code, Code::InvalidData);
        assert_eq!(failure.message, "A look could not be read: bad PNG");
    }
}

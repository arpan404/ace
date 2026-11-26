// SPDX-License-Identifier: Apache-2.0
//! `recording.ts`'s once-per-recording decisions: whether a recording may start, what ace-media
//! is asked for (its origin, its part size and the recording's limit), how an end reads (the
//! failure that is its reason, the truncated warning) and every notice a person sees. The frames
//! a recording keeps, ace-media's writer, the release and the artifact publication are the
//! shell's.

use crate::platform::{Code, Error, Failure, Platform};

use super::recording_limits::{DEVICE_RECORDING_LIMIT, DEVICE_RECORDING_PART_BYTES};

/// MediaFrame codec 1: H.264 Annex B, a keyframe carrying its parameter sets in front.
pub const H264_ANNEX_B: u32 = 1;

/// What `recordDevice` knows before it starts: the thread it acts for, the session's state and
/// whether the artifact registry is available.
#[derive(Debug, Clone, Copy)]
pub struct StartFacts {
    pub has_thread: bool,
    pub live: bool,
    pub recording: bool,
    pub recording_starting: bool,
    pub recording_closing: bool,
    /// `recordingAvailable()` was absent or said yes.
    pub registry_available: bool,
}

/// Whether a recording may start, or the refusal the person sees.
pub fn start_refusal(facts: StartFacts) -> Result<(), Error> {
    if !facts.has_thread {
        return Err(refused(
            Code::PermissionDenied,
            "Recording needs a thread using this device",
            "Call sim_start to take this simulator for the thread.",
        ));
    }
    if !facts.live {
        return Err(refused(
            Code::NotFound,
            "Capture is not live",
            "Start capture before recording.",
        ));
    }
    if facts.recording || facts.recording_starting || facts.recording_closing {
        return Err(refused(
            Code::Busy,
            "Recording already started",
            "Stop the recording first.",
        ));
    }
    if !facts.registry_available {
        return Err(refused(
            Code::ToolMissing,
            "Device artifact registry is unavailable",
            "Configure ACE_WORKSPACE_ROOT before recording devices.",
        ));
    }
    Ok(())
}

/// A capture that isn't streaming H.264 can't be recorded.
pub fn codec_refusal(codec: &str) -> Result<(), Error> {
    if codec == "h264" {
        return Ok(());
    }
    Err(refused(
        Code::NotSupported,
        "This device's capture can't stream video for a recording",
        "Restart the device's live view; if it persists, check its capture tools.",
    ))
}

/// The sizes a recording starts with: its whole limit and the most one MP4 part holds.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
pub struct Sizes {
    pub limit: u64,
    #[serde(rename = "maxBytes")]
    pub max_bytes: u64,
}

/// The limit a recording keeps and the part size it asks ace-media for, from the shell's own
/// limit when it set one.
pub fn sizes(recording_limit_bytes: Option<f64>) -> Sizes {
    let limit = match recording_limit_bytes {
        Some(bytes) if bytes.is_finite() && bytes >= 0.0 => bytes as u64,
        _ => DEVICE_RECORDING_LIMIT,
    };
    Sizes {
        limit,
        max_bytes: DEVICE_RECORDING_PART_BYTES.min(limit),
    }
}

/// Where ace-media reads the recording's video from, in the shape its `start` takes.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Origin {
    /// A Simulator's screen, through the screen manager.
    Screen { platform: &'static str },
    /// scrcpy's tunnel; the capture's own port is not needed for a recording.
    Scrcpy { host: &'static str, port: u16 },
}

/// The origin a recording of `platform` starts with.
pub fn origin(platform: Platform) -> Origin {
    match platform {
        Platform::Ios => Origin::Screen {
            platform: "ios-simulator",
        },
        Platform::Android => Origin::Scrcpy {
            host: "127.0.0.1",
            port: 0,
        },
    }
}

/// How one recording's end reads.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Ended {
    /// ace-media couldn't confirm the recording's last moment.
    pub truncated: bool,
    /// Why the recording failed, when it did and something was written.
    pub failure: Option<Failure>,
    /// Why nothing was written at all.
    pub no_video: Failure,
}

/// Reads an end: ace-media's failure before any success, `truncated` only when it was ok, and
/// the failure's hint told apart by whether any part survives.
pub fn ended(ok: bool, truncated: bool, reason: &str, parts: usize) -> Ended {
    Ended {
        truncated: ok && truncated,
        failure: (!ok).then(|| {
            failed(
                Code::CommandFailed,
                &format!("The recording failed: {reason}"),
                if parts > 0 {
                    "What was recorded before the failure is saved to this thread. Start a new recording to go on."
                } else {
                    "Keep the device on screen while recording, then try again."
                },
            )
        }),
        no_video: no_video(),
    }
}

/// Why a recording that never wrote a part reports nothing to save.
pub fn no_video() -> Failure {
    failed(
        Code::CommandFailed,
        "The recording has no video",
        "Keep the device on screen while recording, then try again.",
    )
}

/// The notices a recording leaves on its thread, once each.
pub const SIZE_LIMIT_NOTICE: &str =
    "Recording stopped at its size limit. The video is being saved to this thread.";
pub const WRITE_FAILED_NOTICE: &str =
    "Recording stopped because it couldn't be written. Check free disk space and try again.";
pub const TRUNCATED_NOTICE: &str = "The recording is saved, but ace-media couldn't confirm its last moment: the end may be incomplete.";
pub const UNSAVED_NOTICE: &str =
    "The recording couldn't be saved. Check the recording tools and try again.";

/// The notice for a part ace-media wrote but the thread never got.
pub fn kept_notice(directory: &str) -> String {
    format!(
        "Part of the recording couldn't be confirmed and wasn't added to the thread; it is kept in {directory}."
    )
}

/// A refusal whose words are data rather than a catalog word.
fn refused(code: Code, message: &str, hint: &str) -> Error {
    Error::Failed(failed(code, message, hint))
}

fn failed(code: Code, message: &str, hint: &str) -> Failure {
    Failure {
        code,
        message: message.to_string(),
        hint: hint.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn code(error: &Error) -> Code {
        match error {
            Error::Failed(failure) => failure.code,
            Error::Refused(refusal) => refusal.code,
            Error::Invalid(_) => panic!("a refusal, not a caller mistake"),
        }
    }

    fn facts() -> StartFacts {
        StartFacts {
            has_thread: true,
            live: true,
            recording: false,
            recording_starting: false,
            recording_closing: false,
            registry_available: true,
        }
    }

    #[test]
    fn a_recording_starts_for_a_live_thread_when_the_registry_is_there() {
        assert!(start_refusal(facts()).is_ok());
    }

    #[test]
    fn each_start_refusal_is_todays_code_and_its_own_words() {
        for (facts, expected) in [
            (
                StartFacts {
                    has_thread: false,
                    ..facts()
                },
                Code::PermissionDenied,
            ),
            (
                StartFacts {
                    live: false,
                    ..facts()
                },
                Code::NotFound,
            ),
            (
                StartFacts {
                    recording: true,
                    ..facts()
                },
                Code::Busy,
            ),
            (
                StartFacts {
                    recording_starting: true,
                    ..facts()
                },
                Code::Busy,
            ),
            (
                StartFacts {
                    recording_closing: true,
                    ..facts()
                },
                Code::Busy,
            ),
            (
                StartFacts {
                    registry_available: false,
                    ..facts()
                },
                Code::ToolMissing,
            ),
        ] {
            assert_eq!(code(&start_refusal(facts).expect_err("refused")), expected);
        }
        // The thread is checked before the registry, as the script refuses in this order.
        assert_eq!(
            code(
                &start_refusal(StartFacts {
                    has_thread: false,
                    registry_available: false,
                    ..facts()
                })
                .expect_err("refused")
            ),
            Code::PermissionDenied
        );
    }

    #[test]
    fn only_h264_is_recorded() {
        assert!(codec_refusal("h264").is_ok());
        assert_eq!(
            code(&codec_refusal("jpeg").expect_err("refused")),
            Code::NotSupported
        );
    }

    #[test]
    fn the_part_size_never_exceeds_a_part_and_the_limit_is_the_scripts_when_unset() {
        assert_eq!(
            sizes(None),
            Sizes {
                limit: DEVICE_RECORDING_LIMIT,
                max_bytes: DEVICE_RECORDING_PART_BYTES,
            }
        );
        assert_eq!(
            sizes(Some(1024.0)),
            Sizes {
                limit: 1024,
                max_bytes: 1024,
            }
        );
        let big = (DEVICE_RECORDING_LIMIT * 2) as f64;
        assert_eq!(sizes(Some(big)).max_bytes, DEVICE_RECORDING_PART_BYTES);
        assert_eq!(sizes(Some(f64::NAN)).limit, DEVICE_RECORDING_LIMIT);
    }

    #[test]
    fn an_origin_names_the_screen_for_a_simulator_and_scrcpys_loopback_for_android() {
        assert_eq!(
            serde_json::to_string(&origin(Platform::Ios)).expect("serializes"),
            r#"{"kind":"screen","platform":"ios-simulator"}"#
        );
        assert_eq!(
            serde_json::to_string(&origin(Platform::Android)).expect("serializes"),
            r#"{"kind":"scrcpy","host":"127.0.0.1","port":0}"#
        );
    }

    #[test]
    fn a_failed_recording_with_parts_keeps_them_and_says_so() {
        let end = ended(false, true, "disk full", 2);
        assert!(!end.truncated, "a failure is not a truncation");
        let failure = end.failure.expect("a failure");
        assert_eq!(failure.message, "The recording failed: disk full");
        assert!(failure.hint.starts_with("What was recorded"));
        let end = ended(false, false, "disk full", 0);
        assert!(
            end.failure
                .expect("a failure")
                .hint
                .starts_with("Keep the device")
        );
    }

    #[test]
    fn a_truncated_recording_is_a_warning_after_a_success_only() {
        assert!(ended(true, true, "", 1).truncated);
        assert!(!ended(true, false, "", 1).truncated);
        assert!(ended(true, true, "", 1).failure.is_none());
    }

    #[test]
    fn a_recording_with_no_video_has_its_own_words() {
        let end = ended(true, false, "", 0);
        assert_eq!(end.no_video.message, "The recording has no video");
        assert!(kept_notice("/tmp/r1.parts").contains("/tmp/r1.parts"));
    }
}

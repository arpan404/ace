//! The hello's capture → encode report (ADR 0148, the K2 capability entry), from the trial
//! the helper runs at start: one picture through the same device, video processor and MFT
//! that live video uses. A machine with no H.264 MFT (an N edition without the Media Feature
//! Pack) reports the encode step failed and offers only JPEG, so the daemon encodes its
//! pictures with the last-resort encoder instead, and the helper says so on stderr.
use serde_json::{json, Value};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TrialState {
    Ok,
    TimedOut,
    Failed,
}
impl TrialState {
    fn name(self) -> &'static str {
        match self {
            Self::Ok => "ok",
            Self::TimedOut => "timed-out",
            Self::Failed => "failed",
        }
    }
}

/// What the trial observed. `hardware` is what the MFT itself says (`MFT_ENUM_FLAG_HARDWARE`).
#[derive(Clone, Debug, PartialEq)]
pub struct Trial {
    pub state: TrialState,
    pub hardware: bool,
    /// The D3D11 video processor converted and scaled the capture texture.
    pub video_processor: bool,
    /// The adapter is a hardware GPU, not WARP or the Basic Render Driver.
    pub gpu: bool,
    /// Picture readbacks the trial's encode made (the software MFT takes system memory).
    pub readbacks: u32,
    pub codec: Option<String>,
    pub detail: String,
}

/// Largest encode the helper offers, its capture limit.
const MAX: (u32, u32) = (3840, 2160);

impl Trial {
    pub fn failed(detail: impl Into<String>) -> Self {
        Self {
            state: TrialState::Failed,
            hardware: false,
            video_processor: false,
            gpu: false,
            readbacks: 0,
            codec: None,
            detail: detail.into(),
        }
    }

    pub fn h264(&self) -> bool {
        self.state == TrialState::Ok
    }

    /// The codecs the hello offers.
    pub fn codecs(&self) -> Value {
        if self.h264() {
            json!(["jpeg", "h264"])
        } else {
            json!(["jpeg"])
        }
    }

    /// The `encoders` entries: the scale step and the encode step.
    pub fn encoders(&self) -> Value {
        let ok = self.h264();
        let (width, height) = if ok { MAX } else { (0, 0) };
        let scale_state = if self.video_processor {
            TrialState::Ok
        } else {
            TrialState::Failed
        };
        let scale_size = if self.video_processor { MAX } else { (0, 0) };
        json!([
            {"step":"scale","backend":"mf","hardware":self.video_processor && self.gpu,
             "zeroCopy":self.video_processor,"state":scale_state.name(),
             "maxWidth":scale_size.0,"maxHeight":scale_size.1},
            {"step":"encode","codec":self.codec.clone().unwrap_or_else(|| "avc1.42E01F".into()),
             "backend":"mf","hardware":ok && self.hardware,
             "zeroCopy":ok && self.video_processor && self.readbacks == 0,
             "state":self.state.name(),"maxWidth":width,"maxHeight":height}
        ])
    }

    /// The line the helper logs at start.
    pub fn summary(&self) -> String {
        match self.state {
            TrialState::Ok => format!(
                "screen video: Media Foundation H.264 ({}, {} readback{} per frame)",
                if self.hardware { "hardware MFT" } else { "software MFT" },
                self.readbacks,
                if self.readbacks == 1 { "" } else { "s" }
            ),
            _ => format!(
                "screen video: no Media Foundation H.264 encoder ({}: {}); live view uses the last-resort encoder",
                self.state.name(),
                self.detail
            ),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn software() -> Trial {
        Trial {
            state: TrialState::Ok,
            hardware: false,
            video_processor: true,
            gpu: true,
            readbacks: 1,
            codec: Some("avc1.42C028".into()),
            detail: String::new(),
        }
    }

    #[test]
    fn a_software_mft_offers_h264_as_not_hardware_with_a_readback() {
        let trial = software();
        assert_eq!(trial.codecs(), json!(["jpeg", "h264"]));
        let encode = &trial.encoders()[1];
        assert_eq!(encode["hardware"], false);
        assert_eq!(encode["zeroCopy"], false);
        assert_eq!(encode["state"], "ok");
        assert_eq!(encode["codec"], "avc1.42C028");
        assert_eq!(encode["maxWidth"], 3840);
        assert!(trial
            .summary()
            .contains("software MFT, 1 readback per frame"));
    }

    #[test]
    fn a_hardware_mft_fed_textures_is_zero_copy() {
        let trial = Trial {
            hardware: true,
            readbacks: 0,
            ..software()
        };
        let encode = &trial.encoders()[1];
        assert_eq!(
            (encode["hardware"].as_bool(), encode["zeroCopy"].as_bool()),
            (Some(true), Some(true))
        );
    }

    #[test]
    fn no_mft_offers_only_jpeg_and_says_the_last_resort_encoder_is_used() {
        let trial = Trial::failed("no H.264 encoder MFT");
        assert_eq!(trial.codecs(), json!(["jpeg"]));
        let encode = &trial.encoders()[1];
        assert_eq!(
            (encode["state"].as_str(), encode["maxWidth"].as_u64()),
            (Some("failed"), Some(0))
        );
        assert!(trial.summary().contains("last-resort encoder"));
        let timed_out = Trial {
            state: TrialState::TimedOut,
            ..Trial::failed("no output in 2 s")
        };
        assert_eq!(timed_out.encoders()[1]["state"], "timed-out");
        assert_eq!(timed_out.codecs(), json!(["jpeg"]));
    }
}

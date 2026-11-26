// SPDX-License-Identifier: Apache-2.0
//! `simulator-capture.ts`'s stream state: JPEG stills or serve-sim's H.264 through ace-media,
//! the error when no route exists, when a viewer's link needs ace-media to re-encode, and the
//! H.264 unit as the frame published to viewers. Pure: the rate's clock is passed in.

use crate::platform::scrcpy::video::VideoUnit;
use crate::platform::simulator_source_rate::SimulatorSourceRate;
use crate::platform::simulator_transcode::{
    Box as TranscodeBox, EncodeSettings, EncodeSpec, Size, TranscodeInput, encode_spec,
    needs_transcode,
};
use crate::platform::{Code, Error, Failure};

/// Which picture a Simulator capture is handing out.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    /// serve-sim's MJPEG, for agents' stills and recordings while nobody watches.
    Jpeg,
    /// serve-sim's H.264 through ace-media, for live views.
    H264,
}

/// A live view is video through ace-media or nothing: say so rather than hand it JPEG.
pub fn to_h264(routed: bool) -> Result<Mode, Error> {
    if !routed {
        return Err(Error::Failed(Failure {
            code: Code::CommandFailed,
            message: "Live video needs ace-media, which isn't available on this computer"
                .to_string(),
            hint:
                "Agents can still see and drive the Simulator. Restart ace to bring ace-media back."
                    .to_string(),
        }));
    }
    Ok(Mode::H264)
}

/// What ace-media is told to encode for a viewer, and the state that follows.
#[derive(Debug, Clone, PartialEq)]
pub enum FollowPlan {
    /// Nothing changes.
    None,
    /// Re-encode at these specs.
    Encode(Vec<EncodeSpec>),
    /// Pass serve-sim's own stream through again.
    PassThrough,
}

#[derive(Debug, Clone, PartialEq)]
pub struct FollowOutcome {
    pub plan: FollowPlan,
    pub transcoding: bool,
}

/// The encode a viewer's settings need now: serve-sim's stream as it is while the viewers can
/// carry it, re-encoded at their size and rate when they can't.
pub fn follow_plan(
    from_media: bool,
    transcoding: bool,
    native: Option<Size>,
    source_peak: f64,
    settings: &EncodeSettings,
) -> FollowOutcome {
    if !from_media {
        return FollowOutcome {
            plan: FollowPlan::None,
            transcoding,
        };
    }
    let need = needs_transcode(&TranscodeInput {
        transcoding,
        bitrate: settings.bitrate,
        box_: TranscodeBox {
            max_width: settings.max_width,
            max_height: settings.max_height,
        },
        native,
        source: Some(source_peak),
    });
    let plan = if need {
        match native {
            Some(native) => FollowPlan::Encode(vec![encode_spec(native, *settings)]),
            None => FollowPlan::None,
        }
    } else if transcoding {
        FollowPlan::PassThrough
    } else {
        FollowPlan::None
    };
    FollowOutcome {
        plan,
        transcoding: need && native.is_some(),
    }
}

/// One H.264 unit as the frame viewers get.
#[derive(Debug, Clone, PartialEq)]
pub struct Published {
    pub width: u32,
    pub height: u32,
    pub scale: f64,
    pub keyframe: bool,
    pub video_codec: Option<String>,
    pub bytes: usize,
}

/// What handing one unit on does.
#[derive(Debug, Clone, PartialEq)]
pub struct Delivery {
    pub publish: Option<Published>,
    /// The second opened: look at the viewer's settings again.
    pub follow: bool,
}

/// serve-sim's H.264 feed: the stream's mode and native size, the busy-rate window and the
/// viewer's transcode state.
#[derive(Debug)]
pub struct H264Feed {
    pub mode: Mode,
    pub video: bool,
    pub native: Option<Size>,
    pub transcoding: bool,
    rate: SimulatorSourceRate,
}

impl H264Feed {
    pub fn new() -> Self {
        Self {
            mode: Mode::Jpeg,
            video: false,
            native: None,
            transcoding: false,
            rate: SimulatorSourceRate::default(),
        }
    }

    /// One H.264 unit back from ace-media: serve-sim's own, or re-encoded for the viewer.
    pub fn deliver(
        &mut self,
        unit: &VideoUnit,
        now: f64,
        viewer: Option<&EncodeSettings>,
        stopped: bool,
    ) -> Delivery {
        if stopped || !self.video {
            return Delivery {
                publish: None,
                follow: false,
            };
        }
        let codec = |keyframe: bool| {
            if keyframe {
                Some(unit.video_codec.clone())
            } else {
                None
            }
        };
        // Re-encoded by ace-media at the viewer's size: published as such, leaving serve-sim's
        // own picture (input mapping, its measured rate) alone.
        if unit.encode.is_some() {
            let scale = match self.native {
                Some(native) if native.width > 0.0 => f64::from(unit.width) / native.width,
                _ => 1.0,
            };
            return Delivery {
                publish: Some(Published {
                    width: unit.width,
                    height: unit.height,
                    scale,
                    keyframe: unit.keyframe,
                    video_codec: codec(unit.keyframe),
                    bytes: unit.payload.len(),
                }),
                follow: false,
            };
        }
        // The first IDR is the switch: later JPEG frames are dropped from here on.
        self.mode = Mode::H264;
        self.native = Some(Size {
            width: f64::from(unit.width),
            height: f64::from(unit.height),
        });
        // A busier source than the viewer was judged against may need re-encoding now.
        let follow = self.rate.record(millis(now), unit.payload.len() as u64) && viewer.is_some();
        Delivery {
            publish: Some(Published {
                width: unit.width,
                height: unit.height,
                scale: 1.0,
                keyframe: unit.keyframe,
                video_codec: codec(unit.keyframe),
                bytes: unit.payload.len(),
            }),
            follow,
        }
    }

    /// The viewer's plan now, after a rate change.
    pub fn plan(&self, viewer: Option<&EncodeSettings>, source_peak: f64) -> FollowOutcome {
        let Some(viewer) = viewer else {
            return FollowOutcome {
                plan: FollowPlan::None,
                transcoding: self.transcoding,
            };
        };
        follow_plan(true, self.transcoding, self.native, source_peak, viewer)
    }

    pub fn peak(&self, now: f64) -> f64 {
        self.rate.peak(millis(now)) as f64
    }
}

impl Default for H264Feed {
    fn default() -> Self {
        Self::new()
    }
}

/// A capture clock reading in whole milliseconds, as the rate window counts them.
fn millis(now: f64) -> i64 {
    now.max(0.0).floor() as i64
}

/// An agent still's scale: its fitted width over serve-sim's native width, else 1.
pub fn still_scale(encoded_width: u32, native: Option<Size>) -> f64 {
    match native {
        Some(native) if native.width > 0.0 => f64::from(encoded_width) / native.width,
        _ => 1.0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unit(
        width: u32,
        height: u32,
        encode: Option<u32>,
        keyframe: bool,
        bytes: usize,
    ) -> VideoUnit {
        VideoUnit {
            payload: vec![0; bytes],
            keyframe,
            video_codec: "avc1.640033".to_string(),
            width,
            height,
            pts: 0,
            encode,
        }
    }

    fn settings(bitrate: f64, width: f64, height: f64) -> EncodeSettings {
        EncodeSettings {
            max_width: width,
            max_height: height,
            bitrate,
        }
    }

    #[test]
    fn a_live_view_without_ace_media_says_so_instead_of_handing_out_jpeg() {
        let error = to_h264(false).expect_err("refused");
        match error {
            Error::Failed(failure) => {
                assert_eq!(failure.code, Code::CommandFailed);
                assert_eq!(
                    failure.message,
                    "Live video needs ace-media, which isn't available on this computer"
                );
            }
            other => panic!("unexpected: {other}"),
        }
        assert_eq!(to_h264(true).expect("allowed"), Mode::H264);
    }

    #[test]
    fn a_viewer_below_the_source_rate_is_re_encoded_at_its_size_and_passes_through_again_above_it()
    {
        let native_size = Size {
            width: 1206.0,
            height: 2622.0,
        };
        let native = Some(native_size);
        let slow = settings(3_000_000.0, 800.0, 1280.0);
        let plan = follow_plan(true, false, native, 6_000_000.0, &slow);
        assert_eq!(
            plan.plan,
            FollowPlan::Encode(vec![encode_spec(native_size, slow)])
        );
        assert!(plan.transcoding);
        // A comfortable link passes serve-sim's own stream through again.
        let fast = settings(30_000_000.0, 4000.0, 4000.0);
        let plan = follow_plan(true, true, native, 6_000_000.0, &fast);
        assert_eq!(plan.plan, FollowPlan::PassThrough);
        assert!(!plan.transcoding);
        // Not routed through ace-media: nothing to tell it.
        assert_eq!(
            follow_plan(false, true, native, 6_000_000.0, &slow).plan,
            FollowPlan::None
        );
    }

    #[test]
    fn a_re_encoded_unit_keeps_the_viewers_scale_and_a_delta_names_no_codec() {
        let mut feed = H264Feed::new();
        feed.video = true;
        feed.native = Some(Size {
            width: 1206.0,
            height: 2622.0,
        });
        let delivery = feed.deliver(&unit(603, 1311, Some(1), false, 10), 0.0, None, false);
        let published = delivery.publish.expect("published");
        assert_eq!((published.width, published.height), (603, 1311));
        assert_eq!(published.scale, 0.5);
        assert_eq!(published.video_codec, None);
        assert!(!published.keyframe);
    }

    #[test]
    fn serve_sims_own_unit_sets_the_native_size_and_a_new_second_asks_the_viewer_to_follow() {
        let mut feed = H264Feed::new();
        feed.video = true;
        let viewer = settings(30_000_000.0, 4000.0, 4000.0);
        let first = feed.deliver(
            &unit(1206, 2622, None, true, 100),
            0.0,
            Some(&viewer),
            false,
        );
        let published = first.publish.expect("published");
        assert_eq!(published.scale, 1.0);
        assert_eq!(published.video_codec.as_deref(), Some("avc1.640033"));
        assert_eq!(
            feed.native,
            Some(Size {
                width: 1206.0,
                height: 2622.0
            })
        );
        assert_eq!(feed.mode, Mode::H264);
        // A new second opens the rate window, so the viewer's plan is looked at again.
        let second = feed.deliver(
            &unit(1206, 2622, None, false, 100),
            1_000.0,
            Some(&viewer),
            false,
        );
        assert!(second.follow);
        assert!(feed.peak(1_000.0) > 0.0);
        // Stopped or not video: nothing is handed on.
        assert!(
            feed.deliver(&unit(1, 1, None, true, 1), 2_000.0, None, true)
                .publish
                .is_none()
        );
        feed.video = false;
        assert!(
            feed.deliver(&unit(1, 1, None, true, 1), 2_000.0, None, false)
                .publish
                .is_none()
        );
    }

    #[test]
    fn an_agent_stills_scale_is_its_width_over_the_native_width_or_one() {
        let native = Some(Size {
            width: 1206.0,
            height: 2622.0,
        });
        assert_eq!(still_scale(603, native), 0.5);
        assert_eq!(still_scale(603, None), 1.0);
    }
}

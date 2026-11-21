use crate::{
    codec::{jpeg, packet, Header},
    coordinates::Bounds,
    errors::{Code, Error, Result},
    media::config::{StreamCodec, StreamSettings},
    tiles::Tiles,
};
use media_ingest::epochs::EpochLedger;
pub use media_ingest::epochs::{CaptureTime, Epoch};
/// Caller supplies event time. A denied pacing slot never updates hashes, so a final change survives.
pub struct Stream {
    tiles: Tiles,
    next_ms: f64,
    fps: u32,
    seq: u64,
    session: String,
    version: u8,
    generation: u64,
    metadata: Option<(u32, u32, f64)>,
    /// Live video while a viewer watches as video (`stream.configure` with H.264).
    video: Option<StreamSettings>,
    video_next_ms: f64,
    keyframe: bool,
    image: bool,
    /// When each privacy epoch was applied, in raw QPC ticks. A picture takes the epoch in
    /// force at its own capture time, however late it is dequeued (`media_ingest::epochs`).
    epochs: EpochLedger,
}

impl Stream {
    pub fn new(session: String, version: u8, fps: u32) -> Self {
        Self {
            tiles: Tiles::default(),
            next_ms: 0.0,
            fps: fps.clamp(1, 30),
            seq: 0,
            session,
            version,
            generation: 1,
            metadata: None,
            video: None,
            video_next_ms: 0.0,
            keyframe: false,
            image: false,
            epochs: EpochLedger::default(),
        }
    }
    /// `stream.configure`: video at the settings' rate, or JPEG stills at it (30 fps at most).
    /// `epoch` applies from `now_ticks`, the raw QPC counter.
    pub fn configure(&mut self, settings: StreamSettings, epoch: Option<Epoch>, now_ticks: i64) {
        if let Some(epoch) = epoch {
            self.epochs.apply(now_ticks, epoch);
        }
        match settings.codec {
            StreamCodec::H264 => {
                if self.video.is_none() {
                    self.keyframe = true;
                    self.video_next_ms = 0.0;
                }
                self.video = Some(settings);
            }
            StreamCodec::Jpeg => {
                self.video = None;
                self.fps = settings.fps.clamp(1, 30);
                self.refresh();
            }
        }
    }
    pub fn video(&self) -> Option<StreamSettings> {
        self.video
    }
    /// The epoch of a picture captured at `when`: the shared rule, which errs toward private.
    pub fn epoch_at(&self, when: CaptureTime) -> u32 {
        self.epochs.epoch_at(when)
    }
    /// The epoch of the newest picture, captured at `when`, which replaces every older one: the
    /// ledger forgets what only an older picture could need.
    pub fn epoch_for_newest(&mut self, when: CaptureTime) -> u32 {
        let epoch = self.epochs.epoch_at(when);
        self.epochs.forget_before(when.first);
        epoch
    }
    pub fn request_keyframe(&mut self) {
        self.keyframe = true;
    }
    pub fn take_keyframe(&mut self) -> bool {
        std::mem::take(&mut self.keyframe)
    }
    /// One JPEG still of the next picture, while video streams (`stream.image`).
    pub fn request_image(&mut self) {
        self.image = true;
        self.refresh();
    }
    pub fn take_image(&mut self) -> bool {
        std::mem::take(&mut self.image)
    }
    /// Whether a picture captured at `now_ms` is due for encoding, at the video rate.
    pub fn video_due(&mut self, now_ms: f64) -> bool {
        let Some(settings) = self.video else {
            return false;
        };
        if now_ms < self.video_next_ms {
            return false;
        }
        self.video_next_ms = now_ms + 1000.0 / settings.fps as f64;
        true
    }
    /// The sequence the next frame will take.
    pub fn sequence(&self) -> u64 {
        self.seq
    }
    /// The next frame sequence, shared by video units and stills so each path's order holds.
    pub fn next_sequence(&mut self) -> u64 {
        let seq = self.seq;
        self.seq += 1;
        seq
    }
    pub fn generation(&mut self, generation: u64) {
        self.generation = generation;
        self.refresh();
    }
    pub fn session_id(&self) -> &str {
        &self.session
    }
    pub fn capture_generation(&self) -> u64 {
        self.generation
    }
    pub fn refresh(&mut self) {
        self.tiles = Tiles::default();
        self.next_ms = 0.0;
        self.metadata = None;
    }
    pub fn due_in(&self, now_ms: f64) -> f64 {
        if self.image {
            return 0.0;
        }
        let next = if self.video.is_some() {
            self.video_next_ms
        } else {
            self.next_ms
        };
        (next - now_ms).max(0.0)
    }
    pub fn frame(
        &mut self,
        rgb: &[u8],
        width: u32,
        height: u32,
        scale: f64,
        now_ms: f64,
    ) -> Result<Option<Vec<u8>>> {
        self.frame_at(rgb, width, height, scale, now_ms, now_ms)
    }
    /// Paces by `now_ms` and stamps the header with `captured_ms`, when the picture was taken.
    pub fn frame_at(
        &mut self,
        rgb: &[u8],
        width: u32,
        height: u32,
        scale: f64,
        now_ms: f64,
        captured_ms: f64,
    ) -> Result<Option<Vec<u8>>> {
        if now_ms < self.next_ms {
            return Ok(None);
        }
        if !scale.is_finite() || scale <= 0.0 {
            return Err(Error::new(Code::Bounds, "Invalid scale"));
        }
        let mut dirty = self.tiles.changed(rgb, width, height)?;
        let metadata = (width, height, scale);
        if self.metadata != Some(metadata) && dirty.is_empty() {
            dirty.push(Bounds {
                x: 0.0,
                y: 0.0,
                w: width as f64,
                h: height as f64,
            });
        }
        if dirty.is_empty() {
            // Bound duplicate-event hashing to requested fps as well as encoded frames.
            self.next_ms = now_ms + 1000.0 / self.fps as f64;
            return Ok(None);
        }
        let payload = jpeg(rgb, width, height)?;
        let header = Header {
            version: self.version,
            session_id: self.session.clone(),
            seq: self.seq,
            capture_generation: (self.version == 2).then_some(self.generation),
            ts: captured_ms,
            width,
            height,
            scale,
            codec: "jpeg".into(),
            keyframe: None,
            video_codec: None,
            bytes: payload.len(),
            dirty_rects: Some(dirty),
        };
        let bytes = packet(&header, &payload)?;
        self.metadata = Some(metadata);
        self.seq += 1;
        self.next_ms = now_ms + 1000.0 / self.fps as f64;
        Ok(Some(bytes))
    }
}

/// When a frame was captured, on the stream's clock (Unix epoch milliseconds). `frame_100ns`
/// is the frame's SystemRelativeTime and `now_100ns` the same counter read at `now_ms`; both
/// are the performance counter in 100 ns units. The result never runs ahead of `now_ms` and
/// never goes back before `floor_ms` (the previous frame), so timestamps stay ordered.
pub fn captured_at(now_ms: f64, now_100ns: i64, frame_100ns: i64, floor_ms: f64) -> f64 {
    let age_ms = (now_100ns.saturating_sub(frame_100ns)).max(0) as f64 / 10_000.0;
    (now_ms - age_ms).max(floor_ms).min(now_ms)
}

#[cfg(test)]
mod captured {
    use super::captured_at;

    #[test]
    fn a_frame_is_stamped_when_it_was_captured_not_when_it_was_read() {
        // Captured 12.5 ms before the readback finished.
        assert_eq!(captured_at(1_000.0, 500_000, 375_000, 0.0), 987.5);
    }

    #[test]
    fn stamps_never_run_ahead_or_backwards() {
        assert_eq!(captured_at(1_000.0, 100, 200, 0.0), 1_000.0);
        assert_eq!(captured_at(1_000.0, 50_000_000, 0, 990.0), 990.0);
    }
}

#[cfg(test)]
mod video {
    use super::*;

    fn settings(codec: StreamCodec, fps: u32) -> StreamSettings {
        StreamSettings {
            codec,
            max_width: 1920,
            max_height: 1080,
            fps,
            bitrate: 4_000_000,
        }
    }

    fn header(packet: &[u8]) -> serde_json::Value {
        let size = u32::from_be_bytes(packet[..4].try_into().unwrap()) as usize;
        serde_json::from_slice(&packet[4..4 + size]).unwrap()
    }

    #[test]
    fn turning_video_on_asks_for_a_keyframe_and_paces_at_the_video_rate() {
        let mut stream = Stream::new("s".into(), 2, 10);
        stream.configure(settings(StreamCodec::H264, 60), Some(Epoch::unsaid(4)), 0);
        assert!(stream.take_keyframe());
        assert!(!stream.take_keyframe());
        assert_eq!(stream.epoch_at(CaptureTime::exact(0)), 4);
        assert!(stream.video_due(0.0));
        assert!(!stream.video_due(10.0));
        assert_eq!(stream.due_in(10.0), 1000.0 / 60.0 - 10.0);
        assert!(stream.video_due(17.0));
        // Reconfiguring while video is on keeps the stream going without a forced keyframe.
        stream.configure(settings(StreamCodec::H264, 30), None, 10);
        assert!(!stream.take_keyframe());
        assert_eq!(stream.epoch_at(CaptureTime::exact(10)), 4);
        stream.configure(settings(StreamCodec::Jpeg, 60), None, 20);
        assert_eq!(stream.video(), None);
        assert!(!stream.video_due(1000.0));
    }

    #[test]
    fn video_units_and_stills_share_one_sequence() {
        let mut stream = Stream::new("s".into(), 2, 10);
        assert!(stream.frame(&[0; 12], 2, 2, 1.0, 0.0).unwrap().is_some());
        assert_eq!(stream.next_sequence(), 1);
        stream.request_image();
        assert_eq!(stream.due_in(5.0), 0.0);
        assert!(stream.take_image());
        let still = stream.frame(&[0; 12], 2, 2, 1.0, 200.0).unwrap().unwrap();
        assert_eq!(header(&still)["seq"], 2);
    }
}

#[cfg(test)]
mod epochs {
    use super::*;

    fn settings() -> StreamSettings {
        StreamSettings {
            codec: StreamCodec::H264,
            max_width: 1920,
            max_height: 1080,
            fps: 60,
            bitrate: 4_000_000,
        }
    }
    const PRIVATE: bool = true;
    const CLEAR: bool = false;

    /// Epoch 4 from tick 100, then epoch 5 from tick 300 (raw QPC ticks).
    fn switched(from: bool, to: bool) -> Stream {
        let mut stream = Stream::new("s".into(), 2, 10);
        stream.configure(
            settings(),
            Some(Epoch {
                id: 4,
                private: from,
            }),
            100,
        );
        stream.configure(settings(), Some(Epoch { id: 5, private: to }), 300);
        stream
    }

    #[test]
    fn private_to_clear_a_tie_at_the_switch_stays_private() {
        let stream = switched(PRIVATE, CLEAR);
        assert_eq!(
            stream.epoch_at(CaptureTime::exact(299)),
            4,
            "one tick before"
        );
        assert_eq!(
            stream.epoch_at(CaptureTime::exact(300)),
            4,
            "exactly at: private wins"
        );
        assert_eq!(stream.epoch_at(CaptureTime::exact(301)), 5, "just after");
    }

    #[test]
    fn clear_to_private_a_tie_at_the_switch_is_already_private() {
        let stream = switched(CLEAR, PRIVATE);
        assert_eq!(
            stream.epoch_at(CaptureTime::exact(299)),
            4,
            "one tick before"
        );
        assert_eq!(
            stream.epoch_at(CaptureTime::exact(300)),
            5,
            "exactly at: private wins"
        );
        assert_eq!(stream.epoch_at(CaptureTime::exact(301)), 5, "just after");
    }

    #[test]
    fn a_rounded_timestamp_that_may_fall_either_side_of_a_switch_to_clear_stays_private() {
        // A 24 MHz counter: one 100 ns unit spans 2.4 ticks, so frame time 125 (100 ns) is any
        // tick from 300 to 302, and the switch to clear at tick 301 may come after it.
        let mut stream = Stream::new("s".into(), 2, 10);
        stream.configure(
            settings(),
            Some(Epoch {
                id: 4,
                private: PRIVATE,
            }),
            100,
        );
        stream.configure(
            settings(),
            Some(Epoch {
                id: 5,
                private: CLEAR,
            }),
            301,
        );
        let frame = CaptureTime::from_100ns(125, 24_000_000);
        assert_eq!((frame.first, frame.last), (300, 302));
        assert_eq!(stream.epoch_at(frame), 4);
        assert_eq!(stream.epoch_at(CaptureTime::from_100ns(126, 24_000_000)), 5);
    }

    #[test]
    fn a_frame_delivered_long_after_a_switch_keeps_the_epoch_of_its_capture() {
        let stream = switched(PRIVATE, CLEAR);
        assert_eq!(stream.epoch_at(CaptureTime::exact(250)), 4);
        assert_eq!(stream.epoch_at(CaptureTime::exact(1_000)), 5);
        // Before any epoch was given: 0, as on the Mac.
        assert_eq!(stream.epoch_at(CaptureTime::exact(50)), 0);
    }

    #[test]
    fn an_epoch_whose_privacy_is_not_said_counts_as_private() {
        let mut stream = Stream::new("s".into(), 2, 10);
        stream.configure(settings(), Some(Epoch::unsaid(4)), 100);
        stream.configure(
            settings(),
            Some(Epoch {
                id: 5,
                private: CLEAR,
            }),
            300,
        );
        assert_eq!(stream.epoch_at(CaptureTime::exact(300)), 4);
    }

    #[test]
    fn a_configure_without_an_epoch_keeps_the_last_one() {
        let mut stream = Stream::new("s".into(), 2, 10);
        stream.configure(
            settings(),
            Some(Epoch {
                id: 9,
                private: CLEAR,
            }),
            100,
        );
        stream.configure(settings(), None, 500);
        assert_eq!(stream.epoch_at(CaptureTime::exact(600)), 9);
    }
}

//! A capture's live video: what `stream.configure` asked for, the epoch pictures are stamped
//! with when they arrive, the encoder (opened on the capture thread, which GL needs), and each
//! unit handed to a sink in order with its picture's capture time, scale and epoch.
use super::encoder::{Captured, ScreenEncoder};
use super::ingest::Clock;
use super::select::Capture;
use super::stream::StreamSettings;
use media_codec::CodecError;
use media_ingest::VideoUnit;
use media_ingest::epochs::{CaptureTime, Epoch, EpochLedger};
use media_wire::capability::Backend;
use std::collections::VecDeque;
use std::sync::{
    Mutex,
    atomic::{AtomicBool, Ordering},
};

/// Encode failures in a row after which the stream gives up on video and sends stills.
const MAX_FAILURES: u32 = 3;
/// Pictures whose units haven't come back yet, remembered for their stamps.
const MAX_IN_FLIGHT: usize = 16;

/// Shortest time between forced keyframes, as ace-media's own rule (`media-core::keyframes`).
pub const KEY_INTERVAL_US: u64 = 500_000;

#[derive(Default)]
struct KeyPacing {
    owed: bool,
    last: Option<u64>,
}

/// What the runtime tells the capture thread about video, and what it reports back.
#[derive(Default)]
pub struct StreamControl {
    settings: Mutex<Option<StreamSettings>>,
    /// Epoch applications on the capture clock (µs since the helper started): each picture
    /// takes the one in force when it arrived, with ties to private (`media_ingest::epochs`).
    epochs: Mutex<EpochLedger>,
    /// Forced keyframes: requests coalesce while one is owed, and one is granted at most every
    /// [`KEY_INTERVAL_US`] on the capture clock, however many parts of the helper ask.
    key: Mutex<KeyPacing>,
    still: AtomicBool,
    running: Mutex<Running>,
}

/// What the stream runs on, for the `stream.configure` reply.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Running {
    pub backend: Option<Backend>,
    pub capture: Option<Capture>,
    /// Video was given up on here: the encoder failed. Stills continue.
    pub failed: Option<String>,
}

impl StreamControl {
    pub fn set(&self, settings: StreamSettings) {
        if let Ok(mut s) = self.settings.lock() {
            *s = Some(settings);
        }
    }
    pub fn settings(&self) -> Option<StreamSettings> {
        self.settings.lock().ok().and_then(|s| s.clone())
    }
    /// `epoch` applies from `at_us` on the capture clock.
    pub fn apply_epoch(&self, at_us: u64, epoch: Epoch) {
        if let Ok(mut epochs) = self.epochs.lock() {
            epochs.apply(at_us as i64, epoch);
        }
    }
    /// The epoch of a picture that arrived at `arrived_us` on the capture clock. Arrivals are
    /// resolved once each, in order, so nothing older will be asked about again: the ledger
    /// forgets what only an older one could need. With the ledger unreadable (a poisoned lock),
    /// 0, a placeholder that is never a clear epoch.
    pub fn resolve_arrival(&self, arrived_us: u64) -> u32 {
        self.epochs.lock().map_or(0, |mut epochs| {
            let epoch = epochs.epoch_at(CaptureTime::exact(arrived_us as i64));
            epochs.forget_before(arrived_us as i64);
            epoch
        })
    }
    pub fn want_key(&self) {
        if let Ok(mut key) = self.key.lock() {
            key.owed = true;
        }
    }
    pub fn key_owed(&self) -> bool {
        self.key.lock().is_ok_and(|key| key.owed)
    }
    /// When an owed keyframe may be forced, in µs from `now_us`: 0 now, `None` if none is owed.
    pub fn key_due_in(&self, now_us: u64) -> Option<u64> {
        let key = self.key.lock().ok()?;
        key.owed.then(|| {
            key.last
                .map_or(0, |last| (last + KEY_INTERVAL_US).saturating_sub(now_us))
        })
    }
    /// Takes the owed keyframe at `now_us` on the capture clock, if it may be forced now; an
    /// earlier request stays owed until the interval since the last one has passed.
    pub fn take_key(&self, now_us: u64) -> bool {
        let Ok(mut key) = self.key.lock() else {
            return false;
        };
        let due = key.owed && key.last.is_none_or(|last| now_us >= last + KEY_INTERVAL_US);
        if due {
            key.owed = false;
            key.last = Some(now_us);
        }
        due
    }
    pub fn want_still(&self) {
        self.still.store(true, Ordering::Release);
    }
    pub fn still_owed(&self) -> bool {
        self.still.load(Ordering::Acquire)
    }
    pub fn take_still(&self) -> bool {
        self.still.swap(false, Ordering::AcqRel)
    }
    pub fn running(&self) -> Running {
        self.running.lock().map(|r| r.clone()).unwrap_or_default()
    }
    fn report(&self, update: impl FnOnce(&mut Running)) {
        if let Ok(mut running) = self.running.lock() {
            update(&mut running);
        }
    }
}

/// Where units go: the route, which sends each to the daemon's socket or ace-media's ingest.
/// `false` when the unit was dropped: the next one should be a keyframe.
pub trait VideoSink: Send {
    fn unit(&mut self, unit: VideoUnit) -> bool;
    /// The frame sequence the next unit takes, shared with stills.
    fn next_sequence(&mut self) -> u64;
}

/// A picture handed to the encoder, kept until its unit comes back.
#[derive(Clone, Copy, Debug)]
pub struct Stamp {
    pub pts_us: u64,
    pub timestamp: f64,
    pub scale: f64,
    pub epoch: u32,
}

pub struct Video {
    pub control: std::sync::Arc<StreamControl>,
    choice: Option<(Backend, Option<media_chrome::ChromeOptions>)>,
    encoder: Option<ScreenEncoder>,
    failures: u32,
    given_up: bool,
    in_flight: VecDeque<Stamp>,
    sink: Box<dyn VideoSink>,
    clock: Clock,
    last_pts: u64,
}

impl Video {
    pub fn new(
        control: std::sync::Arc<StreamControl>,
        choice: Option<(Backend, Option<media_chrome::ChromeOptions>)>,
        sink: Box<dyn VideoSink>,
        clock: Clock,
    ) -> Self {
        Self {
            control,
            choice,
            encoder: None,
            failures: 0,
            given_up: false,
            in_flight: VecDeque::new(),
            sink,
            clock,
            last_pts: 0,
        }
    }

    /// The helper's monotonic microseconds: pictures' capture times, on the route's clock.
    pub fn now_us(&self) -> u64 {
        self.clock.us()
    }

    /// A strictly increasing presentation time for a picture captured at `captured_us`.
    pub fn pts(&mut self, captured_us: u64) -> u64 {
        self.last_pts = captured_us.max(self.last_pts + 1);
        self.last_pts
    }

    /// Opens the encoder now when it imports DMA-BUFs, so the stream can offer them. Must run
    /// on the capture thread. Returns whether DMA-BUFs should be offered.
    pub fn open_for_dmabuf(&mut self) -> bool {
        let Some((backend, _)) = &self.choice else {
            return false;
        };
        if !matches!(backend, Backend::Vaapi | Backend::Nv) {
            return false;
        }
        self.open().is_ok_and(|e| e.imports_dmabuf())
    }

    fn open(&mut self) -> Result<&mut ScreenEncoder, CodecError> {
        if self.encoder.is_none() {
            let (backend, chrome) = self
                .choice
                .clone()
                .ok_or_else(|| CodecError::Unsupported("no encoder here".into()))?;
            match ScreenEncoder::open(backend, chrome) {
                Ok(encoder) => {
                    self.control.report(|r| r.backend = Some(backend));
                    self.encoder = Some(encoder);
                }
                Err(error) => {
                    self.give_up(&error);
                    return Err(error);
                }
            }
        }
        self.encoder.as_mut().ok_or(CodecError::NotConfigured)
    }

    fn give_up(&mut self, error: &CodecError) {
        eprintln!("screen video: {error}; sending stills instead");
        self.given_up = true;
        let reason = error.to_string();
        self.control.report(|r| r.failed = Some(reason));
    }

    /// The settings to encode under now: video asked for, someone watching, an encoder here.
    pub fn active(&self, watching: bool) -> Option<StreamSettings> {
        if !watching || self.given_up || self.choice.is_none() {
            return None;
        }
        self.control.settings().filter(StreamSettings::video)
    }

    /// The encoder this stream opens, if there is one.
    pub fn backend(&self) -> Option<Backend> {
        self.choice.as_ref().map(|(backend, _)| *backend)
    }

    /// Takes the keyframe request, if any.
    pub fn take_key(&self) -> bool {
        self.control.take_key(self.now_us())
    }

    /// Encodes one picture. A DMA-BUF the encoder couldn't import returns `Err`, for the
    /// capture to fall back to shared memory.
    pub fn encode(
        &mut self,
        picture: &Captured<'_>,
        settings: &StreamSettings,
        stamp: Stamp,
        key: bool,
    ) -> Result<(), CodecError> {
        self.control.report(|r| r.capture = Some(picture.capture()));
        let encoder = self.open()?;
        match encoder.encode(picture, settings, key) {
            Ok(()) => {
                self.failures = 0;
                if self.in_flight.len() == MAX_IN_FLIGHT {
                    self.in_flight.pop_front();
                }
                self.in_flight.push_back(stamp);
                Ok(())
            }
            Err(CodecError::Backpressure) => {
                // Skipped: the next picture carries the keyframe if one was owed.
                if key {
                    self.control.want_key();
                }
                Ok(())
            }
            Err(error) => {
                self.control.want_key();
                self.failures += 1;
                if self.failures >= MAX_FAILURES {
                    self.give_up(&error);
                    if let Some(encoder) = self.encoder.take() {
                        encoder.close();
                    }
                }
                Err(error)
            }
        }
    }

    /// A still from a DMA-BUF picture: one readback through the encoder's device.
    pub fn read_back(&mut self, picture: &Captured<'_>) -> Option<(media_codec::CpuPicture, bool)> {
        self.encoder.as_mut()?.read_back(picture)
    }

    /// Whether units may still come back without a new picture.
    pub fn waiting(&self) -> bool {
        !self.in_flight.is_empty()
            && self
                .encoder
                .as_ref()
                .is_some_and(ScreenEncoder::asynchronous)
    }

    /// Hands every unit that is out to the sink, stamped with its picture's stamp.
    pub fn drain(&mut self) {
        loop {
            let output = match self.encoder.as_mut().map(ScreenEncoder::poll) {
                Some(Ok(Some(output))) => output,
                Some(Err(error)) => {
                    eprintln!("screen video: {error}");
                    self.control.want_key();
                    return;
                }
                _ => return,
            };
            while self
                .in_flight
                .front()
                .is_some_and(|s| s.pts_us < output.pts_us)
            {
                self.in_flight.pop_front();
            }
            let Some(stamp) = self
                .in_flight
                .front()
                .copied()
                .filter(|s| s.pts_us == output.pts_us)
            else {
                continue;
            };
            self.in_flight.pop_front();
            let unit = VideoUnit {
                sequence: self.sink.next_sequence(),
                timestamp_ms: stamp.timestamp,
                scale: stamp.scale,
                width: output.size.width,
                height: output.size.height,
                key: output.key,
                codec: output.codec,
                epoch: stamp.epoch,
                captured_us: stamp.pts_us,
                payload: output.data,
            };
            if !self.sink.unit(unit) {
                self.control.want_key();
            }
        }
    }

    pub fn close(&mut self) {
        if let Some(encoder) = self.encoder.take() {
            encoder.close();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::StreamControl;
    use media_ingest::epochs::Epoch;

    #[test]
    fn an_arrival_takes_the_epoch_in_force_when_it_arrived_and_a_tie_at_a_switch_to_clear_stays_private()
     {
        let control = StreamControl::default();
        // On the capture clock (µs): private epoch 4 from 100, clear epoch 5 from 300.
        control.apply_epoch(
            100,
            Epoch {
                id: 4,
                private: true,
            },
        );
        control.apply_epoch(
            300,
            Epoch {
                id: 5,
                private: false,
            },
        );
        assert_eq!(control.resolve_arrival(299), 4, "one tick before");
        assert_eq!(control.resolve_arrival(300), 4, "exactly at: private wins");
        assert_eq!(control.resolve_arrival(301), 5, "just after");
    }

    #[test]
    fn an_arrival_read_after_a_later_switch_still_takes_its_own_epoch() {
        let control = StreamControl::default();
        control.apply_epoch(
            100,
            Epoch {
                id: 4,
                private: true,
            },
        );
        // The picture arrived at 250; the switch to clear came at 300, before it was looked up.
        control.apply_epoch(
            300,
            Epoch {
                id: 5,
                private: false,
            },
        );
        assert_eq!(control.resolve_arrival(250), 4);
    }

    #[test]
    fn an_arrival_resolved_after_a_hundred_switches_keeps_its_private_epoch() {
        let control = StreamControl::default();
        for n in 0..101u32 {
            let id = n + 1;
            control.apply_epoch(
                10 + u64::from(n) * 10,
                Epoch {
                    id,
                    private: id % 2 == 1,
                },
            );
        }
        // Arrived at 15, under private epoch 1, looked up after every switch.
        assert_eq!(control.resolve_arrival(15), 1);
        // Later arrivals resolve exactly; history before them is no longer kept.
        assert_eq!(control.resolve_arrival(1_005), 100);
        assert_eq!(control.resolve_arrival(1_006), 100);
    }

    #[test]
    fn a_delayed_encoder_under_backpressure_forces_at_most_one_keyframe_per_interval() {
        let control = StreamControl::default();
        // Two seconds on the capture clock: backpressure asks for a keyframe every millisecond
        // (the route, the daemon socket and the encoder's own skips all ask), and the capture
        // takes one whenever it may.
        let mut forced = Vec::new();
        for ms in 0..2_000u64 {
            control.want_key();
            if control.take_key(ms * 1_000) {
                forced.push(ms);
            }
        }
        assert_eq!(
            forced,
            [0, 500, 1_000, 1_500],
            "one forced keyframe per 500 ms, at most"
        );
        // A request made between them is kept, not lost: it comes due at the interval.
        assert!(control.key_owed());
        assert!(!control.take_key(1_999_000));
        assert!(control.take_key(2_000_000));
        assert!(!control.key_owed());
    }

    #[test]
    fn requests_while_one_is_owed_coalesce_into_one_keyframe() {
        let control = StreamControl::default();
        for _ in 0..10 {
            control.want_key();
        }
        assert!(control.take_key(0));
        assert!(
            !control.take_key(600_000),
            "nothing more was asked after it"
        );
    }
}

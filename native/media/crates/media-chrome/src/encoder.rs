// SPDX-License-Identifier: Apache-2.0
//! `ChromeEncoder`: media-codec's `Encoder` on a supervised headless Chrome. Chrome starts with
//! the first configuration. If it crashes or is killed, the next picture starts another one,
//! configures it the same way and is encoded as a keyframe, so the stream resumes decodable.
//!
//! - **Bounded restarts.** Browsers that exit before a chunk comes out and launches that fail
//!   both count; a failed launch is retried after a doubling backoff (pictures meanwhile get
//!   `Backpressure`). Past `max_restarts` the encoder has given up for good: every call returns
//!   the same error, and the owner makes a new encoder if it wants to try again.
//! - **Errors from `poll_result`.** A browser that died and a page whose encoder failed are each
//!   reported once, after every chunk that did come out. They are not fatal: the next picture
//!   starts a new browser or configures a new page encoder, and is encoded as a keyframe.

use crate::session::{Event, Session};
use crate::wire::{Command, Notice, PictureHeader, picture_format, picture_message};
use crate::{ChromeOptions, h264_codec_string};
use media_codec::{
    BitstreamFormat, Codec, CodecError, EncodeSpec, EncodedUnit, Encoder, EncoderCaps, Picture,
    RateControl, Size,
};
use std::collections::VecDeque;
use std::time::{Duration, Instant};

/// Pictures sent to the page whose chunks haven't come back. More is refused as backpressure:
/// a software encoder that falls behind should drop at the source, not queue.
pub const MAX_IN_FLIGHT: usize = 3;
/// The largest picture Chrome's software H.264 encoder takes on either side.
pub const MAX_SIDE: u32 = 4096;

pub struct ChromeEncoder {
    options: ChromeOptions,
    session: Option<Session>,
    spec: Option<EncodeSpec>,
    /// Bumped per configuration sent; chunks carry the one they were encoded under.
    generation: u32,
    /// Specs by generation, for chunks still coming out of an older configuration.
    specs: VecDeque<(u32, EncodeSpec)>,
    sequence: u32,
    in_flight: usize,
    key_owed: bool,
    description: Option<Vec<u8>>,
    output: VecDeque<EncodedUnit>,
    /// The page's encoder failed: the next picture configures a new one.
    reconfigure: bool,
    /// An error for `poll_result` to report once.
    report: Option<CodecError>,
    /// The current browser's death was reported.
    death_reported: bool,
    /// Set once the restart budget is spent; returned by every call after.
    given_up: Option<CodecError>,
    /// No relaunch before this, after a failed one.
    retry_at: Option<Instant>,
    /// Browser deaths and failed launches since the last chunk.
    restarts_without_output: u32,
    restarts: u64,
    quantizer: bool,
    message: Vec<u8>,
}

impl ChromeEncoder {
    /// Nothing starts until the first `configure`.
    pub fn new(options: ChromeOptions) -> Self {
        Self {
            options,
            session: None,
            spec: None,
            generation: 0,
            specs: VecDeque::new(),
            sequence: 0,
            in_flight: 0,
            key_owed: true,
            description: None,
            output: VecDeque::new(),
            reconfigure: false,
            report: None,
            death_reported: false,
            given_up: None,
            retry_at: None,
            restarts_without_output: 0,
            restarts: 0,
            quantizer: false,
            message: Vec::new(),
        }
    }

    /// The running browser's process id, if one is running.
    pub fn browser_pid(&self) -> Option<u32> {
        self.session.as_ref().map(Session::pid)
    }

    /// How many times a crashed browser was replaced.
    pub fn restarts(&self) -> u64 {
        self.restarts
    }

    fn session(&mut self) -> Result<&mut Session, CodecError> {
        if let Some(error) = &self.given_up {
            return Err(error.clone());
        }
        if self
            .session
            .as_ref()
            .is_some_and(|session| !session.alive())
        {
            if !self.death_reported
                && let Some(session) = &self.session
            {
                // Found by a picture before poll_result saw it: still reported, once.
                self.report = Some(CodecError::Backend(format!(
                    "{}; a new browser took over at a keyframe",
                    session.end_reason()
                )));
            }
            // Dropping it closes what is left of the old browser's tree.
            self.session = None;
            self.restarts += 1;
            self.restarts_without_output += 1;
            // Chunks of the old browser are gone with it.
            self.in_flight = 0;
        }
        if self.session.is_none() {
            if self.restarts_without_output > self.options.max_restarts {
                return Err(self.give_up("Chrome keeps exiting before it encodes".into()));
            }
            if self.retry_at.is_some_and(|at| Instant::now() < at) {
                return Err(CodecError::Backpressure);
            }
            match Session::start(&self.options) {
                Ok(session) => {
                    self.retry_at = None;
                    self.quantizer = session.quantizer;
                    self.in_flight = 0;
                    self.death_reported = false;
                    self.reconfigure = false;
                    self.key_owed = true;
                    self.session = Some(session);
                }
                Err(error) => {
                    self.restarts_without_output += 1;
                    if self.restarts_without_output > self.options.max_restarts {
                        return Err(self.give_up(format!("Chrome keeps failing to start: {error}")));
                    }
                    let doublings = (self.restarts_without_output - 1).min(5);
                    let wait = (self.options.restart_backoff * (1u32 << doublings))
                        .min(Duration::from_secs(2));
                    self.retry_at = Some(Instant::now() + wait);
                    return Err(error);
                }
            }
            if let Some(spec) = self.spec.clone() {
                self.send_configure(&spec)?;
            }
        }
        self.session
            .as_mut()
            .ok_or_else(|| CodecError::Backend("no browser".into()))
    }

    fn give_up(&mut self, reason: String) -> CodecError {
        let error = CodecError::Backend(reason);
        self.given_up = Some(error.clone());
        self.session = None;
        error
    }

    /// Sends a configuration and waits for the page's answer; chunks arriving meanwhile are kept.
    fn send_configure(&mut self, spec: &EncodeSpec) -> Result<(), CodecError> {
        let generation = self.generation.wrapping_add(1);
        let quantizer = matches!(spec.rate, RateControl::Quantizer(_));
        let command = Command::Configure {
            generation,
            codec: h264_codec_string(spec.size, spec.fps),
            width: spec.size.width,
            height: spec.size.height,
            fps: spec.fps,
            bitrate: match spec.rate {
                RateControl::Bitrate(bits) => Some(bits),
                RateControl::Quantizer(_) => None,
            },
            quantizer,
        };
        let deadline = Instant::now() + self.options.reply_timeout;
        let session = self
            .session
            .as_mut()
            .ok_or_else(|| CodecError::Backend("no browser".into()))?;
        session.command(&command)?;
        loop {
            let event = self
                .session
                .as_ref()
                .and_then(|session| session.event_until(deadline));
            match event {
                Some(Event::Notice(Notice::Configured {
                    generation: answered,
                    ok,
                    reason,
                })) if answered == generation => {
                    if !ok {
                        return Err(CodecError::Unsupported(
                            reason.unwrap_or_else(|| "Chrome refused the configuration".into()),
                        ));
                    }
                    self.generation = generation;
                    self.specs.push_back((generation, spec.clone()));
                    while self.specs.len() > 4 {
                        self.specs.pop_front();
                    }
                    return Ok(());
                }
                Some(event) => self.take(event),
                None if self.session.as_ref().is_some_and(Session::alive) => {
                    return Err(CodecError::DeadlineExceeded);
                }
                None => {
                    return Err(CodecError::Backend(
                        "Chrome exited while configuring".into(),
                    ));
                }
            }
        }
    }

    fn take(&mut self, event: Event) {
        match event {
            Event::Chunk(chunk) => {
                self.in_flight = self.in_flight.saturating_sub(1);
                self.restarts_without_output = 0;
                let Some((_, spec)) = self.specs.iter().find(|(g, _)| *g == chunk.generation)
                else {
                    return;
                };
                if chunk.description.is_some() {
                    self.description = chunk.description;
                }
                self.output.push_back(EncodedUnit {
                    codec: Codec::H264,
                    size: spec.size,
                    format: BitstreamFormat::Avcc,
                    data: chunk.data,
                    key: chunk.key,
                    description: if chunk.key {
                        self.description.clone()
                    } else {
                        None
                    },
                    pts_us: chunk.timestamp_us,
                    duration_us: 1_000_000 / u64::from(spec.fps),
                });
            }
            Event::Notice(Notice::Dropped { .. }) => {
                self.in_flight = self.in_flight.saturating_sub(1);
            }
            Event::Notice(Notice::Failed { generation, reason })
                if generation == self.generation =>
            {
                // The page's encoder is closed; the next picture configures a new one.
                self.report = Some(CodecError::Backend(format!(
                    "Chrome's encoder failed: {reason}; the next picture starts a new one at a keyframe"
                )));
                self.reconfigure = true;
                self.in_flight = 0;
                self.key_owed = true;
            }
            Event::Notice(_) => {}
        }
    }

    fn drain(&mut self) {
        while let Some(event) = self.session.as_ref().and_then(Session::try_event) {
            self.take(event);
        }
    }
}

impl Encoder for ChromeEncoder {
    fn configure(&mut self, spec: &EncodeSpec) -> Result<(), CodecError> {
        if let Some(error) = &self.given_up {
            return Err(error.clone());
        }
        spec.validate()?;
        if spec.codec != Codec::H264 {
            return Err(CodecError::Unsupported(
                "the Chrome encoder writes H.264 only".into(),
            ));
        }
        if spec.size.width > MAX_SIDE || spec.size.height > MAX_SIDE {
            return Err(CodecError::Unsupported(
                "picture too large for Chrome".into(),
            ));
        }
        let stream_changes = self
            .spec
            .as_ref()
            .is_none_or(|old| old.size != spec.size || old.codec != spec.codec);
        let mode_changes = self.spec.as_ref().is_none_or(|old| {
            matches!(old.rate, RateControl::Quantizer(_))
                != matches!(spec.rate, RateControl::Quantizer(_))
                || old.fps != spec.fps
        });
        let quantizer_only =
            !stream_changes && !mode_changes && matches!(spec.rate, RateControl::Quantizer(_));
        if self.session.is_some() && quantizer_only {
            // Every picture carries its own quantizer: nothing to tell the page.
            self.spec = Some(spec.clone());
            return Ok(());
        }
        let fresh = self.session.as_ref().is_none_or(|session| !session.alive());
        if fresh {
            // Starting a browser configures it from `self.spec`; keep the old one on failure.
            let previous = self.spec.replace(spec.clone());
            if let Err(error) = self.session() {
                if previous.is_some() && self.session.is_some() {
                    // A new browser with no encoder: the next picture configures the old spec.
                    self.reconfigure = true;
                }
                self.spec = previous;
                return Err(error);
            }
        } else {
            self.send_configure(spec)?;
            self.spec = Some(spec.clone());
        }
        if stream_changes {
            self.key_owed = true;
        }
        Ok(())
    }

    fn encode(&mut self, picture: Picture, force_key: bool) -> Result<(), CodecError> {
        let spec = self.spec.clone().ok_or(CodecError::NotConfigured)?;
        if picture.size() != spec.size {
            return Err(CodecError::InvalidInput(
                "picture size differs from encode size".into(),
            ));
        }
        let format = picture_format(&picture)?;
        self.drain();
        // Starts a browser (configured from `self.spec`) if there is none or it died.
        self.session()?;
        if self.reconfigure {
            self.send_configure(&spec)?;
            self.reconfigure = false;
            self.key_owed = true;
        }
        if self.in_flight >= MAX_IN_FLIGHT {
            return Err(CodecError::Backpressure);
        }
        let key = force_key || self.key_owed;
        self.sequence = self.sequence.wrapping_add(1);
        let header = PictureHeader {
            format,
            key,
            quantizer: match spec.rate {
                RateControl::Quantizer(q) => Some(q),
                RateControl::Bitrate(_) => None,
            },
            sequence: self.sequence,
            generation: self.generation,
            size: spec.size,
            timestamp_us: picture.pts_us(),
        };
        let mut message = std::mem::take(&mut self.message);
        picture_message(&picture, header, &mut message)?;
        drop(picture);
        let sent = self.session()?.picture(message);
        if let Err(error) = sent {
            // A browser that died mid-send: the next picture restarts it at a keyframe.
            self.key_owed = true;
            return Err(error);
        }
        self.in_flight += 1;
        self.key_owed = false;
        Ok(())
    }

    fn poll(&mut self) -> Option<EncodedUnit> {
        self.drain();
        self.output.pop_front()
    }

    fn poll_result(&mut self) -> Result<Option<EncodedUnit>, CodecError> {
        self.drain();
        if let Some(unit) = self.output.pop_front() {
            return Ok(Some(unit));
        }
        if let Some(error) = &self.given_up {
            return Err(error.clone());
        }
        if let Some(session) = &self.session
            && !session.alive()
            && !self.death_reported
        {
            self.death_reported = true;
            return Err(CodecError::Backend(format!(
                "{}; the next picture starts a new browser at a keyframe",
                session.end_reason()
            )));
        }
        match self.report.take() {
            Some(error) => Err(error),
            None => Ok(None),
        }
    }

    fn caps(&self) -> EncoderCaps {
        EncoderCaps {
            hardware: false,
            codecs: vec![Codec::H264],
            max_size: Size {
                width: MAX_SIDE,
                height: MAX_SIDE,
            },
            quantizer: self.quantizer,
        }
    }

    fn flush(&mut self) -> Result<(), CodecError> {
        if self.session.as_ref().is_none_or(|session| !session.alive()) {
            return Ok(());
        }
        let generation = self.generation;
        let deadline = Instant::now() + self.options.reply_timeout;
        self.session()?.command(&Command::Flush { generation })?;
        loop {
            match self.session.as_ref().and_then(|s| s.event_until(deadline)) {
                Some(Event::Notice(Notice::Flushed { generation: done })) if done == generation => {
                    return Ok(());
                }
                Some(event) => self.take(event),
                None => return Err(CodecError::DeadlineExceeded),
            }
        }
    }
}

//! What goes in and comes out of the live encoder, apart from Media Foundation itself: each
//! picture's capture metadata kept by its timestamp until its unit comes out, however late,
//! and output collected both when a picture goes in and on a timer of its own. A hardware MFT
//! may hand its keyframe back after `encode` returns, on a desktop that sends no new picture;
//! `service` is what fetches it then, and what runs the encoder's stall watchdog.
use crate::media::annexb::AnnexB;
use media_codec::{CodecError, Encoder, Picture};
use media_ingest::VideoUnit;
use std::collections::VecDeque;
use std::time::Duration;

/// How often owed output is looked for between pictures.
pub const SERVICE: Duration = Duration::from_millis(10);

/// What a picture carried into the encoder, found again by its timestamp on the way out.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Captured {
    pub captured_us: u64,
    pub timestamp_ms: f64,
    pub scale: f64,
    pub epoch: u32,
}

/// What servicing the encoder did.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Serviced {
    Kept,
    /// The watchdog replaced a stalled MFT: the pictures it held are gone.
    Replaced,
}

/// An encoder that can be serviced between pictures: collect late output, replace a stalled
/// MFT.
pub trait Live: Encoder {
    fn service(&mut self) -> Result<Serviced, CodecError>;
}

/// Units serviced out, and whether the caller must encode its current picture again with a
/// keyframe: the encoder threw away what it held, and a static screen sends nothing new.
#[derive(Debug, Default)]
pub struct Service {
    pub units: Vec<VideoUnit>,
    pub resend: bool,
}

pub struct Pump<E: Live> {
    encoder: E,
    annexb: AnnexB,
    in_flight: VecDeque<(u64, Captured)>,
    last_pts: u64,
}

impl<E: Live> Pump<E> {
    pub fn new(encoder: E) -> Self {
        Self {
            encoder,
            annexb: AnnexB::default(),
            in_flight: VecDeque::new(),
            last_pts: 0,
        }
    }

    pub fn encoder(&self) -> &E {
        &self.encoder
    }

    pub fn encoder_mut(&mut self) -> &mut E {
        &mut self.encoder
    }

    /// A new session starts with its own parameter sets.
    pub fn reset_stream(&mut self) {
        self.annexb.reset();
    }

    /// The timestamp the next picture should carry: strictly increasing, so each unit finds
    /// its picture again.
    pub fn next_pts(&mut self, captured_us: u64) -> u64 {
        let pts = captured_us.max(self.last_pts + 1);
        self.last_pts = pts;
        pts
    }

    /// Encodes one picture (stamped with a `next_pts` timestamp) and returns the units ready.
    /// A full encoder skips the picture.
    pub fn submit(
        &mut self,
        picture: Picture,
        captured: Captured,
        force_key: bool,
    ) -> Result<Vec<VideoUnit>, CodecError> {
        let pts = picture.pts_us();
        match self.encoder.encode(picture, force_key) {
            Ok(()) => {
                self.in_flight.push_back((pts, captured));
                while self.in_flight.len() > 32 {
                    self.in_flight.pop_front();
                }
            }
            Err(CodecError::Backpressure) => {}
            Err(error) => return Err(error),
        }
        self.collect()
    }

    /// Between pictures: late output and the watchdog. After a replacement nothing more is
    /// owed for the discarded pictures, and the caller is asked to resend its picture.
    pub fn service(&mut self) -> Result<Service, CodecError> {
        if self.in_flight.is_empty() {
            return Ok(Service::default());
        }
        let serviced = self.encoder.service()?;
        let units = self.collect()?;
        let resend = serviced == Serviced::Replaced;
        if resend {
            self.in_flight.clear();
        }
        Ok(Service { units, resend })
    }

    /// Pictures in the encoder whose units haven't come out.
    pub fn owed(&self) -> bool {
        !self.in_flight.is_empty()
    }

    fn collect(&mut self) -> Result<Vec<VideoUnit>, CodecError> {
        let mut units = Vec::new();
        while let Some(unit) = self.encoder.poll_result()? {
            // Pictures before this one were dropped by the MFT.
            while self
                .in_flight
                .front()
                .is_some_and(|(pts, _)| *pts < unit.pts_us)
            {
                self.in_flight.pop_front();
            }
            let Some((_, captured)) = self.in_flight.pop_front() else {
                continue;
            };
            let Some(converted) = self.annexb.convert(&unit) else {
                continue;
            };
            units.push(VideoUnit {
                sequence: 0,
                timestamp_ms: captured.timestamp_ms,
                scale: captured.scale,
                width: unit.size.width,
                height: unit.size.height,
                key: converted.key,
                codec: converted.codec,
                epoch: captured.epoch,
                captured_us: captured.captured_us,
                payload: converted.payload,
            });
        }
        Ok(units)
    }
}

#[cfg(test)]
#[path = "pump_tests.rs"]
mod tests;

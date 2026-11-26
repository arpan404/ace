// SPDX-License-Identifier: Apache-2.0
//! `simulator-jpeg.ts`: serve-sim's MJPEG stream, resized and re-compressed to an image budget:
//! agents' stills and recordings while nobody watches. Live views never get it; they take the
//! H.264 stream.
//!
//! serve-sim sends its picture several times a second even when the screen is still, and has no
//! way to send fewer. So while the capture is on stills (`deviceStillStream`) the stream stays
//! closed: a still opens it, takes the first picture that starts arriving after it asked (on a
//! new request, serve-sim's current screen) and closes it again. A recording keeps it open and
//! takes every picture, as before.
//!
//! HTTP is the capture's port: [`Action::OpenRequest`] and [`Action::AbortRequest`] are the
//! request and its cancellation, and the response, each body chunk, its end and its failure
//! come back as method calls. Nothing here blocks, allocates a runtime or reads a clock: the
//! events carry the time the frame gate schedules by.

mod actions;
mod links;
mod stills;

pub use actions::{ASK_LIMIT, Action, MULTIPART, Reason, STILL_TIMEOUT_MS};

use std::collections::HashMap;

use crate::platform::Error;

use super::mjpeg::{MjpegDecoder, is_valid_boundary};
use super::simulator_frames::{FrameSettings, Image, SimulatorFrames};

#[derive(Debug)]
struct Link {
    request: u64,
    decoder: Option<MjpegDecoder>,
}

#[derive(Debug, Clone, Copy)]
struct Ask {
    id: u64,
    request: u64,
    after: u32,
    still: u64,
}

#[derive(Debug)]
struct PendingConfigure {
    still: u64,
    request: u64,
    settings: FrameSettings,
}

/// serve-sim's MJPEG stream as a capture's stills and recordings. See the module docs.
#[derive(Debug)]
pub struct SimulatorJpeg {
    url: String,
    frames: SimulatorFrames,
    link: Option<Link>,
    streaming: bool,
    stopped: bool,
    asks: Vec<Ask>,
    /// Every still that has not settled, and whether it swallows a too-large picture
    /// (`configure`, as the TypeScript's catch does).
    stills: HashMap<u64, bool>,
    /// A frame-gate waiter and the still waiting for it.
    waiters: HashMap<u64, u64>,
    pending_configure: Option<PendingConfigure>,
    next_request: u64,
    next_ask: u64,
    next_still: u64,
}

impl SimulatorJpeg {
    pub fn new(url: &str, settings: FrameSettings) -> Self {
        Self {
            url: url.to_string(),
            frames: SimulatorFrames::new(settings),
            link: None,
            streaming: true,
            stopped: false,
            asks: Vec::new(),
            stills: HashMap::new(),
            waiters: HashMap::new(),
            pending_configure: None,
            next_request: 0,
            next_ask: 0,
            next_still: 0,
        }
    }

    /// Resolves once serve-sim has accepted the stream request.
    pub fn start(&mut self) -> (u64, Vec<Action>) {
        if let Some(link) = &self.link {
            return (
                link.request,
                vec![Action::AwaitRequest {
                    request: link.request,
                }],
            );
        }
        let request = self.next_request;
        self.next_request += 1;
        if self.stopped {
            return (
                request,
                vec![Action::RequestFailed {
                    request,
                    reason: Reason::text("Simulator stream stopped"),
                }],
            );
        }
        self.link = Some(Link {
            request,
            decoder: None,
        });
        (
            request,
            vec![Action::OpenRequest {
                request,
                url: self.url.clone(),
            }],
        )
    }

    /// Streams to the new settings, or idles on stills. The returned still settles once the
    /// settings are in force (and, streaming, the replay they ask for is answered).
    pub fn configure(&mut self, settings: FrameSettings, stills: bool) -> (u64, Vec<Action>) {
        let still = self.new_still(true);
        if stills {
            self.streaming = false;
            let idle = self.frames.idle(settings);
            let mut actions = self.map_frames(idle);
            if self.asks.is_empty() {
                actions.extend(self.close_link());
            }
            self.settle(still, Ok(()), &mut actions);
            return (still, actions);
        }
        let mut actions = Vec::new();
        if self.link.is_none() {
            // A picture kept from before the stream closed may be out of date: wait for a new one.
            self.frames.forget();
            self.streaming = true;
            let (request, opened) = self.start();
            actions.extend(opened);
            if self.link.is_some() {
                self.pending_configure = Some(PendingConfigure {
                    still,
                    request,
                    settings,
                });
            } else {
                self.settle(
                    still,
                    Err(Reason::text("Simulator stream stopped")),
                    &mut actions,
                );
            }
            return (still, actions);
        }
        self.streaming = true;
        self.start_configure(still, settings, &mut actions);
        (still, actions)
    }

    /// A still: the latest picture, or a new one while on stills.
    pub fn replay(&mut self) -> Result<(u64, Vec<Action>), Error> {
        if self.streaming {
            let still = self.new_still(false);
            let mut actions = Vec::new();
            match self.frames.replay() {
                Ok((replay, effects)) => {
                    actions.extend(self.map_replay(still, replay));
                    actions.extend(self.map_frames(effects));
                }
                Err(error) => {
                    self.settle(still, Err(Reason::text(&error.to_string())), &mut actions);
                }
            }
            return Ok((still, actions));
        }
        if self.asks.len() >= ASK_LIMIT {
            return Err(Error::Invalid("Simulator frame request limit".to_string()));
        }
        let still = self.new_still(false);
        let mut actions = Vec::new();
        let (request, opened) = self.start();
        actions.extend(opened);
        let Some(link) = &self.link else {
            self.settle(
                still,
                Err(Reason::text("Simulator stream stopped")),
                &mut actions,
            );
            return Ok((still, actions));
        };
        let ask = Ask {
            id: self.next_ask,
            request,
            after: link
                .decoder
                .as_ref()
                .map(MjpegDecoder::started)
                .unwrap_or(0),
            still,
        };
        self.next_ask += 1;
        self.asks.push(ask);
        actions.push(Action::ScheduleAsk {
            ask: ask.id,
            after_ms: STILL_TIMEOUT_MS,
        });
        Ok((still, actions))
    }

    /// serve-sim answered the request: its headers decide whether the stream can be read.
    pub fn response(&mut self, request: u64, ok: bool, content_type: Option<&str>) -> Vec<Action> {
        let current = self
            .link
            .as_ref()
            .is_some_and(|link| link.request == request);
        if !current {
            return vec![
                Action::AbortRequest { request },
                Action::RequestFailed {
                    request,
                    reason: Reason::text("Simulator stream closed"),
                },
            ];
        }
        let unavailable = || Reason::text("Simulator framebuffer stream unavailable");
        if !ok {
            return self.abandon(request, unavailable());
        }
        let Some(content_type) = content_type else {
            return self.abandon(request, unavailable());
        };
        if !content_type.starts_with(MULTIPART) {
            return self.abandon(request, unavailable());
        }
        let Some(boundary) = boundary_of(content_type) else {
            return self.abandon(
                request,
                Reason::text("Simulator multipart boundary unavailable"),
            );
        };
        let Ok(decoder) = MjpegDecoder::new(boundary) else {
            return self.abandon(
                request,
                Reason::text("Simulator multipart boundary unavailable"),
            );
        };
        let Some(link) = self.link.as_mut() else {
            return Vec::new();
        };
        link.decoder = Some(decoder);
        let mut actions = vec![Action::RequestReady { request }];
        if let Some(pending) = self.pending_configure.take()
            && pending.request == request
        {
            self.start_configure(pending.still, pending.settings, &mut actions);
        }
        actions
    }

    /// One body chunk arrived; every whole picture it completed is handed on.
    pub fn chunk(&mut self, request: u64, bytes: &[u8], now: f64) -> Vec<Action> {
        let current = self
            .link
            .as_ref()
            .is_some_and(|link| link.request == request);
        if !current {
            return Vec::new();
        }
        let Some(link) = self.link.as_mut() else {
            return Vec::new();
        };
        let Some(decoder) = link.decoder.as_mut() else {
            return Vec::new();
        };
        let mut pictures = Vec::new();
        let result = decoder.push(bytes, &mut pictures);
        let mut actions = Vec::new();
        // Every picture the chunk completed is this still's before a later part in the same
        // chunk can fail: the TypeScript emits each one as it completes.
        for frame in pictures {
            actions.extend(self.received(
                request,
                frame.image,
                frame.width,
                frame.height,
                frame.frame,
                now,
            ));
        }
        match result {
            Ok(()) => actions,
            Err(error) => {
                actions.extend(self.ended_with(request, Reason::text(&error.to_string())));
                actions
            }
        }
    }

    /// The body ended on its own.
    pub fn ended(&mut self, request: u64) -> Vec<Action> {
        self.ended_with(request, Reason::text("Simulator framebuffer stream ended"))
    }

    /// The body's reader failed.
    pub fn failed(&mut self, request: u64, message: &str) -> Vec<Action> {
        self.ended_with(request, Reason::text(message))
    }

    /// The still's time limit fired.
    pub fn timeout(&mut self, ask: u64) -> Vec<Action> {
        let Some(index) = self.asks.iter().position(|waiting| waiting.id == ask) else {
            return Vec::new();
        };
        let waiting = self.asks.remove(index);
        let mut actions = Vec::new();
        self.settle(
            waiting.still,
            Err(Reason::text("The Simulator sent no picture in time")),
            &mut actions,
        );
        // Nobody else waits on the request: close it, even if serve-sim never answered.
        if !self.streaming
            && !self
                .asks
                .iter()
                .any(|other| other.request == waiting.request)
        {
            actions.extend(self.close_link());
        }
        actions
    }

    /// Runs the frame gate's microtask.
    pub fn step(&mut self) -> Vec<Action> {
        let effects = self.frames.step();
        self.map_frames(effects)
    }

    /// The frame gate's rate timer fired.
    pub fn timer(&mut self, now: f64) -> Vec<Action> {
        let effects = self.frames.timer(now);
        self.map_frames(effects)
    }

    /// Stops the capture: the request is aborted, every still is told, and the frame gate
    /// settles its own.
    pub fn stop(&mut self) -> Vec<Action> {
        self.stopped = true;
        let mut actions = Vec::new();
        if let Some(link) = self.link.take() {
            actions.push(Action::AbortRequest {
                request: link.request,
            });
        }
        let asks = std::mem::take(&mut self.asks);
        for waiting in asks {
            actions.push(Action::CancelAsk { ask: waiting.id });
            self.settle(
                waiting.still,
                Err(Reason::text("Simulator stream stopped")),
                &mut actions,
            );
        }
        if let Some(pending) = self.pending_configure.take() {
            self.settle(
                pending.still,
                Err(Reason::text("Simulator stream stopped")),
                &mut actions,
            );
        }
        let effects = self.frames.stop();
        actions.extend(self.map_frames(effects));
        actions
    }
}

#[cfg(test)]
mod tests;

/// The boundary a multipart content type names, if it names a usable one.
fn boundary_of(content_type: &str) -> Option<&str> {
    for (at, _) in content_type.match_indices("boundary=") {
        let rest = &content_type[at + "boundary=".len()..];
        let end = rest.find(';').unwrap_or(rest.len());
        let value = &rest[..end];
        if is_valid_boundary(value) {
            return Some(value);
        }
    }
    None
}

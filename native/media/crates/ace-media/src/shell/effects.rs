// SPDX-License-Identifier: Apache-2.0
//! Carrying out the engine's effects, in order.
use super::pictures::Pictures;
use super::priority_gate::PriorityGate;
use super::readers::Readers;
use super::relay_sockets::RelaySockets;
use super::viewers::Outboxes;
use super::writer::Writer;
use crate::engine::delivery::MediaOut;
use crate::engine::relay::{CloseMode, RelayEffect};
use crate::engine::sources::IngestId;
use crate::engine::{Effect, EncodeEffect, Engine};
use crate::framing::{encode, encode_with};
use media_wire::control::{FromMedia, Lane, Sequence, Stats};
use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tokio::sync::oneshot;

pub enum Step {
    Continue,
    /// `shutdown`: finish within this long.
    Shutdown(Duration),
    /// The process can't go on safely; exit with this reason.
    Exit(&'static str),
}

pub struct Outputs<'a> {
    pub stdout: &'a Writer,
    pub priority: Option<&'a Writer>,
    pub connections: &'a mut HashMap<IngestId, oneshot::Sender<()>>,
    /// When each unanswered priority message arrived, oldest first.
    pub lag: &'a Mutex<VecDeque<Instant>>,
    pub pictures: &'a mut Pictures,
    pub readers: &'a mut Readers,
    pub relays: &'a mut RelaySockets,
    /// Priority answers held until the sockets they report shut are gone.
    pub gate: &'a mut PriorityGate,
    /// Clients' media connections.
    pub media: &'a mut Outboxes,
    /// ace-media's monotonic milliseconds, for when encoder threads were closed.
    pub now_ms: u64,
    /// One-shot image jobs (ADR 0201).
    pub images: &'a crate::images::ImageThreads,
}

fn sequence(value: u64) -> Sequence {
    Sequence::new(value.min(9_007_199_254_740_991)).unwrap_or_else(|_| unreachable!())
}

fn send(writer: &Writer, message: FromMedia, lane: Lane) -> Result<(), &'static str> {
    let bytes = encode(message, lane).map_err(|_| "an outgoing message did not encode")?;
    writer
        .send(bytes)
        .map_err(|_| "an outbound lane is backed up past its bound")
}

pub fn apply(engine: &mut Engine, outputs: &mut Outputs<'_>) -> Step {
    let mut step = Step::Continue;
    // A relay socket that is backed up ends its stream, which makes more effects (its
    // connection's close); those are carried out here too, not left for the next event.
    loop {
        let mut backed_up = Vec::new();
        if let Some(exit) = apply_once(engine, outputs, &mut step, &mut backed_up) {
            return exit;
        }
        for stream in backed_up {
            let close = outputs.relays.close(&stream, CloseMode::Forced);
            outputs.gate.closed(close);
            if let Ok(id) = media_wire::control::Id::new(stream) {
                // Only the monotonic clock matters for a close.
                let now = crate::engine::Now {
                    mono_ms: outputs.now_ms,
                    mono_us: outputs.now_ms.saturating_mul(1_000),
                    wall_ms: 0,
                };
                engine.relay_ended(&id, "backlog", now);
            }
        }
        if !engine.has_effects() {
            // Closes no answer followed don't hold the next one.
            outputs.gate.settle();
            return step;
        }
    }
}

fn apply_once(
    engine: &mut Engine,
    outputs: &mut Outputs<'_>,
    step: &mut Step,
    backed_up: &mut Vec<String>,
) -> Option<Step> {
    let counts = engine.counts();
    let effects: Vec<Effect> = engine.effects().collect();
    for effect in effects {
        let sent = match effect {
            Effect::Normal(message) => send(outputs.stdout, message, Lane::Normal),
            Effect::NormalWith(message, payload) => encode_with(message, payload, Lane::Normal)
                .map_err(|_| "an outgoing message did not encode")
                .and_then(|bytes| {
                    outputs
                        .stdout
                        .send(bytes)
                        .map_err(|_| "an outbound lane is backed up past its bound")
                }),
            // The priority lane is only ever answered once it is up, and an answer that follows a
            // relay socket's close only once that socket is gone.
            Effect::Priority(message) => match outputs.priority {
                None => Ok(()),
                Some(priority) => encode(message, Lane::Priority)
                    .map_err(|_| "an outgoing message did not encode")
                    .and_then(|bytes| match outputs.gate.answer(bytes) {
                        Some(now) => priority
                            .send(now)
                            .map_err(|_| "an outbound lane is backed up past its bound"),
                        None => Ok(()),
                    }),
            },
            Effect::Pong(id) => {
                let lag_ms = outputs
                    .lag
                    .lock()
                    .ok()
                    .and_then(|l| l.front().map(|t| t.elapsed().as_millis() as u64))
                    .unwrap_or(0);
                let stats = Stats {
                    sources: sequence(counts.sources),
                    viewers: sequence(counts.viewers),
                    connections: sequence(counts.connections),
                    cpu_ms: sequence(crate::os::cpu_ms()),
                    rss_bytes: sequence(crate::os::rss_bytes()),
                    bytes_out: sequence(counts.bytes_out),
                    priority_lag_ms: sequence(lag_ms),
                };
                send(outputs.stdout, FromMedia::Pong { id, stats }, Lane::Normal)
            }
            Effect::CloseIngest(id) => {
                outputs.connections.remove(&id);
                Ok(())
            }
            Effect::Shutdown { grace_ms } => {
                *step = Step::Shutdown(Duration::from_millis(u64::from(grace_ms)));
                Ok(())
            }
            Effect::Relay(RelayEffect::Dial { stream, url }) => {
                outputs.relays.dial(stream, url);
                Ok(())
            }
            Effect::Relay(RelayEffect::Send { stream, frame }) => {
                if !outputs.relays.send(&stream, frame) && !backed_up.contains(&stream) {
                    backed_up.push(stream);
                }
                Ok(())
            }
            Effect::Relay(RelayEffect::Close { stream, mode }) => {
                let close = outputs.relays.close(&stream, mode);
                outputs.gate.closed(close);
                Ok(())
            }
            Effect::Encode(command) => {
                let pictures = &mut *outputs.pictures;
                let readers = &mut *outputs.readers;
                let now_ms = outputs.now_ms;
                match command {
                    EncodeEffect::Configure { token, encodes, .. } if readers.has(token) => {
                        readers.configure(token, encodes)
                    }
                    EncodeEffect::Configure {
                        source,
                        token,
                        encodes,
                    } => pictures.configure(&source, token, encodes, now_ms),
                    EncodeEffect::Picture {
                        token,
                        text,
                        epoch,
                        age_us,
                        ..
                    } => pictures.picture(token, text, epoch, age_us),
                    EncodeEffect::Read { source, token, url } => readers.open(&source, token, &url),
                    // A token is a reader's or an encoder's, never both.
                    EncodeEffect::Key { token, .. } if readers.has(token) => readers.key(token),
                    EncodeEffect::Key { token, encode, .. } => pictures.key(token, encode),
                    EncodeEffect::Drain { token, .. } if readers.has(token) => readers.drain(token),
                    EncodeEffect::Drain { source, token } => pictures.drain(&source, token),
                    EncodeEffect::Close { token, .. } if readers.has(token) => {
                        readers.close(token, now_ms)
                    }
                    EncodeEffect::Close { token, .. } => pictures.close(token, now_ms),
                }
                Ok(())
            }
            Effect::Media { connection, out } => {
                match out {
                    MediaOut::Binary(bytes) => outputs.media.binary(&connection, bytes),
                    MediaOut::Text(text) => outputs.media.text(&connection, text),
                    MediaOut::Close(code) => outputs.media.close(&connection, code),
                }
                Ok(())
            }
            Effect::Image(work) => {
                outputs.images.submit(work);
                Ok(())
            }
            Effect::Fatal(reason) => Err(reason),
        };
        if let Err(reason) = sent {
            return Some(Step::Exit(reason));
        }
    }
    None
}

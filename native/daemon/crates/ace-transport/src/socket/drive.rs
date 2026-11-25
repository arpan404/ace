// SPDX-License-Identifier: Apache-2.0
//! The two tasks that run one socket. The reader delivers what arrives and the
//! writer flushes what `send` queued; whichever ends the conversation, the
//! writer ends it, so `Error` and every owed `Sent` are emitted before the one
//! `Close`. A local close the peer never answers ends at the socket's close
//! timeout, as `ws`'s does, and every closing write is bounded.

use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicU64};

use bytes::Bytes;
use futures_util::StreamExt;
use tokio::io::ReadHalf;
use tokio::runtime::Handle;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use super::{Inner, OPEN, Queued, Shared, SocketEvents, SocketHandle};
use crate::deflate::{Body, Deflate};
use crate::driver::UpgradeIo;
use crate::frame::assemble::{Message, conclude};
use crate::frame::{Frame, FrameError, FrameLimits, FrameReader, FrameWriter, Opcode};
use crate::stats::Stats;

mod writer;
#[cfg(test)]
pub(crate) use writer::OFF_THREAD;

type Source = FrameReader<ReadHalf<Box<dyn UpgradeIo>>, Body>;

/// How a socket's conversation ended, and what it still owes the wire.
pub(super) struct Ending {
    /// `Close`'s code, and the close frame's when one is sent.
    code: u16,
    reason: Vec<u8>,
    /// The `Error` event to report before `Close`.
    error: Option<(&'static str, String)>,
    wire: Wire,
}

enum Wire {
    /// The connection is gone: nothing more is written.
    Nothing,
    /// The peer closed. The writer sends the local close if one is queued, else
    /// echoes this payload, unless a close frame already went out.
    Peer(Bytes),
    /// `ws` closes with this code (a violation, or its own local close).
    Close(u16),
}

impl Ending {
    /// The connection ended without a close handshake, or `terminate` dropped it.
    pub(super) fn lost() -> Self {
        Self {
            code: 1006,
            reason: Vec::new(),
            error: None,
            wire: Wire::Nothing,
        }
    }

    /// A framing failure. `ws` closes the wire with its code for the violation
    /// and, having no peer close to report, ends the socket locally with `1006`.
    fn failed(error: FrameError) -> Self {
        let message = error.to_string();
        let wire = match &error {
            FrameError::TooBig(_) => Wire::Close(1009),
            // Invalid UTF-8 in a text frame is its own code, not a protocol one;
            // a compressed message that does not decode is its neighbour.
            FrameError::InvalidUtf8(_) | FrameError::Compression(_) => Wire::Close(1007),
            FrameError::Protocol(_) => Wire::Close(1002),
            FrameError::TooManyFragments(_) => Wire::Close(1008),
            FrameError::Io(_) => Wire::Nothing,
        };
        Ending {
            code: 1006,
            reason: Vec::new(),
            error: Some((error.error_code(), message)),
            wire,
        }
    }

    /// The queued pong payload passed the memory ceiling. `ws` has no limit;
    /// this is the recorded difference, closed with 1008 as a policy refusal.
    fn control_backlog() -> Self {
        Ending {
            code: 1006,
            reason: Vec::new(),
            error: Some(("protocol", "Too many queued pong bytes".to_owned())),
            wire: Wire::Close(1008),
        }
    }

    /// The peer's close frame: reported with its code and reason (`ws`'s 1005
    /// when the frame named no code). What is written is decided in `finish`,
    /// because `ws` keeps the local close it already queued and ends without a
    /// second frame once one has been sent.
    fn peer(frame: Option<(u16, Vec<u8>)>, reply: Bytes) -> Self {
        let (code, reason) = frame.unwrap_or((1005, Vec::new()));
        Ending {
            code,
            reason,
            error: None,
            wire: Wire::Peer(reply),
        }
    }
}

/// Opens a socket over either kind of stream the handshake hands on (the raw
/// path's `Prefixed<Box<dyn ConnIo>>`, the keep-alive path's upgraded stream),
/// `OPEN` at once on the caller's tokio runtime (T1a.5). `deflate` is the
/// `permessage-deflate` extension the connection negotiated (T1b.3b); `stats` the
/// listener's counters, when it has them.
pub fn open(
    stream: Box<dyn UpgradeIo>,
    deflate: Option<Deflate>,
    stats: Option<Arc<Stats>>,
) -> (SocketHandle, SocketEvents) {
    open_with_limits(stream, deflate, stats, FrameLimits::default())
}

/// Opens a socket with explicit inbound bounds for workloads such as Autobahn.
pub fn open_with_limits(
    stream: Box<dyn UpgradeIo>,
    deflate: Option<Deflate>,
    stats: Option<Arc<Stats>>,
    limits: FrameLimits,
) -> (SocketHandle, SocketEvents) {
    let (events, incoming) = mpsc::unbounded_channel();
    let (outbound, queued) = mpsc::unbounded_channel();
    let (wake, woken) = mpsc::channel(1);
    let shared = Arc::new(Shared {
        inner: Mutex::new(Inner {
            state: OPEN,
            outbound: Some(outbound),
            events: Some(events),
            close: None,
            close_sent: false,
        }),
        buffered: AtomicU64::new(0),
        pending: AtomicU64::new(0),
        control_bytes: AtomicU64::new(0),
        paused: AtomicBool::new(false),
        waiting_bytes: AtomicU64::new(0),
        waiting_messages: AtomicU64::new(0),
        wake,
        over: CancellationToken::new(),
        stop: CancellationToken::new(),
        ending: Mutex::new(None),
        expired: CancellationToken::new(),
        runtime: Handle::current(),
        stats,
    });
    Handle::current().spawn(run(
        stream,
        Arc::clone(&shared),
        queued,
        woken,
        deflate,
        limits,
    ));
    let events = SocketEvents {
        receiver: incoming,
        shared: Arc::clone(&shared),
    };
    (SocketHandle::attach(shared), events)
}

async fn run(
    stream: Box<dyn UpgradeIo>,
    shared: Arc<Shared>,
    queued: mpsc::UnboundedReceiver<Queued>,
    woken: mpsc::Receiver<()>,
    deflate: Option<Deflate>,
    limits: FrameLimits,
) {
    let (reader, writer) = tokio::io::split(stream);
    let body = Body::with_payload_limit(deflate.as_ref(), limits.max_payload);
    let source = FrameReader::with_limits(reader, body, limits);
    let sink = FrameWriter::new(writer);
    let reader = tokio::spawn(read(source, Arc::clone(&shared), woken));
    writer::write(sink, Arc::clone(&shared), queued, deflate).await;
    // The writer has ended the conversation; the reader returns at once.
    let _ = reader.await;
}

/// Delivers what arrives until the socket ends, and records why. A peer's ping
/// is answered here and never surfaced; a pong is ignored, as `autoPong` does.
async fn read(mut source: Source, shared: Arc<Shared>, mut woken: mpsc::Receiver<()>) {
    // The message in flight is compressed (its first data frame set RSV1), so
    // completing it counts one inflated message.
    let mut inflating = false;
    let ending = loop {
        let readable = shared.readable();
        tokio::select! {
            biased;
            // The writer ended the conversation: it reports, so this side says
            // nothing more.
            _ = shared.over.cancelled() => return,
            frame = source.next(), if readable => match frame {
                Some(Ok(frame)) => {
                    if matches!(frame.opcode, Opcode::Text | Opcode::Binary) && frame.rsv1 {
                        inflating = true;
                    }
                    match frame_in(&shared, &mut source, frame) {
                        Ok(Some(message)) => {
                            if inflating
                                && let Some(stats) = &shared.stats
                            {
                                stats.inflated_in();
                            }
                            inflating = false;
                            if !shared.deliver(message.data, message.binary) {
                                break Ending::lost();
                            }
                        }
                        // A control frame between fragments, or a fragment that
                        // did not finish the message: nothing is delivered.
                        Ok(None) => {}
                        Err(ending) => break ending,
                    }
                }
                Some(Err(error)) => break Ending::failed(error),
                None => break Ending::lost(),
            },
            _ = woken.recv() => {}
        }
    };
    // A compressed message that inflated past the payload limit was still inflated before it was
    // refused, and T1b.5's evidence counts that (`inflatedIn`): its case's whole point is the
    // refused message, so a count only on delivered messages would say it never inflated one.
    if inflating
        && matches!(ending.error, Some(("too_big", _)))
        && let Some(stats) = &shared.stats
    {
        stats.inflated_in();
    }
    shared.end(ending);
}

/// One frame's meaning: a completed message, nothing (a control frame handled
/// here), or the end of the socket.
fn frame_in(shared: &Shared, source: &mut Source, frame: Frame) -> Result<Option<Message>, Ending> {
    match frame.opcode {
        Opcode::Ping => {
            if shared.control(Opcode::Pong, frame.payload) {
                Ok(None)
            } else {
                Err(Ending::control_backlog())
            }
        }
        // `ws`'s `autoPong` answers pings; a pong is never surfaced.
        Opcode::Pong => Ok(None),
        Opcode::Close => {
            let reply = frame.payload.clone();
            match conclude(&frame.payload) {
                Ok(peer) => Err(Ending::peer(peer, reply)),
                Err(code) => Err(Ending::failed(FrameError::from(code))),
            }
        }
        Opcode::Text | Opcode::Binary | Opcode::Continuation => {
            match source.assembler_mut().push(frame) {
                Ok(message) => Ok(message),
                Err(code) => Err(Ending::failed(FrameError::from(code))),
            }
        }
    }
}

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

use super::{DELIVERY_BYTES, Inner, OPEN, Queued, Shared, SocketEvents, SocketHandle};
use crate::deflate::{Body, Deflate};
use crate::driver::UpgradeIo;
use crate::frame::assemble::{Message, conclude};
use crate::frame::read::Front;
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
    let body = if deflate.is_some() {
        Body::compressed_with_limit(limits.max_payload)
    } else {
        Body::plain_with_limit(limits.max_payload)
    };
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
    // The peer ended its half, but bytes it sent before that may still wait in
    // the buffer: `ws` feeds its receiver what it holds before it reports the
    // close, so a message or a close frame there still counts.
    let mut ended = false;
    let ending = loop {
        let readable = shared.readable();
        if ended {
            // The peer's end is recorded, so what the buffer holds is all that
            // will ever arrive: nothing ends before it is parsed, and a frame
            // whose tail can never come is judged and ended here instead of
            // left for credit that would parse nothing.
            match source.front_frame() {
                Ok(Front::Whole) => {}
                Ok(Front::Partial) => break Ending::lost(),
                Err(error) => break Ending::failed(error),
            }
        }
        if !readable {
            // No credit: no frame is read or delivered, but the connection is
            // still watched, so a peer that drops is seen here.
            match wait(&shared, &mut source, &mut woken, ended).await {
                Wait::Reading => continue,
                Wait::Over => return,
                Wait::End => {
                    ended = true;
                    continue;
                }
                Wait::Failed(error) => break failed(error, ended),
            }
        }
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
                Some(Err(error)) => break failed(error, ended),
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

/// A frame failure, with the peer's end in mind: a tail that never arrived is
/// that end, which `ws` reports as a bare close and nothing on `error`
/// (`websocket.js:1335-1411`), so no error precedes it.
fn failed(error: FrameError, ended: bool) -> Ending {
    let quiet = match &error {
        FrameError::Io(source) => ended || source.kind() == std::io::ErrorKind::UnexpectedEof,
        _ => false,
    };
    if quiet {
        Ending::lost()
    } else {
        Ending::failed(error)
    }
}

/// Why a reader without credit stopped waiting.
enum Wait {
    /// A delivery may have restored credit, or a pause was lifted: look again.
    Reading,
    /// The writer ended the conversation, so this side says nothing more.
    Over,
    /// The peer ended its half. Bytes it sent before that are still buffered,
    /// so the socket ends only once they have been parsed.
    End,
    /// Waiting on the connection failed.
    Failed(FrameError),
}

/// How many bytes a reader without credit may still pull: one delivery's worth,
/// the size of the credit bound itself. Past it the socket waits for credit
/// again, so a paused socket never buffers without limit.
const WATCH_BYTES: usize = DELIVERY_BYTES as usize;

/// Waits while the reader has no credit, without turning its back on the
/// connection: it pulls unparsed bytes up to [`WATCH_BYTES`], so a peer that
/// drops is noticed here instead of holding the socket until a consumer reads
/// again. Nothing is parsed or delivered while waiting. Once `ended`, there is
/// nothing more to watch for.
async fn wait(
    shared: &Shared,
    source: &mut Source,
    woken: &mut mpsc::Receiver<()>,
    ended: bool,
) -> Wait {
    let watching = !ended && source.buffered_bytes() < WATCH_BYTES;
    tokio::select! {
        biased;
        _ = shared.over.cancelled() => Wait::Over,
        watched = watch(source), if watching => match watched {
            Ok(true) => Wait::Reading,
            Ok(false) => Wait::End,
            Err(error) => Wait::Failed(error),
        },
        _ = woken.recv() => Wait::Reading,
    }
}

/// One watch fill as a future, so it can be selected beside the wake channel.
async fn watch(source: &mut Source) -> Result<bool, FrameError> {
    std::future::poll_fn(|cx| source.poll_watch(cx, WATCH_BYTES)).await
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

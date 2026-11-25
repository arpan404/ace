// SPDX-License-Identifier: Apache-2.0
//! The two tasks that run one socket. The reader delivers what arrives and the
//! writer flushes what `send` queued; whichever ends the conversation, the
//! writer ends it, so `Error` and every owed `Sent` are emitted before the one
//! `Close`. A local close the peer never answers ends at the socket's close
//! timeout, as `ws`'s does, and every closing write is bounded.

use std::future::Future;
use std::io;
use std::sync::Arc;

use bytes::Bytes;
use futures_util::{SinkExt, StreamExt};
use tokio::io::{ReadHalf, WriteHalf};
use tokio::sync::mpsc;

use super::{CLOSED, CLOSING, OPEN, Queued, Shared, SocketEvent, lock};
use crate::deflate::{Body, Deflate, Deflater, deflate_window, may_compress};
use crate::driver::UpgradeIo;
use crate::frame::assemble::{Message, conclude};
use crate::frame::write::header_length;
use crate::frame::{Frame, FrameError, FrameReader, FrameWriter, Opcode, Outbound};
use crate::prefixed::WRITE_TIMEOUT;

type Source = FrameReader<ReadHalf<Box<dyn UpgradeIo>>, Body>;
type Sink = FrameWriter<WriteHalf<Box<dyn UpgradeIo>>>;

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

pub(super) async fn run(
    stream: Box<dyn UpgradeIo>,
    shared: Arc<Shared>,
    queued: mpsc::UnboundedReceiver<Queued>,
    woken: mpsc::Receiver<()>,
    deflate: Option<Deflate>,
) {
    let (reader, writer) = tokio::io::split(stream);
    let body = match deflate {
        Some(_) => Body::compressed(),
        None => Body::plain(),
    };
    let source = FrameReader::with_body(reader, body);
    let sink = FrameWriter::new(writer);
    let reader = tokio::spawn(read(source, Arc::clone(&shared), woken));
    write(sink, Arc::clone(&shared), queued, deflate).await;
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

/// Flushes what `send` queued until the conversation ends, then ends it. A local
/// close starts `ws`'s close timeout at the call, so a queue of frames still
/// waiting cannot postpone the socket being destroyed. Compression happens here,
/// in the socket's order and with one context, reset after every message (no
/// context takeover); a message past [`OFF_THREAD`] is deflated on the blocking
/// pool so the runtime's worker stays free.
async fn write(
    mut sink: Sink,
    shared: Arc<Shared>,
    mut queued: mpsc::UnboundedReceiver<Queued>,
    deflate: Option<Deflate>,
) {
    let mut deflater = deflate
        .as_ref()
        .map(|deflate| Deflater::new(deflate_window(deflate.server_max_window_bits())));
    loop {
        let item = tokio::select! {
            biased;
            _ = shared.over.cancelled() => {
                return finish(sink, &shared, &mut queued, shared.ended(), None).await;
            }
            _ = shared.expired.cancelled() => {
                return finish(sink, &shared, &mut queued, Ending::lost(), None).await;
            }
            item = queued.recv() => item,
        };
        let Some(item) = item else {
            return finish(sink, &shared, &mut queued, Ending::lost(), None).await;
        };
        let owed = item.own.map(|own| own.id);
        let close = item.frame.opcode == Opcode::Close;
        let frame = match compress(&shared, &mut deflater, item.frame, item.compress).await {
            Ok(frame) => frame,
            Err(ending) => {
                shared.release(item.charge, item.memory, item.control);
                return finish(sink, &shared, &mut queued, ending, owed).await;
            }
        };
        // ws leaves only the compressed frame's bytes pending once deflate
        // finished (sender.js:511-527, websocket.js:133-136): the queued charge
        // was the message's original size, so the difference moves now.
        let charge = if frame.rsv1 {
            shared.recharge(item.charge, wire_bytes(&frame))
        } else {
            item.charge
        };
        match flushed(&shared, sink.send(frame)).await {
            Ok(Ok(())) => {
                if close {
                    shared.close_flushed();
                }
                shared.settle(item.own, charge, item.memory, item.control, None);
            }
            Ok(Err(error)) => {
                shared.settle(
                    item.own,
                    charge,
                    item.memory,
                    item.control,
                    Some(not_open(shared.state())),
                );
                return finish(
                    sink,
                    &shared,
                    &mut queued,
                    Ending::failed(error.into()),
                    None,
                )
                .await;
            }
            // The frame is owed a `Sent`, which `finish` reports once the state
            // is sealed.
            Err(ending) => {
                shared.release(charge, item.memory, item.control);
                // The interrupted frame may be the local close itself. It counts
                // as sent: `finish` flushes what is in flight, and a second close
                // must never follow it.
                if close && sink.accepted() {
                    shared.close_flushed();
                }
                return finish(sink, &shared, &mut queued, ending, owed).await;
            }
        }
    }
}

/// Runs one write to its end, or abandons it because the conversation ended: the
/// stream is dropped whole then, so no half-written frame is resumed. The close
/// deadline abandons it too, however long the queue in front of it is.
async fn flushed<F: Future<Output = Result<(), io::Error>>>(
    shared: &Shared,
    write: F,
) -> Result<Result<(), io::Error>, Ending> {
    let mut write = std::pin::pin!(write);
    tokio::select! {
        biased;
        _ = shared.over.cancelled() => Err(shared.ended()),
        _ = shared.expired.cancelled() => Err(Ending::lost()),
        outcome = &mut write => Ok(outcome),
    }
}

/// One closing write. It is bounded twice: by the stream's write timeout, and by
/// `terminate`, which drops the socket at once rather than waiting for a flush
/// that may never come.
async fn terminal<F: Future<Output = Result<(), io::Error>>>(
    shared: &Shared,
    write: F,
) -> Option<Result<(), io::Error>> {
    tokio::select! {
        biased;
        _ = shared.stop.cancelled() => None,
        outcome = tokio::time::timeout(WRITE_TIMEOUT, write) => outcome.ok(),
    }
}

async fn finish(
    mut sink: Sink,
    shared: &Arc<Shared>,
    queued: &mut mpsc::UnboundedReceiver<Queued>,
    ending: Ending,
    owed: Option<u64>,
) {
    if let Some((code, message)) = &ending.error {
        // ws reports a failed connection as CLOSING before its error event, so a
        // handler that terminates from it finds a closing socket and leaves the
        // 1009 or 1002 close frame the grace to reach the peer.
        {
            let mut inner = lock(&shared.inner);
            if inner.state == OPEN {
                inner.state = CLOSING;
            }
        }
        let _ = shared.emit(SocketEvent::Error {
            code,
            message: message.clone(),
        });
    }
    match ending.wire {
        // The peer's close: `ws` keeps a local close that was queued first and
        // writes no second frame once one has gone out.
        Wire::Peer(reply) => {
            let payload = {
                let mut inner = lock(&shared.inner);
                if inner.close_sent {
                    None
                } else if inner.close.is_some() {
                    inner.close.take().map(Bytes::from)
                } else {
                    Some(reply)
                }
            };
            close_frame(&mut sink, shared, payload.unwrap_or_default()).await;
        }
        // `ws`'s answer to a protocol or size violation, before it drops.
        Wire::Close(code) => {
            close_frame(
                &mut sink,
                shared,
                Bytes::copy_from_slice(&code.to_be_bytes()),
            )
            .await;
        }
        Wire::Nothing => {}
    }
    // Sealing first is what makes the drain complete: no `send` can queue a
    // frame after this, so every id still owed a `Sent` is in the queue below.
    shared.seal();
    if let Some(id) = owed {
        shared.sent(id, Some(not_open(shared.state())));
    }
    while let Ok(item) = queued.try_recv() {
        shared.settle(
            item.own,
            item.charge,
            item.memory,
            item.control,
            Some(not_open(shared.state())),
        );
    }
    shared.finish_events(ending.code, ending.reason);
    // The reader stops at once; whatever it read meanwhile is dropped.
    shared.over.cancel();
}

/// Writes one close frame after finishing any partly written frame, inside the
/// close deadline. A frame already in flight is completed first, never
/// interleaved; if it cannot be finished the stream is dropped without a close,
/// as `ws` drops a socket it cannot drain.
async fn close_frame(sink: &mut Sink, shared: &Shared, payload: bytes::Bytes) {
    // Finish whatever is in flight first, whether or not a close still needs to
    // go out: a close already being written is completed, never followed.
    if !matches!(terminal(shared, sink.flush()).await, Some(Ok(()))) {
        return;
    }
    if lock(&shared.inner).close_sent {
        return;
    }
    let frame = Outbound {
        opcode: Opcode::Close,
        rsv1: false,
        payload,
    };
    if matches!(terminal(shared, sink.send(frame)).await, Some(Ok(()))) {
        shared.close_flushed();
    }
}

/// A message at least this large is deflated off the runtime's worker threads.
/// Level 6 deflates at roughly 100–300 MB/s, so 64 KiB is about half a
/// millisecond of a worker — long enough to delay every other socket that shares
/// it, and the size the outbox already packs a frame at, so it is the size a
/// send arrives in. A message past it is up to the 1 MiB cap, 16 times this.
pub(crate) const OFF_THREAD: usize = 64 * 1024;

/// The frame this send puts on the wire: deflated with RSV1 set when the socket
/// negotiated `permessage-deflate`, the shell asked for it and the payload
/// reached the threshold; exactly as sent otherwise. A deflate that fails sends
/// the message plain rather than a broken frame, and nothing is compressed on a
/// socket that negotiated no extension (T1b.0 §3's trap). Large messages run on
/// the blocking pool; the writer awaits each one, so order holds and the
/// conversation's end abandons the wait the same way a write does.
async fn compress(
    shared: &Shared,
    deflater: &mut Option<Deflater>,
    frame: Outbound,
    ask: bool,
) -> Result<Outbound, Ending> {
    if !may_compress(frame.opcode, frame.payload.len(), ask) {
        return Ok(frame);
    }
    let Some(mut owned) = deflater.take() else {
        return Ok(frame);
    };
    if frame.payload.len() < OFF_THREAD {
        let deflated = owned.deflate(&frame.payload);
        *deflater = Some(owned);
        return Ok(deflated_frame(frame, deflated, shared));
    }
    let payload = frame.payload.clone();
    let task = tokio::task::spawn_blocking(move || {
        let deflated = owned.deflate(&payload);
        (owned, deflated)
    });
    tokio::select! {
        biased;
        _ = shared.over.cancelled() => Err(shared.ended()),
        _ = shared.expired.cancelled() => Err(Ending::lost()),
        joined = task => match joined {
            Ok((owned, deflated)) => {
                *deflater = Some(owned);
                Ok(deflated_frame(frame, deflated, shared))
            }
            // The blocking task panicked: nothing more can be trusted here.
            Err(_) => Err(Ending::lost()),
        },
    }
}

/// The compressed frame, or the message as it was when the deflater failed.
fn deflated_frame(frame: Outbound, deflated: Option<Vec<u8>>, shared: &Shared) -> Outbound {
    let Some(payload) = deflated else {
        return frame;
    };
    if let Some(stats) = &shared.stats {
        stats.deflated_out();
    }
    Outbound {
        opcode: frame.opcode,
        rsv1: true,
        payload: Bytes::from(payload),
    }
}

/// The bytes the frame takes on the wire: its unmasked header and payload, which
/// is what `ws`'s `bufferedAmount` counts for a frame waiting to be written.
fn wire_bytes(frame: &Outbound) -> u64 {
    (header_length(frame.payload.len()) + frame.payload.len()) as u64
}

/// `ws`'s words for a send that could not be completed.
fn not_open(state: u8) -> String {
    let name = match state {
        OPEN => "OPEN",
        CLOSING => "CLOSING",
        CLOSED => "CLOSED",
        _ => "CONNECTING",
    };
    format!("WebSocket is not open: readyState {state} ({name})")
}

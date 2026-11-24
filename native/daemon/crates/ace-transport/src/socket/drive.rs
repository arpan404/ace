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
use crate::driver::UpgradeIo;
use crate::frame::assemble::{Message, conclude};
use crate::frame::{Frame, FrameError, FrameReader, FrameWriter, Opcode, Outbound};
use crate::prefixed::WRITE_TIMEOUT;

type Source = FrameReader<ReadHalf<Box<dyn UpgradeIo>>>;
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
    /// The peer closed: answer with this frame's payload.
    Reply(Vec<u8>),
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
            // Invalid UTF-8 in a text frame is its own code, not a protocol one.
            FrameError::InvalidUtf8(_) => Wire::Close(1007),
            FrameError::Protocol(_) => Wire::Close(1002),
            FrameError::Io(_) => Wire::Nothing,
        };
        Ending {
            code: 1006,
            reason: Vec::new(),
            error: Some((error.error_code(), message)),
            wire,
        }
    }

    /// The peer's close frame: answered with the same payload and reported with
    /// its code and reason (`ws`'s 1005 when the frame named no code).
    fn peer(frame: Option<(u16, Vec<u8>)>, reply: Vec<u8>) -> Self {
        let (code, reason) = frame.unwrap_or((1005, Vec::new()));
        Ending {
            code,
            reason,
            error: None,
            wire: Wire::Reply(reply),
        }
    }
}

pub(super) async fn run(
    stream: Box<dyn UpgradeIo>,
    shared: Arc<Shared>,
    queued: mpsc::UnboundedReceiver<Queued>,
    woken: mpsc::Receiver<()>,
) {
    let (reader, writer) = tokio::io::split(stream);
    let source = FrameReader::new(reader);
    let sink = FrameWriter::new(writer);
    let reader = tokio::spawn(read(source, Arc::clone(&shared), woken));
    write(sink, Arc::clone(&shared), queued).await;
    // The writer has ended the conversation; the reader returns at once.
    let _ = reader.await;
}

/// Delivers what arrives until the socket ends, and records why. A peer's ping
/// is answered here and never surfaced; a pong is ignored, as `autoPong` does.
async fn read(mut source: Source, shared: Arc<Shared>, mut woken: mpsc::Receiver<()>) {
    let ending = loop {
        let readable = shared.readable();
        tokio::select! {
            biased;
            // The writer ended the conversation: it reports, so this side says
            // nothing more.
            _ = shared.over.cancelled() => return,
            frame = source.next(), if readable => match frame {
                Some(Ok(frame)) => match frame_in(&shared, &mut source, frame) {
                    Ok(Some(message)) => {
                        if !shared.deliver(message.data, message.binary) {
                            break Ending::lost();
                        }
                    }
                    Ok(None) => {}
                    Err(ending) => break ending,
                },
                Some(Err(error)) => break Ending::failed(error),
                None => break Ending::lost(),
            },
            _ = woken.recv() => {}
        }
    };
    shared.end(ending);
}

/// One frame's meaning: a completed message, nothing (a control frame handled
/// here), or the end of the socket.
fn frame_in(shared: &Shared, source: &mut Source, frame: Frame) -> Result<Option<Message>, Ending> {
    match frame.opcode {
        Opcode::Ping => {
            shared.control(Opcode::Pong, frame.payload);
            Ok(None)
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
/// waiting cannot postpone the socket being destroyed.
async fn write(mut sink: Sink, shared: Arc<Shared>, mut queued: mpsc::UnboundedReceiver<Queued>) {
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
        match flushed(&shared, sink.send(item.frame)).await {
            Ok(Ok(())) => shared.complete(item.own, None),
            Ok(Err(error)) => {
                shared.complete(item.own, Some(not_open(shared.state())));
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
                shared.release(item.own);
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
        // The peer's close, answered with the payload it carried.
        Wire::Reply(payload) => {
            let frame = Outbound {
                opcode: Opcode::Close,
                rsv1: false,
                payload: Bytes::from(payload),
            };
            let _ = terminal(shared, sink.send(frame)).await;
        }
        // `ws`'s answer to a protocol or size violation, before it drops.
        Wire::Close(code) => {
            let frame = Outbound {
                opcode: Opcode::Close,
                rsv1: false,
                payload: Bytes::copy_from_slice(&code.to_be_bytes()),
            };
            let _ = terminal(shared, sink.send(frame)).await;
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
        shared.complete(item.own, Some(not_open(shared.state())));
    }
    shared.finish_events(ending.code, ending.reason);
    // The reader stops at once; whatever it read meanwhile is dropped.
    shared.over.cancel();
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

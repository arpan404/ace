// SPDX-License-Identifier: Apache-2.0
//! The two tasks that run one socket. The reader delivers what arrives and the
//! writer flushes what `send` queued; whichever ends the conversation, the
//! writer ends it, so `Error` and every owed `Sent` are emitted before the one
//! `Close`.

use std::future::Future;

use futures_util::stream::{SplitSink, SplitStream};
use futures_util::{SinkExt, StreamExt};
use tokio::sync::mpsc;
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::protocol::{CloseFrame, Role, WebSocketConfig};
use tokio_tungstenite::tungstenite::{Error as WsError, Message, Utf8Bytes};

use super::{
    CLOSED, CLOSING, Ending, MAX_MESSAGE_BYTES, OPEN, Outbound, Shared, SocketEvent, Wire, subtract,
};
use crate::driver::UpgradeIo;

type Source = SplitStream<WebSocketStream<Box<dyn UpgradeIo>>>;
type Sink = SplitSink<WebSocketStream<Box<dyn UpgradeIo>>, Message>;

impl Ending {
    /// A tungstenite error: a size or protocol violation sends `ws`'s close code,
    /// anything else is a lost connection.
    fn failed(error: WsError) -> Self {
        let message = error.to_string();
        match &error {
            WsError::Capacity(_) => Ending {
                code: 1009,
                reason: Vec::new(),
                error: Some(("too_big", message)),
                wire: Wire::Close(1009),
            },
            WsError::Protocol(_) | WsError::Utf8(_) | WsError::AttackAttempt => Ending {
                code: 1002,
                reason: Vec::new(),
                error: Some(("protocol", message)),
                wire: Wire::Close(1002),
            },
            _ => Ending {
                code: 1006,
                reason: Vec::new(),
                error: Some(("io", message)),
                wire: Wire::Nothing,
            },
        }
    }

    /// The peer's close frame, or none: answered and reported with its code.
    fn peer(frame: Option<CloseFrame>) -> Self {
        let (code, reason) = match frame {
            Some(frame) => (frame.code.into(), frame.reason.as_str().as_bytes().to_vec()),
            // No code on the wire is `ws`'s 1005.
            None => (1005, Vec::new()),
        };
        Ending {
            code,
            reason,
            error: None,
            wire: Wire::Reply,
        }
    }
}

pub(super) async fn run(
    stream: Box<dyn UpgradeIo>,
    shared: std::sync::Arc<Shared>,
    queued: mpsc::UnboundedReceiver<Outbound>,
    woken: mpsc::Receiver<()>,
) {
    let socket = WebSocketStream::from_raw_socket(stream, Role::Server, Some(config())).await;
    let (sink, source) = socket.split();
    let reader = tokio::spawn(read(source, std::sync::Arc::clone(&shared), woken));
    write(sink, std::sync::Arc::clone(&shared), queued).await;
    // The writer has ended the conversation; the reader returns at once.
    let _ = reader.await;
}

fn config() -> WebSocketConfig {
    WebSocketConfig::default()
        .max_message_size(Some(MAX_MESSAGE_BYTES))
        .max_frame_size(Some(MAX_MESSAGE_BYTES))
}

/// Delivers what arrives until the socket ends, and records why. A peer's ping
/// is answered by tungstenite on the read that follows and never surfaced; a
/// pong is ignored, as `autoPong` does.
async fn read(mut source: Source, shared: std::sync::Arc<Shared>, mut woken: mpsc::Receiver<()>) {
    let ending = loop {
        let readable = shared.readable();
        tokio::select! {
            biased;
            // The writer ended the conversation: it reports, so this side says
            // nothing more.
            _ = shared.over.cancelled() => return,
            message = source.next(), if readable => match message {
                Some(Ok(Message::Text(text))) => {
                    if !shared.deliver(text.as_str().as_bytes().to_vec(), false) {
                        break Ending::lost();
                    }
                }
                Some(Ok(Message::Binary(data))) => {
                    if !shared.deliver(data.to_vec(), true) {
                        break Ending::lost();
                    }
                }
                Some(Ok(Message::Close(frame))) => break Ending::peer(frame),
                Some(Ok(Message::Ping(_) | Message::Pong(_) | Message::Frame(_))) => {}
                Some(Err(error)) => break Ending::failed(error),
                None => break Ending::lost(),
            },
            _ = woken.recv() => {}
        }
    };
    shared.end(ending);
}

/// Flushes what `send` queued until the conversation ends, then ends it.
async fn write(
    mut sink: Sink,
    shared: std::sync::Arc<Shared>,
    mut queued: mpsc::UnboundedReceiver<Outbound>,
) {
    loop {
        let item = tokio::select! {
            biased;
            _ = shared.over.cancelled() => {
                return finish(sink, &shared, &mut queued, shared.ended(), None).await;
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
                return finish(sink, &shared, &mut queued, Ending::failed(error), None).await;
            }
            // The frame is owed a `Sent`, which `finish` reports once the state
            // is sealed.
            Err(ending) => {
                if let Some(own) = item.own {
                    subtract(&shared.buffered, own.length);
                }
                return finish(sink, &shared, &mut queued, ending, owed).await;
            }
        }
    }
}

/// Runs one write to its end, or abandons it because the conversation ended: the
/// stream is dropped whole then, so no half-written frame is resumed.
async fn flushed<F: Future<Output = Result<(), WsError>>>(
    shared: &Shared,
    write: F,
) -> Result<Result<(), WsError>, Ending> {
    let mut write = std::pin::pin!(write);
    tokio::select! {
        biased;
        _ = shared.over.cancelled() => Err(shared.ended()),
        outcome = &mut write => Ok(outcome),
    }
}

async fn finish(
    mut sink: Sink,
    shared: &std::sync::Arc<Shared>,
    queued: &mut mpsc::UnboundedReceiver<Outbound>,
    ending: Ending,
    owed: Option<u64>,
) {
    if let Some((code, message)) = &ending.error {
        let _ = shared.emit(SocketEvent::Error {
            code,
            message: message.clone(),
        });
    }
    match ending.wire {
        // tungstenite queued the reply as it read the peer's close; flushing it
        // completes the handshake.
        Wire::Reply => {
            let _ = sink.flush().await;
        }
        // `ws`'s answer to a protocol or size violation, before it drops.
        Wire::Close(code) => {
            let frame = CloseFrame {
                code: CloseCode::from(code),
                reason: Utf8Bytes::from_static(""),
            };
            let _ = sink.send(Message::Close(Some(frame))).await;
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

// SPDX-License-Identifier: Apache-2.0
//! Clients' media connections on the direct listener (D1): `ws://127.0.0.1:<port>/media`.
//! A connection has [`HELLO_WITHIN`] from accept, the handshake included, to send its binary
//! hello, and may send only the bytes a handshake and a hello need until it is accepted. The
//! ticket is read into a wiped buffer and handed to the engine, which decides whether the
//! connection opens. After that the client's text messages go to the engine, and what the engine
//! sends goes out through a bounded outbox.
use super::budget::{Budget, Cap, Slot};
use futures_util::{SinkExt, StreamExt};
use media_wire::media_link::{HELLO_BYTES, TICKET_BYTES, close, hello_ticket};
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;
use tokio::net::TcpListener;
use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tokio_tungstenite::tungstenite::http::StatusCode;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::tungstenite::protocol::frame::CloseFrame;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::{Bytes, Message, Utf8Bytes};
use zeroize::{Zeroize, Zeroizing};

pub const HELLO_WITHIN: Duration = Duration::from_secs(2);
/// Open media connections, and how many of them may still be waiting on a hello.
pub const MAX_CONNECTIONS: usize = 1024;
pub const MAX_PENDING: usize = 16;
/// The bytes queued for one client before it counts as gone: well past a full ack window.
pub const OUTBOX_LIMIT: usize = 32 * 1024 * 1024;
/// A client's text message: an ack or a ping is a few hundred bytes.
const CLIENT_MESSAGE_MAX: usize = 4 * 1024;
const HANDSHAKE_BUDGET: usize = 8 * 1024 + 14 + HELLO_BYTES;

pub type Ticket = Zeroizing<[u8; TICKET_BYTES]>;

pub enum MediaEvent {
    /// A hello to check. Answered with the connection it opened, or `None` to close it.
    Hello {
        ticket: Ticket,
        outbox: Outbox,
        admit: oneshot::Sender<Option<String>>,
    },
    Text(String, String),
    /// A client's connection ended (or broke a rule the socket layer checks).
    Closed(String),
}

/// How long one write may take before the client counts as gone.
pub const WRITE_LIMIT: Duration = Duration::from_secs(5);
/// After a close from the engine, how long the close frame has before the socket is cut anyway:
/// a client that stopped reading never holds a revocation up (250 ms, ADR 0147 §5.6).
pub const CLOSE_GRACE: Duration = Duration::from_millis(100);

/// What goes out on one client's socket.
#[derive(Clone)]
pub struct Outbox {
    tx: mpsc::UnboundedSender<Message>,
    queued: Arc<AtomicUsize>,
    /// Cuts the connection whatever its writes are doing.
    shut: Arc<tokio::sync::Notify>,
}

impl Outbox {
    /// False when the client is too far behind: the caller closes it.
    pub fn send(&self, message: Message) -> bool {
        let size = message.len();
        if self.queued.fetch_add(size, Ordering::AcqRel) + size > OUTBOX_LIMIT {
            return false;
        }
        self.tx.send(message).is_ok()
    }

    /// Sends the close frame, and cuts the connection once it went or `CLOSE_GRACE` passed.
    pub fn close(&self, code: u16) {
        let frame = CloseFrame {
            code: CloseCode::from(code),
            reason: Utf8Bytes::from_static(""),
        };
        let _ = self.tx.send(Message::Close(Some(frame)));
        let shut = self.shut.clone();
        tokio::spawn(async move {
            tokio::time::sleep(CLOSE_GRACE).await;
            shut.notify_one();
        });
    }
}

/// The open connections' outboxes, by connection id.
#[derive(Default)]
pub struct Outboxes(HashMap<String, Outbox>);

impl Outboxes {
    pub fn insert(&mut self, connection: String, outbox: Outbox) {
        self.0.insert(connection, outbox);
    }

    pub fn binary(&mut self, connection: &str, bytes: Vec<u8>) {
        self.deliver(connection, Message::Binary(Bytes::from(bytes)));
    }

    pub fn text(&mut self, connection: &str, text: String) {
        self.deliver(connection, Message::Text(Utf8Bytes::from(text)));
    }

    fn deliver(&mut self, connection: &str, message: Message) {
        let Some(outbox) = self.0.get(connection) else {
            return;
        };
        if !outbox.send(message) {
            outbox.close(close::GOING_AWAY);
            self.0.remove(connection);
        }
    }

    pub fn close(&mut self, connection: &str, code: u16) {
        if let Some(outbox) = self.0.remove(connection) {
            outbox.close(code);
        }
    }
}

/// Only `/media`. Any origin: the ticket is what admits a client, as the web app runs on many.
#[allow(clippy::result_large_err)]
fn admit(request: &Request, response: Response) -> Result<Response, ErrorResponse> {
    if request.uri().path() == "/media" {
        return Ok(response);
    }
    let mut refusal = ErrorResponse::new(None);
    *refusal.status_mut() = StatusCode::NOT_FOUND;
    Err(refusal)
}

fn ticket_of(bytes: Bytes) -> Option<Ticket> {
    let read = |b: &[u8]| -> Option<Ticket> {
        let ticket = hello_ticket(b).ok()?;
        let mut out = Zeroizing::new([0u8; TICKET_BYTES]);
        out.copy_from_slice(ticket);
        Some(out)
    };
    match bytes.try_into_mut() {
        Ok(mut owned) => {
            let ticket = read(&owned);
            owned.as_mut().zeroize();
            ticket
        }
        Err(shared) => read(&shared),
    }
}

pub fn serve(listener: TcpListener, events: mpsc::Sender<MediaEvent>) {
    let config = WebSocketConfig::default()
        .max_message_size(Some(CLIENT_MESSAGE_MAX))
        .max_frame_size(Some(CLIENT_MESSAGE_MAX));
    let connections = Cap::new(MAX_CONNECTIONS);
    let pending = Cap::new(MAX_PENDING);
    tokio::spawn(async move {
        loop {
            let Ok((stream, _)) = listener.accept().await else {
                continue;
            };
            let _ = stream.set_nodelay(true);
            let Some(waiting) = pending.take() else {
                continue;
            };
            let Some(slot) = connections.take() else {
                continue;
            };
            let events = events.clone();
            tokio::spawn(connection(stream, config, slot, waiting, events));
        }
    });
}

async fn connection(
    stream: tokio::net::TcpStream,
    config: WebSocketConfig,
    _slot: Slot,
    waiting: Slot,
    events: mpsc::Sender<MediaEvent>,
) {
    let hello = tokio::time::timeout(HELLO_WITHIN, async {
        let stream = Budget::new(stream, HANDSHAKE_BUDGET);
        let mut socket =
            tokio_tungstenite::accept_hdr_async_with_config(stream, admit, Some(config))
                .await
                .ok()?;
        let first = socket.next().await;
        Some((socket, first))
    })
    .await;
    let Ok(Some((mut socket, first))) = hello else {
        return;
    };
    let refuse = |code: u16| {
        Message::Close(Some(CloseFrame {
            code: CloseCode::from(code),
            reason: Utf8Bytes::from_static(""),
        }))
    };
    let ticket = match first {
        Some(Ok(Message::Binary(bytes))) => ticket_of(bytes),
        None => return,
        _ => None,
    };
    let Some(ticket) = ticket else {
        let _ = socket.send(refuse(close::REFUSED)).await;
        return;
    };
    let (tx, mut rx) = mpsc::unbounded_channel();
    let queued = Arc::new(AtomicUsize::new(0));
    let shut = Arc::new(tokio::sync::Notify::new());
    let outbox = Outbox {
        tx,
        queued: queued.clone(),
        shut: shut.clone(),
    };
    let own = outbox.clone();
    let (answer, answered) = oneshot::channel();
    let asked = MediaEvent::Hello {
        ticket,
        outbox,
        admit: answer,
    };
    if events.send(asked).await.is_err() {
        return;
    }
    let Ok(Some(id)) = answered.await else {
        let _ = socket.send(refuse(close::REFUSED)).await;
        return;
    };
    socket.get_mut().lift();
    drop(waiting);
    let (mut sink, mut source) = socket.split();
    // Writes run on their own, each bounded: a client that stops reading only ever blocks its
    // writer, never the reader below, a close or a revocation.
    let mut writer = tokio::spawn(async move {
        while let Some(message) = rx.recv().await {
            let closing = matches!(message, Message::Close(_));
            queued.fetch_sub(
                message.len().min(queued.load(Ordering::Acquire)),
                Ordering::AcqRel,
            );
            let sent = tokio::time::timeout(WRITE_LIMIT, sink.send(message)).await;
            if !matches!(sent, Ok(Ok(()))) || closing {
                return;
            }
        }
    });
    let refused = loop {
        tokio::select! {
            _ = shut.notified() => break false,
            _ = &mut writer => break false,
            incoming = source.next() => match incoming {
                Some(Ok(Message::Text(text))) => {
                    if events.send(MediaEvent::Text(id.clone(), text.to_string())).await.is_err() {
                        break false;
                    }
                }
                Some(Ok(Message::Ping(_) | Message::Pong(_))) => {}
                // Binary after the hello is nothing a media connection takes.
                Some(Ok(Message::Binary(_))) => break true,
                _ => break false,
            },
        }
    };
    if refused {
        // The writer still owns the sink: the close frame goes through it, within its grace.
        own.close(close::PROTOCOL);
        let _ = tokio::time::timeout(CLOSE_GRACE, &mut writer).await;
    }
    // Every way out ends the socket (the writer's half with it) and tells the engine.
    writer.abort();
    drop(source);
    let _ = events.send(MediaEvent::Closed(id)).await;
}

/// How long a hello whose ticket ace-media doesn't know yet waits for it. The client got the
/// ticket from the daemon, which wrote `media.ticket` on stdin first, but the two travel on
/// different connections: the hello can come first.
pub const TICKET_WAIT: Duration = Duration::from_secs(1);

struct Waiting {
    ticket: Ticket,
    outbox: Outbox,
    admit: oneshot::Sender<Option<String>>,
    until: std::time::Instant,
}

/// Hellos waiting for their ticket. A ticket that never comes refuses its hello when the wait
/// ends, so a wrong one is answered no sooner than a late one.
#[derive(Default)]
pub struct Hellos(Vec<Waiting>);

impl Hellos {
    /// Presents a hello now, or keeps it until its ticket arrives.
    pub fn present(
        &mut self,
        ticket: Ticket,
        outbox: Outbox,
        admit: oneshot::Sender<Option<String>>,
        claim: &mut dyn FnMut(&[u8]) -> Option<String>,
        outboxes: &mut Outboxes,
    ) {
        let waiting = Waiting {
            ticket,
            outbox,
            admit,
            until: std::time::Instant::now() + TICKET_WAIT,
        };
        if let Some(waiting) = Self::try_claim(waiting, claim, outboxes) {
            self.0.push(waiting);
        }
    }

    /// After anything the engine took (a `media.ticket` among it): tries the waiting hellos
    /// again, and refuses those whose wait is over.
    pub fn retry(
        &mut self,
        claim: &mut dyn FnMut(&[u8]) -> Option<String>,
        outboxes: &mut Outboxes,
    ) {
        if self.0.is_empty() {
            return;
        }
        let now = std::time::Instant::now();
        for waiting in std::mem::take(&mut self.0) {
            match Self::try_claim(waiting, claim, outboxes) {
                Some(waiting) if waiting.until <= now => {
                    let _ = waiting.admit.send(None);
                }
                Some(waiting) => self.0.push(waiting),
                None => {}
            }
        }
    }

    fn try_claim(
        waiting: Waiting,
        claim: &mut dyn FnMut(&[u8]) -> Option<String>,
        outboxes: &mut Outboxes,
    ) -> Option<Waiting> {
        let Some(connection) = claim(&waiting.ticket[..]) else {
            return Some(waiting);
        };
        outboxes.insert(connection.clone(), waiting.outbox);
        let _ = waiting.admit.send(Some(connection));
        None
    }
}

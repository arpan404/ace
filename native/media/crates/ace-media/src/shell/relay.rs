// SPDX-License-Identifier: Apache-2.0
//! Relay stream sockets: the dial to the relay's `/join`, a reader that hands each binary frame
//! to the main loop, and a writer that masks pooled sealed frames in place and returns their
//! buffers. Closing a stream aborts both at once, which shuts the socket, so a revocation's
//! answer follows the shutdown of every socket it covers.
use super::relay_ws::{self, Masks, OP_BINARY, OP_CLOSE, OP_PING, OP_PONG, Parse};
use crate::engine::relay::Pool;
use media_wire::control::Id;
use std::collections::HashMap;
use std::io::IoSlice;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::net::tcp::{OwnedReadHalf, OwnedWriteHalf};
use tokio::sync::mpsc;
use tokio::task::AbortHandle;

/// The relay's own handshake deadline.
const DIAL_DEADLINE: Duration = Duration::from_secs(10);
/// Frames queued for one socket's writer; past it the stream is backed up and closes. The
/// client's flow window (1 MiB) keeps a well-behaved stream far below it.
const WRITE_QUEUE: usize = 256;

pub enum RelayEvent {
    Dialed { stream: Id, socket: Socket },
    Frame { stream: Id, frame: Vec<u8> },
    Ended { stream: Id, reason: &'static str },
}

enum Out {
    Frame(Vec<u8>),
    Pong(Vec<u8>),
}

/// One dialed stream's socket tasks; dropping it shuts the socket.
pub struct Socket {
    tx: mpsc::Sender<Out>,
    tasks: [AbortHandle; 2],
}

impl Drop for Socket {
    fn drop(&mut self) {
        for task in &self.tasks {
            task.abort();
        }
    }
}

pub struct RelaySockets {
    events: mpsc::Sender<RelayEvent>,
    dialing: HashMap<String, AbortHandle>,
    sockets: HashMap<String, Socket>,
    pool: Pool,
}

impl RelaySockets {
    pub fn new(events: mpsc::Sender<RelayEvent>, pool: Pool) -> Self {
        Self {
            events,
            dialing: HashMap::new(),
            sockets: HashMap::new(),
            pool,
        }
    }

    pub fn dial(&mut self, stream: String, url: String) {
        let events = self.events.clone();
        let pool = self.pool.clone();
        let Ok(id) = Id::new(stream.clone()) else {
            return;
        };
        let task = tokio::spawn(async move {
            let opened = tokio::time::timeout(DIAL_DEADLINE, open(&url)).await;
            let event = match opened {
                Ok(Ok((read, write, leftover))) => RelayEvent::Dialed {
                    stream: id.clone(),
                    socket: spawn(id, read, write, leftover, events.clone(), pool),
                },
                _ => RelayEvent::Ended {
                    stream: id,
                    reason: "dial",
                },
            };
            let _ = events.send(event).await;
        });
        self.dialing.insert(stream, task.abort_handle());
    }

    /// The engine took a dialed socket.
    pub fn adopt(&mut self, stream: &Id, socket: Socket) {
        self.dialing.remove(stream.get());
        self.sockets.insert(stream.get().to_owned(), socket);
    }

    /// Queues a sealed frame. False when the stream has no socket or is backed up.
    pub fn send(&mut self, stream: &str, frame: Vec<u8>) -> bool {
        let Some(socket) = self.sockets.get(stream) else {
            self.pool.give(frame);
            return false;
        };
        match socket.tx.try_send(Out::Frame(frame)) {
            Ok(()) => true,
            Err(error) => {
                if let Out::Frame(frame) = error.into_inner() {
                    self.pool.give(frame);
                }
                false
            }
        }
    }

    pub fn close(&mut self, stream: &str) {
        if let Some(task) = self.dialing.remove(stream) {
            task.abort();
        }
        self.sockets.remove(stream);
    }
}

/// TCP connect and the upgrade. Returns the halves and any frame bytes read past the response.
async fn open(url: &str) -> std::io::Result<(OwnedReadHalf, OwnedWriteHalf, Vec<u8>)> {
    let address = relay_ws::address(url).ok_or_else(|| std::io::Error::other("address"))?;
    let stream = TcpStream::connect(&address.authority).await?;
    stream.set_nodelay(true)?;
    let (mut read, mut write) = stream.into_split();
    let key = relay_ws::key();
    write
        .write_all(relay_ws::request(&address, &key).as_bytes())
        .await?;
    let mut head = Vec::with_capacity(1024);
    let mut chunk = [0u8; 1024];
    let end = loop {
        let n = read.read(&mut chunk).await?;
        if n == 0 {
            return Err(std::io::Error::other("closed during upgrade"));
        }
        head.extend_from_slice(&chunk[..n]);
        if let Some(end) = relay_ws::response_end(&head) {
            break end;
        }
        if head.len() > relay_ws::MAX_RESPONSE {
            return Err(std::io::Error::other("upgrade response too long"));
        }
    };
    if !relay_ws::accepted(&head[..end], &key) {
        return Err(std::io::Error::other("upgrade refused"));
    }
    Ok((read, write, head.split_off(end)))
}

fn spawn(
    stream: Id,
    read: OwnedReadHalf,
    write: OwnedWriteHalf,
    leftover: Vec<u8>,
    events: mpsc::Sender<RelayEvent>,
    pool: Pool,
) -> Socket {
    let (tx, rx) = mpsc::channel(WRITE_QUEUE);
    let writer = tokio::spawn(write_frames(
        stream.clone(),
        write,
        rx,
        events.clone(),
        pool,
    ));
    let reader = tokio::spawn(read_frames(stream, read, leftover, tx.clone(), events));
    Socket {
        tx,
        tasks: [reader.abort_handle(), writer.abort_handle()],
    }
}

async fn read_frames(
    stream: Id,
    mut read: OwnedReadHalf,
    mut buffer: Vec<u8>,
    pongs: mpsc::Sender<Out>,
    events: mpsc::Sender<RelayEvent>,
) {
    let reason = loop {
        match relay_ws::parse(&buffer) {
            Parse::Invalid => break "protocol",
            Parse::Frame(frame) if buffer.len() >= frame.header + frame.length => {
                let payload = buffer[frame.header..frame.header + frame.length].to_vec();
                buffer.drain(..frame.header + frame.length);
                match frame.opcode {
                    OP_BINARY => {
                        let event = RelayEvent::Frame {
                            stream: stream.clone(),
                            frame: payload,
                        };
                        if events.send(event).await.is_err() {
                            return;
                        }
                    }
                    OP_PING => {
                        if pongs.try_send(Out::Pong(payload)).is_err() {
                            break "backlog";
                        }
                    }
                    OP_PONG => {}
                    OP_CLOSE => break "closed",
                    _ => break "protocol",
                }
                continue;
            }
            Parse::Frame(_) | Parse::Short => {}
        }
        let start = buffer.len();
        buffer.resize(start + 16 * 1024, 0);
        match read.read(&mut buffer[start..]).await {
            Ok(0) | Err(_) => {
                buffer.truncate(start);
                break "closed";
            }
            Ok(n) => buffer.truncate(start + n),
        }
    };
    let _ = events.send(RelayEvent::Ended { stream, reason }).await;
}

async fn write_frames(
    stream: Id,
    mut write: OwnedWriteHalf,
    mut rx: mpsc::Receiver<Out>,
    events: mpsc::Sender<RelayEvent>,
    pool: Pool,
) {
    let mut masks = Masks::new();
    while let Some(out) = rx.recv().await {
        let (opcode, mut payload) = match out {
            Out::Frame(frame) => (OP_BINARY, frame),
            Out::Pong(data) => (OP_PONG, data),
        };
        let key = masks.next();
        let (head, n) = relay_ws::header(opcode, payload.len(), key);
        relay_ws::mask(&mut payload, key);
        let written = write_all(&mut write, &head[..n], &payload).await;
        if opcode == OP_BINARY {
            pool.give(payload);
        }
        if written.is_err() {
            let _ = events
                .send(RelayEvent::Ended {
                    stream,
                    reason: "write",
                })
                .await;
            return;
        }
    }
    let (head, n) = relay_ws::header(OP_CLOSE, 0, masks.next());
    let _ = write.write_all(&head[..n]).await;
    let _ = write.shutdown().await;
}

/// The header and the payload in as few writes as the socket allows.
async fn write_all(write: &mut OwnedWriteHalf, head: &[u8], payload: &[u8]) -> std::io::Result<()> {
    let total = head.len() + payload.len();
    let mut done = 0;
    while done < total {
        let n = if done < head.len() {
            write
                .write_vectored(&[IoSlice::new(&head[done..]), IoSlice::new(payload)])
                .await?
        } else {
            write.write(&payload[done - head.len()..]).await?
        };
        if n == 0 {
            return Err(std::io::ErrorKind::WriteZero.into());
        }
        done += n;
    }
    Ok(())
}

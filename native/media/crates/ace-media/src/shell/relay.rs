// SPDX-License-Identifier: Apache-2.0
//! A relay stream's socket: the dial to the relay's `/join`, a reader that hands each binary frame
//! to the main loop, and a writer that masks pooled sealed frames in place and returns their
//! buffers. `Socket::shut` closes it gracefully (what was written, then the WebSocket close, with
//! normal linger, bounded) or forcibly (a reset at once), and resolves once every task that
//! owns the socket has ended. The registry is `relay_sockets.rs`.
use super::relay_tls::{Tls, pump_tls};
use super::relay_ws::{self, Masks, OP_BINARY, OP_CLOSE, OP_PING, OP_PONG, Parse};
use crate::engine::relay::{CloseMode, Pool};
use media_wire::control::Id;
use std::io::IoSlice;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::net::tcp::{OwnedReadHalf, OwnedWriteHalf};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

/// The relay's own handshake deadline.
pub(super) const DIAL_DEADLINE: Duration = Duration::from_secs(10);
/// How long a graceful close may take to deliver what was written and the WebSocket close,
/// before it is forced. Well inside the supervisor's 250 ms kill, for `closed` answers.
pub(super) const GRACE: Duration = Duration::from_millis(100);
/// Frames queued for one socket's writer; past it the stream is backed up and closes. The
/// client's flow window (1 MiB) keeps a well-behaved stream far below it.
const WRITE_QUEUE: usize = 256;

pub enum RelayEvent {
    /// The socket is up, in the registry's slot for the stream.
    Dialed {
        stream: Id,
    },
    Frame {
        stream: Id,
        frame: Vec<u8>,
    },
    Ended {
        stream: Id,
        reason: &'static str,
    },
}

pub(super) enum Out {
    Frame(Vec<u8>),
    Pong(Vec<u8>),
    /// A graceful close: send what is queued ahead of this, then the WebSocket close.
    Close,
}

/// One dialed stream's socket tasks, the writer first; dropping it aborts them, which closes
/// the socket with a reset (relay sockets keep a zero linger unless closed gracefully).
pub struct Socket {
    tx: mpsc::Sender<Out>,
    tasks: Vec<JoinHandle<()>>,
}

impl Socket {
    /// Queues a sealed frame; the frame back when the writer is backed up or gone.
    pub(super) fn send(&self, frame: Vec<u8>) -> Result<(), Vec<u8>> {
        self.tx
            .try_send(Out::Frame(frame))
            .map_err(|error| match error.into_inner() {
                Out::Frame(frame) => frame,
                Out::Pong(data) => data,
                Out::Close => Vec::new(),
            })
    }

    /// Shuts the socket. Resolves once every task that owns it has ended, so the socket is
    /// closed: gracefully within `GRACE`, then forced.
    pub(super) async fn shut(mut self, mode: CloseMode) {
        let mut tasks = std::mem::take(&mut self.tasks);
        if mode == CloseMode::Graceful && self.tx.try_send(Out::Close).is_ok() {
            let deadline = tokio::time::Instant::now() + GRACE;
            // The writer delivers what it has and the close, then each task ends as the relay
            // closes its side.
            while let Some(task) = tasks.first_mut() {
                if tokio::time::timeout_at(deadline, task).await.is_err() {
                    break;
                }
                tasks.remove(0);
            }
        }
        for task in &tasks {
            task.abort();
        }
        for task in tasks {
            let _ = task.await;
        }
    }
}

impl Drop for Socket {
    fn drop(&mut self) {
        for task in &self.tasks {
            task.abort();
        }
    }
}

/// A dialed socket, upgraded: plain TCP halves, or a TLS connection; either with the frame bytes
/// read past the upgrade response.
pub(super) enum Opened {
    Plain(OwnedReadHalf, OwnedWriteHalf, Vec<u8>),
    Tls(Box<Tls>, Vec<u8>),
}

/// TCP connect, TLS for `wss://`, and the upgrade. The error is the `relay.failed` reason.
pub(super) async fn open(url: &str) -> Result<Opened, &'static str> {
    let address = relay_ws::address(url).ok_or("address")?;
    let stream = TcpStream::connect(&address.authority)
        .await
        .map_err(|_| "dial")?;
    // First, before anything can fail: a socket dropped without a graceful close resets, so
    // nothing it had queued in the kernel reaches the relay. Only `Out::Close` turns it off.
    stream.set_zero_linger().map_err(|_| "dial")?;
    stream.set_nodelay(true).map_err(|_| "dial")?;
    let key = relay_ws::key();
    let request = relay_ws::request(&address, &key);
    let mut head = Vec::with_capacity(1024);
    match &address.tls {
        Some(name) => {
            let mut tls = Tls::connect(stream, name).await.map_err(|_| "tls")?;
            tls.send(&[request.as_bytes()], &mut head)
                .await
                .map_err(|_| "dial")?;
            let end = loop {
                if let Some(end) = upgraded(&head)? {
                    break end;
                }
                let more = tls.wait_readable().await.is_ok()
                    && matches!(tls.read_ready(), Ok(true))
                    && tls.receive(&mut head).await.is_ok();
                if !more {
                    return Err("dial");
                }
            };
            accept(&head, end, &key)?;
            Ok(Opened::Tls(Box::new(tls), head.split_off(end)))
        }
        None => {
            let (mut read, mut write) = stream.into_split();
            write
                .write_all(request.as_bytes())
                .await
                .map_err(|_| "dial")?;
            let mut chunk = [0u8; 1024];
            let end = loop {
                if let Some(end) = upgraded(&head)? {
                    break end;
                }
                match read.read(&mut chunk).await {
                    Ok(n) if n > 0 => head.extend_from_slice(&chunk[..n]),
                    _ => return Err("dial"),
                }
            };
            accept(&head, end, &key)?;
            Ok(Opened::Plain(read, write, head.split_off(end)))
        }
    }
}

/// Where the upgrade response ends, once it has; too long a response fails the dial.
fn upgraded(head: &[u8]) -> Result<Option<usize>, &'static str> {
    match relay_ws::response_end(head) {
        Some(end) => Ok(Some(end)),
        None if head.len() > relay_ws::MAX_RESPONSE => Err("dial"),
        None => Ok(None),
    }
}

fn accept(head: &[u8], end: usize, key: &str) -> Result<(), &'static str> {
    if relay_ws::accepted(&head[..end], key) {
        Ok(())
    } else {
        Err("dial")
    }
}

pub(super) fn spawn_tls(
    stream: Id,
    tls: Box<Tls>,
    leftover: Vec<u8>,
    events: mpsc::Sender<RelayEvent>,
    pool: Pool,
) -> Socket {
    let (tx, rx) = mpsc::channel(WRITE_QUEUE);
    let task = tokio::spawn(pump_tls(stream, tls, leftover, rx, events, pool));
    Socket {
        tx,
        tasks: vec![task],
    }
}

pub(super) fn spawn(
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
        tasks: vec![writer, reader],
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
            Out::Close => return finish(&mut write, &mut masks).await,
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
}

/// A graceful close's last bytes: the WebSocket close, then normal linger (so what the kernel
/// holds is delivered, not reset) and our FIN.
async fn finish(write: &mut OwnedWriteHalf, masks: &mut Masks) {
    let (head, n) = relay_ws::header(OP_CLOSE, 0, masks.next());
    if write.write_all(&head[..n]).await.is_err() {
        return;
    }
    #[allow(deprecated)] // `None` only turns linger off; nothing blocks on drop.
    let _ = write.as_ref().set_linger(None);
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

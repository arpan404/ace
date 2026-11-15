// SPDX-License-Identifier: Apache-2.0
//! A relay stream's socket: the dial to the relay's `/join`, a reader that hands each binary frame
//! to the main loop, and a writer that masks pooled sealed frames in place and returns their
//! buffers. `Socket::shut` closes it gracefully (what was written, then the WebSocket close, with
//! normal linger, bounded) or forcibly (a reset at once), and resolves once every task that
//! owns the socket has ended. The registry is `relay_sockets.rs`.
use super::relay_tls::{Tls, pump_tls};
use super::relay_ws::{self, Masks, OP_BINARY, OP_CLOSE, OP_PING, OP_PONG, Parse};
use crate::engine::relay::{CloseMode, Pool};
use crate::os::SocketHandle;
use media_wire::control::Id;
use std::io::IoSlice;
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::net::tcp::{OwnedReadHalf, OwnedWriteHalf};
use tokio::sync::Notify;
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
    /// A close finished: the stream's socket is gone.
    Closed {
        stream: Id,
    },
}

pub(super) enum Out {
    Frame(Vec<u8>),
    Pong(Vec<u8>),
    /// A graceful close: send what is queued ahead of this, then the WebSocket close.
    Close,
    /// Makes the writer panic (tests).
    #[cfg(test)]
    Panic,
}

/// How a stream's socket makes its final close, decided in one place: the second handle on the
/// socket, and whether a revocation forced the close. A close in progress and an escalation both
/// take this lock, so a force either lands before the handle is closed (and the close resets) or
/// finds it closed already.
#[derive(Default)]
pub struct Finale {
    handle: Option<SocketHandle>,
    forced: bool,
    /// Holds the close between its tasks ending and the handle closing (tests).
    #[cfg(test)]
    pub(super) pause: Option<(Arc<Notify>, Arc<Notify>)>,
}

impl Finale {
    pub(super) fn hold(&mut self, handle: SocketHandle) {
        self.handle = Some(handle);
    }

    /// A revocation reached the close: the final close resets. False when the socket is closed
    /// already, so nothing is left to force.
    pub(super) fn force(&mut self) -> bool {
        self.forced = true;
        self.handle.is_some()
    }
}

pub(super) type SharedFinale = Arc<Mutex<Finale>>;

fn finale(shared: &SharedFinale) -> std::sync::MutexGuard<'_, Finale> {
    shared
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// One dialed stream's socket: its tasks, the writer first. Dropping it aborts the tasks; the
/// socket then closes with a reset (relay sockets keep a zero linger unless a graceful close
/// turned it off). Its final close is the stream's `Finale`'s.
pub struct Socket {
    tx: mpsc::Sender<Out>,
    tasks: Vec<JoinHandle<()>>,
    /// Held by every task that owns the socket: none left means none is running (read by
    /// tests).
    #[cfg_attr(not(test), allow(dead_code))]
    alive: Weak<()>,
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
                #[cfg(test)]
                Out::Panic => Vec::new(),
            })
    }

    /// Whether a task that owns the socket is still running (tests).
    #[cfg(test)]
    pub(super) fn alive(&self) -> Weak<()> {
        self.alive.clone()
    }

    /// Makes the writer panic, as a bug in it would (tests).
    #[cfg(test)]
    pub(super) fn panic_writer(&self) {
        let _ = self.tx.try_send(Out::Panic);
    }

    /// Aborts the writer alone, as a close that finished too early would (tests).
    #[cfg(test)]
    pub(super) fn abort_writer(&self) {
        if let Some(writer) = self.tasks.first() {
            writer.abort();
        }
    }

    /// Shuts the socket. Resolves once every task that owns it has ended and the socket is
    /// closed. A graceful close sends what is queued and the WebSocket close, within `GRACE`;
    /// past it, or once `force` is notified (a revocation reaching a close in progress), the
    /// close is forced. Only a graceful close that completed ends without a reset.
    pub(super) async fn shut(mut self, mode: CloseMode, force: Arc<Notify>, last: SharedFinale) {
        let mut tasks = std::mem::take(&mut self.tasks);
        let mut finished = false;
        if mode == CloseMode::Graceful && self.tx.try_send(Out::Close).is_ok() {
            let deadline = tokio::time::Instant::now() + GRACE;
            let forced = force.notified();
            tokio::pin!(forced);
            // The writer delivers what it has and the close, then each task ends as the relay
            // closes its side.
            while let Some(task) = tasks.first_mut() {
                tokio::select! {
                    biased;
                    () = &mut forced => break,
                    ended = tokio::time::timeout_at(deadline, task) => {
                        if ended.is_err() {
                            break;
                        }
                        tasks.remove(0);
                    }
                }
            }
            finished = tasks.is_empty();
        }
        for task in &tasks {
            task.abort();
        }
        for task in tasks {
            let _ = task.await;
        }
        #[cfg(test)]
        {
            let pause = finale(&last).pause.clone();
            if let Some((reached, release)) = pause {
                reached.notify_one();
                release.notified().await;
            }
        }
        // Every task is gone, so nothing else can turn the linger back off; and under the lock a
        // force that came at any moment until now is seen.
        let mut last = finale(&last);
        if let Some(handle) = last.handle.take() {
            // Set on this handle either way: on Windows each duplicate keeps its own linger.
            if !finished || last.forced {
                handle.reset_on_close();
            } else {
                handle.linger_off();
            }
            drop(handle);
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
    Plain(OwnedReadHalf, OwnedWriteHalf, Vec<u8>, SocketHandle),
    Tls(Box<Tls>, Vec<u8>, SocketHandle),
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
    // Required: without it a close could not be forced to reset.
    let handle = SocketHandle::of(&stream).ok_or("dial")?;
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
            Ok(Opened::Tls(Box::new(tls), head.split_off(end), handle))
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
            Ok(Opened::Plain(read, write, head.split_off(end), handle))
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

/// Spawns one of a socket's tasks under supervision: if it panics, the stream ends as if its
/// socket had (`Ended` with reason `panic`), so the main loop force-closes what is left: the other
/// tasks joined and the socket reset. Every other way a task ends is reported by the task itself
/// or is part of a close.
fn supervised(
    stream: Id,
    events: mpsc::Sender<RelayEvent>,
    task: impl Future<Output = ()> + Send + 'static,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        use futures_util::FutureExt;
        // The task's halves and token are dropped while it unwinds, before this reports.
        if std::panic::AssertUnwindSafe(task)
            .catch_unwind()
            .await
            .is_err()
        {
            let _ = events
                .send(RelayEvent::Ended {
                    stream,
                    reason: "panic",
                })
                .await;
        }
    })
}

pub(super) fn spawn_tls(
    stream: Id,
    tls: Box<Tls>,
    leftover: Vec<u8>,
    events: mpsc::Sender<RelayEvent>,
    pool: Pool,
) -> Socket {
    let (tx, rx) = mpsc::channel(WRITE_QUEUE);
    let token = Arc::new(());
    let alive = Arc::downgrade(&token);
    let ends = events.clone();
    let task = supervised(stream.clone(), ends, async move {
        let _token = token;
        pump_tls(stream, tls, leftover, rx, events, pool).await;
    });
    Socket {
        tx,
        tasks: vec![task],
        alive,
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
    let token = Arc::new(());
    let alive = Arc::downgrade(&token);
    let writing = token.clone();
    let writer = supervised(stream.clone(), events.clone(), {
        let (stream, events) = (stream.clone(), events.clone());
        async move {
            let _token = writing;
            write_frames(stream, write, rx, events, pool).await;
        }
    });
    let pongs = tx.clone();
    let reader = supervised(stream.clone(), events.clone(), async move {
        let _token = token;
        read_frames(stream, read, leftover, pongs, events).await;
    });
    Socket {
        tx,
        tasks: vec![writer, reader],
        alive,
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

/// The writer's half, released without shutting the write direction down (tokio's own drop does),
/// on every path, an abort's included. Once both directions are shut some platforms (Darwin)
/// refuse socket options, so the final close could no longer be made a reset; and a FIN sent
/// early can't be taken back. Our FIN comes with the final close.
struct Unshut(Option<OwnedWriteHalf>);

impl Drop for Unshut {
    fn drop(&mut self) {
        if let Some(write) = self.0.take() {
            write.forget();
        }
    }
}

async fn write_frames(
    stream: Id,
    write: OwnedWriteHalf,
    rx: mpsc::Receiver<Out>,
    events: mpsc::Sender<RelayEvent>,
    pool: Pool,
) {
    let mut held = Unshut(Some(write));
    if let Some(write) = held.0.as_mut() {
        write_to(stream, write, rx, events, pool).await;
    }
}

async fn write_to(
    stream: Id,
    write: &mut OwnedWriteHalf,
    mut rx: mpsc::Receiver<Out>,
    events: mpsc::Sender<RelayEvent>,
    pool: Pool,
) {
    let mut masks = Masks::new();
    while let Some(out) = rx.recv().await {
        let (opcode, mut payload) = match out {
            Out::Frame(frame) => (OP_BINARY, frame),
            Out::Pong(data) => (OP_PONG, data),
            Out::Close => return finish(write, &mut masks).await,
            #[cfg(test)]
            Out::Panic => panic!("a writer panic, injected by a test"),
        };
        let key = masks.next();
        let (head, n) = relay_ws::header(opcode, payload.len(), key);
        relay_ws::mask(&mut payload, key);
        let written = write_all(write, &head[..n], &payload).await;
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

/// A graceful close's last bytes: the WebSocket close, then normal linger, so what the kernel
/// holds is delivered when the socket closes rather than reset.
async fn finish(write: &mut OwnedWriteHalf, masks: &mut Masks) {
    let (head, n) = relay_ws::header(OP_CLOSE, 0, masks.next());
    if write.write_all(&head[..n]).await.is_err() {
        return;
    }
    #[allow(deprecated)] // `None` only turns linger off; nothing blocks on drop.
    let _ = write.as_ref().set_linger(None);
    // No shutdown here: our FIN comes with the final close, which a revocation can still turn
    // into a reset (once a FIN is out, a zero-linger close no longer resets on every platform).
    // The relay answers the WebSocket close by closing, which ends the reader.
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

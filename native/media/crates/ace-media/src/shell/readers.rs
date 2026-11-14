// SPDX-License-Identifier: Apache-2.0
//! Sources ace-media reads itself (E3b): serve-sim's `/stream.avcc` for a Simulator. One
//! coordinating thread per source, and one blocking thread per HTTP subscription. A keyframe
//! request opens a second subscription, switches to it at its first IDR and closes the old one,
//! so the picture never stops while a keyframe is on its way; serve-sim starts every
//! subscription with its description and an IDR. Units go out on the same channel as the
//! picture encoders', under the source's encoder token.
use super::pictures::Encoded;
use crate::encode::worker::Output;
use crate::serve_sim::{HttpBody, Records, Translator, loopback_url};
use media_wire::frame::MediaFrame;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{Shutdown, SocketAddr, TcpStream};
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender, channel};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};
use tokio::sync::mpsc;

/// Longest a connect may take: serve-sim is on this machine.
const CONNECT: Duration = Duration::from_secs(2);
/// Longest a new subscription may take to send its first IDR before it is given up.
const KEY_DEADLINE: Duration = Duration::from_secs(5);
/// A closed reader still running this long after its close is stuck.
pub const STUCK_AFTER_MS: u64 = 2_000;

enum Message {
    Key,
    Drain,
    /// The source's reader ends (the coordinator holds a sender of its own, for subscriptions).
    Close,
    Frame(u32, MediaFrame),
    Ended(u32, String),
}

struct Handle {
    messages: Sender<Message>,
    thread: JoinHandle<()>,
}

pub struct Readers {
    outputs: mpsc::Sender<Encoded>,
    threads: HashMap<u64, Handle>,
    closing: Vec<(JoinHandle<()>, u64)>,
}

impl Readers {
    pub fn new(outputs: mpsc::Sender<Encoded>) -> Self {
        Self {
            outputs,
            threads: HashMap::new(),
            closing: Vec::new(),
        }
    }

    /// Starts reading `url` for `source` under `token`. A URL that isn't serve-sim's loopback
    /// address fails the source at once.
    pub fn open(&mut self, source: &str, token: u64, url: &str) {
        let failed = |reason: &str| (source.to_owned(), token, Output::Failed(reason.into()));
        let Some((port, path)) = loopback_url(url) else {
            let _ = self.outputs.try_send(failed("reader-address"));
            return;
        };
        let (messages, received) = channel();
        let outputs = self.outputs.clone();
        let own = messages.clone();
        let name = source.to_owned();
        let spawned = std::thread::Builder::new()
            .name("ace-media-reader".into())
            .spawn(move || {
                let addr = SocketAddr::from(([127, 0, 0, 1], port));
                run(
                    Coordinator::new(addr, path, own),
                    received,
                    outputs,
                    (name, token),
                );
            });
        match spawned {
            Ok(thread) => {
                self.threads.insert(token, Handle { messages, thread });
            }
            Err(_) => {
                let _ = self.outputs.try_send(failed("reader-failed"));
            }
        }
    }

    pub fn has(&self, token: u64) -> bool {
        self.threads.contains_key(&token)
    }

    pub fn key(&mut self, token: u64) {
        if let Some(handle) = self.threads.get(&token) {
            let _ = handle.messages.send(Message::Key);
        }
    }

    /// The source closed: every unit read has gone out already, so the reader says so at once.
    pub fn drain(&mut self, token: u64) {
        if let Some(handle) = self.threads.get(&token) {
            let _ = handle.messages.send(Message::Drain);
        }
    }

    pub fn close(&mut self, token: u64, now_ms: u64) {
        if let Some(handle) = self.threads.remove(&token) {
            let _ = handle.messages.send(Message::Close);
            self.closing.push((handle.thread, now_ms));
        }
    }

    /// Closed readers still running [`STUCK_AFTER_MS`] after their close.
    pub fn stuck(&mut self, now_ms: u64) -> usize {
        self.closing.retain(|(thread, _)| !thread.is_finished());
        self.closing
            .iter()
            .filter(|(_, closed)| now_ms.saturating_sub(*closed) >= STUCK_AFTER_MS)
            .count()
    }
}

/// One source's subscriptions: the one whose units go out, and one opened for a keyframe.
struct Coordinator {
    addr: SocketAddr,
    path: String,
    own: Sender<Message>,
    last: u32,
    active: Option<u32>,
    next: Option<(u32, Instant)>,
    streams: HashMap<u32, TcpStream>,
}

impl Coordinator {
    fn new(addr: SocketAddr, path: String, own: Sender<Message>) -> Self {
        Self {
            addr,
            path,
            own,
            last: 0,
            active: None,
            next: None,
            streams: HashMap::new(),
        }
    }

    /// Opens a subscription as the next one; its first IDR makes it the active one.
    fn subscribe(&mut self) -> Result<(), String> {
        self.last += 1;
        let id = self.last;
        let stream = TcpStream::connect_timeout(&self.addr, CONNECT).map_err(|e| e.to_string())?;
        let mut writer = stream.try_clone().map_err(|e| e.to_string())?;
        let request = format!(
            "GET {} HTTP/1.1\r\nHost: {}\r\nAccept: application/octet-stream\r\nConnection: close\r\n\r\n",
            self.path, self.addr
        );
        writer
            .write_all(request.as_bytes())
            .map_err(|e| e.to_string())?;
        let own = self.own.clone();
        std::thread::Builder::new()
            .name("ace-media-subscription".into())
            .spawn(move || subscription(id, writer, own))
            .map_err(|e| e.to_string())?;
        self.streams.insert(id, stream);
        self.next = Some((id, Instant::now()));
        Ok(())
    }

    fn end(&mut self, id: u32) {
        if let Some(stream) = self.streams.remove(&id) {
            let _ = stream.shutdown(Shutdown::Both);
        }
    }

    fn end_all(&mut self) {
        for (_, stream) in self.streams.drain() {
            let _ = stream.shutdown(Shutdown::Both);
        }
    }
}

fn run(
    mut coordinator: Coordinator,
    messages: Receiver<Message>,
    outputs: mpsc::Sender<Encoded>,
    (source, token): (String, u64),
) {
    let send = |output: Output| {
        outputs
            .blocking_send((source.clone(), token, output))
            .is_ok()
    };
    if let Err(reason) = coordinator.subscribe() {
        let _ = send(Output::Failed(format!("reader-unreachable: {reason}")));
        return;
    }
    loop {
        // A keyframe subscription that never sent its IDR is given up; the active one goes on.
        if let Some((id, opened)) = coordinator.next
            && opened.elapsed() >= KEY_DEADLINE
            && coordinator.active.is_some()
        {
            coordinator.end(id);
            coordinator.next = None;
        }
        let message = match messages.recv_timeout(Duration::from_millis(250)) {
            Ok(message) => message,
            Err(RecvTimeoutError::Timeout) => continue,
            Err(RecvTimeoutError::Disconnected) => break,
        };
        match message {
            Message::Frame(id, frame) => {
                let key = frame.flags & 1 != 0;
                if key && coordinator.next.is_some_and(|(next, _)| next == id) {
                    if let Some(previous) = coordinator.active.replace(id) {
                        coordinator.end(previous);
                    }
                    coordinator.next = None;
                }
                if coordinator.active == Some(id) && !send(Output::Unit(frame)) {
                    break;
                }
            }
            Message::Key => {
                if coordinator.next.is_none()
                    && let Err(reason) = coordinator.subscribe()
                {
                    // The active subscription goes on; the next request tries again.
                    let _ = reason;
                }
            }
            Message::Ended(id, reason) => {
                let first = coordinator.active.is_none()
                    && coordinator.next.is_some_and(|(next, _)| next == id);
                if coordinator.active == Some(id) || first {
                    let _ = send(Output::Failed(format!("reader-ended: {reason}")));
                    break;
                }
                if coordinator.next.is_some_and(|(next, _)| next == id) {
                    coordinator.next = None;
                }
                coordinator.streams.remove(&id);
            }
            Message::Drain => {
                let _ = send(Output::Drained);
                break;
            }
            Message::Close => break,
        }
    }
    coordinator.end_all();
}

/// Reads one subscription until it ends, handing on each unit it carries.
fn subscription(id: u32, mut stream: TcpStream, own: Sender<Message>) {
    let (mut http, mut records, mut translate) = (
        HttpBody::default(),
        Records::default(),
        Translator::default(),
    );
    let (mut buffer, mut body, mut found) = (vec![0; 64 * 1024], Vec::new(), Vec::new());
    let reason = loop {
        let read = match stream.read(&mut buffer) {
            Ok(0) => break "serve-sim ended the stream".to_owned(),
            Ok(read) => read,
            Err(error) => break error.to_string(),
        };
        body.clear();
        if let Err(error) = http.push(&buffer[..read], &mut body) {
            break format!("{error:?}");
        }
        if let Err(error) = records.push(&body, &mut found) {
            break format!("{error:?}");
        }
        let mut failed = None;
        for record in found.drain(..) {
            match translate.frame(record) {
                Ok(Some(frame)) => {
                    if own.send(Message::Frame(id, frame)).is_err() {
                        return;
                    }
                }
                Ok(None) => {}
                Err(error) => {
                    failed = Some(format!("{error:?}"));
                    break;
                }
            }
        }
        if let Some(reason) = failed {
            break reason;
        }
        if http.finished() {
            break "serve-sim ended the stream".to_owned();
        }
    };
    let _ = own.send(Message::Ended(id, reason));
}

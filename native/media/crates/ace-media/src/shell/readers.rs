// SPDX-License-Identifier: Apache-2.0
//! Sources ace-media reads itself (E3b): serve-sim's `/stream.avcc` for a Simulator. One
//! coordinating thread per source, and one blocking thread per HTTP subscription. A keyframe
//! request opens a second subscription, switches to it at its first IDR and closes the old one,
//! so the picture never stops while a keyframe is on its way; serve-sim starts every
//! subscription with its description and an IDR. Units go out on the same channel as the
//! picture encoders', under the source's encoder token.
use super::pictures::Encoded;
use crate::encode::worker::Output;
use crate::serve_sim::{HttpBody, Record, Records, Translator, loopback_url};
use media_wire::control::EncodeSpec;
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
    /// The encodes a viewer needs: one re-encodes the stream (macOS), none passes it through.
    Configure(Vec<EncodeSpec>),
    Drain,
    /// The source's reader ends (the coordinator holds a sender of its own, for subscriptions).
    Close,
    Record(u32, Record),
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

    pub fn configure(&mut self, token: u64, encodes: Vec<EncodeSpec>) {
        if let Some(handle) = self.threads.get(&token) {
            let _ = handle.messages.send(Message::Configure(encodes));
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
    /// Each subscription's decoder configuration: each opens with its own description.
    translators: HashMap<u32, Translator>,
    #[cfg(target_os = "macos")]
    transcode: Option<super::sim_transcode::Transcode>,
    reported: Option<media_wire::capability::Acceleration>,
    started: Instant,
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
            translators: HashMap::new(),
            #[cfg(target_os = "macos")]
            transcode: None,
            reported: None,
            started: Instant::now(),
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

    fn transcoding(&self) -> bool {
        #[cfg(target_os = "macos")]
        return self.transcode.is_some();
        #[cfg(not(target_os = "macos"))]
        return false;
    }

    /// One record of subscription `id`: the units out, passed through or re-encoded.
    fn record(&mut self, id: u32, record: Record, out: &mut Vec<Output>) -> Result<(), String> {
        if matches!(record, Record::Key(_)) && self.next.is_some_and(|(next, _)| next == id) {
            if let Some(previous) = self.active.replace(id) {
                self.end(previous);
            }
            self.next = None;
        }
        let translator = self.translators.entry(id).or_default();
        if self.active != Some(id) {
            // Not this subscription's turn yet, but its description is needed when it comes.
            if matches!(record, Record::Description(_)) {
                translator.frame(record).map_err(|e| format!("{e:?}"))?;
            }
            return Ok(());
        }
        #[cfg(target_os = "macos")]
        if let Some(transcode) = &mut self.transcode {
            if matches!(record, Record::Description(_)) {
                translator.frame(record).map_err(|e| format!("{e:?}"))?;
                return Ok(());
            }
            let pts = self.started.elapsed().as_micros() as u64;
            let Some(unit) = translator.source(&record, pts) else {
                return Ok(());
            };
            let mut frames = Vec::new();
            transcode
                .push(&unit, &mut frames)
                .map_err(|e| format!("transcode: {e:?}"))?;
            out.extend(frames.into_iter().map(Output::Unit));
            let acceleration = transcode.acceleration();
            if self.reported.as_ref() != Some(&acceleration) {
                self.reported = Some(acceleration.clone());
                out.push(Output::Report(acceleration));
            }
            return Ok(());
        }
        if let Some(frame) = translator.frame(record).map_err(|e| format!("{e:?}"))? {
            out.push(Output::Unit(frame));
        }
        Ok(())
    }

    /// The source closed: what a re-encode still holds goes out before the drain is reported.
    fn flush(&mut self, out: &mut Vec<Output>) {
        #[cfg(target_os = "macos")]
        if let Some(transcode) = &mut self.transcode {
            let mut frames = Vec::new();
            let _ = transcode.flush(&mut frames);
            out.extend(frames.into_iter().map(Output::Unit));
        }
        let _ = out;
    }

    /// Units a re-encode finished between records.
    fn poll(&mut self, out: &mut Vec<Output>) -> Result<(), String> {
        #[cfg(target_os = "macos")]
        if let Some(transcode) = &mut self.transcode {
            let mut frames = Vec::new();
            transcode
                .poll(&mut frames)
                .map_err(|e| format!("transcode: {e:?}"))?;
            out.extend(frames.into_iter().map(Output::Unit));
        }
        let _ = out;
        Ok(())
    }

    /// A viewer's encodes: re-encode at the first one's size and rate, or pass through. Either
    /// way the stream starts again at a fresh IDR, which a decoder needs.
    fn configure(&mut self, encodes: &[EncodeSpec]) -> Result<(), String> {
        #[cfg(target_os = "macos")]
        {
            match (encodes.first(), &mut self.transcode) {
                (None, slot) => *slot = None,
                (Some(spec), Some(transcode)) => transcode
                    .configure(spec)
                    .map_err(|e| format!("transcode: {e:?}"))?,
                (Some(spec), slot) => {
                    *slot = Some(
                        super::sim_transcode::Transcode::new(spec)
                            .map_err(|e| format!("transcode: {e:?}"))?,
                    );
                }
            }
            self.reported = None;
        }
        // Elsewhere the stream passes through: nothing routes a Simulator here off a Mac.
        #[cfg(not(target_os = "macos"))]
        let _ = encodes;
        if self.next.is_none() {
            self.subscribe()?;
        }
        Ok(())
    }

    /// A keyframe: the encoder's next picture while re-encoding, else a fresh subscription. The
    /// active subscription goes on if a new one can't open; the next request tries again.
    fn key(&mut self) {
        #[cfg(target_os = "macos")]
        if let Some(transcode) = &mut self.transcode {
            return transcode.key();
        }
        if self.next.is_none() {
            let _ = self.subscribe();
        }
    }

    fn end(&mut self, id: u32) {
        self.translators.remove(&id);
        if let Some(stream) = self.streams.remove(&id) {
            let _ = stream.shutdown(Shutdown::Both);
        }
    }

    fn end_all(&mut self) {
        self.translators.clear();
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
        // While re-encoding, the encoder's own threads finish units between records.
        let wait = if coordinator.transcoding() {
            Duration::from_millis(4)
        } else {
            Duration::from_millis(250)
        };
        let mut out = Vec::new();
        let step = match messages.recv_timeout(wait) {
            Ok(Message::Record(id, record)) => coordinator.record(id, record, &mut out),
            Ok(Message::Configure(encodes)) => coordinator.configure(&encodes),
            Ok(Message::Key) => {
                coordinator.key();
                Ok(())
            }
            Ok(Message::Ended(id, reason)) => {
                let first = coordinator.active.is_none()
                    && coordinator.next.is_some_and(|(next, _)| next == id);
                if coordinator.active == Some(id) || first {
                    Err(format!("ended: {reason}"))
                } else {
                    if coordinator.next.is_some_and(|(next, _)| next == id) {
                        coordinator.next = None;
                    }
                    coordinator.end(id);
                    Ok(())
                }
            }
            Ok(Message::Drain) => {
                let mut held = Vec::new();
                coordinator.flush(&mut held);
                let _ = held.into_iter().all(&send) && send(Output::Drained);
                break;
            }
            Ok(Message::Close) | Err(RecvTimeoutError::Disconnected) => break,
            Err(RecvTimeoutError::Timeout) => coordinator.poll(&mut out),
        };
        if let Err(reason) = step {
            let _ = send(Output::Failed(format!("reader-{reason}")));
            break;
        }
        if !out.into_iter().all(&send) {
            break;
        }
    }
    coordinator.end_all();
}

/// Reads one subscription until it ends, handing on each record it carries.
fn subscription(id: u32, mut stream: TcpStream, own: Sender<Message>) {
    let (mut http, mut records) = (HttpBody::default(), Records::default());
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
        for record in found.drain(..) {
            if own.send(Message::Record(id, record)).is_err() {
                return;
            }
        }
        if http.finished() {
            break "serve-sim ended the stream".to_owned();
        }
    };
    let _ = own.send(Message::Ended(id, reason));
}

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
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender, channel};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};
use tokio::sync::mpsc;

/// Longest a connect may take: serve-sim is on this machine.
const CONNECT: Duration = Duration::from_secs(2);
/// Longest a new subscription may take to send its first IDR before it is given up.
const KEY_DEADLINE: Duration = Duration::from_secs(5);
/// Longest the first subscription may take to send its first IDR. Past it the source fails, and
/// the daemon reads serve-sim itself again, inside its 2 s fallback.
const FIRST_KEY_DEADLINE: Duration = Duration::from_millis(1_500);
/// Most bytes of records waiting for the coordinator; past it records are dropped to the next
/// keyframe, which is asked for.
const RECORD_BUDGET: usize = 8 * 1024 * 1024;
/// Longest the coordinator waits for a record before it looks at control again.
const IDLE_WAIT: Duration = Duration::from_millis(20);
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
    /// Subscription `id` dropped records past the budget: it waits for a keyframe.
    Gap(u32),
    Ended(u32, String),
}

/// What a subscription does with a record, given what is already waiting for the coordinator.
#[derive(Debug, PartialEq, Eq)]
enum Admit {
    Send,
    Drop,
    /// The first record dropped past the budget: a keyframe is needed to start again.
    DropAndAsk,
}

/// The byte budget on records waiting: past it, deltas would pile up without bound behind a
/// slow re-encode, so records are dropped until a keyframe that fits.
#[derive(Default)]
struct Admission {
    skipping: bool,
}

impl Admission {
    fn admit(&mut self, key: bool, bytes: usize, queued: usize, limit: usize) -> Admit {
        let fits = queued.saturating_add(bytes) <= limit;
        if self.skipping {
            if key && fits {
                self.skipping = false;
                return Admit::Send;
            }
            return Admit::Drop;
        }
        if fits {
            return Admit::Send;
        }
        self.skipping = true;
        Admit::DropAndAsk
    }
}

/// The coordinator's two queues: control (keyframes, encodes, drain, close) is always taken
/// before records, so a close never waits behind queued video.
struct Mailbox {
    control: Receiver<Message>,
    data: Receiver<Message>,
}

impl Mailbox {
    /// The mailbox, its control sender and its data sender.
    fn new() -> (Self, Sender<Message>, Sender<Message>) {
        let (control_tx, control) = channel();
        let (data_tx, data) = channel();
        (Self { control, data }, control_tx, data_tx)
    }

    fn next(&self, wait: Duration) -> Result<Message, RecvTimeoutError> {
        match self.control.try_recv() {
            Ok(message) => return Ok(message),
            // The reader's owner is gone: as good as a close.
            Err(std::sync::mpsc::TryRecvError::Disconnected) => return Ok(Message::Close),
            Err(std::sync::mpsc::TryRecvError::Empty) => {}
        }
        match self.data.recv_timeout(wait) {
            Ok(message) => Ok(message),
            Err(error) => self.control.try_recv().map_err(|_| error),
        }
    }
}

/// A record's size against the budget.
fn record_bytes(record: &Record) -> usize {
    match record {
        Record::Description(body) | Record::Key(body) | Record::Delta(body) => body.len(),
        Record::Other(_) => 0,
    }
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
        let (mailbox, messages, own) = Mailbox::new();
        let outputs = self.outputs.clone();
        let name = source.to_owned();
        let spawned = std::thread::Builder::new()
            .name("ace-media-reader".into())
            .spawn(move || {
                let addr = SocketAddr::from(([127, 0, 0, 1], port));
                run(
                    Coordinator::new(addr, path, own),
                    mailbox,
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
    /// Bytes of records waiting for the coordinator, across its subscriptions.
    queued: Arc<AtomicUsize>,
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
            queued: Arc::default(),
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
        let queued = self.queued.clone();
        std::thread::Builder::new()
            .name("ace-media-subscription".into())
            .spawn(move || subscription(id, writer, own, queued))
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
    mailbox: Mailbox,
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
        // The first subscription must start in time, or the daemon reads serve-sim again.
        if coordinator.active.is_none()
            && coordinator
                .next
                .is_some_and(|(_, opened)| opened.elapsed() >= FIRST_KEY_DEADLINE)
        {
            let _ = send(Output::Failed(
                "reader-stalled: serve-sim sent no keyframe in time".into(),
            ));
            break;
        }
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
            IDLE_WAIT
        };
        let mut out = Vec::new();
        let step = match mailbox.next(wait) {
            Ok(Message::Record(id, record)) => {
                coordinator
                    .queued
                    .fetch_sub(record_bytes(&record), Ordering::AcqRel);
                coordinator.record(id, record, &mut out)
            }
            Ok(Message::Gap(id)) => {
                // Records were dropped: start again from a fresh subscription's IDR.
                if coordinator.active == Some(id) && coordinator.next.is_none() {
                    let _ = coordinator.subscribe();
                }
                Ok(())
            }
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
fn subscription(id: u32, mut stream: TcpStream, own: Sender<Message>, queued: Arc<AtomicUsize>) {
    let (mut http, mut records) = (HttpBody::default(), Records::default());
    let mut admission = Admission::default();
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
            let bytes = record_bytes(&record);
            let key = matches!(record, Record::Key(_));
            // A description always goes: it is small, and the next keyframe needs it.
            let admit = if matches!(record, Record::Description(_)) {
                Admit::Send
            } else {
                admission.admit(key, bytes, queued.load(Ordering::Acquire), RECORD_BUDGET)
            };
            let sent = match admit {
                Admit::Send => {
                    queued.fetch_add(bytes, Ordering::AcqRel);
                    own.send(Message::Record(id, record))
                }
                Admit::Drop => Ok(()),
                Admit::DropAndAsk => own.send(Message::Gap(id)),
            };
            if sent.is_err() {
                return;
            }
        }
        if http.finished() {
            break "serve-sim ended the stream".to_owned();
        }
    };
    let _ = own.send(Message::Ended(id, reason));
}

#[cfg(test)]
#[path = "readers_tests.rs"]
mod tests;

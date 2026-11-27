// SPDX-License-Identifier: Apache-2.0
//! The host's control session with a relay (`apps/relay/src/host.ts`): registration over the
//! control handshake, the generation clients wait for, the control messages the relay sends, the
//! client slots, retry with backoff, and the channel a `client` ticket opens. The sockets are
//! [`FrameIo`]s, so the same code runs on the relay link and on a test's pipe.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

use ace_json::Value;
use zeroize::Zeroizing;

use crate::codec::{Codec, Kind, fragment_cost};
use crate::error::RelayError;
use crate::host::frame_io::FrameIo;
use crate::host::link::{Incoming, Link, relay_address};
use crate::host::{
    Backoff, ClientSlots, ControlMessage, HTTP_FEATURE, HostOptions, MEDIA_FEATURE, Registration,
    RejectReason, valid_ticket,
};
use crate::noise::{KeyPair, NoiseNk, NoiseXx, SessionKeys};
use crate::socket::{Frame, HostChannel};
use crate::wire::{CONTROL_PROLOGUE, NK_REFUSAL_MS, NK_STREAM_PROLOGUE, STREAM_PROLOGUE};

/// The XX first message is exactly this many bytes; anything else is NK (`host.ts:150`).
pub const XX_FIRST_MESSAGE: usize = 32;

/// An injected clock, milliseconds since the epoch.
pub type Clock = Arc<dyn Fn() -> i64 + Send + Sync>;

/// The daemon's handler for one opened channel, shared by the loop's threads.
pub type OnClient = Arc<dyn Fn(&mut dyn HostChannel) + Send + Sync>;

/// The daemon's NK admission, as the loop calls it: the plaintext is already decrypted, and the
/// answer goes out when this returns true (the client then sends its confirmation).
pub trait NkAcceptor: Send + Sync {
    fn admit(&self, payload: &mut Zeroizing<Vec<u8>>, ephemeral: &[u8]) -> bool;
}

/// What a host needs to register.
pub struct HostConnect {
    pub relay_url: String,
    pub keys: KeyPair,
    pub options: HostOptions,
    pub ace_client: Option<String>,
    /// The forwarded-HTTP and media features this host takes (`http`/`media` in the upgrade).
    pub http: bool,
    pub media: bool,
    pub clock: Clock,
    pub entropy: Arc<dyn Fn(usize) -> Vec<u8> + Send + Sync>,
    pub random: Arc<dyn Fn() -> f64 + Send + Sync>,
    pub nk: Option<Arc<dyn NkAcceptor>>,
    pub stop: Arc<AtomicBool>,
}

impl std::fmt::Debug for HostConnect {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HostConnect")
            .field("relay_url", &self.relay_url)
            .field("host_id", &self.keys.host_id())
            .field("options", &self.options)
            .finish_non_exhaustive()
    }
}

struct Shared {
    registration: Mutex<Registration>,
    changed: Condvar,
    closed: AtomicBool,
}

/// A running registration.
pub struct HostRelay {
    pub host_id: String,
    shared: Arc<Shared>,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl HostRelay {
    pub fn generation(&self) -> u64 {
        self.shared
            .registration
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .generation()
    }

    /// Resolves once the relay confirmed a registration after `after`, or the connection ended.
    pub fn when_registered(&self, after: u64) -> Result<u64, RelayError> {
        let mut registration = self
            .shared
            .registration
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        loop {
            let generation = registration.generation();
            if generation > after {
                return Ok(generation);
            }
            if self.shared.closed.load(Ordering::SeqCst) {
                return Err(RelayError::Protocol("Host connection closed"));
            }
            let (guard, _) = self
                .shared
                .changed
                .wait_timeout(registration, Duration::from_millis(100))
                .unwrap_or_else(|error| error.into_inner());
            registration = guard;
        }
    }

    /// Gives up the registration and stops the loop.
    pub fn close(mut self) {
        self.stop.store(true, Ordering::SeqCst);
        self.shared.closed.store(true, Ordering::SeqCst);
        self.shared.changed.notify_all();
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

/// Register on the relay and keep the registration alive on a background thread. Returns once
/// the relay confirmed it.
pub fn connect_host(connect: HostConnect, on_client: OnClient) -> Result<HostRelay, RelayError> {
    let host_id = connect.keys.host_id();
    let shared = Arc::new(Shared {
        registration: Mutex::new(Registration::default()),
        changed: Condvar::new(),
        closed: AtomicBool::new(false),
    });
    let stop = Arc::clone(&connect.stop);
    let loop_shared = Arc::clone(&shared);
    let thread = std::thread::spawn(move || {
        run(connect, on_client, loop_shared);
    });
    let host = HostRelay {
        host_id,
        shared,
        stop,
        thread: Some(thread),
    };
    host.when_registered(0)?;
    Ok(host)
}

/// One registration attempt's outcome.
enum Attempt {
    Lost,
    Refused,
    Stopped,
}

fn run(connect: HostConnect, on_client: OnClient, shared: Arc<Shared>) {
    let mut backoff = Backoff::new(
        connect.options.retry_initial_ms,
        connect.options.retry_max_ms,
    );
    while !connect.stop.load(Ordering::SeqCst) {
        let attempt = session(&connect, &on_client, &shared, &mut backoff);
        if matches!(attempt, Attempt::Refused | Attempt::Stopped) {
            break;
        }
        let wait = backoff.next((connect.random)());
        sleep_interruptible(wait, &connect.stop);
    }
    shared.closed.store(true, Ordering::SeqCst);
    shared.changed.notify_all();
    let mut registration = shared
        .registration
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    registration.close();
}

/// Sleeps in small steps so a close is noticed at once.
fn sleep_interruptible(milliseconds: i64, stop: &AtomicBool) {
    let mut left = milliseconds.max(0);
    while left > 0 && !stop.load(Ordering::SeqCst) {
        let step = left.min(25);
        std::thread::sleep(Duration::from_millis(step as u64));
        left -= step;
    }
}

fn session(
    connect: &HostConnect,
    on_client: &OnClient,
    shared: &Arc<Shared>,
    backoff: &mut Backoff,
) -> Attempt {
    let host_id = connect.keys.host_id();
    let mut query: Vec<(&str, String)> = vec![("hostId", host_id.clone())];
    let mut features: Vec<&str> = Vec::new();
    if connect.http {
        features.push(HTTP_FEATURE);
    }
    if connect.media {
        features.push(MEDIA_FEATURE);
    }
    if !features.is_empty() {
        query.push(("features", features.join(",")));
    }
    let pairs: Vec<(&str, &str)> = query
        .iter()
        .map(|(key, value)| (*key, value.as_str()))
        .collect();
    let url = match relay_address(&connect.relay_url, "/host", &pairs) {
        Ok(url) => url,
        Err(_) => return Attempt::Refused,
    };
    let mut io = match Link::dial(
        &url,
        &[],
        connect.ace_client.as_deref(),
        crate::host::link::Timeouts {
            connect: Duration::from_millis(
                u64::try_from(connect.options.handshake_timeout_ms).unwrap_or(10_000),
            ),
            read: Duration::from_millis(
                u64::try_from(connect.options.ping_interval_ms).unwrap_or(10_000),
            ),
        },
    ) {
        Ok(io) => io,
        Err(_) => return Attempt::Lost,
    };
    let mut xx = NoiseXx::initiator(
        connect.keys.reopen(),
        match KeyPair::generate(&*connect.entropy) {
            Ok(keys) => keys,
            Err(_) => return Attempt::Stopped,
        },
        CONTROL_PROLOGUE,
        None,
    );
    let mut keys = match initiate(
        &mut io,
        &mut xx,
        &connect.clock,
        connect.options.handshake_timeout_ms,
    ) {
        Ok(keys) => keys,
        Err(_) => return Attempt::Lost,
    };
    let registered = match read_control(&mut io, &mut keys) {
        Ok(ControlMessage::Registered { host_id: named }) if named == host_id => named,
        Ok(_) => return Attempt::Lost,
        Err(Attempt::Refused) => return Attempt::Refused,
        Err(_) => return Attempt::Lost,
    };
    if registered != host_id {
        return Attempt::Lost;
    }
    {
        let mut registration = shared
            .registration
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if registration.registered(&registered, &host_id).is_err() {
            return Attempt::Lost;
        }
    }
    shared.changed.notify_all();
    backoff.reset();
    let outcome = control(&mut io, &mut keys, connect, on_client, shared, &host_id);
    shared.changed.notify_all();
    outcome
}

/// The three-message control handshake, initiated.
fn initiate(
    io: &mut dyn FrameIo,
    xx: &mut NoiseXx,
    clock: &Clock,
    timeout_ms: i64,
) -> Result<SessionKeys, RelayError> {
    io.send(&xx.write_message(&[])?)?;
    let reply = read_frame(io, clock, timeout_ms)?;
    if !xx.read_message(&reply)?.is_empty() {
        return Err(RelayError::Protocol("Handshake payload must be empty"));
    }
    io.send(&xx.write_message(&[])?)?;
    xx.take_transport()
}

/// The three-message handshake, responded to; `first` when the caller already read it.
fn respond(
    io: &mut dyn FrameIo,
    xx: &mut NoiseXx,
    first: Option<&[u8]>,
    clock: &Clock,
    timeout_ms: i64,
) -> Result<SessionKeys, RelayError> {
    let first = match first {
        Some(first) => first.to_vec(),
        None => read_frame(io, clock, timeout_ms)?,
    };
    if !xx.read_message(&first)?.is_empty() {
        return Err(RelayError::Protocol("Handshake payload must be empty"));
    }
    io.send(&xx.write_message(&[])?)?;
    let third = read_frame(io, clock, timeout_ms)?;
    if !xx.read_message(&third)?.is_empty() {
        return Err(RelayError::Protocol("Handshake payload must be empty"));
    }
    xx.take_transport()
}

/// One data frame, giving up at the handshake deadline. An idle read is not a deadline miss: the
/// link's read timeout is the ping interval, so idle reads are expected while waiting.
fn read_frame(io: &mut dyn FrameIo, clock: &Clock, timeout_ms: i64) -> Result<Vec<u8>, RelayError> {
    let deadline = clock() + timeout_ms;
    loop {
        match io.read()? {
            Incoming::Data(frame) => return Ok(frame),
            Incoming::Idle => {
                if (clock)() >= deadline {
                    io.terminate();
                    return Err(RelayError::Protocol("Handshake timed out"));
                }
            }
            Incoming::Closed { code, reason } => {
                return Err(RelayError::Closed { code, reason });
            }
        }
    }
}

/// The next decrypted control message.
fn read_control(io: &mut dyn FrameIo, keys: &mut SessionKeys) -> Result<ControlMessage, Attempt> {
    let frame = match io.read() {
        Ok(Incoming::Data(frame)) => frame,
        Ok(Incoming::Idle) => {
            let _ = io.ping();
            return Err(Attempt::Lost);
        }
        Ok(Incoming::Closed { code, reason }) => {
            return Err(if code == 1008 {
                let _ = reason;
                Attempt::Refused
            } else {
                Attempt::Lost
            });
        }
        Err(_) => return Err(Attempt::Lost),
    };
    let plain = keys.receive(&frame).map_err(|_| Attempt::Lost)?;
    let value = ace_json::parse(std::str::from_utf8(&plain).unwrap_or_default())
        .map_err(|_| Attempt::Lost)?;
    ControlMessage::parse(&value).map_err(|_| Attempt::Lost)
}

/// The control loop once registration was confirmed.
fn control(
    io: &mut dyn FrameIo,
    keys: &mut SessionKeys,
    connect: &HostConnect,
    on_client: &OnClient,
    shared: &Arc<Shared>,
    host_id: &str,
) -> Attempt {
    let slots = Arc::new(Mutex::new(ClientSlots::new(
        connect.options.max_client_channels,
    )));
    let pending: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>> =
        Arc::new(Mutex::new(HashMap::new()));
    let mut tasks: Vec<JoinHandle<()>> = Vec::new();
    let mut last_activity = (connect.clock)();
    let idle_ms = connect.options.idle_timeout_ms;
    let outcome;
    loop {
        if connect.stop.load(Ordering::SeqCst) {
            outcome = Attempt::Stopped;
            break;
        }
        let incoming = match io.read() {
            Ok(incoming) => incoming,
            Err(_) => {
                outcome = Attempt::Lost;
                break;
            }
        };
        match incoming {
            Incoming::Data(frame) => {
                last_activity = (connect.clock)();
                let plain = match keys.receive(&frame) {
                    Ok(plain) => plain,
                    Err(_) => {
                        outcome = Attempt::Lost;
                        break;
                    }
                };
                let value = match ace_json::parse(std::str::from_utf8(&plain).unwrap_or_default()) {
                    Ok(value) => value,
                    Err(_) => {
                        outcome = Attempt::Lost;
                        break;
                    }
                };
                let message = match ControlMessage::parse(&value) {
                    Ok(message) => message,
                    Err(_) => {
                        outcome = Attempt::Lost;
                        break;
                    }
                };
                match message {
                    ControlMessage::Registered { .. } => {
                        outcome = Attempt::Lost;
                        break;
                    }
                    ControlMessage::Http { ticket } => {
                        // No forwarded-HTTP handler in this host: off, in the relay's words.
                        let _ = reject(io, keys, &ticket, Some(RejectReason::Off));
                    }
                    ControlMessage::Client { ticket, media } => {
                        if media {
                            // ace-media dials `/join` itself; with no media handler, refuse.
                            let _ = reject(io, keys, &ticket, None);
                            continue;
                        }
                        let reservation = slots
                            .lock()
                            .unwrap_or_else(|error| error.into_inner())
                            .reserve(&ticket);
                        if !reservation.accepted {
                            let _ = reject(io, keys, &ticket, None);
                            continue;
                        }
                        if let Some(evicted) = reservation.evicted
                            && let Some(abort) = pending
                                .lock()
                                .unwrap_or_else(|error| error.into_inner())
                                .get(&evicted)
                        {
                            abort.store(true, Ordering::SeqCst);
                        }
                        let owned = Arc::new(AtomicBool::new(false));
                        pending
                            .lock()
                            .unwrap_or_else(|error| error.into_inner())
                            .insert(ticket.clone(), Arc::clone(&owned));
                        let context = Context {
                            relay_url: connect.relay_url.clone(),
                            host_id: host_id.to_owned(),
                            keys: connect.keys.reopen(),
                            options: connect.options,
                            ace_client: connect.ace_client.clone(),
                            clock: Arc::clone(&connect.clock),
                            entropy: Arc::clone(&connect.entropy),
                            nk: connect.nk.clone(),
                            slots: Arc::clone(&slots),
                            pending: Arc::clone(&pending),
                            on_client: Arc::clone(on_client),
                        };
                        let ticket_for_thread = ticket.clone();
                        let task = std::thread::spawn(move || {
                            context.open(ticket_for_thread, owned);
                        });
                        tasks.push(task);
                    }
                }
            }
            Incoming::Idle => {
                if (connect.clock)() - last_activity >= idle_ms {
                    io.terminate();
                    outcome = Attempt::Lost;
                    break;
                }
                let _ = io.ping();
            }
            Incoming::Closed { code, reason } => {
                outcome = if code == 1008 {
                    let _ = reason;
                    Attempt::Refused
                } else if code == 4001 {
                    Attempt::Stopped
                } else {
                    Attempt::Lost
                };
                break;
            }
        }
    }
    for task in tasks {
        let _ = task.join();
    }
    shared.changed.notify_all();
    outcome
}

/// The `reject` the relay reads: `{type, ticket}` or with `reason` (`host.ts:335`, `:372`).
fn reject(
    io: &mut dyn FrameIo,
    keys: &mut SessionKeys,
    ticket: &str,
    reason: Option<RejectReason>,
) -> Result<(), RelayError> {
    let text = match reason {
        Some(reason) => reason.message(ticket),
        None => {
            let mut message = ace_json::Map::new();
            message.insert("type", Value::String("reject".into()));
            message.insert("ticket", Value::String(ticket.into()));
            ace_json::to_string(&Value::Object(message))
        }
    };
    io.send(&keys.send(text.as_bytes())?)
}

/// What one opened channel needs to dial and run.
struct Context {
    relay_url: String,
    host_id: String,
    keys: KeyPair,
    options: HostOptions,
    ace_client: Option<String>,
    clock: Clock,
    entropy: Arc<dyn Fn(usize) -> Vec<u8> + Send + Sync>,
    nk: Option<Arc<dyn NkAcceptor>>,
    slots: Arc<Mutex<ClientSlots>>,
    pending: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
    on_client: OnClient,
}

impl Context {
    /// Dial `/join` for `ticket`, tell XX from NK by the first frame, and hand the channel over.
    fn open(&self, ticket: String, abort: Arc<AtomicBool>) {
        if !valid_ticket(&ticket) {
            return;
        }
        let url = match relay_address(
            &self.relay_url,
            "/join",
            &[
                ("ticket", ticket.as_str()),
                ("hostId", self.host_id.as_str()),
            ],
        ) {
            Ok(url) => url,
            Err(_) => return,
        };
        let mut io = match Link::dial(
            &url,
            &[],
            self.ace_client.as_deref(),
            crate::host::link::Timeouts {
                connect: Duration::from_millis(
                    u64::try_from(self.options.handshake_timeout_ms).unwrap_or(10_000),
                ),
                read: Duration::from_millis(
                    u64::try_from(self.options.ping_interval_ms).unwrap_or(10_000),
                ),
            },
        ) {
            Ok(io) => io,
            Err(_) => return,
        };
        let arrived_at = (self.clock)();
        let first = match self.first_frame(&mut io) {
            Some(first) => first,
            None => return,
        };
        let (keys, nk) = if first.len() == XX_FIRST_MESSAGE {
            let mut xx = NoiseXx::responder(
                self.keys.reopen(),
                match KeyPair::generate(&*self.entropy) {
                    Ok(keys) => keys,
                    Err(_) => return,
                },
                STREAM_PROLOGUE,
            );
            match respond(
                &mut io,
                &mut xx,
                Some(&first),
                &self.clock,
                self.options.handshake_timeout_ms,
            ) {
                Ok(keys) => (keys, false),
                Err(_) => {
                    io.terminate();
                    return;
                }
            }
        } else {
            match self.answer_nk(&mut io, &first, abort.clone()) {
                Some(keys) => (keys, true),
                None => {
                    self.refuse_at(io, arrived_at);
                    return;
                }
            }
        };
        let mut channel = LinkChannel::new(
            io,
            Codec::new(keys),
            true,
            abort,
            Arc::clone(&self.clock),
            self.options.idle_timeout_ms,
            nk,
        );
        (self.on_client)(&mut channel);
        channel.close();
        self.pending
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .remove(&ticket);
        self.slots
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .release(&ticket);
    }

    /// The client's first frame, before the handshake deadline.
    fn first_frame(&self, io: &mut dyn FrameIo) -> Option<Vec<u8>> {
        let expired = self.options.handshake_timeout_ms;
        let started = (self.clock)();
        loop {
            match io.read() {
                Ok(Incoming::Data(frame)) => return Some(frame),
                Ok(Incoming::Idle) => {
                    if (self.clock)() - started >= expired {
                        io.terminate();
                        return None;
                    }
                }
                Ok(Incoming::Closed { .. }) | Err(_) => return None,
            }
        }
    }

    /// An NK first message, read and admitted, or `None` (the client falls back to XX).
    fn answer_nk(
        &self,
        io: &mut dyn FrameIo,
        first: &[u8],
        _abort: Arc<AtomicBool>,
    ) -> Option<SessionKeys> {
        let acceptor = self.nk.as_ref()?;
        let mut nk = NoiseNk::responder(
            self.keys.reopen(),
            KeyPair::generate(&*self.entropy).ok()?,
            NK_STREAM_PROLOGUE,
        );
        let ephemeral = {
            // The first message's ephemeral is what replay suppression remembers.
            let mut probe = NoiseNk::responder(
                self.keys.reopen(),
                KeyPair::generate(&*self.entropy).ok()?,
                NK_STREAM_PROLOGUE,
            );
            let _ = probe.read_message(first).ok()?;
            probe.remote_ephemeral()?
        };
        let mut plain = nk.read_message(first).ok()?;
        if !acceptor.admit(&mut plain, &ephemeral) {
            return None;
        }
        let answer = nk.write_message(&[]).ok()?;
        io.send(&answer).ok()?;
        nk.into_transport().ok()
    }

    /// The refusal time is `arrivedAt + 150 ms` whatever the reason (`nk-stream.ts:67`).
    fn refuse_at(&self, io: Link, arrived_at: i64) {
        let deadline = arrived_at + NK_REFUSAL_MS;
        let mut io = io;
        while (self.clock)() < deadline {
            std::thread::sleep(Duration::from_millis(5));
        }
        io.terminate();
    }
}

/// A channel opened by a `client` ticket: the codec over a relay socket, seen as the daemon's
/// `HostChannel` (`relay-socket.ts`'s `HostChannel`).
pub struct LinkChannel<I: FrameIo> {
    io: I,
    codec: Codec,
    deflate: bool,
    abort: Arc<AtomicBool>,
    clock: Clock,
    idle_ms: i64,
    last_activity: i64,
    closed: Option<RelayError>,
    queue: VecDeque<Frame>,
    /// The first message a client may send (its hello, a redemption, or an NK confirmation).
    first: FirstRule,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FirstRule {
    Hello,
    Confirmation,
    Done,
}

impl<I: FrameIo> LinkChannel<I> {
    pub fn new(
        io: I,
        codec: Codec,
        deflate: bool,
        abort: Arc<AtomicBool>,
        clock: Clock,
        idle_ms: i64,
        nk: bool,
    ) -> Self {
        Self {
            io,
            codec,
            deflate,
            abort,
            last_activity: clock(),
            clock,
            idle_ms,
            closed: None,
            queue: VecDeque::new(),
            first: if nk {
                FirstRule::Confirmation
            } else {
                FirstRule::Hello
            },
        }
    }

    /// One frame from the peer: a credit goes back, a message is queued.
    fn pump(&mut self) -> Result<(), RelayError> {
        match self.io.read()? {
            Incoming::Data(frame) => {
                self.last_activity = (self.clock)();
                let received = self.codec.open(&frame)?;
                if let Some(credit) = received.credit {
                    let sealed = self.codec.seal(&credit)?;
                    self.io.send(&sealed)?;
                }
                if let Some(message) = received.message {
                    self.admit_first(&message)?;
                    self.queue.push_back(match message {
                        crate::codec::Message::Text(text) => Frame::Text(text),
                        crate::codec::Message::Binary(bytes) => Frame::Binary(bytes),
                    });
                }
                Ok(())
            }
            Incoming::Idle => {
                if (self.clock)() - self.last_activity >= self.idle_ms {
                    self.io.terminate();
                    let error = RelayError::Protocol("Relay connection idle");
                    self.closed = Some(error.clone());
                    return Err(error);
                }
                self.io.ping()
            }
            Incoming::Closed { code, reason } => {
                let error = RelayError::Closed { code, reason };
                self.closed = Some(error.clone());
                Err(error)
            }
        }
    }

    /// The first message's rule (`host.ts:222`-`:248`): a pairing redemption is answered and
    /// closed by the daemon and never authorizes; anything else must be the hello.
    fn admit_first(&mut self, message: &crate::codec::Message) -> Result<(), RelayError> {
        if self.first == FirstRule::Done {
            return Ok(());
        }
        let crate::codec::Message::Text(text) = message else {
            let error = RelayError::Protocol(match self.first {
                FirstRule::Confirmation => "First message must be hello.confirm",
                _ => "First message must be hello",
            });
            self.closed = Some(error.clone());
            return Err(error);
        };
        let kind = ace_json::parse(text)
            .ok()
            .and_then(|value| value.get("type").and_then(Value::as_str).map(str::to_owned))
            .unwrap_or_default();
        match self.first {
            FirstRule::Confirmation if kind == "hello.confirm" => {
                self.first = FirstRule::Done;
                Ok(())
            }
            FirstRule::Hello if kind == "hello" || kind == "pair.redeem" => {
                self.first = FirstRule::Done;
                Ok(())
            }
            FirstRule::Confirmation => {
                Err(self.first_refused("First message must be hello.confirm"))
            }
            FirstRule::Hello => Err(self.first_refused("First message must be hello")),
            FirstRule::Done => Ok(()),
        }
    }

    fn first_refused(&mut self, reason: &'static str) -> RelayError {
        self.io.terminate();
        let error = RelayError::Protocol(reason);
        self.closed = Some(error.clone());
        error
    }

    fn write(&mut self, kind: Kind, payload: &[u8], compress: bool) -> Result<(), RelayError> {
        let frames = self.codec.outbound(kind, payload, compress)?;
        for plain in frames {
            let cost = fragment_cost(plain.len());
            while !self.codec.may_send(cost) {
                if self.closed.is_some() {
                    return Err(RelayError::Protocol("Relay channel closed"));
                }
                self.pump()?;
            }
            self.codec.spend(cost);
            let sealed = self.codec.seal(&plain)?;
            self.io.send(&sealed)?;
        }
        Ok(())
    }
}

impl<I: FrameIo> HostChannel for LinkChannel<I> {
    fn receive(&mut self) -> Option<Frame> {
        loop {
            if let Some(frame) = self.queue.pop_front() {
                return Some(frame);
            }
            if self.closed.is_some() || self.abort.load(Ordering::SeqCst) {
                return None;
            }
            if let Err(error) = self.pump() {
                self.closed = Some(error);
            }
        }
    }

    fn closed_cause(&self) -> Option<RelayError> {
        self.closed.clone()
    }

    fn send_text(&mut self, text: &str, deflate: bool) -> Result<(), RelayError> {
        self.write(Kind::Json, text.as_bytes(), deflate && self.deflate)
    }

    fn send_binary(&mut self, bytes: &[u8]) -> Result<(), RelayError> {
        self.write(Kind::Binary, bytes, false)
    }

    fn buffered_bytes(&self) -> usize {
        self.io.buffered()
    }

    fn close_after_flush(&mut self) {
        self.io.close();
    }
}

impl<I: FrameIo> LinkChannel<I> {
    fn close(&mut self) {
        self.io.close();
    }
}

#[cfg(test)]
mod tests;

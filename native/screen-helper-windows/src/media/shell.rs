//! The I/O around `media-ingest`'s route: one pump thread per ingest connection, writing its
//! bytes in the order the route gave them and reporting each write back; a ticker for the
//! route's deadlines; and the dial that opens a connection. The route decides everything;
//! this shell only carries out its actions. Generic over the connection, so the same code runs
//! over Windows named pipes in the helper and over Unix sockets in the host tests.
use media_ingest::route::Config;
use media_ingest::{Address, Bytes, Route, RouteAction, Switch, VideoUnit};
use std::collections::HashMap;
use std::io;
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

/// One connection's byte stream. `write_all` blocks; `alive` must not.
pub trait Link: Send + 'static {
    fn write_all(&mut self, bytes: &[u8]) -> io::Result<()>;
    /// Whether the other end still holds the connection.
    fn alive(&mut self) -> bool;
    /// The end frame is written: wait until the reader has the bytes, then close.
    fn finish(&mut self) {}
}
/// Unblocks a write in progress from another thread.
pub trait Cancel: Send + Sync + 'static {
    fn cancel(&self);
}
pub type Dial = Box<dyn Fn(&str) -> io::Result<(Box<dyn Link>, Arc<dyn Cancel>)> + Send + Sync>;

/// Where the route's other actions go.
pub struct Sinks {
    /// A unit for the daemon's pipe.
    pub legacy: Box<dyn Fn(&VideoUnit) + Send + Sync>,
    /// The current ingest connection was cut: video is on the daemon's pipe again.
    pub closed: Box<dyn Fn(Option<u64>) + Send + Sync>,
    pub keyframe: Box<dyn Fn() + Send + Sync>,
}

/// How often an idle connection checks that ace-media still holds it, and deadlines are judged.
pub const POLL: Duration = Duration::from_millis(100);

enum Message {
    Write(u64, Bytes),
    Shutdown,
    Destroy,
}

struct Connection {
    tx: Sender<Message>,
    cancel: Arc<dyn Cancel>,
}

struct Inner {
    route: Mutex<Route>,
    connections: Mutex<HashMap<u64, Connection>>,
    dial: Dial,
    sinks: Sinks,
    /// Microseconds on a monotonic clock.
    clock: Box<dyn Fn() -> u64 + Send + Sync>,
}

/// The outcome of `configure`, as `stream.configure`'s reply says it.
#[derive(Debug, PartialEq, Eq)]
pub struct Routed {
    pub switched: bool,
    pub boundary: Option<u64>,
    pub ingesting: bool,
}

#[derive(Clone)]
pub struct IngestShell(Arc<Inner>);

impl IngestShell {
    pub fn new(dial: Dial, sinks: Sinks, clock: Box<dyn Fn() -> u64 + Send + Sync>) -> Self {
        let inner = Arc::new(Inner {
            route: Mutex::new(Route::new(Config::default())),
            connections: Mutex::new(HashMap::new()),
            dial,
            sinks,
            clock,
        });
        let weak = Arc::downgrade(&inner);
        std::thread::spawn(move || ticker(weak));
        Self(inner)
    }

    /// Video goes to `target` from now on (the daemon's pipe for `None`).
    pub fn configure(&self, target: Option<Address>) -> io::Result<Routed> {
        let now = self.0.now_ms();
        let switch = self
            .0
            .with_route(|route, out| route.begin(target, now, out));
        let (generation, socket) = match switch {
            Switch::Same => return Ok(self.routed(false, None)),
            Switch::Switched { boundary } => return Ok(self.routed(true, boundary)),
            Switch::Stale => return Ok(self.routed(false, None)),
            Switch::Connect { generation, socket } => (generation, socket),
        };
        let (link, cancel) = match (self.0.dial)(&socket) {
            Ok(opened) => opened,
            Err(error) => {
                self.0
                    .with_route(|route, _| route.connect_failed(generation));
                return Err(error);
            }
        };
        // Registered before the route takes it, so the hello it queues finds its pump.
        let (tx, rx) = mpsc::channel();
        self.0
            .connections()
            .insert(generation, Connection { tx, cancel });
        let weak = Arc::downgrade(&self.0);
        std::thread::spawn(move || pump(weak, generation, link, rx));
        let now = self.0.now_ms();
        match self
            .0
            .with_route(|route, out| route.connected(generation, now, out))
        {
            Switch::Switched { boundary } => Ok(self.routed(true, boundary)),
            _ => {
                self.0.destroy(generation);
                Ok(self.routed(false, None))
            }
        }
    }

    fn routed(&self, switched: bool, boundary: Option<u64>) -> Routed {
        Routed {
            switched,
            boundary,
            ingesting: self.ingesting(),
        }
    }

    /// The shell's clock, microseconds: the clock units' ages are measured on.
    pub fn now_us(&self) -> u64 {
        (self.0.clock)()
    }

    pub fn ingesting(&self) -> bool {
        self.0.lock_route().ingesting()
    }

    /// Routes one unit and writes it on its path.
    pub fn publish(&self, unit: &VideoUnit) {
        let now_us = (self.0.clock)();
        self.0
            .with_route(|route, out| route.publish(unit, now_us / 1000, now_us, out));
    }

    /// Writes a still on the daemon's pipe under the route's lock, as sequence `sequence`, so
    /// a switch's boundary counts it.
    pub fn legacy_still(&self, sequence: u64, write: impl FnOnce()) {
        let mut route = self.0.lock_route();
        write();
        route.legacy_still(sequence);
    }

    /// Closes every connection at once.
    pub fn close(&self) {
        self.0.with_route(|route, out| route.close(out));
    }
}

impl Inner {
    fn now_ms(&self) -> u64 {
        (self.clock)() / 1000
    }

    fn lock_route(&self) -> std::sync::MutexGuard<'_, Route> {
        self.route.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn connections(&self) -> std::sync::MutexGuard<'_, HashMap<u64, Connection>> {
        self.connections.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Runs `step` on the route and carries out its actions. Writes are handed to their pump
    /// under the route's lock, so each connection's bytes keep the route's order; a cut's
    /// report runs after the lock is released.
    fn with_route<T>(&self, step: impl FnOnce(&mut Route, &mut Vec<RouteAction>) -> T) -> T {
        let mut out = Vec::new();
        let mut closed = Vec::new();
        let result = {
            let mut route = self.lock_route();
            let result = step(&mut route, &mut out);
            for action in out {
                match action {
                    RouteAction::Write {
                        generation,
                        id,
                        bytes,
                    } => {
                        if let Some(connection) = self.connections().get(&generation) {
                            let _ = connection.tx.send(Message::Write(id, bytes));
                        }
                    }
                    RouteAction::Shutdown { generation } => {
                        if let Some(connection) = self.connections().remove(&generation) {
                            let _ = connection.tx.send(Message::Shutdown);
                        }
                    }
                    RouteAction::Destroy { generation } => self.destroy(generation),
                    RouteAction::Legacy(unit) => (self.sinks.legacy)(&unit),
                    RouteAction::IngestClosed { boundary, .. } => closed.push(boundary),
                    RouteAction::Keyframe => (self.sinks.keyframe)(),
                }
            }
            result
        };
        for boundary in closed {
            (self.sinks.closed)(boundary);
        }
        result
    }

    fn destroy(&self, generation: u64) {
        if let Some(connection) = self.connections().remove(&generation) {
            connection.cancel.cancel();
            let _ = connection.tx.send(Message::Destroy);
        }
    }
}

fn pump(inner: Weak<Inner>, generation: u64, mut link: Box<dyn Link>, rx: mpsc::Receiver<Message>) {
    let report = |event: &dyn Fn(&mut Route, u64, &mut Vec<RouteAction>)| {
        if let Some(inner) = inner.upgrade() {
            inner.with_route(|route, out| event(route, generation, out));
        }
    };
    loop {
        match rx.recv_timeout(POLL) {
            Ok(Message::Write(id, bytes)) => {
                if link.write_all(bytes.as_slice()).is_err() {
                    report(&|route, g, out| route.write_failed(g, out));
                    return;
                }
                drop(bytes);
                report(&|route, g, out| route.written(g, id, out));
            }
            Ok(Message::Shutdown) => {
                link.finish();
                return;
            }
            Ok(Message::Destroy) | Err(RecvTimeoutError::Disconnected) => return,
            Err(RecvTimeoutError::Timeout) => {
                if !link.alive() {
                    report(&|route, g, out| route.socket_closed(g, out));
                    return;
                }
            }
        }
    }
}

fn ticker(inner: Weak<Inner>) {
    loop {
        std::thread::sleep(POLL);
        let Some(inner) = inner.upgrade() else { return };
        let now = inner.now_ms();
        inner.with_route(|route, out| route.tick(now, out));
    }
}

#[cfg(all(test, unix))]
#[path = "shell_tests.rs"]
mod tests;

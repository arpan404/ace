//! The I/O around `media-ingest`'s route: one pump thread per ingest connection, writing its
//! bytes in the order the route gave them and reporting each write back; a ticker for the
//! route's deadlines; and the dial that opens a connection. The route decides everything;
//! this shell only carries out its actions. Generic over the connection, so the same code runs
//! over Windows named pipes in the helper and over Unix sockets in the host tests.
use super::connection::{Connection, Report};
use media_ingest::route::Config;
use media_ingest::{Address, Route, RouteAction, Switch, VideoUnit};
use std::collections::HashMap;
use std::io;
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
/// Opens a connection to `socket`, refusing it unless its server is process `server` when one is
/// named (Windows: the pipe's server process, before any byte is sent).
pub type Dial =
    Box<dyn Fn(&str, Option<u32>) -> io::Result<(Box<dyn Link>, Arc<dyn Cancel>)> + Send + Sync>;

/// Where the route's other actions go. Video goes only to ace-media's ingest.
pub struct Sinks {
    /// The current ingest connection was cut: video goes nowhere until a new address.
    pub closed: Box<dyn Fn(Option<u64>) + Send + Sync>,
    pub keyframe: Box<dyn Fn() + Send + Sync>,
}

/// How often an idle connection checks that ace-media still holds it, and deadlines are judged.
pub const POLL: Duration = Duration::from_millis(100);

/// Longest a connection may take to finish (its reader taking the last bytes) after its end
/// frame was handed over: past it, it is cut.
pub const FINISH_LIMIT: Duration = Duration::from_secs(2);

struct Inner {
    route: Mutex<Route>,
    connections: Mutex<HashMap<u64, Connection>>,
    /// Connections the route let go of whose pump hasn't yet: cut ones, cancelled again on
    /// every tick, and finishing ones, cut once past their deadline.
    leaving: Mutex<Vec<(Connection, Option<u64>)>>,
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
            leaving: Mutex::new(Vec::new()),
            dial,
            sinks,
            clock,
        });
        let weak = Arc::downgrade(&inner);
        std::thread::spawn(move || ticker(weak));
        Self(inner)
    }

    /// Video goes to `target` from now on (the daemon's pipe for `None`). `server` is the
    /// ace-media process the daemon started: a connection served by any other is refused.
    pub fn configure(&self, target: Option<Address>, server: Option<u32>) -> io::Result<Routed> {
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
        let (link, cancel) = match (self.0.dial)(&socket, server) {
            Ok(opened) => opened,
            Err(error) => {
                self.0
                    .with_route(|route, _| route.connect_failed(generation));
                return Err(error);
            }
        };
        // Registered before the route takes it, so the hello it queues finds its pump.
        let weak = Arc::downgrade(&self.0);
        let connection = Connection::start(link, cancel, move |report| {
            let Some(inner) = weak.upgrade() else { return };
            inner.with_route(|route, out| match report {
                Report::Written(id) => route.written(generation, id, out),
                Report::WriteFailed => route.write_failed(generation, out),
                Report::Closed => route.socket_closed(generation, out),
            });
        });
        self.0.connections().insert(generation, connection);
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

    /// Writes one unit to the current ingest connection; with none it is dropped.
    pub fn publish(&self, unit: &VideoUnit) {
        let now_us = (self.0.clock)();
        self.0
            .with_route(|route, out| route.publish(unit, now_us / 1000, now_us, out));
    }

    /// Writes a still on the daemon's pipe under the route's lock, so it is ordered with the
    /// switches around it. A still never moves a switch's boundary.
    pub fn still(&self, write: impl FnOnce()) {
        let _route = self.0.lock_route();
        write();
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
                            connection.write(id, bytes);
                        }
                    }
                    RouteAction::Shutdown { generation } => {
                        if let Some(connection) = self.connections().remove(&generation) {
                            connection.shutdown();
                            let deadline = self.now_ms() + FINISH_LIMIT.as_millis() as u64;
                            self.leaving().push((connection, Some(deadline)));
                        }
                    }
                    RouteAction::Destroy { generation } => self.destroy(generation),
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

    fn leaving(&self) -> std::sync::MutexGuard<'_, Vec<(Connection, Option<u64>)>> {
        self.leaving.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Cuts a connection the route has let go of, and keeps it until its pump has.
    fn destroy(&self, generation: u64) {
        if let Some(connection) = self.connections().remove(&generation) {
            connection.cut();
            self.leaving().push((connection, None));
        }
    }

    /// Each tick: a cut connection's write is cancelled again until its pump lets go, and a
    /// finish past its deadline is cut.
    fn reap(&self, now: u64) {
        self.leaving().retain_mut(|(connection, deadline)| {
            if connection.finished() {
                return false;
            }
            if deadline.is_some_and(|at| now >= at) {
                connection.cut();
                *deadline = None;
            }
            connection.recancel();
            true
        });
    }
}

fn ticker(inner: Weak<Inner>) {
    loop {
        std::thread::sleep(POLL);
        let Some(inner) = inner.upgrade() else { return };
        let now = inner.now_ms();
        inner.with_route(|route, out| route.tick(now, out));
        inner.reap(now);
    }
}

#[cfg(all(test, unix))]
#[path = "shell_tests.rs"]
mod tests;

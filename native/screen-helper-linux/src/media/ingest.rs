//! The Linux I/O shell around `media_ingest::Route` (docs/media/plan.md, E2): one tokio task
//! owns the route, and every event reaches it through one queue, in order. The capture
//! thread's units and `stream.configure`'s switches share that queue, so the route sees them
//! in the order they happened and a switch keeps its exact boundary. Each connection is a
//! Unix socket with a writer task (writes in order, reports each) and a reader (ace-media
//! never writes on ingest: anything readable means it closed). A tick judges deadlines.
use media_ingest::{Address, Route, RouteAction, Switch, VideoUnit, route::Config};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixStream;
use tokio::sync::{mpsc, oneshot};

/// How often deadlines (the finish limit, a backlog that won't drain) are judged.
const TICK: Duration = Duration::from_millis(100);

/// The helper's monotonic clock: capture times and the route's `now` read the same one.
#[derive(Clone, Copy)]
pub struct Clock(Instant);
impl Clock {
    pub fn start() -> Self {
        Self(Instant::now())
    }
    pub fn us(&self) -> u64 {
        self.0.elapsed().as_micros() as u64
    }
    pub fn ms(&self) -> u64 {
        self.0.elapsed().as_millis() as u64
    }
}

/// What the route reports outward: units for the daemon's socket, a keyframe owed, and the
/// current connection's cut.
pub struct Outlets {
    pub legacy: Box<dyn FnMut(VideoUnit) + Send>,
    pub keyframe: Arc<dyn Fn() + Send + Sync>,
    pub closed: Box<dyn FnMut(Option<u64>) + Send>,
}

/// A switch's answer: whether video moved and the last sequence the previous path took.
#[derive(Debug, PartialEq, Eq)]
pub struct Moved {
    pub switched: bool,
    pub boundary: Option<u64>,
}

enum Event {
    Unit(VideoUnit),
    Begin(Option<Address>, oneshot::Sender<std::io::Result<Moved>>),
    Connected(u64, UnixStream),
    ConnectFailed(u64, std::io::Error),
    Written(u64, u64),
    WriteFailed(u64),
    SocketClosed(u64),
    Close,
}

/// The capture thread's and the runtime's handle on the route.
#[derive(Clone)]
pub struct Ingest {
    events: mpsc::UnboundedSender<Event>,
}

impl Ingest {
    /// Starts the route's task on the current tokio runtime.
    pub fn spawn(clock: Clock, outlets: Outlets) -> Self {
        let (events, inbox) = mpsc::unbounded_channel();
        let ingest = Self {
            events: events.clone(),
        };
        tokio::spawn(run(clock, outlets, events, inbox));
        ingest
    }

    /// One unit, in capture order. Never blocks: the route bounds what it keeps.
    pub fn unit(&self, unit: VideoUnit) {
        let _ = self.events.send(Event::Unit(unit));
    }

    /// Sends video to `target` from now on (the daemon's socket for `None`), once its
    /// connection is open; an error leaves video where it was.
    pub async fn route(&self, target: Option<Address>) -> std::io::Result<Moved> {
        let (reply, answer) = oneshot::channel();
        self.events
            .send(Event::Begin(target, reply))
            .map_err(|_| std::io::Error::other("ingest route ended"))?;
        answer
            .await
            .map_err(|_| std::io::Error::other("ingest route ended"))?
    }

    /// Closes every connection at once (the capture stopped).
    pub fn close(&self) {
        let _ = self.events.send(Event::Close);
    }
}

/// One connection's tasks: its write queue, and the tasks to abort on destroy.
struct Connection {
    writes: mpsc::UnboundedSender<Write>,
    tasks: [tokio::task::AbortHandle; 2],
}

enum Write {
    Bytes(u64, media_ingest::Bytes),
    Shutdown,
}

async fn run(
    clock: Clock,
    mut outlets: Outlets,
    events: mpsc::UnboundedSender<Event>,
    mut inbox: mpsc::UnboundedReceiver<Event>,
) {
    let mut route = Route::new(Config::default());
    let mut connections: HashMap<u64, Connection> = HashMap::new();
    let mut waiting: HashMap<u64, oneshot::Sender<std::io::Result<Moved>>> = HashMap::new();
    let mut tick = tokio::time::interval(TICK);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut out = Vec::new();
    loop {
        let event = tokio::select! {
            event = inbox.recv() => match event {
                Some(event) => event,
                None => Event::Close,
            },
            _ = tick.tick(), if !connections.is_empty() => {
                route.tick(clock.ms(), &mut out);
                carry(&mut out, &mut connections, &mut outlets);
                continue;
            }
        };
        match event {
            Event::Unit(unit) => route.publish(&unit, clock.ms(), clock.us(), &mut out),
            Event::Begin(target, reply) => match route.begin(target, clock.ms(), &mut out) {
                Switch::Same => {
                    let _ = reply.send(Ok(Moved {
                        switched: false,
                        boundary: None,
                    }));
                }
                Switch::Switched { boundary } => {
                    let _ = reply.send(Ok(Moved {
                        switched: true,
                        boundary,
                    }));
                }
                Switch::Connect { generation, socket } => {
                    // A switch superseded before it opened gets its answer now.
                    for (_, earlier) in waiting.drain() {
                        let _ = earlier.send(Err(std::io::Error::other("superseded")));
                    }
                    waiting.insert(generation, reply);
                    let events = events.clone();
                    tokio::spawn(async move {
                        let _ = events.send(match UnixStream::connect(&socket).await {
                            Ok(stream) => Event::Connected(generation, stream),
                            Err(error) => Event::ConnectFailed(generation, error),
                        });
                    });
                }
                Switch::Stale => {}
            },
            Event::Connected(generation, stream) => {
                match route.connected(generation, clock.ms(), &mut out) {
                    Switch::Switched { boundary } => {
                        connections.insert(generation, open(generation, stream, &events));
                        // Its hello and anything queued are in `out`, carried below.
                        if let Some(reply) = waiting.remove(&generation) {
                            let _ = reply.send(Ok(Moved {
                                switched: true,
                                boundary,
                            }));
                        }
                    }
                    _ => drop(stream),
                }
            }
            Event::ConnectFailed(generation, error) => {
                route.connect_failed(generation);
                if let Some(reply) = waiting.remove(&generation) {
                    let _ = reply.send(Err(error));
                }
            }
            Event::Written(generation, id) => route.written(generation, id, &mut out),
            Event::WriteFailed(generation) => route.write_failed(generation, &mut out),
            Event::SocketClosed(generation) => route.socket_closed(generation, &mut out),
            Event::Close => {
                route.close(&mut out);
                carry(&mut out, &mut connections, &mut outlets);
                for (_, reply) in waiting.drain() {
                    let _ = reply.send(Err(std::io::Error::other("capture stopped")));
                }
                if inbox.is_closed() {
                    return;
                }
                continue;
            }
        }
        carry(&mut out, &mut connections, &mut outlets);
    }
}

/// Carries out the route's actions.
fn carry(
    out: &mut Vec<RouteAction>,
    connections: &mut HashMap<u64, Connection>,
    outlets: &mut Outlets,
) {
    for action in out.drain(..) {
        match action {
            RouteAction::Write {
                generation,
                id,
                bytes,
            } => {
                if let Some(c) = connections.get(&generation) {
                    let _ = c.writes.send(Write::Bytes(id, bytes));
                }
            }
            RouteAction::Shutdown { generation } => {
                if let Some(c) = connections.remove(&generation) {
                    // After every write queued before it; the writer task then ends.
                    let _ = c.writes.send(Write::Shutdown);
                    c.tasks[1].abort();
                }
            }
            RouteAction::Destroy { generation } => {
                if let Some(c) = connections.remove(&generation) {
                    for task in &c.tasks {
                        task.abort();
                    }
                }
            }
            RouteAction::Legacy(unit) => (outlets.legacy)(unit),
            RouteAction::IngestClosed { boundary, cut } => {
                eprintln!("ingest: cut ({})", cut.reason());
                (outlets.closed)(boundary);
            }
            RouteAction::Keyframe => (outlets.keyframe)(),
        }
    }
}

/// A connection's writer and reader tasks.
fn open(generation: u64, stream: UnixStream, events: &mpsc::UnboundedSender<Event>) -> Connection {
    let (mut read, mut write) = stream.into_split();
    let (writes, mut queue) = mpsc::unbounded_channel::<Write>();
    let reports = events.clone();
    let writer = tokio::spawn(async move {
        while let Some(next) = queue.recv().await {
            match next {
                Write::Bytes(id, bytes) => {
                    if write.write_all(bytes.as_slice()).await.is_err() {
                        let _ = reports.send(Event::WriteFailed(generation));
                        return;
                    }
                    let _ = reports.send(Event::Written(generation, id));
                }
                Write::Shutdown => {
                    let _ = write.shutdown().await;
                    return;
                }
            }
        }
    });
    let reports = events.clone();
    let reader = tokio::spawn(async move {
        let mut buffer = [0u8; 64];
        loop {
            match read.read(&mut buffer).await {
                Ok(0) | Err(_) => {
                    let _ = reports.send(Event::SocketClosed(generation));
                    return;
                }
                Ok(_) => {}
            }
        }
    });
    Connection {
        writes,
        tasks: [writer.abort_handle(), reader.abort_handle()],
    }
}

#[cfg(test)]
#[path = "ingest_tests.rs"]
mod tests;

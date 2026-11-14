// SPDX-License-Identifier: Apache-2.0
//! The thin I/O shell around the engine (docs/media/plan.md, "Transport"): `init` → sockets,
//! probe and `ready`; lane authentication; then one loop that serves the priority lane before
//! anything on the normal lane (a biased select), feeds ingest frames to the engine, and
//! carries out the engine's effects in order. Exits within 1 s of stdin closing.
mod ingest;
mod lanes;
mod writer;

use crate::engine::recorder::NoRecorders;
use crate::engine::sources::IngestId;
use crate::engine::{Effect, Engine, Now};
use crate::framing::{encode, read_control};
use crate::probe::{CpuTrial, TRIAL_DEADLINE, probe};
use crate::secret::LaneSecret;
use ingest::IngestEvent;
use media_wire::control::{
    Control, ControlFrame, FromMedia, Ingest, Lane, Listen, Protocol, Sequence, Stats, ToMedia,
};
use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::io::AsyncReadExt;
use tokio::net::{TcpListener, UnixListener};
use tokio::sync::{mpsc, oneshot};
use writer::Writer;

/// Exit codes the supervisor reads: 2 stops restarts until the daemon restarts.
pub const EXIT_OK: i32 = 0;
pub const EXIT_FAILED: i32 = 1;
pub const EXIT_PROTOCOL: i32 = 2;
/// Every unix socket path must fit `sun_path` (104 bytes on macOS, with its NUL).
const SOCKET_PATH_MAX: usize = 103;
const STDIN_GRACE: Duration = Duration::from_millis(500);
const TICK: Duration = Duration::from_millis(100);

fn fail(message: &str) -> i32 {
    eprintln!("ace-media: {message}");
    EXIT_FAILED
}

fn bind_unix(path: &Path) -> std::io::Result<UnixListener> {
    if path.as_os_str().len() > SOCKET_PATH_MAX {
        return Err(std::io::Error::other("socket path too long"));
    }
    let _ = std::fs::remove_file(path);
    let listener = UnixListener::bind(path)?;
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    Ok(listener)
}

fn sequence(value: u64) -> Sequence {
    Sequence::new(value.min(9_007_199_254_740_991)).unwrap_or_else(|_| unreachable!())
}

struct Clock(Instant);

impl Clock {
    fn now(&self) -> Now {
        let wall = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| d.as_millis() as u64);
        Now {
            mono_ms: self.0.elapsed().as_millis() as u64,
            wall_ms: wall,
        }
    }
}

/// Runs ace-media until stdin closes, `shutdown`, or a lane fails. Returns the exit code.
pub async fn run(version: &str) -> i32 {
    let clock = Clock(Instant::now());
    let mut stdin = tokio::io::stdin();
    let init = match read_control(&mut stdin, Lane::Normal).await {
        Ok(Some(frame)) => frame,
        Ok(None) => return EXIT_OK,
        Err(_) => return EXIT_PROTOCOL,
    };
    let ControlFrame {
        message: ToMedia::Init { runtime_dir, .. },
        payload,
    } = init
    else {
        eprintln!("ace-media: the first message was not init");
        return EXIT_PROTOCOL;
    };
    let Some(secret) = LaneSecret::from_payload(&payload) else {
        return EXIT_PROTOCOL;
    };
    drop(payload);

    let pid = std::process::id();
    let dir = PathBuf::from(runtime_dir);
    let control_path = dir.join(format!("m{pid}c.sock"));
    let ingest_path = dir.join(format!("m{pid}i.sock"));
    let paths = [control_path.clone(), ingest_path.clone()];
    let code = serve(version, &clock, stdin, secret, &control_path, &ingest_path).await;
    for path in paths {
        let _ = std::fs::remove_file(path);
    }
    code
}

async fn serve(
    version: &str,
    clock: &Clock,
    mut stdin: tokio::io::Stdin,
    secret: LaneSecret,
    control_path: &Path,
    ingest_path: &Path,
) -> i32 {
    let control = match bind_unix(control_path) {
        Ok(listener) => listener,
        Err(error) => return fail(&format!("control socket: {error}")),
    };
    let ingest_socket = match bind_unix(ingest_path) {
        Ok(listener) => listener,
        Err(error) => return fail(&format!("ingest socket: {error}")),
    };
    let websocket = match TcpListener::bind(("127.0.0.1", 0)).await {
        Ok(listener) => listener,
        Err(error) => return fail(&format!("ingest websocket: {error}")),
    };
    let websocket_port = websocket.local_addr().map_or(0, |a| u32::from(a.port()));

    let probed =
        tokio::task::spawn_blocking(|| probe(vec![Box::new(CpuTrial)], TRIAL_DEADLINE)).await;
    let Ok((mut capabilities, late)) = probed else {
        return fail("probe");
    };
    let (late_tx, mut late_rx) = mpsc::unbounded_channel();
    std::thread::spawn(move || {
        while let Ok(result) = late.recv() {
            if late_tx.send(result).is_err() {
                return;
            }
        }
    });

    let stdout = Writer::spawn(tokio::io::stdout());
    let ready = FromMedia::Ready {
        protocol: Protocol::new(1).unwrap_or_else(|_| unreachable!()),
        version: version.to_owned(),
        pid: std::process::id(),
        capabilities: capabilities.list(),
        ingest: Ingest {
            socket: ingest_path.to_string_lossy().into_owned(),
            websocket_port,
        },
        control: Control {
            socket: control_path.to_string_lossy().into_owned(),
        },
        listen: Listen {
            loopback_port: 0,
            remote_port: None,
        },
    };
    match encode(ready, Lane::Normal) {
        Ok(bytes) => stdout.send(bytes),
        Err(_) => return fail("ready"),
    }

    let mut lanes = lanes::serve(control, secret);
    let ids = Arc::new(std::sync::atomic::AtomicU64::new(1));
    let (ingest_tx, mut ingest_rx) = mpsc::channel(64);
    ingest::serve_socket(ingest_socket, ids.clone(), ingest_tx.clone());
    ingest::serve_websocket(websocket, ids, ingest_tx);

    let (normal_tx, mut normal_rx) = mpsc::channel(4);
    tokio::spawn(async move {
        loop {
            let frame = read_control(&mut stdin, Lane::Normal).await;
            let end = !matches!(frame, Ok(Some(_)));
            if normal_tx.send(frame).await.is_err() || end {
                return;
            }
        }
    });

    let mut engine = Engine::new(Box::new(NoRecorders));
    let mut connections: HashMap<IngestId, oneshot::Sender<()>> = HashMap::new();
    let lag: Arc<Mutex<VecDeque<Instant>>> = Arc::default();
    let mut priority_rx: Option<mpsc::Receiver<ControlFrame<ToMedia>>> = None;
    let mut priority_out: Option<Writer> = None;
    let mut egress_closed: Option<oneshot::Receiver<()>> = None;
    let mut tick = tokio::time::interval(TICK);
    let mut lanes_pending = true;

    let code = loop {
        tokio::select! {
            biased;
            frame = async {
                match &mut priority_rx {
                    Some(rx) => rx.recv().await,
                    None => std::future::pending().await,
                }
            } => {
                let Some(frame) = frame else { break fail("the priority lane closed") };
                if let Ok(mut lag) = lag.lock() {
                    lag.pop_front();
                }
                engine.control(frame.message, frame.payload, clock.now());
            }
            _ = async {
                match &mut egress_closed {
                    Some(rx) => { let _ = rx.await; }
                    None => std::future::pending().await,
                }
            } => break fail("the egress lane closed"),
            up = &mut lanes, if lanes_pending => {
                lanes_pending = false;
                let Ok(up) = up else { break fail("lane authentication") };
                let (mut read, write) = up.priority.into_split();
                priority_out = Some(Writer::spawn(write));
                let (tx, rx) = mpsc::channel(16);
                priority_rx = Some(rx);
                let lag = lag.clone();
                tokio::spawn(async move {
                    while let Ok(Some(frame)) = read_control(&mut read, Lane::Priority).await {
                        if let Ok(mut lag) = lag.lock() {
                            lag.push_back(Instant::now());
                        }
                        if tx.send(frame).await.is_err() {
                            return;
                        }
                    }
                });
                let (closed_tx, closed_rx) = oneshot::channel();
                egress_closed = Some(closed_rx);
                let mut egress = up.egress;
                tokio::spawn(async move {
                    // Egress carries frames out only (G1); reading tells us when it drops.
                    let mut byte = [0u8; 1];
                    while matches!(egress.read(&mut byte).await, Ok(n) if n > 0) {}
                    let _ = closed_tx.send(());
                });
            }
            frame = normal_rx.recv() => match frame {
                Some(Ok(Some(frame))) => engine.control(frame.message, frame.payload, clock.now()),
                Some(Err(_)) => {
                    eprintln!("ace-media: invalid control frame on stdin");
                    break EXIT_PROTOCOL;
                }
                Some(Ok(None)) | None => {
                    engine.finish();
                    apply(&mut engine, &stdout, priority_out.as_ref(), &mut connections, &lag);
                    break EXIT_OK;
                }
            },
            event = ingest_rx.recv() => match event {
                Some(IngestEvent::Opened(id, close)) => { connections.insert(id, close); }
                Some(IngestEvent::Frame(id, frame)) => engine.ingest(id, frame, clock.now()),
                Some(IngestEvent::Closed(id)) => {
                    connections.remove(&id);
                    engine.ingest_closed(id, clock.now());
                }
                None => {}
            },
            Some((trial, found)) = late_rx.recv() => {
                capabilities.update(trial, found);
                if let Ok(bytes) = encode(
                    FromMedia::CapabilitiesChanged { capabilities: capabilities.list() },
                    Lane::Normal,
                ) {
                    stdout.send(bytes);
                }
            }
            _ = tick.tick() => engine.tick(clock.now()),
        }
        if let Some(grace) = apply(
            &mut engine,
            &stdout,
            priority_out.as_ref(),
            &mut connections,
            &lag,
        ) {
            engine.finish();
            apply(
                &mut engine,
                &stdout,
                priority_out.as_ref(),
                &mut connections,
                &lag,
            );
            let half = grace / 2;
            if let Some(priority) = priority_out.take() {
                priority.close(half).await;
            }
            stdout.close(half).await;
            return EXIT_OK;
        }
    };
    drop(connections);
    if let Some(priority) = priority_out.take() {
        priority.close(STDIN_GRACE).await;
    }
    stdout.close(STDIN_GRACE).await;
    code
}

/// Carries out the engine's effects in order. Returns the grace period when it asked to shut
/// down.
fn apply(
    engine: &mut Engine,
    stdout: &Writer,
    priority: Option<&Writer>,
    connections: &mut HashMap<IngestId, oneshot::Sender<()>>,
    lag: &Mutex<VecDeque<Instant>>,
) -> Option<Duration> {
    let counts = engine.counts();
    let mut shutdown = None;
    let effects: Vec<Effect> = engine.effects().collect();
    for effect in effects {
        match effect {
            Effect::Normal(message) => {
                if let Ok(bytes) = encode(message, Lane::Normal) {
                    stdout.send(bytes);
                }
            }
            Effect::Priority(message) => {
                if let (Some(priority), Ok(bytes)) = (priority, encode(message, Lane::Priority)) {
                    priority.send(bytes);
                }
            }
            Effect::Pong(id) => {
                let lag_ms = lag
                    .lock()
                    .ok()
                    .and_then(|l| l.front().map(|t| t.elapsed().as_millis() as u64))
                    .unwrap_or(0);
                let stats = Stats {
                    sources: sequence(counts.sources),
                    viewers: sequence(counts.viewers),
                    connections: sequence(counts.connections),
                    cpu_ms: sequence(crate::os::cpu_ms()),
                    rss_bytes: sequence(crate::os::rss_bytes()),
                    bytes_out: sequence(counts.bytes_out),
                    priority_lag_ms: sequence(lag_ms),
                };
                if let Ok(bytes) = encode(FromMedia::Pong { id, stats }, Lane::Normal) {
                    stdout.send(bytes);
                }
            }
            Effect::CloseIngest(id) => {
                connections.remove(&id);
            }
            Effect::Shutdown { grace_ms } => {
                shutdown = Some(Duration::from_millis(u64::from(grace_ms)));
            }
        }
    }
    shutdown
}

// SPDX-License-Identifier: Apache-2.0
//! The thin I/O shell around the engine (docs/media/plan.md, "Transport"): `init` → sockets,
//! probe and `ready`; lane authentication; then one loop that serves the priority lane before
//! anything on the normal lane (a biased select), feeds ingest frames to the engine, and
//! carries out the engine's effects in order. Exits within 1 s of stdin closing.
mod budget;
mod effects;
mod egress;
mod ingest;
mod lanes;
mod listener;
mod pictures;
#[cfg(windows)]
mod pipe;
mod readers;
#[cfg(target_os = "macos")]
mod sim_transcode;
mod writer;

use crate::encode::worker::Output;
use crate::engine::sources::IngestId;
use crate::engine::{Engine, Now};
use crate::framing::{encode, read_control};
use crate::probe::{Cancel, TRIAL_DEADLINE, probe, trials};
use crate::secret::LaneSecret;
use effects::{Outputs, Step, apply};
use egress::EgressLane;
use ingest::{Ingest, IngestEvent};
use listener::{Home, Listener, Role};
use media_wire::control::{
    Control, ControlFrame, FromMedia, Ingest as IngestAddress, Lane, Listen, Protocol, ToMedia,
};
use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::io::AsyncReadExt;
use tokio::net::TcpListener;
use tokio::sync::{mpsc, oneshot};
use writer::{EGRESS_LIMIT, NORMAL_LIMIT, PRIORITY_LIMIT, Writer};

/// Exit codes the supervisor reads: 2 stops restarts until the daemon restarts.
pub const EXIT_OK: i32 = 0;
pub const EXIT_FAILED: i32 = 1;
pub const EXIT_PROTOCOL: i32 = 2;
const STDIN_GRACE: Duration = Duration::from_millis(500);
const TICK: Duration = Duration::from_millis(100);

fn fail(message: &str) -> i32 {
    eprintln!("ace-media: {message}");
    EXIT_FAILED
}

/// Recordings need the recorder's unix file handling; elsewhere `record.start` is refused as
/// `recorder-unavailable`, so the daemon keeps its own path.
fn recorders() -> Box<dyn crate::engine::recorder::Recorders> {
    #[cfg(unix)]
    {
        Box::new(crate::record::Mp4Recorders)
    }
    #[cfg(not(unix))]
    {
        Box::new(crate::engine::recorder::NoRecorders)
    }
}

struct Clock(Instant);

impl Clock {
    fn now(&self) -> Now {
        let wall = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| d.as_millis() as u64);
        let mono = self.0.elapsed();
        Now {
            mono_ms: mono.as_millis() as u64,
            mono_us: mono.as_micros() as u64,
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
        message:
            ToMedia::Init {
                runtime_dir,
                data_dir,
                ..
            },
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

    let dir = PathBuf::from(runtime_dir);
    if let Err(reason) = crate::os::private_dir(&dir) {
        return fail(&reason);
    }
    let home = match Home::new(&dir, std::process::id()) {
        Ok(home) => home,
        Err(error) => return fail(&format!("socket names: {error}")),
    };
    let places = Places {
        home: &home,
        data: Path::new(&data_dir),
        runtime: &dir,
    };
    let code = serve(version, &clock, stdin, secret, places).await;
    home.remove();
    code
}

/// Waits on an optional receiver; never resolves while there is none.
async fn maybe<T>(rx: &mut Option<mpsc::Receiver<T>>) -> Option<T> {
    match rx {
        Some(rx) => rx.recv().await,
        None => std::future::pending().await,
    }
}

async fn fired<T>(rx: &mut Option<oneshot::Receiver<T>>) {
    match rx {
        Some(rx) => {
            let _ = rx.await;
        }
        None => std::future::pending().await,
    }
}

/// Where ace-media keeps its sockets and finds its data.
struct Places<'a> {
    home: &'a Home,
    data: &'a Path,
    runtime: &'a Path,
}

struct CancelOnDrop(Cancel);

impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        self.0.cancel();
    }
}

async fn serve(
    version: &str,
    clock: &Clock,
    mut stdin: tokio::io::Stdin,
    secret: LaneSecret,
    places: Places<'_>,
) -> i32 {
    let control = match Listener::bind(places.home, Role::Control) {
        Ok(listener) => listener,
        Err(error) => return fail(&format!("control socket: {error}")),
    };
    let ingest_socket = match Listener::bind(places.home, Role::Ingest) {
        Ok(listener) => listener,
        Err(error) => return fail(&format!("ingest socket: {error}")),
    };
    let websocket = match TcpListener::bind(("127.0.0.1", 0)).await {
        Ok(listener) => listener,
        Err(error) => return fail(&format!("ingest websocket: {error}")),
    };
    let websocket_port = websocket.local_addr().map_or(0, |a| u32::from(a.port()));

    // Trials still running when ace-media stops close their sessions at their next step.
    let cancel = Cancel::default();
    let _cancel_on_exit = CancelOnDrop(cancel.clone());
    let trial_cancel = cancel.clone();
    let probed =
        tokio::task::spawn_blocking(move || probe(trials(), TRIAL_DEADLINE, &trial_cancel)).await;
    let Ok((mut capabilities, late)) = probed else {
        return fail("probe");
    };
    let (late_tx, mut late_rx) = mpsc::unbounded_channel();
    let late_chrome = late_tx.clone();
    std::thread::spawn(move || {
        while let Ok(result) = late.recv() {
            if late_tx.send(result).is_err() {
                return;
            }
        }
    });
    // The last-resort encoder is tried only where no hardware encoder worked; its result comes
    // after `ready`, as `capabilities.changed`.
    let shared: crate::encode::platform::SharedCapabilities =
        Arc::new(Mutex::new(capabilities.list()));
    let profiles = places.runtime.join("chrome");
    let chrome = crate::trials::chrome_options(&capabilities.list(), places.data, &profiles)
        .filter(|_| std::fs::create_dir_all(&profiles).is_ok());
    if let Some(options) = chrome.clone() {
        let slot = capabilities.add_slot();
        crate::trials::chrome_trial(options, TRIAL_DEADLINE, &cancel, move |found| {
            let _ = late_chrome.send((slot, vec![found]));
        });
    }
    let (encoded_tx, mut encoded_rx) = mpsc::channel(256);
    let mut readers = readers::Readers::new(encoded_tx.clone());
    let mut pictures = pictures::Pictures::new(shared.clone(), chrome, encoded_tx);

    let mut stdout = Writer::spawn(tokio::io::stdout(), NORMAL_LIMIT);
    let ready = FromMedia::Ready {
        protocol: Protocol::new(1).unwrap_or_else(|_| unreachable!()),
        version: version.to_owned(),
        pid: std::process::id(),
        capabilities: capabilities.list(),
        ingest: IngestAddress {
            socket: places.home.address(Role::Ingest),
            websocket_port,
        },
        control: Control {
            socket: places.home.address(Role::Control),
        },
        listen: Listen {
            loopback_port: 0,
            remote_port: None,
        },
    };
    let sent = encode(ready, Lane::Normal).map(|bytes| stdout.send(bytes));
    if !matches!(sent, Ok(Ok(()))) {
        return fail("ready");
    }

    let mut lanes = lanes::serve(control, secret);
    let (ingest_tx, mut ingest_rx) = mpsc::channel(64);
    let ingest = Ingest::new(ingest_tx);
    ingest::serve_socket(ingest_socket, ingest.clone());
    ingest::serve_websocket(websocket, ingest);

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

    let egress_lane = EgressLane::default();
    let mut engine = Engine::new(recorders(), Box::new(egress_lane.clone()));
    let (still_tx, mut still_rx) = mpsc::unbounded_channel();
    let started = clock.0;
    let threads = crate::stills::StillThreads::probed(
        crate::stills::thread_count(std::thread::available_parallelism().map_or(1, |n| n.get())),
        &capabilities.list(),
        Arc::new(move || started.elapsed().as_micros() as u64),
        Arc::new(move |outcome| {
            let _ = still_tx.send(outcome);
        }),
    );
    if let Ok(threads) = threads {
        engine = engine.with_stills(Box::new(threads));
    }
    let mut connections: HashMap<IngestId, oneshot::Sender<()>> = HashMap::new();
    let lag: Arc<Mutex<VecDeque<Instant>>> = Arc::default();
    let mut priority_rx: Option<mpsc::Receiver<ControlFrame<ToMedia>>> = None;
    let mut priority_out: Option<Writer> = None;
    let mut priority_failed: Option<oneshot::Receiver<()>> = None;
    let mut egress_closed: Option<oneshot::Receiver<()>> = None;
    let mut egress_failed: Option<oneshot::Receiver<()>> = None;
    let mut tick = tokio::time::interval(TICK);
    let mut lanes_pending = true;

    let code = loop {
        tokio::select! {
            biased;
            frame = maybe(&mut priority_rx) => {
                let Some(frame) = frame else { break fail("the priority lane closed") };
                if let Ok(mut lag) = lag.lock() {
                    lag.pop_front();
                }
                engine.control(frame.message, frame.payload, clock.now());
            }
            _ = fired(&mut priority_failed) => break fail("the priority lane failed"),
            _ = &mut stdout.failed => break fail("stdout failed"),
            _ = fired(&mut egress_closed) => break fail("the egress lane closed"),
            _ = fired(&mut egress_failed) => break fail("the egress lane failed"),
            up = &mut lanes, if lanes_pending => {
                lanes_pending = false;
                let Ok(up) = up else { break fail("lane authentication") };
                let (mut read, write) = listener::split(up.priority);
                let mut writer = Writer::spawn(write, PRIORITY_LIMIT);
                priority_failed = Some(std::mem::replace(&mut writer.failed, oneshot::channel().1));
                priority_out = Some(writer);
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
                let (mut egress_read, egress_write) = listener::split(up.egress);
                let mut writer = Writer::spawn(egress_write, EGRESS_LIMIT);
                egress_failed = Some(std::mem::replace(&mut writer.failed, oneshot::channel().1));
                egress_lane.connect(writer);
                tokio::spawn(async move {
                    // Egress carries frames out only; reading tells us when it drops.
                    let mut byte = [0u8; 1];
                    while matches!(egress_read.read(&mut byte).await, Ok(n) if n > 0) {}
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
                    let mut outputs = Outputs {
                        stdout: &stdout,
                        priority: priority_out.as_ref(),
                        connections: &mut connections,
                        lag: &lag,
                        pictures: &mut pictures,
                        readers: &mut readers,
                        now_ms: clock.now().mono_ms,
                    };
                    apply(&mut engine, &mut outputs);
                    break EXIT_OK;
                }
            },
            event = ingest_rx.recv() => match event {
                Some(IngestEvent::Hello { id, token, admit, close }) => {
                    let admitted = engine.ingest_hello(id, &token[..]);
                    drop(token);
                    if admitted {
                        connections.insert(id, close);
                    }
                    let _ = admit.send(admitted);
                }
                Some(IngestEvent::Frame(id, frame)) => engine.ingest(id, frame, clock.now()),
                Some(IngestEvent::Closed(id)) => {
                    connections.remove(&id);
                    engine.ingest_closed(id, clock.now());
                }
                None => {}
            },
            Some((source, token, output)) = encoded_rx.recv() => match output {
                Output::Unit(frame) => engine.encoded(&source, token, frame, clock.now()),
                Output::Report(acceleration) => engine.encoder_steps(&source, token, acceleration),
                Output::Failed(reason) => engine.encoder_failed(&source, token, &reason),
                Output::Drained => engine.encoder_drained(&source, token),
            },
            Some((trial, found)) = late_rx.recv() => {
                capabilities.update(trial, found);
                let list = capabilities.list();
                if let Ok(mut shared) = shared.lock() {
                    *shared = list.clone();
                }
                engine.capabilities_changed(&list);
                pictures.capabilities_changed();
                let changed = FromMedia::CapabilitiesChanged { capabilities: list };
                if let Ok(bytes) = encode(changed, Lane::Normal)
                    && stdout.send(bytes).is_err()
                {
                    break fail("stdout is backed up past its bound");
                }
            }
            Some(outcome) = still_rx.recv() => engine.still_finished(outcome),
            _ = tick.tick() => {
                let now = clock.now();
                engine.encoders_stuck(pictures.stuck(now.mono_ms) + readers.stuck(now.mono_ms));
                engine.tick(now);
            }
        }
        let mut outputs = Outputs {
            stdout: &stdout,
            priority: priority_out.as_ref(),
            connections: &mut connections,
            lag: &lag,
            pictures: &mut pictures,
            readers: &mut readers,
            now_ms: clock.now().mono_ms,
        };
        match apply(&mut engine, &mut outputs) {
            Step::Continue => {}
            Step::Exit(reason) => break fail(reason),
            Step::Shutdown(grace) => {
                engine.finish();
                apply(&mut engine, &mut outputs);
                let half = grace / 2;
                if let Some(priority) = priority_out.take() {
                    priority.close(half).await;
                }
                stdout.close(half).await;
                return EXIT_OK;
            }
        }
    };
    drop(connections);
    if let Some(priority) = priority_out.take() {
        priority.close(STDIN_GRACE).await;
    }
    stdout.close(STDIN_GRACE).await;
    code
}

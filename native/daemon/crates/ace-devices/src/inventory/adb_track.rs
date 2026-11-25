// SPDX-License-Identifier: Apache-2.0
//! ADB host protocol (`host:track-devices-l`) over TCP + supervised `adb start-server`
//! (ADR 0225, D2). Each attempt is a single connection lifecycle driven by the
//! inventory coordinator's backoff and health state machine.

use crate::error::DeviceError;
use ace_supervisor::child::spawn_child;
use ace_supervisor::errors::NodeIoError;
use ace_supervisor::signal::SignalName;
use ace_supervisor::spawn::{Delivered, EventSink, OutputStream, RawExit, SpawnSpec, StdioMode};
use std::future::Future;
use std::io::ErrorKind;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::{mpsc, oneshot};
use tokio_util::sync::CancellationToken;

/// Default ADB server TCP port on loopback (`127.0.0.1:5037`).
pub const DEFAULT_ADB_PORT: u16 = 5037;

/// ADB host service request for extended device tracking.
pub const TRACK_DEVICES_SERVICE: &str = "host:track-devices-l";

/// Byte cap per track frame, matching `adb devices -l` (`android-platform.ts:105`).
pub const MAX_ADB_FRAME_BYTES: usize = 128 * 1024;

/// Byte cap for an ADB `FAIL` error payload.
const MAX_ADB_FAIL_BYTES: usize = 4 * 1024;

/// Maximum time to connect or complete the `OKAY`/`FAIL` handshake.
pub const ADB_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);

/// Maximum time allowed for `adb start-server` to exit.
pub const ADB_START_SERVER_TIMEOUT: Duration = Duration::from_secs(15);

/// Output byte cap for `adb start-server`.
const ADB_START_SERVER_MAX_BYTES: u64 = 64 * 1024;

/// Configuration for one `host:track-devices-l` session.
#[derive(Debug, Clone)]
pub struct AdbTrackConfig {
    pub addr: SocketAddr,
    pub adb_path: Option<String>,
    pub env: Vec<(String, String)>,
    pub handshake_timeout: Duration,
    pub start_server_timeout: Duration,
}

impl AdbTrackConfig {
    pub fn loopback(port: u16, adb_path: Option<String>, env: Vec<(String, String)>) -> Self {
        Self {
            addr: SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port),
            adb_path,
            env,
            handshake_timeout: ADB_HANDSHAKE_TIMEOUT,
            start_server_timeout: ADB_START_SERVER_TIMEOUT,
        }
    }
}

/// Resolves the ADB server TCP port from `ANDROID_ADB_SERVER_PORT`, defaulting to 5037.
pub fn adb_server_port(env: &[(String, String)]) -> u16 {
    env.iter()
        .find(|(key, _)| key == "ANDROID_ADB_SERVER_PORT")
        .and_then(|(_, val)| val.trim().parse::<u16>().ok())
        .filter(|&port| port > 0)
        .unwrap_or(DEFAULT_ADB_PORT)
}

/// Encodes an ADB host service command as 4 lowercase hex digits + ASCII payload.
pub fn encode_adb_request(service: &str) -> Result<Vec<u8>, DeviceError> {
    let len = service.len();
    if len > 0xffff {
        return Err(DeviceError::AdbProtocol(
            "adb request exceeds 64 KiB".into(),
        ));
    }
    let mut buf = Vec::with_capacity(4 + len);
    buf.extend_from_slice(format!("{len:04x}").as_bytes());
    buf.extend_from_slice(service.as_bytes());
    Ok(buf)
}

/// Parses a 4-hex-digit ADB length prefix.
pub fn parse_hex_len(bytes: &[u8; 4]) -> Result<usize, DeviceError> {
    let text = std::str::from_utf8(bytes)
        .map_err(|_| DeviceError::AdbProtocol("non-ASCII adb length prefix".into()))?;
    usize::from_str_radix(text, 16)
        .map_err(|_| DeviceError::AdbProtocol(format!("invalid adb length prefix: {text}")))
}

/// Sends `host:track-devices-l` and reads `OKAY` or `FAIL`.
pub async fn handshake_track_devices<S>(stream: &mut S) -> Result<(), DeviceError>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let request = encode_adb_request(TRACK_DEVICES_SERVICE)?;
    stream
        .write_all(&request)
        .await
        .map_err(|e| DeviceError::Io(format!("adb write request: {e}")))?;
    stream
        .flush()
        .await
        .map_err(|e| DeviceError::Io(format!("adb flush request: {e}")))?;

    let mut status = [0u8; 4];
    stream
        .read_exact(&mut status)
        .await
        .map_err(|e| DeviceError::Io(format!("adb read status: {e}")))?;

    match &status {
        b"OKAY" => Ok(()),
        b"FAIL" => {
            let mut len_buf = [0u8; 4];
            stream
                .read_exact(&mut len_buf)
                .await
                .map_err(|e| DeviceError::Io(format!("adb read fail length: {e}")))?;
            let len = parse_hex_len(&len_buf)?;
            if len > MAX_ADB_FAIL_BYTES {
                return Err(DeviceError::AdbProtocol(format!(
                    "adb FAIL message too large ({len} bytes)"
                )));
            }
            let mut msg = vec![0u8; len];
            if len > 0 {
                stream
                    .read_exact(&mut msg)
                    .await
                    .map_err(|e| DeviceError::Io(format!("adb read fail body: {e}")))?;
            }
            Err(DeviceError::AdbProtocol(format!(
                "adb server refused track-devices-l: {}",
                String::from_utf8_lossy(&msg)
            )))
        }
        other => Err(DeviceError::AdbProtocol(format!(
            "unexpected adb status: {}",
            String::from_utf8_lossy(other)
        ))),
    }
}

/// Reads one length-prefixed update frame from an active `host:track-devices-l` stream.
/// Returns `Ok(None)` on clean EOF at a frame boundary.
pub async fn read_track_frame<R>(reader: &mut R) -> Result<Option<String>, DeviceError>
where
    R: AsyncRead + Unpin,
{
    let mut len_buf = [0u8; 4];
    let mut filled = 0;
    while filled < 4 {
        let n = reader
            .read(&mut len_buf[filled..])
            .await
            .map_err(|e| DeviceError::Io(format!("adb track read header: {e}")))?;
        if n == 0 {
            if filled == 0 {
                return Ok(None);
            }
            return Err(DeviceError::AdbProtocol(
                "adb track stream ended mid-header".into(),
            ));
        }
        filled += n;
    }
    let len = parse_hex_len(&len_buf)?;
    if len > MAX_ADB_FRAME_BYTES {
        return Err(DeviceError::AdbProtocol(format!(
            "adb track frame exceeds {MAX_ADB_FRAME_BYTES} byte cap ({len} bytes)"
        )));
    }
    let mut payload = vec![0u8; len];
    if len > 0 {
        reader
            .read_exact(&mut payload)
            .await
            .map_err(|e| DeviceError::Io(format!("adb track read payload: {e}")))?;
    }
    Ok(Some(String::from_utf8_lossy(&payload).into_owned()))
}

/// Events emitted by one `host:track-devices-l` connection task.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AdbTrackEvent {
    Connected,
    Update(String),
    Disconnected(String),
}

/// Boundary trait for running `adb start-server` (supervised in production, fake in tests).
pub trait AdbServerStarter: Send + Sync {
    fn start_server(
        &self,
        adb_path: String,
        env: Vec<(String, String)>,
        timeout: Duration,
        cancel: CancellationToken,
    ) -> Pin<Box<dyn Future<Output = Result<(), DeviceError>> + Send>>;
}

/// Event sink for supervised `adb start-server`, capturing exit status without buffering unbounded output.
#[derive(Clone)]
struct StartServerSink {
    exit_tx: Arc<Mutex<Option<oneshot::Sender<RawExit>>>>,
}

impl EventSink for StartServerSink {
    fn output(&self, _stream: OutputStream, _bytes: Vec<u8>, delivered: Delivered) {
        delivered.taken(true);
    }
    fn end(&self, _stream: OutputStream) {}
    fn exit(&self, exit: RawExit) {
        if let Ok(mut slot) = self.exit_tx.lock()
            && let Some(tx) = slot.take()
        {
            let _ = tx.send(exit);
        }
    }
    fn close(&self, _exit: RawExit) {}
    fn stdin_written(&self) {}
    fn stdin_error(&self, _error: NodeIoError) {}
    fn hold_limit(&self) {}
    fn held(&self, _message: String) {}
}

/// Production `adb start-server` starter routed through `ace-supervisor` (ADR 0223 E2).
#[derive(Debug, Default)]
pub struct SupervisedAdbStarter;

impl AdbServerStarter for SupervisedAdbStarter {
    fn start_server(
        &self,
        adb_path: String,
        env: Vec<(String, String)>,
        timeout: Duration,
        cancel: CancellationToken,
    ) -> Pin<Box<dyn Future<Output = Result<(), DeviceError>> + Send>> {
        Box::pin(async move {
            let spec = SpawnSpec {
                command: adb_path,
                args: vec!["start-server".to_owned()],
                cwd: None,
                env,
                windows_verbatim: false,
                hide_window: true,
                // adb start-server daemonizes the adb server process intentionally.
                contain: false,
                max_output_bytes: Some(ADB_START_SERVER_MAX_BYTES),
                stdin: StdioMode::Ignore,
                stdout: StdioMode::Piped,
                stderr: StdioMode::Piped,
            };
            let (exit_tx, exit_rx) = oneshot::channel();
            let sink = StartServerSink {
                exit_tx: Arc::new(Mutex::new(Some(exit_tx))),
            };
            let handle = tokio::runtime::Handle::current();
            let child = spawn_child(&spec, sink, &handle, None)
                .map_err(|e| DeviceError::Io(format!("spawn adb start-server: {e}")))?;

            let outcome = tokio::select! {
                () = cancel.cancelled() => {
                    let _ = child.kill(SignalName::Kill);
                    child.dispose();
                    return Err(DeviceError::Io("adb start-server cancelled".into()));
                }
                () = tokio::time::sleep(timeout) => {
                    let _ = child.kill(SignalName::Kill);
                    child.dispose();
                    return Err(DeviceError::Io("adb start-server timed out".into()));
                }
                res = exit_rx => res,
            };
            child.dispose();
            match outcome {
                Ok(exit) if exit.code == Some(0) => Ok(()),
                Ok(exit) => Err(DeviceError::Io(format!(
                    "adb start-server exited with code {:?} signal {:?}",
                    exit.code, exit.signal
                ))),
                Err(_) => Err(DeviceError::Io("adb start-server waiter closed".into())),
            }
        })
    }
}

async fn connect_with_timeout(
    addr: SocketAddr,
    timeout: Duration,
    cancel: &CancellationToken,
) -> Result<TcpStream, std::io::Error> {
    tokio::select! {
        () = cancel.cancelled() => Err(std::io::Error::new(ErrorKind::Interrupted, "cancelled")),
        res = tokio::time::timeout(timeout, TcpStream::connect(addr)) => {
            match res {
                Ok(inner) => inner,
                Err(_) => Err(std::io::Error::new(ErrorKind::TimedOut, "adb connect timed out")),
            }
        }
    }
}

/// Runs one `host:track-devices-l` connection until EOF, error, or cancellation.
/// On `ConnectionRefused`, runs `adb start-server` (when `adb_path` is set) and retries once.
pub async fn run_adb_track_once(
    config: AdbTrackConfig,
    starter: Arc<dyn AdbServerStarter>,
    events: mpsc::UnboundedSender<AdbTrackEvent>,
    cancel: CancellationToken,
) {
    let mut stream = match connect_with_timeout(config.addr, config.handshake_timeout, &cancel)
        .await
    {
        Ok(stream) => stream,
        Err(err) if err.kind() == ErrorKind::ConnectionRefused => {
            if let Some(adb_path) = config.adb_path.clone() {
                if let Err(start_err) = starter
                    .start_server(
                        adb_path,
                        config.env.clone(),
                        config.start_server_timeout,
                        cancel.clone(),
                    )
                    .await
                {
                    if !cancel.is_cancelled() {
                        let _ = events.send(AdbTrackEvent::Disconnected(start_err.to_string()));
                    }
                    return;
                }
                match connect_with_timeout(config.addr, config.handshake_timeout, &cancel).await {
                    Ok(stream) => stream,
                    Err(retry_err) => {
                        if !cancel.is_cancelled() {
                            let _ = events.send(AdbTrackEvent::Disconnected(format!(
                                "adb connect after start-server: {retry_err}"
                            )));
                        }
                        return;
                    }
                }
            } else {
                if !cancel.is_cancelled() {
                    let _ = events.send(AdbTrackEvent::Disconnected(format!("adb connect: {err}")));
                }
                return;
            }
        }
        Err(err) => {
            if !cancel.is_cancelled() {
                let _ = events.send(AdbTrackEvent::Disconnected(format!("adb connect: {err}")));
            }
            return;
        }
    };

    let handshake = tokio::select! {
        () = cancel.cancelled() => return,
        res = tokio::time::timeout(config.handshake_timeout, handshake_track_devices(&mut stream)) => res,
    };
    match handshake {
        Ok(Ok(())) => {
            let _ = events.send(AdbTrackEvent::Connected);
        }
        Ok(Err(err)) => {
            if !cancel.is_cancelled() {
                let _ = events.send(AdbTrackEvent::Disconnected(err.to_string()));
            }
            return;
        }
        Err(_) => {
            if !cancel.is_cancelled() {
                let _ = events.send(AdbTrackEvent::Disconnected(
                    "adb track-devices-l handshake timed out".into(),
                ));
            }
            return;
        }
    }

    loop {
        let frame = tokio::select! {
            () = cancel.cancelled() => return,
            res = read_track_frame(&mut stream) => res,
        };
        match frame {
            Ok(Some(payload)) => {
                if events.send(AdbTrackEvent::Update(payload)).is_err() {
                    return;
                }
            }
            Ok(None) => {
                if !cancel.is_cancelled() {
                    let _ = events.send(AdbTrackEvent::Disconnected(
                        "adb track-devices-l stream ended".into(),
                    ));
                }
                return;
            }
            Err(err) => {
                if !cancel.is_cancelled() {
                    let _ = events.send(AdbTrackEvent::Disconnected(err.to_string()));
                }
                return;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tokio::net::TcpListener;

    type StartFuture = Pin<Box<dyn Future<Output = Result<(), DeviceError>> + Send>>;
    type StartFn = Arc<dyn Fn() -> StartFuture + Send + Sync>;

    struct FakeStarter {
        calls: Arc<AtomicUsize>,
        on_start: StartFn,
    }

    impl AdbServerStarter for FakeStarter {
        fn start_server(
            &self,
            _adb_path: String,
            _env: Vec<(String, String)>,
            _timeout: Duration,
            _cancel: CancellationToken,
        ) -> Pin<Box<dyn Future<Output = Result<(), DeviceError>> + Send>> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            (self.on_start)()
        }
    }

    #[test]
    fn encodes_track_request_and_resolves_port() {
        assert_eq!(
            encode_adb_request(TRACK_DEVICES_SERVICE),
            Ok(b"0014host:track-devices-l".to_vec())
        );
        assert_eq!(adb_server_port(&[]), 5037);
        assert_eq!(
            adb_server_port(&[("ANDROID_ADB_SERVER_PORT".into(), "5040".into())]),
            5040
        );
        assert_eq!(
            adb_server_port(&[("ANDROID_ADB_SERVER_PORT".into(), "bad".into())]),
            5037
        );
    }

    #[tokio::test]
    async fn track_receives_okay_updates_and_reports_disconnect_on_eof() {
        let Ok(listener) = TcpListener::bind("127.0.0.1:0").await else {
            panic!("bind loopback");
        };
        let Ok(addr) = listener.local_addr() else {
            panic!("local_addr");
        };
        let server = tokio::spawn(async move {
            let Ok((mut sock, _)) = listener.accept().await else {
                return;
            };
            let mut req = [0u8; 24];
            if sock.read_exact(&mut req).await.is_err() {
                return;
            }
            assert_eq!(&req, b"0014host:track-devices-l");
            let frame1 = "emulator-5554 device model:Pixel_9\n";
            let msg = format!("OKAY{:04x}{frame1}0000", frame1.len());
            let _ = sock.write_all(msg.as_bytes()).await;
            let _ = sock.shutdown().await;
        });

        let (tx, mut rx) = mpsc::unbounded_channel();
        let cancel = CancellationToken::new();
        let starter = Arc::new(FakeStarter {
            calls: Arc::new(AtomicUsize::new(0)),
            on_start: Arc::new(|| Box::pin(async { Ok(()) })),
        });
        let config = AdbTrackConfig {
            addr,
            adb_path: Some("/fake/adb".into()),
            env: vec![],
            handshake_timeout: Duration::from_secs(2),
            start_server_timeout: Duration::from_secs(2),
        };
        run_adb_track_once(config, starter.clone(), tx, cancel).await;
        let _ = server.await;

        assert_eq!(starter.calls.load(Ordering::SeqCst), 0);
        assert_eq!(rx.recv().await, Some(AdbTrackEvent::Connected));
        assert_eq!(
            rx.recv().await,
            Some(AdbTrackEvent::Update(
                "emulator-5554 device model:Pixel_9\n".into()
            ))
        );
        assert_eq!(rx.recv().await, Some(AdbTrackEvent::Update(String::new())));
        assert!(matches!(
            rx.recv().await,
            Some(AdbTrackEvent::Disconnected(_))
        ));
    }

    #[tokio::test]
    async fn connection_refused_starts_adb_server_and_reconnects() {
        // Reserve and immediately release a loopback port so initial connect gets ConnectionRefused.
        let Ok(probe) = TcpListener::bind("127.0.0.1:0").await else {
            panic!("bind");
        };
        let Ok(addr) = probe.local_addr() else {
            panic!("addr");
        };
        drop(probe);

        let calls = Arc::new(AtomicUsize::new(0));
        let starter = Arc::new(FakeStarter {
            calls: Arc::clone(&calls),
            on_start: Arc::new(move || {
                Box::pin(async move {
                    let listener = TcpListener::bind(addr)
                        .await
                        .map_err(|e| DeviceError::Io(e.to_string()))?;
                    tokio::spawn(async move {
                        if let Ok((mut sock, _)) = listener.accept().await {
                            let mut req = [0u8; 24];
                            if sock.read_exact(&mut req).await.is_ok() {
                                let _ = sock.write_all(b"OKAY0000").await;
                            }
                        }
                    });
                    Ok(())
                })
            }),
        });
        let (tx, mut rx) = mpsc::unbounded_channel();
        let cancel = CancellationToken::new();
        let config = AdbTrackConfig {
            addr,
            adb_path: Some("/fake/adb".into()),
            env: vec![],
            handshake_timeout: Duration::from_secs(2),
            start_server_timeout: Duration::from_secs(2),
        };
        run_adb_track_once(config, starter, tx, cancel).await;

        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(rx.recv().await, Some(AdbTrackEvent::Connected));
        assert_eq!(rx.recv().await, Some(AdbTrackEvent::Update(String::new())));
    }

    #[tokio::test]
    async fn fail_handshake_and_oversized_frame_disconnect_cleanly() {
        let Ok(listener) = TcpListener::bind("127.0.0.1:0").await else {
            panic!("bind");
        };
        let Ok(addr) = listener.local_addr() else {
            panic!("addr");
        };
        tokio::spawn(async move {
            if let Ok((mut sock, _)) = listener.accept().await {
                let mut req = [0u8; 24];
                if sock.read_exact(&mut req).await.is_ok() {
                    let _ = sock.write_all(b"FAIL0004nope").await;
                }
            }
        });
        let (tx, mut rx) = mpsc::unbounded_channel();
        let starter = Arc::new(FakeStarter {
            calls: Arc::new(AtomicUsize::new(0)),
            on_start: Arc::new(|| Box::pin(async { Ok(()) })),
        });
        run_adb_track_once(
            AdbTrackConfig::loopback(addr.port(), None, vec![]),
            starter,
            tx,
            CancellationToken::new(),
        )
        .await;
        let event = rx.recv().await;
        assert!(
            matches!(event, Some(AdbTrackEvent::Disconnected(ref msg)) if msg.contains("nope"))
        );
    }
}

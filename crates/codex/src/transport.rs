use crate::{CodexError, Result};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, VecDeque},
    io,
    path::Path,
    process::Stdio,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicI64, Ordering},
    },
    time::Duration,
};
#[cfg(unix)]
use tokio::net::UnixStream;
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, Command},
    sync::{Mutex, mpsc, oneshot},
    time,
};

const OUTBOUND_QUEUE_SIZE: usize = 256;
const EVENT_QUEUE_SIZE: usize = 1024;
const MAX_PENDING_REQUESTS: usize = 256;
const MAX_LINE_BYTES: usize = 16 * 1024 * 1024;
const STDERR_TAIL_LINES: usize = 128;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CodexJsonRpcError {
    pub code: i64,
    pub message: String,
    #[serde(default)]
    pub data: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CodexResponse {
    pub id: i64,
    #[serde(default)]
    pub result: Option<Value>,
    #[serde(default)]
    pub error: Option<CodexJsonRpcError>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum CodexInboundEvent {
    Notification {
        method: String,
        params: Value,
    },
    ServerRequest {
        id: i64,
        method: String,
        params: Value,
    },
    StderrLine(String),
    ServerExited {
        code: Option<i32>,
    },
}

type PendingSender = oneshot::Sender<Result<Value>>;
type PendingRequests = Arc<Mutex<HashMap<i64, PendingSender>>>;
type StderrTail = Arc<Mutex<VecDeque<String>>>;

enum ChildControl {
    Shutdown {
        grace: Duration,
        done: oneshot::Sender<()>,
    },
}

#[async_trait]
pub trait AppServerTransport: Send + Sync {
    async fn request(&self, method: &str, params: Value, timeout: Duration) -> Result<Value>;
    async fn notify(&self, method: &str, params: Value) -> Result<()>;
    async fn respond_result(&self, id: i64, result: Value) -> Result<()>;
    async fn respond_error(&self, id: i64, code: i64, message: &str) -> Result<()>;
    async fn recv(&self) -> Option<CodexInboundEvent>;
    async fn stderr_tail(&self) -> Vec<String>;
    async fn shutdown(&self, timeout: Duration) -> Result<()>;

    fn is_closed(&self) -> bool {
        false
    }
}

#[derive(Clone)]
pub struct CodexStdioTransport {
    outbound: mpsc::Sender<Vec<u8>>,
    events: Arc<Mutex<mpsc::Receiver<CodexInboundEvent>>>,
    pending: PendingRequests,
    next_id: Arc<AtomicI64>,
    stderr_tail: StderrTail,
    child_control: mpsc::Sender<ChildControl>,
    closed: Arc<AtomicBool>,
}

pub type JsonlAppServerTransport = CodexStdioTransport;

#[derive(Clone)]
pub struct CodexUnixSocketTransport {
    outbound: mpsc::Sender<Vec<u8>>,
    events: Arc<Mutex<mpsc::Receiver<CodexInboundEvent>>>,
    pending: PendingRequests,
    next_id: Arc<AtomicI64>,
    closed: Arc<AtomicBool>,
}

impl CodexStdioTransport {
    pub async fn spawn(command: &str, args: &[String]) -> Result<Self> {
        let mut command_builder = Command::new(command);
        command_builder
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let mut child = command_builder.spawn().map_err(|source| {
            if source.kind() == io::ErrorKind::NotFound {
                CodexError::MissingBinary(command.to_string())
            } else {
                CodexError::Spawn(source)
            }
        })?;

        let mut stdin = child.stdin.take().ok_or(CodexError::MissingStdin)?;
        let stdout = child.stdout.take().ok_or(CodexError::MissingStdout)?;
        let stderr = child.stderr.take().ok_or(CodexError::MissingStderr)?;

        let (outbound, mut outbound_rx) = mpsc::channel::<Vec<u8>>(OUTBOUND_QUEUE_SIZE);
        let (events_tx, events_rx) = mpsc::channel::<CodexInboundEvent>(EVENT_QUEUE_SIZE);
        let (child_control, child_control_rx) = mpsc::channel::<ChildControl>(1);
        let pending: PendingRequests = Arc::new(Mutex::new(HashMap::new()));
        let stderr_tail: StderrTail =
            Arc::new(Mutex::new(VecDeque::with_capacity(STDERR_TAIL_LINES)));
        let closed = Arc::new(AtomicBool::new(false));

        tokio::spawn(async move {
            while let Some(frame) = outbound_rx.recv().await {
                if stdin.write_all(&frame).await.is_err() {
                    break;
                }
            }
        });

        tokio::spawn(read_stdout_loop(
            stdout,
            Arc::clone(&pending),
            events_tx.clone(),
        ));
        tokio::spawn(read_stderr_loop(
            stderr,
            Arc::clone(&stderr_tail),
            events_tx.clone(),
        ));
        tokio::spawn(child_lifecycle_loop(
            child,
            child_control_rx,
            Arc::clone(&pending),
            events_tx,
            Arc::clone(&closed),
        ));

        Ok(Self {
            outbound,
            events: Arc::new(Mutex::new(events_rx)),
            pending,
            next_id: Arc::new(AtomicI64::new(1)),
            stderr_tail,
            child_control,
            closed,
        })
    }

    async fn send_value(&self, value: Value) -> Result<()> {
        let mut frame = serde_json::to_vec(&value)?;
        if frame.len() > MAX_LINE_BYTES {
            return Err(CodexError::FrameTooLarge {
                limit: MAX_LINE_BYTES,
            });
        }
        frame.push(b'\n');
        self.outbound
            .send(frame)
            .await
            .map_err(|_| CodexError::OutboundQueueFull)
    }
}

#[async_trait]
impl AppServerTransport for CodexStdioTransport {
    async fn request(&self, method: &str, params: Value, timeout: Duration) -> Result<Value> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        {
            let mut pending = self.pending.lock().await;
            if pending.len() >= MAX_PENDING_REQUESTS {
                return Err(CodexError::PendingRequestsFull);
            }
            pending.insert(id, tx);
        }

        let payload = json!({
            "id": id,
            "method": method,
            "params": params,
        });
        if let Err(error) = self.send_value(payload).await {
            self.pending.lock().await.remove(&id);
            return Err(error);
        }

        time::timeout(timeout, rx)
            .await
            .map_err(|_| {
                let pending = Arc::clone(&self.pending);
                tokio::spawn(async move {
                    pending.lock().await.remove(&id);
                });
                CodexError::RequestTimeout {
                    method: method.to_string(),
                    timeout,
                }
            })?
            .map_err(|_| CodexError::TransportClosed)?
    }

    async fn notify(&self, method: &str, params: Value) -> Result<()> {
        self.send_value(json!({
            "method": method,
            "params": params,
        }))
        .await
    }

    async fn respond_result(&self, id: i64, result: Value) -> Result<()> {
        self.send_value(json!({ "id": id, "result": result })).await
    }

    async fn respond_error(&self, id: i64, code: i64, message: &str) -> Result<()> {
        self.send_value(json!({
            "id": id,
            "error": {
                "code": code,
                "message": message,
            },
        }))
        .await
    }

    async fn recv(&self) -> Option<CodexInboundEvent> {
        self.events.lock().await.recv().await
    }

    async fn stderr_tail(&self) -> Vec<String> {
        self.stderr_tail.lock().await.iter().cloned().collect()
    }

    async fn shutdown(&self, timeout: Duration) -> Result<()> {
        let _ = self.notify("shutdown", Value::Null).await;
        let (done_tx, done_rx) = oneshot::channel();
        if self
            .child_control
            .send(ChildControl::Shutdown {
                grace: timeout,
                done: done_tx,
            })
            .await
            .is_err()
        {
            return Err(CodexError::TransportClosed);
        }
        done_rx.await.map_err(|_| CodexError::TransportClosed)
    }

    fn is_closed(&self) -> bool {
        self.closed.load(Ordering::Relaxed)
    }
}

impl CodexUnixSocketTransport {
    #[cfg(unix)]
    pub async fn connect(path: impl AsRef<Path>) -> Result<Self> {
        let stream = UnixStream::connect(path).await?;
        let (read_half, mut write_half) = stream.into_split();
        let (outbound, mut outbound_rx) = mpsc::channel::<Vec<u8>>(OUTBOUND_QUEUE_SIZE);
        let (events_tx, events_rx) = mpsc::channel::<CodexInboundEvent>(EVENT_QUEUE_SIZE);
        let pending: PendingRequests = Arc::new(Mutex::new(HashMap::new()));
        let closed = Arc::new(AtomicBool::new(false));

        let writer_closed = Arc::clone(&closed);
        let writer_pending = Arc::clone(&pending);
        tokio::spawn(async move {
            while let Some(frame) = outbound_rx.recv().await {
                if write_half.write_all(&frame).await.is_err() {
                    break;
                }
            }
            writer_closed.store(true, Ordering::Relaxed);
            close_pending_requests(&writer_pending).await;
        });

        tokio::spawn(read_socket_loop(
            read_half,
            Arc::clone(&pending),
            events_tx,
            Arc::clone(&closed),
        ));

        Ok(Self {
            outbound,
            events: Arc::new(Mutex::new(events_rx)),
            pending,
            next_id: Arc::new(AtomicI64::new(1)),
            closed,
        })
    }

    #[cfg(not(unix))]
    pub async fn connect(_path: impl AsRef<Path>) -> Result<Self> {
        Err(CodexError::InvalidMessage(
            "Unix socket Codex app-server transport is not supported on this platform".to_string(),
        ))
    }

    async fn send_value(&self, value: Value) -> Result<()> {
        let mut frame = serde_json::to_vec(&value)?;
        if frame.len() > MAX_LINE_BYTES {
            return Err(CodexError::FrameTooLarge {
                limit: MAX_LINE_BYTES,
            });
        }
        frame.push(b'\n');
        self.outbound
            .send(frame)
            .await
            .map_err(|_| CodexError::OutboundQueueFull)
    }
}

#[async_trait]
impl AppServerTransport for CodexUnixSocketTransport {
    async fn request(&self, method: &str, params: Value, timeout: Duration) -> Result<Value> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        {
            let mut pending = self.pending.lock().await;
            if pending.len() >= MAX_PENDING_REQUESTS {
                return Err(CodexError::PendingRequestsFull);
            }
            pending.insert(id, tx);
        }

        let payload = json!({
            "id": id,
            "method": method,
            "params": params,
        });
        if let Err(error) = self.send_value(payload).await {
            self.pending.lock().await.remove(&id);
            return Err(error);
        }

        time::timeout(timeout, rx)
            .await
            .map_err(|_| {
                let pending = Arc::clone(&self.pending);
                tokio::spawn(async move {
                    pending.lock().await.remove(&id);
                });
                CodexError::RequestTimeout {
                    method: method.to_string(),
                    timeout,
                }
            })?
            .map_err(|_| CodexError::TransportClosed)?
    }

    async fn notify(&self, method: &str, params: Value) -> Result<()> {
        self.send_value(json!({
            "method": method,
            "params": params,
        }))
        .await
    }

    async fn respond_result(&self, id: i64, result: Value) -> Result<()> {
        self.send_value(json!({ "id": id, "result": result })).await
    }

    async fn respond_error(&self, id: i64, code: i64, message: &str) -> Result<()> {
        self.send_value(json!({
            "id": id,
            "error": {
                "code": code,
                "message": message,
            },
        }))
        .await
    }

    async fn recv(&self) -> Option<CodexInboundEvent> {
        self.events.lock().await.recv().await
    }

    async fn stderr_tail(&self) -> Vec<String> {
        Vec::new()
    }

    async fn shutdown(&self, _timeout: Duration) -> Result<()> {
        let _ = self.notify("shutdown", Value::Null).await;
        Ok(())
    }

    fn is_closed(&self) -> bool {
        self.closed.load(Ordering::Relaxed)
    }
}

async fn read_stdout_loop(
    stdout: impl tokio::io::AsyncRead + Unpin,
    pending: PendingRequests,
    events: mpsc::Sender<CodexInboundEvent>,
) {
    let mut lines = BufReader::new(stdout).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        if line.len() > MAX_LINE_BYTES {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        route_message(value, &pending, &events).await;
    }
}

#[cfg(unix)]
async fn read_socket_loop(
    stream: tokio::net::unix::OwnedReadHalf,
    pending: PendingRequests,
    events: mpsc::Sender<CodexInboundEvent>,
    closed: Arc<AtomicBool>,
) {
    let mut lines = BufReader::new(stream).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        if line.len() > MAX_LINE_BYTES {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        route_message(value, &pending, &events).await;
    }
    closed.store(true, Ordering::Relaxed);
    close_pending_requests(&pending).await;
    let _ = events
        .send(CodexInboundEvent::ServerExited { code: None })
        .await;
}

async fn read_stderr_loop(
    stderr: impl tokio::io::AsyncRead + Unpin,
    tail: StderrTail,
    events: mpsc::Sender<CodexInboundEvent>,
) {
    let mut lines = BufReader::new(stderr).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let line = if line.len() > MAX_LINE_BYTES {
            line.chars().take(MAX_LINE_BYTES).collect()
        } else {
            line
        };
        {
            let mut tail = tail.lock().await;
            if tail.len() >= STDERR_TAIL_LINES {
                tail.pop_front();
            }
            tail.push_back(line.clone());
        }
        if events
            .send(CodexInboundEvent::StderrLine(line))
            .await
            .is_err()
        {
            break;
        }
    }
}

async fn child_lifecycle_loop(
    mut child: Child,
    mut control: mpsc::Receiver<ChildControl>,
    pending: PendingRequests,
    events: mpsc::Sender<CodexInboundEvent>,
    closed: Arc<AtomicBool>,
) {
    let code = tokio::select! {
        status = child.wait() => status.ok().and_then(|status| status.code()),
        command = control.recv() => {
            match command {
                Some(ChildControl::Shutdown { grace, done }) => {
                    let code = match time::timeout(grace, child.wait()).await {
                        Ok(status) => status.ok().and_then(|status| status.code()),
                        Err(_) => {
                            let _ = child.start_kill();
                            child.wait().await.ok().and_then(|status| status.code())
                        }
                    };
                    let _ = done.send(());
                    code
                }
                None => child.wait().await.ok().and_then(|status| status.code()),
            }
        }
    };
    closed.store(true, Ordering::Relaxed);
    close_pending_requests(&pending).await;
    let _ = events.send(CodexInboundEvent::ServerExited { code }).await;
}

async fn close_pending_requests(pending: &PendingRequests) {
    let requests = {
        let mut pending = pending.lock().await;
        pending
            .drain()
            .map(|(_, sender)| sender)
            .collect::<Vec<_>>()
    };
    for sender in requests {
        let _ = sender.send(Err(CodexError::TransportClosed));
    }
}

async fn route_message(
    value: Value,
    pending: &PendingRequests,
    events: &mpsc::Sender<CodexInboundEvent>,
) {
    let Some(object) = value.as_object() else {
        return;
    };

    if object.contains_key("result") || object.contains_key("error") {
        let Some(id) = object.get("id").and_then(Value::as_i64) else {
            return;
        };
        let response = parse_response(id, value);
        if let Some(sender) = pending.lock().await.remove(&id) {
            let _ = sender.send(response);
        }
        return;
    }

    let Some(method) = object.get("method").and_then(Value::as_str) else {
        return;
    };
    let params = object.get("params").cloned().unwrap_or(Value::Null);
    let event = if let Some(id) = object.get("id").and_then(Value::as_i64) {
        CodexInboundEvent::ServerRequest {
            id,
            method: method.to_string(),
            params,
        }
    } else {
        CodexInboundEvent::Notification {
            method: method.to_string(),
            params,
        }
    };
    let _ = events.send(event).await;
}

fn parse_response(id: i64, value: Value) -> Result<Value> {
    let response: CodexResponse = serde_json::from_value(value)?;
    if let Some(error) = response.error {
        return Err(CodexError::RequestFailed {
            method: format!("request#{id}"),
            code: error.code,
            message: error.message,
        });
    }
    Ok(response.result.unwrap_or(Value::Null))
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::{collections::VecDeque, sync::Mutex as StdMutex};
    use tokio::io::AsyncWriteExt;
    #[cfg(unix)]
    use tokio::net::UnixListener;

    #[derive(Default)]
    pub struct FakeTransport {
        pub requests: StdMutex<Vec<(String, Value)>>,
        pub notifications: StdMutex<Vec<(String, Value)>>,
        pub server_request_responses: StdMutex<VecDeque<Value>>,
        pub responses: StdMutex<VecDeque<Result<Value>>>,
        pub inbound: StdMutex<VecDeque<CodexInboundEvent>>,
        pub stderr_tail: StdMutex<Vec<String>>,
        pub shutdowns: StdMutex<Vec<Duration>>,
        pub closed: StdMutex<bool>,
    }

    #[async_trait]
    impl AppServerTransport for FakeTransport {
        async fn request(&self, method: &str, params: Value, _timeout: Duration) -> Result<Value> {
            self.requests
                .lock()
                .expect("requests")
                .push((method.to_string(), params));
            self.responses
                .lock()
                .expect("responses")
                .pop_front()
                .unwrap_or(Ok(Value::Null))
        }

        async fn notify(&self, method: &str, params: Value) -> Result<()> {
            self.notifications
                .lock()
                .expect("notifications")
                .push((method.to_string(), params));
            Ok(())
        }

        async fn respond_result(&self, id: i64, result: Value) -> Result<()> {
            self.server_request_responses
                .lock()
                .expect("server request responses")
                .push_back(json!({ "id": id, "result": result }));
            Ok(())
        }

        async fn respond_error(&self, id: i64, code: i64, message: &str) -> Result<()> {
            self.server_request_responses
                .lock()
                .expect("server request responses")
                .push_back(json!({
                    "id": id,
                    "error": {
                        "code": code,
                        "message": message,
                    }
                }));
            Ok(())
        }

        async fn recv(&self) -> Option<CodexInboundEvent> {
            self.inbound.lock().expect("inbound").pop_front()
        }

        async fn stderr_tail(&self) -> Vec<String> {
            self.stderr_tail.lock().expect("stderr tail").clone()
        }

        async fn shutdown(&self, timeout: Duration) -> Result<()> {
            self.shutdowns.lock().expect("shutdowns").push(timeout);
            Ok(())
        }

        fn is_closed(&self) -> bool {
            *self.closed.lock().expect("closed")
        }
    }

    #[tokio::test]
    async fn fake_transport_records_server_request_responses_as_json_rpc_frames() {
        let fake = FakeTransport::default();
        fake.respond_result(11, json!({ "approved": true }))
            .await
            .expect("result");
        fake.respond_error(12, -32001, "denied")
            .await
            .expect("error");

        let responses = fake
            .server_request_responses
            .lock()
            .expect("server request responses")
            .clone();
        assert_eq!(
            responses.into_iter().collect::<Vec<_>>(),
            vec![
                json!({ "id": 11, "result": { "approved": true } }),
                json!({
                    "id": 12,
                    "error": {
                        "code": -32001,
                        "message": "denied"
                    }
                })
            ]
        );
    }

    #[tokio::test]
    async fn routes_response_notification_and_server_request() {
        let (events_tx, mut events_rx) = mpsc::channel(4);
        let pending: PendingRequests = Arc::new(Mutex::new(HashMap::new()));
        let (tx, rx) = oneshot::channel();
        pending.lock().await.insert(7, tx);

        route_message(
            json!({ "id": 7, "result": { "ok": true } }),
            &pending,
            &events_tx,
        )
        .await;
        assert_eq!(rx.await.expect("response").expect("ok")["ok"], true);

        route_message(
            json!({ "method": "turn/started", "params": { "threadId": "t" } }),
            &pending,
            &events_tx,
        )
        .await;
        assert!(matches!(
            events_rx.recv().await,
            Some(CodexInboundEvent::Notification { method, .. }) if method == "turn/started"
        ));

        route_message(
            json!({ "id": 9, "method": "item/tool/call", "params": {} }),
            &pending,
            &events_tx,
        )
        .await;
        assert!(matches!(
            events_rx.recv().await,
            Some(CodexInboundEvent::ServerRequest { id: 9, method, .. }) if method == "item/tool/call"
        ));
    }

    #[tokio::test]
    async fn stderr_loop_captures_tail_and_emits_events() {
        let (mut writer, reader) = tokio::io::duplex(1024);
        let tail: StderrTail = Arc::new(Mutex::new(VecDeque::new()));
        let (events_tx, mut events_rx) = mpsc::channel(4);
        let task = tokio::spawn(read_stderr_loop(reader, Arc::clone(&tail), events_tx));

        writer
            .write_all(b"warn one\nwarn two\n")
            .await
            .expect("write");
        drop(writer);
        task.await.expect("stderr loop");

        assert_eq!(
            tail.lock().await.iter().cloned().collect::<Vec<_>>(),
            ["warn one".to_string(), "warn two".to_string()]
        );
        assert_eq!(
            events_rx.recv().await,
            Some(CodexInboundEvent::StderrLine("warn one".to_string()))
        );
        assert_eq!(
            events_rx.recv().await,
            Some(CodexInboundEvent::StderrLine("warn two".to_string()))
        );
    }

    #[tokio::test]
    async fn close_pending_requests_wakes_waiters_with_transport_closed() {
        let pending: PendingRequests = Arc::new(Mutex::new(HashMap::new()));
        let (tx, rx) = oneshot::channel();
        pending.lock().await.insert(99, tx);

        close_pending_requests(&pending).await;

        let error = rx
            .await
            .expect("pending response")
            .expect_err("transport closed");
        assert!(matches!(error, CodexError::TransportClosed));
        assert!(pending.lock().await.is_empty());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn unix_socket_transport_routes_json_rpc_frames() {
        let directory = tempfile::tempdir().expect("tempdir");
        let socket_path = directory.path().join("codex.sock");
        let listener = UnixListener::bind(&socket_path).expect("bind socket");

        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.expect("accept");
            let (read_half, mut write_half) = stream.into_split();
            let mut lines = BufReader::new(read_half).lines();

            let request = lines
                .next_line()
                .await
                .expect("read request")
                .expect("request line");
            let request: Value = serde_json::from_str(&request).expect("request json");
            assert_eq!(request["method"], "thread/read");
            assert_eq!(request["params"]["threadId"], "thread-1");
            write_half
                .write_all(
                    format!(
                        "{}\n",
                        json!({
                            "id": request["id"],
                            "result": { "threadId": "thread-1" }
                        })
                    )
                    .as_bytes(),
                )
                .await
                .expect("write response");

            write_half
                .write_all(
                    format!(
                        "{}\n",
                        json!({
                            "method": "turn/started",
                            "params": { "threadId": "thread-1", "turnId": "turn-1" }
                        })
                    )
                    .as_bytes(),
                )
                .await
                .expect("write notification");
        });

        let transport = CodexUnixSocketTransport::connect(&socket_path)
            .await
            .expect("connect socket");
        let result = transport
            .request(
                "thread/read",
                json!({ "threadId": "thread-1" }),
                Duration::from_secs(1),
            )
            .await
            .expect("request result");
        assert_eq!(result["threadId"], "thread-1");
        assert!(matches!(
            transport.recv().await,
            Some(CodexInboundEvent::Notification { method, params })
                if method == "turn/started" && params["turnId"] == "turn-1"
        ));

        server.await.expect("server task");
    }
}

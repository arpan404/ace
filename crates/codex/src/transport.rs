use crate::{CodexError, Result};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    io,
    process::Stdio,
    sync::{
        Arc,
        atomic::{AtomicI64, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::Command,
    sync::{Mutex, mpsc, oneshot},
    time,
};

const OUTBOUND_QUEUE_SIZE: usize = 256;
const EVENT_QUEUE_SIZE: usize = 1024;
const MAX_PENDING_REQUESTS: usize = 256;
const MAX_LINE_BYTES: usize = 16 * 1024 * 1024;

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
}

#[derive(Debug, Clone, PartialEq)]
pub enum StdioTransportEvent {
    StderrLine(String),
    ServerExited,
}

type PendingSender = oneshot::Sender<Result<Value>>;
type PendingRequests = Arc<Mutex<HashMap<i64, PendingSender>>>;

#[async_trait]
pub trait AppServerTransport: Send + Sync {
    async fn request(&self, method: &str, params: Value, timeout: Duration) -> Result<Value>;
    async fn notify(&self, method: &str, params: Value) -> Result<()>;
    async fn respond_result(&self, id: i64, result: Value) -> Result<()>;
    async fn respond_error(&self, id: i64, code: i64, message: &str) -> Result<()>;
    async fn recv(&self) -> Option<CodexInboundEvent>;
}

#[derive(Clone)]
pub struct CodexStdioTransport {
    outbound: mpsc::Sender<Vec<u8>>,
    events: Arc<Mutex<mpsc::Receiver<CodexInboundEvent>>>,
    pending: PendingRequests,
    next_id: Arc<AtomicI64>,
}

pub type JsonlAppServerTransport = CodexStdioTransport;

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
        let pending: PendingRequests = Arc::new(Mutex::new(HashMap::new()));

        tokio::spawn(async move {
            while let Some(frame) = outbound_rx.recv().await {
                if stdin.write_all(&frame).await.is_err() {
                    break;
                }
            }
        });

        tokio::spawn(read_stdout_loop(stdout, Arc::clone(&pending), events_tx));
        tokio::spawn(read_stderr_loop(stderr));
        tokio::spawn(async move {
            let _ = child.wait().await;
        });

        Ok(Self {
            outbound,
            events: Arc::new(Mutex::new(events_rx)),
            pending,
            next_id: Arc::new(AtomicI64::new(1)),
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

async fn read_stderr_loop(stderr: impl tokio::io::AsyncRead + Unpin) {
    let mut lines = BufReader::new(stderr).lines();
    while matches!(lines.next_line().await, Ok(Some(_))) {}
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

    #[derive(Default)]
    pub struct FakeTransport {
        pub requests: StdMutex<Vec<(String, Value)>>,
        pub notifications: StdMutex<Vec<(String, Value)>>,
        pub responses: StdMutex<VecDeque<Result<Value>>>,
        pub inbound: StdMutex<VecDeque<CodexInboundEvent>>,
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

        async fn respond_result(&self, _id: i64, _result: Value) -> Result<()> {
            Ok(())
        }

        async fn respond_error(&self, _id: i64, _code: i64, _message: &str) -> Result<()> {
            Ok(())
        }

        async fn recv(&self) -> Option<CodexInboundEvent> {
            self.inbound.lock().expect("inbound").pop_front()
        }
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
}

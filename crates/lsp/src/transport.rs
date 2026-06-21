use crate::{LspError, Result};
use async_trait::async_trait;
use lsp_types as lsp;
use serde_json::{Value, json};
use std::{
    collections::{HashMap, VecDeque},
    io,
    path::Path,
    process::Stdio,
    sync::{
        Arc, Mutex,
        atomic::{AtomicI64, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWriteExt},
    process::Command,
    sync::{mpsc, oneshot},
    time,
};

pub const MAX_FRAME_BYTES: usize = 16 * 1024 * 1024;
const MAX_HEADER_BYTES: usize = 16 * 1024;
const MAX_PENDING_REQUESTS: usize = 256;
const OUTBOUND_QUEUE_SIZE: usize = 256;

#[derive(Debug, Clone, PartialEq)]
pub struct JsonRpcMessage {
    pub payload: Value,
}

#[async_trait]
pub trait LspTransport: Send + Sync {
    async fn request(&self, method: &str, params: Value, timeout: Duration) -> Result<Value>;
    async fn notify(&self, method: &str, params: Value) -> Result<()>;
}

#[derive(Debug, Clone)]
pub enum StdioTransportEvent {
    PublishDiagnostics {
        uri: String,
        diagnostics: Vec<lsp::Diagnostic>,
    },
    StderrLine(String),
    ServerExited,
}

pub type StdioTransportEventSink = Arc<dyn Fn(StdioTransportEvent) + Send + Sync>;

type PendingSender = oneshot::Sender<Result<Value>>;
type PendingRequests = Arc<tokio::sync::Mutex<HashMap<i64, PendingSender>>>;

#[derive(Clone)]
pub struct StdioLspTransport {
    outbound: mpsc::Sender<Vec<u8>>,
    pending: PendingRequests,
    next_id: Arc<AtomicI64>,
}

impl StdioLspTransport {
    pub async fn spawn(
        command: &str,
        args: &[String],
        cwd: &Path,
        env: &[(String, String)],
        event_sink: StdioTransportEventSink,
    ) -> Result<Self> {
        let mut command_builder = Command::new(command);
        command_builder
            .args(args)
            .current_dir(cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        for (key, value) in env {
            command_builder.env(key, value);
        }

        let mut child = command_builder.spawn()?;
        let mut stdin = child.stdin.take().ok_or_else(|| {
            LspError::InvalidFrame("language server stdin unavailable".to_string())
        })?;
        let stdout = child.stdout.take().ok_or_else(|| {
            LspError::InvalidFrame("language server stdout unavailable".to_string())
        })?;
        let stderr = child.stderr.take().ok_or_else(|| {
            LspError::InvalidFrame("language server stderr unavailable".to_string())
        })?;

        let (outbound, mut outbound_rx) = mpsc::channel::<Vec<u8>>(OUTBOUND_QUEUE_SIZE);
        let pending: PendingRequests = Arc::new(tokio::sync::Mutex::new(HashMap::new()));
        let read_pending = Arc::clone(&pending);
        let read_sink = Arc::clone(&event_sink);
        tokio::spawn(async move {
            read_stdout_loop(stdout, read_pending, read_sink).await;
        });

        tokio::spawn(async move {
            while let Some(frame) = outbound_rx.recv().await {
                if stdin.write_all(&frame).await.is_err() {
                    break;
                }
            }
        });

        let stderr_sink = Arc::clone(&event_sink);
        tokio::spawn(async move {
            read_stderr_loop(stderr, stderr_sink).await;
        });

        tokio::spawn(async move {
            let _ = child.wait().await;
            event_sink(StdioTransportEvent::ServerExited);
        });

        Ok(Self {
            outbound,
            pending,
            next_id: Arc::new(AtomicI64::new(1)),
        })
    }

    async fn send_frame(&self, payload: Value) -> Result<()> {
        let frame = encode_message(&payload)?;
        self.outbound
            .send(frame)
            .await
            .map_err(|_| LspError::OutboundQueueFull)
    }
}

#[async_trait]
impl LspTransport for StdioLspTransport {
    async fn request(&self, method: &str, params: Value, timeout: Duration) -> Result<Value> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        {
            let mut pending = self.pending.lock().await;
            if pending.len() >= MAX_PENDING_REQUESTS {
                return Err(LspError::PendingRequestsFull);
            }
            pending.insert(id, tx);
        }

        let payload = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });
        if let Err(error) = self.send_frame(payload).await {
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
                LspError::RequestTimeout {
                    method: method.to_string(),
                    timeout,
                }
            })?
            .map_err(|_| LspError::InvalidResponse(method.to_string()))?
    }

    async fn notify(&self, method: &str, params: Value) -> Result<()> {
        self.send_frame(json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
        }))
        .await
    }
}

pub fn encode_message(payload: &Value) -> Result<Vec<u8>> {
    let body = serde_json::to_vec(payload)?;
    if body.len() > MAX_FRAME_BYTES {
        return Err(LspError::InvalidFrame("frame exceeds limit".to_string()));
    }
    let mut frame = format!("Content-Length: {}\r\n\r\n", body.len()).into_bytes();
    frame.extend(body);
    Ok(frame)
}

pub fn decode_message(frame: &[u8]) -> Result<JsonRpcMessage> {
    let header_end = frame
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .ok_or_else(|| LspError::InvalidFrame("missing header terminator".to_string()))?;
    let header = std::str::from_utf8(&frame[..header_end])
        .map_err(|_| LspError::InvalidFrame("header is not utf-8".to_string()))?;
    let content_length = header
        .lines()
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.eq_ignore_ascii_case("content-length")
                .then(|| value.trim().parse::<usize>().ok())
                .flatten()
        })
        .ok_or_else(|| LspError::InvalidFrame("missing content length".to_string()))?;
    if content_length > MAX_FRAME_BYTES {
        return Err(LspError::InvalidFrame("frame exceeds limit".to_string()));
    }
    let body_start = header_end + 4;
    let body_end = body_start
        .checked_add(content_length)
        .ok_or_else(|| LspError::InvalidFrame("content length overflow".to_string()))?;
    if frame.len() < body_end {
        return Err(LspError::InvalidFrame("incomplete body".to_string()));
    }
    Ok(JsonRpcMessage {
        payload: serde_json::from_slice(&frame[body_start..body_end])?,
    })
}

pub async fn read_message<R: AsyncRead + Unpin>(reader: &mut R) -> Result<JsonRpcMessage> {
    let mut header = Vec::with_capacity(128);
    loop {
        let mut byte = [0_u8; 1];
        reader.read_exact(&mut byte).await.map_err(map_read_error)?;
        header.push(byte[0]);
        if header.ends_with(b"\r\n\r\n") {
            break;
        }
        if header.len() > MAX_HEADER_BYTES {
            return Err(LspError::InvalidFrame("header exceeds limit".to_string()));
        }
    }

    let header_text = std::str::from_utf8(&header)
        .map_err(|_| LspError::InvalidFrame("header is not utf-8".to_string()))?;
    let content_length = header_text
        .lines()
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.eq_ignore_ascii_case("content-length")
                .then(|| value.trim().parse::<usize>().ok())
                .flatten()
        })
        .ok_or_else(|| LspError::InvalidFrame("missing content length".to_string()))?;
    if content_length > MAX_FRAME_BYTES {
        return Err(LspError::InvalidFrame("frame exceeds limit".to_string()));
    }

    let mut body = vec![0_u8; content_length];
    reader.read_exact(&mut body).await.map_err(map_read_error)?;
    Ok(JsonRpcMessage {
        payload: serde_json::from_slice(&body)?,
    })
}

fn map_read_error(error: io::Error) -> LspError {
    if error.kind() == io::ErrorKind::UnexpectedEof {
        LspError::InvalidFrame("language server stream closed".to_string())
    } else {
        LspError::Io(error)
    }
}

async fn read_stdout_loop<R: AsyncRead + Unpin>(
    mut stdout: R,
    pending: PendingRequests,
    event_sink: StdioTransportEventSink,
) {
    while let Ok(message) = read_message(&mut stdout).await {
        handle_inbound_message(message.payload, &pending, &event_sink).await;
    }
}

async fn handle_inbound_message(
    payload: Value,
    pending: &PendingRequests,
    event_sink: &StdioTransportEventSink,
) {
    if let Some(id) = payload.get("id").and_then(Value::as_i64) {
        let response = if let Some(error) = payload.get("error") {
            Err(LspError::InvalidResponse(error.to_string()))
        } else {
            Ok(payload.get("result").cloned().unwrap_or(Value::Null))
        };
        if let Some(tx) = pending.lock().await.remove(&id) {
            let _ = tx.send(response);
        }
        return;
    }

    if payload.get("method").and_then(Value::as_str) == Some("textDocument/publishDiagnostics")
        && let Some(params) = payload.get("params")
        && let Ok(params) = serde_json::from_value::<lsp::PublishDiagnosticsParams>(params.clone())
    {
        event_sink(StdioTransportEvent::PublishDiagnostics {
            uri: params.uri.as_str().to_string(),
            diagnostics: params.diagnostics,
        });
    }
}

async fn read_stderr_loop<R: AsyncRead + Unpin>(
    mut stderr: R,
    event_sink: StdioTransportEventSink,
) {
    let mut buffer = Vec::with_capacity(256);
    let mut byte = [0_u8; 1];
    loop {
        match stderr.read(&mut byte).await {
            Ok(0) => {
                if !buffer.is_empty() {
                    emit_stderr_line(&mut buffer, &event_sink);
                }
                break;
            }
            Ok(_) if byte[0] == b'\n' => emit_stderr_line(&mut buffer, &event_sink),
            Ok(_) => {
                if buffer.len() < 4096 {
                    buffer.push(byte[0]);
                }
            }
            Err(_) => break,
        }
    }
}

fn emit_stderr_line(buffer: &mut Vec<u8>, event_sink: &StdioTransportEventSink) {
    let line = String::from_utf8_lossy(buffer)
        .trim_end_matches('\r')
        .to_string();
    buffer.clear();
    if !line.is_empty() {
        event_sink(StdioTransportEvent::StderrLine(line));
    }
}

#[derive(Debug, Default)]
pub struct FakeLspTransport {
    requests: Mutex<Vec<(String, Value)>>,
    notifications: Mutex<Vec<(String, Value)>>,
    responses: Mutex<VecDeque<Value>>,
}

impl FakeLspTransport {
    #[must_use]
    pub fn with_responses(responses: Vec<Value>) -> Self {
        Self {
            responses: Mutex::new(VecDeque::from(responses)),
            ..Self::default()
        }
    }

    #[must_use]
    pub fn requests(&self) -> Vec<(String, Value)> {
        self.requests.lock().expect("requests").clone()
    }

    #[must_use]
    pub fn notifications(&self) -> Vec<(String, Value)> {
        self.notifications.lock().expect("notifications").clone()
    }
}

#[async_trait]
impl LspTransport for FakeLspTransport {
    async fn request(&self, method: &str, params: Value, _timeout: Duration) -> Result<Value> {
        self.requests
            .lock()
            .expect("requests")
            .push((method.to_string(), params));
        self.responses
            .lock()
            .expect("responses")
            .pop_front()
            .ok_or_else(|| LspError::InvalidResponse(method.to_string()))
    }

    async fn notify(&self, method: &str, params: Value) -> Result<()> {
        self.notifications
            .lock()
            .expect("notifications")
            .push((method.to_string(), params));
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn frames_json_rpc_messages() {
        let payload = json!({"jsonrpc":"2.0","id":1,"method":"initialize"});
        let frame = encode_message(&payload).expect("encode");
        let decoded = decode_message(&frame).expect("decode");
        assert_eq!(decoded.payload, payload);
    }

    #[test]
    fn rejects_incomplete_frames() {
        let error = decode_message(b"Content-Length: 10\r\n\r\n{}").expect_err("invalid");
        assert!(matches!(error, LspError::InvalidFrame(_)));
    }

    #[tokio::test]
    async fn reads_streamed_frame() {
        let payload = json!({"jsonrpc":"2.0","id":1,"result":true});
        let frame = encode_message(&payload).expect("frame");
        let mut reader = std::io::Cursor::new(frame);
        let message = read_message(&mut reader).await.expect("message");
        assert_eq!(message.payload, payload);
    }

    #[tokio::test]
    async fn demuxes_responses_and_diagnostics() {
        let pending: PendingRequests = Arc::new(tokio::sync::Mutex::new(HashMap::new()));
        let (tx, rx) = oneshot::channel();
        pending.lock().await.insert(7, tx);
        let events = Arc::new(Mutex::new(Vec::new()));
        let sink_events = Arc::clone(&events);
        let sink: StdioTransportEventSink =
            Arc::new(move |event| sink_events.lock().expect("events").push(event));
        handle_inbound_message(
            json!({"jsonrpc":"2.0","id":7,"result":{"ok":true}}),
            &pending,
            &sink,
        )
        .await;
        assert_eq!(rx.await.expect("response").expect("ok"), json!({"ok":true}));

        handle_inbound_message(
            json!({
                "jsonrpc":"2.0",
                "method":"textDocument/publishDiagnostics",
                "params":{"uri":"file:///tmp/main.rs","diagnostics":[]}
            }),
            &pending,
            &sink,
        )
        .await;
        assert!(matches!(
            &events.lock().expect("events")[0],
            StdioTransportEvent::PublishDiagnostics { .. }
        ));
    }
}

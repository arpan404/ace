use crate::{LspError, Result};
use async_trait::async_trait;
use serde_json::Value;
use std::{collections::VecDeque, sync::Mutex, time::Duration};

pub const MAX_FRAME_BYTES: usize = 16 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq)]
pub struct JsonRpcMessage {
    pub payload: Value,
}

#[async_trait]
pub trait LspTransport: Send + Sync {
    async fn request(&self, method: &str, params: Value, timeout: Duration) -> Result<Value>;
    async fn notify(&self, method: &str, params: Value) -> Result<()>;
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
}

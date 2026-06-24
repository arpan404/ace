use ace_protocol::{
    PROTOCOL_VERSION,
    ws::{WsClientRequest, WsServerPayload, WsServerResponse},
};
use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;
use std::sync::Arc;
use tokio::runtime::Handle;
use tokio_tungstenite::{connect_async, tungstenite::Message};
use uuid::Uuid;

#[derive(Debug, Clone)]
pub struct DesktopBackend {
    inner: Arc<DesktopBackendInner>,
}

#[derive(Debug)]
struct DesktopBackendInner {
    runtime: Handle,
    ws_url: String,
}

#[derive(Debug, Clone)]
pub struct BackendError {
    pub code: String,
    pub message: String,
}

impl DesktopBackend {
    #[must_use]
    pub fn new(runtime: Handle, ws_url: String) -> Self {
        Self {
            inner: Arc::new(DesktopBackendInner { runtime, ws_url }),
        }
    }

    pub fn spawn<T>(
        &self,
        task: impl Future<Output = T> + Send + 'static,
    ) -> tokio::task::JoinHandle<T>
    where
        T: Send + 'static,
    {
        self.inner.runtime.spawn(task)
    }

    pub async fn rpc<P, T>(&self, method: &str, payload: P) -> Result<T, BackendError>
    where
        P: Serialize,
        T: DeserializeOwned,
    {
        let body = self
            .rpc_value(method, serde_json::to_value(payload)?)
            .await?;
        serde_json::from_value(body).map_err(BackendError::from)
    }

    pub async fn rpc_value(&self, method: &str, payload: Value) -> Result<Value, BackendError> {
        let (mut socket, _) = connect_async(&self.inner.ws_url).await.map_err(|error| {
            BackendError::transport("connect", format!("websocket connect failed: {error}"))
        })?;
        let request_id = Uuid::now_v7().to_string();
        let request = WsClientRequest {
            version: PROTOCOL_VERSION,
            request_id: request_id.clone(),
            method: method.to_owned(),
            payload,
        };
        let frame = serde_json::to_string(&request)?;
        socket
            .send(Message::Text(frame.into()))
            .await
            .map_err(|error| {
                BackendError::transport("send", format!("websocket send failed: {error}"))
            })?;

        while let Some(frame) = socket.next().await {
            let frame = frame.map_err(|error| {
                BackendError::transport("receive", format!("websocket receive failed: {error}"))
            })?;
            let Message::Text(text) = frame else {
                continue;
            };
            let response: WsServerResponse = serde_json::from_str(&text)?;
            if response.request_id != request_id {
                continue;
            }
            return match response.payload {
                WsServerPayload::Result { body } => Ok(body),
                WsServerPayload::Error { code, message } => Err(BackendError { code, message }),
                WsServerPayload::Event { .. } => continue,
            };
        }

        Err(BackendError::transport(
            "closed",
            "websocket closed before response".to_owned(),
        ))
    }
}

impl BackendError {
    fn transport(code: &str, message: String) -> Self {
        Self {
            code: code.to_owned(),
            message,
        }
    }

    #[must_use]
    pub fn display(&self) -> String {
        format!("{}: {}", self.code, self.message)
    }
}

impl From<serde_json::Error> for BackendError {
    fn from(error: serde_json::Error) -> Self {
        Self {
            code: "json".to_owned(),
            message: error.to_string(),
        }
    }
}

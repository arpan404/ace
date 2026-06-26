use ace_protocol::{
    PROTOCOL_VERSION,
    ws::{WsClientRequest, WsServerPayload, WsServerResponse},
};
use futures_util::{SinkExt, StreamExt};
use serde::{Serialize, de::DeserializeOwned};
use serde_json::Value;
use std::{
    collections::HashMap,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};
use thiserror::Error;
use tokio::{
    sync::{broadcast, mpsc, oneshot},
    time,
};
use tokio_tungstenite::{connect_async, tungstenite::Message};

const DEFAULT_QUEUE_CAPACITY: usize = 1024;
const DEFAULT_CALL_TIMEOUT: Duration = Duration::from_secs(30);

pub trait RpcMethod {
    type Request: Serialize;
    type Response: DeserializeOwned;

    const METHOD: &'static str;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RpcEndpoint {
    pub host: String,
    pub port: u16,
    pub path: String,
}

impl RpcEndpoint {
    #[must_use]
    pub fn localhost(port: u16) -> Self {
        Self {
            host: "127.0.0.1".to_string(),
            port,
            path: "/ws".to_string(),
        }
    }

    #[must_use]
    pub fn websocket_url(&self) -> String {
        format!("ws://{}:{}{}", self.host, self.port, self.path)
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct RpcEvent {
    pub topic: String,
    pub body: Value,
}

#[derive(Debug, Error)]
pub enum RpcError {
    #[error("failed to connect websocket: {0}")]
    Connect(#[from] tokio_tungstenite::tungstenite::Error),
    #[error("websocket client is closed")]
    Closed,
    #[error("websocket request queue is closed")]
    QueueClosed,
    #[error("websocket request timed out")]
    Timeout,
    #[error("websocket send failed: {0}")]
    Send(String),
    #[error("invalid websocket response: {0}")]
    InvalidResponse(#[from] serde_json::Error),
    #[error("backend returned {code}: {message}")]
    Backend { code: String, message: String },
}

type RawResponse = Result<WsServerPayload, RpcError>;

struct PendingCall {
    request: WsClientRequest,
    response: oneshot::Sender<RawResponse>,
}

#[derive(Clone)]
pub struct WsRpcClient {
    outbound: mpsc::Sender<PendingCall>,
    events: broadcast::Sender<RpcEvent>,
    next_request_id: Arc<AtomicU64>,
    call_timeout: Duration,
}

impl WsRpcClient {
    pub async fn connect(endpoint: RpcEndpoint) -> Result<Self, RpcError> {
        Self::connect_with_capacity(endpoint, DEFAULT_QUEUE_CAPACITY).await
    }

    pub async fn connect_with_capacity(
        endpoint: RpcEndpoint,
        queue_capacity: usize,
    ) -> Result<Self, RpcError> {
        let (stream, _) = connect_async(endpoint.websocket_url()).await?;
        let (mut writer, mut reader) = stream.split();
        let (outbound_tx, mut outbound_rx) = mpsc::channel::<PendingCall>(queue_capacity);
        let (events_tx, _) = broadcast::channel(queue_capacity);
        let task_events = events_tx.clone();

        tokio::spawn(async move {
            let mut pending = HashMap::<String, oneshot::Sender<RawResponse>>::new();

            loop {
                tokio::select! {
                    call = outbound_rx.recv() => {
                        let Some(call) = call else {
                            break;
                        };
                        let request_id = call.request.request_id.clone();
                        match serde_json::to_string(&call.request) {
                            Ok(raw) => {
                                pending.insert(request_id.clone(), call.response);
                                if let Err(error) = writer.send(Message::Text(raw.into())).await {
                                    if let Some(response) = pending.remove(&request_id) {
                                        let _ = response.send(Err(RpcError::Send(error.to_string())));
                                    }
                                    break;
                                }
                            }
                            Err(error) => {
                                let _ = call.response.send(Err(RpcError::InvalidResponse(error)));
                            }
                        }
                    }
                    message = reader.next() => {
                        let Some(message) = message else {
                            break;
                        };
                        match message {
                            Ok(Message::Text(text)) => {
                                match serde_json::from_str::<WsServerResponse>(text.as_ref()) {
                                    Ok(response) => handle_response(response, &mut pending, &task_events),
                                    Err(error) => tracing::warn!(%error, "invalid websocket response"),
                                }
                            }
                            Ok(Message::Close(_)) => break,
                            Ok(Message::Binary(_) | Message::Ping(_) | Message::Pong(_) | Message::Frame(_)) => {}
                            Err(error) => {
                                tracing::warn!(%error, "websocket receive failed");
                                break;
                            }
                        }
                    }
                }
            }

            for (_, response) in pending {
                let _ = response.send(Err(RpcError::Closed));
            }
        });

        Ok(Self {
            outbound: outbound_tx,
            events: events_tx,
            next_request_id: Arc::new(AtomicU64::new(1)),
            call_timeout: DEFAULT_CALL_TIMEOUT,
        })
    }

    #[must_use]
    pub fn subscribe_events(&self) -> broadcast::Receiver<RpcEvent> {
        self.events.subscribe()
    }

    pub async fn request<M: RpcMethod>(
        &self,
        payload: &M::Request,
    ) -> Result<M::Response, RpcError> {
        self.call(M::METHOD, payload).await
    }

    pub async fn call<T, O>(&self, method: impl Into<String>, payload: &T) -> Result<O, RpcError>
    where
        T: Serialize,
        O: DeserializeOwned,
    {
        let payload = serde_json::to_value(payload)?;
        let request = WsClientRequest {
            version: PROTOCOL_VERSION,
            request_id: self.next_id(),
            method: method.into(),
            payload,
        };
        let (response_tx, response_rx) = oneshot::channel();
        self.outbound
            .send(PendingCall {
                request,
                response: response_tx,
            })
            .await
            .map_err(|_| RpcError::QueueClosed)?;

        let payload = time::timeout(self.call_timeout, response_rx)
            .await
            .map_err(|_| RpcError::Timeout)?
            .map_err(|_| RpcError::Closed)??;
        match payload {
            WsServerPayload::Result { body } => Ok(serde_json::from_value(body)?),
            WsServerPayload::Error { code, message } => Err(RpcError::Backend { code, message }),
            WsServerPayload::Event { topic, body } => {
                let _ = self.events.send(RpcEvent { topic, body });
                Err(RpcError::Closed)
            }
        }
    }

    fn next_id(&self) -> String {
        self.next_request_id
            .fetch_add(1, Ordering::Relaxed)
            .to_string()
    }
}

fn handle_response(
    response: WsServerResponse,
    pending: &mut HashMap<String, oneshot::Sender<RawResponse>>,
    events: &broadcast::Sender<RpcEvent>,
) {
    match response.payload {
        WsServerPayload::Event { topic, body } => {
            let _ = events.send(RpcEvent { topic, body });
        }
        payload => {
            if let Some(sender) = pending.remove(&response.request_id) {
                let _ = sender.send(Ok(payload));
            } else {
                tracing::debug!(request_id = %response.request_id, "response for unknown websocket request");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ace_protocol::ws::WsServerResponse;
    use axum::{
        Router,
        extract::ws::{Message, WebSocket, WebSocketUpgrade},
        response::Response,
        routing::get,
    };
    use serde::{Deserialize, Serialize};
    use tokio::net::TcpListener;

    #[derive(Debug, Serialize)]
    struct EchoRequest {
        value: String,
    }

    #[derive(Debug, Deserialize, PartialEq, Eq)]
    struct EchoResponse {
        value: String,
    }

    #[tokio::test]
    async fn call_round_trips_typed_payloads() {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let port = listener.local_addr().expect("local addr").port();
        tokio::spawn(async move {
            axum::serve(listener, Router::new().route("/ws", get(ws_upgrade)))
                .await
                .expect("serve");
        });

        let client = WsRpcClient::connect(RpcEndpoint::localhost(port))
            .await
            .expect("connect");
        let response: EchoResponse = client
            .call(
                "test.echo",
                &EchoRequest {
                    value: "ok".to_string(),
                },
            )
            .await
            .expect("call");

        assert_eq!(
            response,
            EchoResponse {
                value: "ok".to_string()
            }
        );
    }

    async fn ws_upgrade(ws: WebSocketUpgrade) -> Response {
        ws.on_upgrade(handle_socket)
    }

    async fn handle_socket(mut socket: WebSocket) {
        while let Some(Ok(Message::Text(text))) = socket.recv().await {
            let request: WsClientRequest = serde_json::from_str(text.as_ref()).expect("request");
            let response = WsServerResponse {
                version: PROTOCOL_VERSION,
                request_id: request.request_id,
                payload: WsServerPayload::Result {
                    body: request.payload,
                },
            };
            socket
                .send(Message::Text(
                    serde_json::to_string(&response).expect("response").into(),
                ))
                .await
                .expect("send response");
        }
    }
}

mod github;

use crate::github::{GithubApiError, GithubService};
use ace_git::{GithubCliClient, ProcessRunner, TokioProcessRunner};
use ace_protocol::{
    PROTOCOL_VERSION,
    ws::{WsClientRequest, WsServerPayload, WsServerResponse},
};
use axum::{
    Router,
    extract::{
        State,
        ws::{Message, WebSocket, WebSocketUpgrade},
    },
    response::Response,
    routing::get,
};
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;
use std::{future::Future, sync::Arc};
use thiserror::Error;

pub struct WsApiState<R: ProcessRunner = TokioProcessRunner> {
    github: Arc<GithubService<R>>,
}

impl<R: ProcessRunner> Clone for WsApiState<R> {
    fn clone(&self) -> Self {
        Self {
            github: Arc::clone(&self.github),
        }
    }
}

impl WsApiState<TokioProcessRunner> {
    #[must_use]
    pub fn production() -> Self {
        Self {
            github: Arc::new(GithubService::new(GithubCliClient::new())),
        }
    }
}

impl<R: ProcessRunner> WsApiState<R> {
    #[must_use]
    pub fn new(github: GithubService<R>) -> Self {
        Self {
            github: Arc::new(github),
        }
    }
}

pub fn router() -> Router {
    router_with_state(WsApiState::<TokioProcessRunner>::production())
}

pub fn router_with_state<R>(state: WsApiState<R>) -> Router
where
    R: ProcessRunner + 'static,
{
    Router::new()
        .route("/ws", get(ws_upgrade::<R>))
        .route("/api/ws", get(ws_upgrade::<R>))
        .with_state(state)
}

async fn ws_upgrade<R>(ws: WebSocketUpgrade, State(state): State<WsApiState<R>>) -> Response
where
    R: ProcessRunner + 'static,
{
    ws.on_upgrade(move |socket| handle_socket(socket, state))
}

async fn handle_socket<R>(mut socket: WebSocket, state: WsApiState<R>)
where
    R: ProcessRunner,
{
    while let Some(message) = socket.recv().await {
        let Ok(message) = message else {
            break;
        };
        match message {
            Message::Text(text) => {
                let response = state.dispatch_text(text.as_str()).await;
                if socket.send(Message::Text(response.into())).await.is_err() {
                    break;
                }
            }
            Message::Binary(_) => {
                let response = error_response(
                    "",
                    "unsupported_message",
                    "binary messages are not supported",
                );
                if socket.send(Message::Text(response.into())).await.is_err() {
                    break;
                }
            }
            Message::Close(_) => break,
            Message::Ping(_) | Message::Pong(_) => {}
        }
    }
}

impl<R: ProcessRunner> WsApiState<R> {
    async fn dispatch_text(&self, raw: &str) -> String {
        let response = match serde_json::from_str::<WsClientRequest>(raw) {
            Ok(request) => self.dispatch_request(request).await,
            Err(error) => WsServerResponse {
                version: PROTOCOL_VERSION,
                request_id: String::new(),
                payload: WsServerPayload::Error {
                    code: "invalid_json".to_string(),
                    message: error.to_string(),
                },
            },
        };
        serde_json::to_string(&response).expect("serialize websocket response")
    }

    async fn dispatch_request(&self, request: WsClientRequest) -> WsServerResponse {
        let request_id = request.request_id;
        let result = self
            .dispatch_github_method(&request.method, request.payload)
            .await;
        match result {
            Ok(body) => WsServerResponse {
                version: PROTOCOL_VERSION,
                request_id,
                payload: WsServerPayload::Result { body },
            },
            Err(error) => WsServerResponse {
                version: PROTOCOL_VERSION,
                request_id,
                payload: WsServerPayload::Error {
                    code: error.code().to_string(),
                    message: error.to_string(),
                },
            },
        }
    }

    async fn github_json<T, O, Fut, F>(
        &self,
        payload: Value,
        call: F,
    ) -> Result<Value, WsDispatchError>
    where
        T: DeserializeOwned,
        O: Serialize,
        Fut: Future<Output = Result<O, GithubApiError>>,
        F: FnOnce(Arc<GithubService<R>>, T) -> Fut,
    {
        let request = serde_json::from_value(payload)?;
        let response = call(Arc::clone(&self.github), request).await?;
        Ok(serde_json::to_value(response)?)
    }
}

fn error_response(request_id: &str, code: &str, message: &str) -> String {
    serde_json::to_string(&WsServerResponse {
        version: PROTOCOL_VERSION,
        request_id: request_id.to_string(),
        payload: WsServerPayload::Error {
            code: code.to_string(),
            message: message.to_string(),
        },
    })
    .expect("serialize websocket error response")
}

#[derive(Debug, Error)]
enum WsDispatchError {
    #[error("unknown websocket method: {0}")]
    UnknownMethod(String),
    #[error("invalid websocket payload: {0}")]
    InvalidPayload(#[from] serde_json::Error),
    #[error("{0}")]
    Github(#[from] GithubApiError),
}

impl WsDispatchError {
    fn code(&self) -> &'static str {
        match self {
            Self::UnknownMethod(_) => "unknown_method",
            Self::InvalidPayload(_) => "invalid_payload",
            Self::Github(_) => "github_error",
        }
    }
}

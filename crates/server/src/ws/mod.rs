mod checkpoint;
mod codex;
mod editor;
mod git;
mod github;
mod lsp_tools;
mod project;
mod repository_activity;
mod terminal;
mod workspace;

use crate::checkpoint::{CheckpointApiError, CheckpointService};
use crate::codex::{CodexApiError, CodexService};
use crate::editor::{EditorApiError, EditorService};
use crate::git::{GitApiError, GitService};
use crate::github::{GithubApiError, GithubService};
use crate::project::{ProjectApiError, ProjectService};
use ace_core::ProviderKind;
use ace_fs::AppDirs;
use ace_git::{GitClient, GithubCliClient, ProcessRunner, TokioProcessRunner};
use ace_persistence::{PersistenceError, ProviderEventLogRepository};
use ace_protocol::{
    PROTOCOL_VERSION,
    ws::{WsClientRequest, WsServerPayload, WsServerResponse},
};
use ace_runtime::{
    host_tools::HostToolRegistry,
    native_provider::AceNativeProvider,
    provider::{DynProviderDriver, ProviderEvent, ProviderRegistry, ProviderRuntimeError},
};
use ace_terminal::{PortablePtyAdapter, PtyAdapter, TerminalError, TerminalManager};
use axum::{
    Router,
    extract::{
        State,
        ws::{Message, WebSocket, WebSocketUpgrade},
    },
    response::Response,
    routing::get,
};
use rusqlite::Connection;
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;
use std::{
    collections::HashMap,
    future::Future,
    sync::{Arc, Mutex},
};
use thiserror::Error;
use tokio::sync::{broadcast, mpsc};

pub struct WsApiState<R: ProcessRunner = TokioProcessRunner, A: PtyAdapter = PortablePtyAdapter> {
    checkpoint: Arc<CheckpointService<TokioProcessRunner>>,
    codex: Arc<CodexService>,
    providers: ProviderRegistry,
    host_tools: Arc<HostToolRegistry>,
    provider_events: Arc<Mutex<ProviderEventLogRepository>>,
    provider_event_streams:
        Arc<Mutex<HashMap<ProviderKind, broadcast::Sender<ProviderEventStreamMessage>>>>,
    git: Arc<GitService<R>>,
    github: Arc<GithubService<R>>,
    project: Arc<ProjectService>,
    terminal: Arc<TerminalManager<A>>,
    editor: Arc<EditorService<TokioProcessRunner>>,
}

impl<R: ProcessRunner, A: PtyAdapter> Clone for WsApiState<R, A> {
    fn clone(&self) -> Self {
        Self {
            checkpoint: Arc::clone(&self.checkpoint),
            codex: Arc::clone(&self.codex),
            providers: self.providers.clone(),
            host_tools: Arc::clone(&self.host_tools),
            provider_events: Arc::clone(&self.provider_events),
            provider_event_streams: Arc::clone(&self.provider_event_streams),
            git: Arc::clone(&self.git),
            github: Arc::clone(&self.github),
            project: Arc::clone(&self.project),
            terminal: Arc::clone(&self.terminal),
            editor: Arc::clone(&self.editor),
        }
    }
}

impl WsApiState<TokioProcessRunner, PortablePtyAdapter> {
    #[must_use]
    pub fn production() -> Self {
        let codex = Arc::new(CodexService::production());
        let ace = Arc::new(AceNativeProvider::new());
        let providers = ProviderRegistry::new()
            .with_driver(ace.clone())
            .with_driver(codex.clone())
            .with_event_source(ace_core::ProviderKind::Ace, ace.clone())
            .with_event_source(ace_core::ProviderKind::Codex, codex.clone())
            .with_server_request_responder(ace_core::ProviderKind::Ace, ace.clone())
            .with_server_request_responder(ace_core::ProviderKind::Codex, codex.clone())
            .with_state_source(ace_core::ProviderKind::Ace, ace.clone())
            .with_state_source(ace_core::ProviderKind::Codex, codex.clone())
            .with_host_tool_registry(ace_core::ProviderKind::Ace)
            .with_host_tool_registry(ace_core::ProviderKind::Codex);
        let paths = AppDirs::resolve().expect("resolve app paths");
        Self {
            checkpoint: Arc::new(CheckpointService::production()),
            codex,
            providers,
            host_tools: Arc::new(HostToolRegistry::with_default_bridge_contracts()),
            provider_events: Arc::new(Mutex::new(
                ProviderEventLogRepository::open(paths.state_dir.join("provider-events.sqlite3"))
                    .expect("initialize provider event log"),
            )),
            provider_event_streams: Arc::new(Mutex::new(HashMap::new())),
            git: Arc::new(GitService::new_with_github(
                GitClient::new(),
                GithubCliClient::new(),
            )),
            github: Arc::new(GithubService::new(GithubCliClient::new())),
            project: Arc::new(ProjectService::production().expect("initialize project service")),
            terminal: Arc::new(TerminalManager::production()),
            editor: Arc::new(EditorService::production().expect("initialize editor service")),
        }
    }
}

impl<R: ProcessRunner> WsApiState<R, PortablePtyAdapter> {
    #[must_use]
    pub fn new_services(git: GitService<R>, github: GithubService<R>) -> Self {
        let codex = Arc::new(CodexService::production());
        let ace = Arc::new(AceNativeProvider::new());
        let providers = ProviderRegistry::new()
            .with_driver(ace.clone())
            .with_driver(codex.clone())
            .with_event_source(ace_core::ProviderKind::Ace, ace.clone())
            .with_event_source(ace_core::ProviderKind::Codex, codex.clone())
            .with_server_request_responder(ace_core::ProviderKind::Ace, ace.clone())
            .with_server_request_responder(ace_core::ProviderKind::Codex, codex.clone())
            .with_state_source(ace_core::ProviderKind::Ace, ace.clone())
            .with_state_source(ace_core::ProviderKind::Codex, codex.clone())
            .with_host_tool_registry(ace_core::ProviderKind::Ace)
            .with_host_tool_registry(ace_core::ProviderKind::Codex);
        Self {
            checkpoint: Arc::new(CheckpointService::production()),
            codex,
            providers,
            host_tools: Arc::new(HostToolRegistry::with_default_bridge_contracts()),
            provider_events: Arc::new(Mutex::new(
                ProviderEventLogRepository::from_connection(
                    Connection::open_in_memory().expect("provider event log db"),
                )
                .expect("initialize provider event log"),
            )),
            provider_event_streams: Arc::new(Mutex::new(HashMap::new())),
            git: Arc::new(git),
            github: Arc::new(github),
            project: Arc::new(
                ProjectService::memory().expect("initialize in-memory project service"),
            ),
            terminal: Arc::new(TerminalManager::production()),
            editor: Arc::new(EditorService::production().expect("initialize editor service")),
        }
    }

    #[must_use]
    pub fn with_terminal_manager<A: PtyAdapter>(
        self,
        terminal: TerminalManager<A>,
    ) -> WsApiState<R, A> {
        WsApiState {
            checkpoint: self.checkpoint,
            codex: self.codex,
            providers: self.providers,
            host_tools: self.host_tools,
            provider_events: self.provider_events,
            provider_event_streams: self.provider_event_streams,
            git: self.git,
            github: self.github,
            project: self.project,
            terminal: Arc::new(terminal),
            editor: self.editor,
        }
    }
}

impl<R: ProcessRunner, A: PtyAdapter> WsApiState<R, A> {
    #[must_use]
    pub fn with_project_service(mut self, project: ProjectService) -> Self {
        self.project = Arc::new(project);
        self
    }

    #[must_use]
    pub fn with_codex_service(mut self, codex: CodexService) -> Self {
        let codex = Arc::new(codex);
        self.providers.register(codex.clone());
        self.providers
            .register_event_source(ace_core::ProviderKind::Codex, codex.clone());
        self.providers
            .register_server_request_responder(ace_core::ProviderKind::Codex, codex.clone());
        self.providers
            .register_state_source(ace_core::ProviderKind::Codex, codex.clone());
        self.codex = codex;
        self
    }

    #[must_use]
    pub fn with_provider_driver(mut self, driver: DynProviderDriver) -> Self {
        self.providers.register(driver);
        self
    }

    #[must_use]
    pub fn with_provider_event_log(mut self, event_log: ProviderEventLogRepository) -> Self {
        self.provider_events = Arc::new(Mutex::new(event_log));
        self.provider_event_streams = Arc::new(Mutex::new(HashMap::new()));
        self
    }

    #[must_use]
    pub fn with_host_tools(mut self, host_tools: HostToolRegistry) -> Self {
        self.host_tools = Arc::new(host_tools);
        self
    }

    #[must_use]
    pub fn replace_terminal_manager(mut self, terminal: TerminalManager<A>) -> Self {
        self.terminal = Arc::new(terminal);
        self
    }

    #[must_use]
    pub fn with_editor_service(mut self, editor: EditorService<TokioProcessRunner>) -> Self {
        self.editor = Arc::new(editor);
        self
    }
}

#[derive(Debug, Clone)]
pub(super) enum ProviderEventStreamMessage {
    Events {
        events: Vec<ProviderEvent>,
        last_persisted_sequence: Option<i64>,
    },
    Error {
        code: String,
        message: String,
    },
}

pub fn router() -> Router {
    router_with_state(WsApiState::<TokioProcessRunner>::production())
}

pub fn router_with_state<R, A>(state: WsApiState<R, A>) -> Router
where
    R: ProcessRunner + 'static,
    A: PtyAdapter + 'static,
{
    Router::new()
        .route("/ws", get(ws_upgrade::<R, A>))
        .route("/api/ws", get(ws_upgrade::<R, A>))
        .with_state(state)
}

async fn ws_upgrade<R, A>(ws: WebSocketUpgrade, State(state): State<WsApiState<R, A>>) -> Response
where
    R: ProcessRunner + 'static,
    A: PtyAdapter + 'static,
{
    ws.on_upgrade(move |socket| handle_socket::<R, A>(socket, state))
}

async fn handle_socket<R, A>(mut socket: WebSocket, state: WsApiState<R, A>)
where
    R: ProcessRunner,
    A: PtyAdapter,
{
    let (outbound_tx, mut outbound_rx) = mpsc::channel::<String>(1024);
    loop {
        tokio::select! {
            message = socket.recv() => {
                let Some(message) = message else {
                    break;
                };
                let Ok(message) = message else {
                    break;
                };
                match message {
                    Message::Text(text) => {
                        let response = state
                            .dispatch_text_with_events(text.as_str(), Some(outbound_tx.clone()))
                            .await;
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
            outbound = outbound_rx.recv() => {
                let Some(response) = outbound else {
                    break;
                };
                if socket.send(Message::Text(response.into())).await.is_err() {
                    break;
                }
            }
        }
    }
}

impl<R: ProcessRunner, A: PtyAdapter> WsApiState<R, A> {
    #[cfg(test)]
    async fn dispatch_text(&self, raw: &str) -> String {
        self.dispatch_text_with_events(raw, None).await
    }

    async fn dispatch_text_with_events(
        &self,
        raw: &str,
        outbound: Option<mpsc::Sender<String>>,
    ) -> String {
        let response = match serde_json::from_str::<WsClientRequest>(raw) {
            Ok(request) => self.dispatch_request_with_events(request, outbound).await,
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

    async fn dispatch_request_with_events(
        &self,
        request: WsClientRequest,
        outbound: Option<mpsc::Sender<String>>,
    ) -> WsServerResponse {
        let request_id = request.request_id;
        let result = if request.method == ace_protocol::ws::methods::TERMINAL_EVENTS_SUBSCRIBE {
            self.subscribe_terminal_events(request.payload, outbound)
                .await
        } else if request.method == ace_protocol::ws::methods::EDITOR_DIAGNOSTICS_SUBSCRIBE {
            self.subscribe_editor_diagnostics(request.payload, outbound)
                .await
        } else if request.method == ace_protocol::ws::methods::WORKSPACE_FILE_EVENTS_SUBSCRIBE {
            self.subscribe_workspace_file_events(request.payload, outbound)
                .await
        } else if request.method == ace_protocol::ws::methods::PROVIDER_RUNTIME_EVENTS_SUBSCRIBE {
            self.subscribe_provider_runtime_events(request.payload, outbound)
                .await
        } else {
            self.dispatch_method(&request.method, request.payload).await
        };
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

    async fn dispatch_method(
        &self,
        method: &str,
        payload: Value,
    ) -> Result<Value, WsDispatchError> {
        if method.starts_with("codex.") {
            self.dispatch_codex_method(method, payload).await
        } else if method.starts_with("provider_runtime.") {
            self.dispatch_provider_runtime_method(method, payload).await
        } else if method.starts_with("git.") {
            self.dispatch_git_method(method, payload).await
        } else if method.starts_with("github.") {
            self.dispatch_github_method(method, payload).await
        } else if method.starts_with("projects.") {
            self.dispatch_project_method(method, payload).await
        } else if method.starts_with("checkpoints.") {
            self.dispatch_checkpoint_method(method, payload).await
        } else if method.starts_with("terminal.") {
            self.dispatch_terminal_method(method, payload).await
        } else if method.starts_with("editor.") {
            self.dispatch_editor_method(method, payload).await
        } else if method.starts_with("workspace.") {
            self.dispatch_workspace_method(method, payload).await
        } else if method.starts_with("lsp_tools.") {
            self.dispatch_lsp_tools_method(method, payload).await
        } else {
            Err(WsDispatchError::UnknownMethod(method.to_string()))
        }
    }

    async fn git_json<T, O, Fut, F>(
        &self,
        payload: Value,
        call: F,
    ) -> Result<Value, WsDispatchError>
    where
        T: DeserializeOwned,
        O: Serialize,
        Fut: Future<Output = Result<O, GitApiError>>,
        F: FnOnce(Arc<GitService<R>>, T) -> Fut,
    {
        let request = serde_json::from_value(payload)?;
        let response = call(Arc::clone(&self.git), request).await?;
        Ok(serde_json::to_value(response)?)
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

    async fn project_json<T, O, Fut, F>(
        &self,
        payload: Value,
        call: F,
    ) -> Result<Value, WsDispatchError>
    where
        T: DeserializeOwned,
        O: Serialize,
        Fut: Future<Output = Result<O, ProjectApiError>>,
        F: FnOnce(Arc<ProjectService>, T) -> Fut,
    {
        let request = serde_json::from_value(payload)?;
        let response = call(Arc::clone(&self.project), request).await?;
        Ok(serde_json::to_value(response)?)
    }

    async fn checkpoint_json<T, O, Fut, F>(
        &self,
        payload: Value,
        call: F,
    ) -> Result<Value, WsDispatchError>
    where
        T: DeserializeOwned,
        O: Serialize,
        Fut: Future<Output = Result<O, CheckpointApiError>>,
        F: FnOnce(Arc<CheckpointService<TokioProcessRunner>>, T) -> Fut,
    {
        let request = serde_json::from_value(payload)?;
        let response = call(Arc::clone(&self.checkpoint), request).await?;
        Ok(serde_json::to_value(response)?)
    }

    async fn codex_json<T, O, Fut, F>(
        &self,
        payload: Value,
        call: F,
    ) -> Result<Value, WsDispatchError>
    where
        T: DeserializeOwned,
        O: Serialize,
        Fut: Future<Output = Result<O, CodexApiError>>,
        F: FnOnce(Arc<CodexService>, T) -> Fut,
    {
        let request = serde_json::from_value(payload)?;
        let response = call(Arc::clone(&self.codex), request).await?;
        Ok(serde_json::to_value(response)?)
    }

    async fn terminal_json<T, O, Fut, F>(
        &self,
        payload: Value,
        call: F,
    ) -> Result<Value, WsDispatchError>
    where
        T: DeserializeOwned,
        O: Serialize,
        Fut: Future<Output = Result<O, TerminalError>>,
        F: FnOnce(Arc<TerminalManager<A>>, T) -> Fut,
    {
        let request = serde_json::from_value(payload)?;
        let response = call(Arc::clone(&self.terminal), request).await?;
        Ok(serde_json::to_value(response)?)
    }

    async fn editor_json<T, O, Fut, F>(
        &self,
        payload: Value,
        call: F,
    ) -> Result<Value, WsDispatchError>
    where
        T: DeserializeOwned,
        O: Serialize,
        Fut: Future<Output = Result<O, EditorApiError>>,
        F: FnOnce(Arc<EditorService<TokioProcessRunner>>, T) -> Fut,
    {
        let request = serde_json::from_value(payload)?;
        let response = call(Arc::clone(&self.editor), request).await?;
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
    #[error("bad websocket request: {0}")]
    BadRequest(String),
    #[error("invalid websocket payload: {0}")]
    InvalidPayload(#[from] serde_json::Error),
    #[error("{0}")]
    Github(#[from] GithubApiError),
    #[error("{0}")]
    Git(#[from] GitApiError),
    #[error("{0}")]
    Project(#[from] ProjectApiError),
    #[error("{0}")]
    Checkpoint(#[from] CheckpointApiError),
    #[error("{0}")]
    Codex(#[from] CodexApiError),
    #[error("{0}")]
    ProviderRuntime(#[from] ProviderRuntimeError),
    #[error("{0}")]
    Persistence(#[from] PersistenceError),
    #[error("{0}")]
    Terminal(#[from] TerminalError),
    #[error("{0}")]
    Editor(#[from] EditorApiError),
}

impl WsDispatchError {
    fn code(&self) -> &'static str {
        match self {
            Self::UnknownMethod(_) => "unknown_method",
            Self::BadRequest(_) => "bad_request",
            Self::InvalidPayload(_) => "invalid_payload",
            Self::Github(_) => "github_error",
            Self::Git(_) => "git_error",
            Self::Project(_) => "project_error",
            Self::Checkpoint(_) => "checkpoint_error",
            Self::Codex(error) => error.code(),
            Self::ProviderRuntime(error) => match error {
                ProviderRuntimeError::ProviderUnavailable { .. } => "provider_unavailable",
                ProviderRuntimeError::Driver(_) => "provider_request_failed",
            },
            Self::Persistence(_) => "persistence_error",
            Self::Terminal(_) => "terminal_error",
            Self::Editor(_) => "editor_error",
        }
    }
}

use crate::github::{GithubApiError, GithubService};
use ace_git::{GithubCliClient, ProcessRunner, TokioProcessRunner};
use ace_protocol::{
    PROTOCOL_VERSION,
    github::{
        PullRequestActivityRequest, PullRequestChecksRequest, PullRequestDashboardRequest,
        WorkflowRunArtifactsRequest, WorkflowRunListRequest, WorkflowRunLogRequest,
        WorkflowRunRequest,
    },
    ws::{WsClientRequest, WsServerPayload, WsServerResponse, methods},
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
        let result = self.dispatch_method(&request.method, request.payload).await;
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
        match method {
            methods::GITHUB_PULL_REQUEST_CHECKS => {
                self.github_json::<PullRequestChecksRequest, _, _, _>(
                    payload,
                    |service, request| async move { service.pull_request_checks(request).await },
                )
                .await
            }
            methods::GITHUB_PULL_REQUEST_ACTIVITY => {
                self.github_json::<PullRequestActivityRequest, _, _, _>(
                    payload,
                    |service, request| async move { service.pull_request_activity(request).await },
                )
                .await
            }
            methods::GITHUB_PULL_REQUEST_DASHBOARD => {
                self.github_json::<PullRequestDashboardRequest, _, _, _>(
                    payload,
                    |service, request| async move { service.pull_request_dashboard(request).await },
                )
                .await
            }
            methods::GITHUB_WORKFLOW_RUNS_LIST => {
                self.github_json::<WorkflowRunListRequest, _, _, _>(
                    payload,
                    |service, request| async move { service.list_workflow_runs(request).await },
                )
                .await
            }
            methods::GITHUB_WORKFLOW_RUN_VIEW => {
                self.github_json::<WorkflowRunRequest, _, _, _>(
                    payload,
                    |service, request| async move { service.workflow_run(request).await },
                )
                .await
            }
            methods::GITHUB_WORKFLOW_RUN_LOG => {
                self.github_json::<WorkflowRunLogRequest, _, _, _>(
                    payload,
                    |service, request| async move { service.workflow_run_log(request).await },
                )
                .await
            }
            methods::GITHUB_WORKFLOW_RUN_ARTIFACTS => {
                self.github_json::<WorkflowRunArtifactsRequest, _, _, _>(
                    payload,
                    |service, request| async move { service.workflow_run_artifacts(request).await },
                )
                .await
            }
            _ => Err(WsDispatchError::UnknownMethod(method.to_string())),
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

#[cfg(test)]
mod tests {
    use super::*;
    use ace_git::{CommandOutput, CommandRequest, GitToolError};
    use async_trait::async_trait;
    use std::{
        collections::VecDeque,
        sync::{Arc, Mutex},
    };

    #[derive(Debug)]
    struct FakeRunner {
        outputs: Mutex<VecDeque<CommandOutput>>,
        requests: Mutex<Vec<CommandRequest>>,
    }

    impl FakeRunner {
        fn new(outputs: Vec<CommandOutput>) -> Self {
            Self {
                outputs: Mutex::new(VecDeque::from(outputs)),
                requests: Mutex::new(Vec::new()),
            }
        }

        fn requests(&self) -> Vec<CommandRequest> {
            self.requests.lock().expect("lock requests").clone()
        }
    }

    #[async_trait]
    impl ProcessRunner for FakeRunner {
        async fn run(&self, request: CommandRequest) -> ace_git::Result<CommandOutput> {
            self.requests.lock().expect("lock requests").push(request);
            self.outputs
                .lock()
                .expect("lock outputs")
                .pop_front()
                .ok_or_else(|| GitToolError::Parse {
                    context: "fake runner",
                    message: "no fake output queued".to_string(),
                })
        }
    }

    fn ok(stdout: impl AsRef<[u8]>) -> CommandOutput {
        CommandOutput {
            status: 0,
            stdout: stdout.as_ref().to_vec(),
            stderr: Vec::new(),
        }
    }

    fn test_state(runner: Arc<FakeRunner>) -> WsApiState<FakeRunner> {
        WsApiState::new(GithubService::new(GithubCliClient::with_runner(runner)))
    }

    #[tokio::test]
    async fn dispatches_pull_request_checks_over_ws_rpc() {
        let runner = Arc::new(FakeRunner::new(vec![ok(
            br#"[{"bucket":"pass","completedAt":"2026-06-21T00:00:00Z","description":null,"event":"push","link":"https://example.test/check","name":"CI","startedAt":"2026-06-21T00:00:00Z","state":"SUCCESS","workflow":"CI"}]"#,
        )]));
        let state = test_state(runner.clone());

        let response = state
            .dispatch_text(
                &serde_json::json!({
                    "version": PROTOCOL_VERSION,
                    "request_id": "req-1",
                    "method": methods::GITHUB_PULL_REQUEST_CHECKS,
                    "payload": {
                        "repo_path": "/repo",
                        "selector": "42",
                        "required_only": true
                    }
                })
                .to_string(),
            )
            .await;
        let response: WsServerResponse = serde_json::from_str(&response).expect("response");

        assert_eq!(response.request_id, "req-1");
        let WsServerPayload::Result { body } = response.payload else {
            panic!("expected result");
        };
        assert_eq!(body["summary"]["passed"], 1);
        assert_eq!(
            runner.requests()[0].args,
            vec![
                "pr",
                "checks",
                "42",
                "--required",
                "--json",
                "bucket,completedAt,description,event,link,name,startedAt,state,workflow"
            ]
        );
    }

    #[tokio::test]
    async fn dispatches_workflow_runs_over_ws_rpc() {
        let runner = Arc::new(FakeRunner::new(vec![ok(
            br#"[{"attempt":1,"conclusion":null,"createdAt":"2026-06-21T00:00:00Z","databaseId":7,"displayTitle":"Run","event":"pull_request","headBranch":"feature/x","headSha":"abc","name":"CI","number":3,"startedAt":"2026-06-21T00:00:00Z","status":"in_progress","updatedAt":"2026-06-21T00:01:00Z","url":"https://example.test/run/7","workflowDatabaseId":2,"workflowName":"CI"}]"#,
        )]));
        let state = test_state(runner.clone());

        let response = state
            .dispatch_text(
                &serde_json::json!({
                    "version": PROTOCOL_VERSION,
                    "request_id": "req-2",
                    "method": methods::GITHUB_WORKFLOW_RUNS_LIST,
                    "payload": {
                        "repo_path": "/repo",
                        "filter": {
                            "limit": 10,
                            "branch": "feature/x",
                            "commit": null,
                            "status": "in_progress",
                            "workflow": "CI",
                            "event": null,
                            "user": null,
                            "include_disabled": false
                        }
                    }
                })
                .to_string(),
            )
            .await;
        let response: WsServerResponse = serde_json::from_str(&response).expect("response");

        let WsServerPayload::Result { body } = response.payload else {
            panic!("expected result");
        };
        assert_eq!(body[0]["databaseId"], 7);
        let args = &runner.requests()[0].args;
        assert!(
            args.windows(2)
                .any(|pair| pair == ["--branch", "feature/x"])
        );
        assert!(
            args.windows(2)
                .any(|pair| pair == ["--status", "in_progress"])
        );
        assert!(args.windows(2).any(|pair| pair == ["--workflow", "CI"]));
    }

    #[tokio::test]
    async fn returns_ws_error_for_unknown_method() {
        let state = test_state(Arc::new(FakeRunner::new(Vec::new())));

        let response = state
            .dispatch_text(
                &serde_json::json!({
                    "version": PROTOCOL_VERSION,
                    "request_id": "req-3",
                    "method": "github.unknown",
                    "payload": {}
                })
                .to_string(),
            )
            .await;
        let response: WsServerResponse = serde_json::from_str(&response).expect("response");

        assert_eq!(response.request_id, "req-3");
        assert_eq!(
            response.payload,
            WsServerPayload::Error {
                code: "unknown_method".to_string(),
                message: "unknown websocket method: github.unknown".to_string()
            }
        );
    }

    #[tokio::test]
    async fn returns_ws_error_for_invalid_payload() {
        let state = test_state(Arc::new(FakeRunner::new(Vec::new())));

        let response = state
            .dispatch_text(
                &serde_json::json!({
                    "version": PROTOCOL_VERSION,
                    "request_id": "req-4",
                    "method": methods::GITHUB_WORKFLOW_RUNS_LIST,
                    "payload": {
                        "repo_path": "/repo"
                    }
                })
                .to_string(),
            )
            .await;
        let response: WsServerResponse = serde_json::from_str(&response).expect("response");

        let WsServerPayload::Error { code, .. } = response.payload else {
            panic!("expected error");
        };
        assert_eq!(code, "invalid_payload");
    }
}

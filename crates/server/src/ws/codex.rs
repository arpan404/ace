use crate::ws::{WsApiState, WsDispatchError};
use ace_git::ProcessRunner;
use ace_protocol::{
    codex::{
        CodexPlanTurnStartRequest, CodexRawRequest, CodexThreadForkRequest, CodexThreadIdRequest,
        CodexThreadStartRequest, CodexTurnStartRequest,
    },
    ws::methods,
};
use ace_terminal::PtyAdapter;
use serde_json::Value;

impl<R: ProcessRunner, A: PtyAdapter> WsApiState<R, A> {
    pub(super) async fn dispatch_codex_method(
        &self,
        method: &str,
        payload: Value,
    ) -> Result<Value, WsDispatchError> {
        match method {
            methods::CODEX_RAW_REQUEST => {
                self.codex_json::<CodexRawRequest, _, _, _>(payload, |service, request| async move {
                    service.raw_request(request.method, request.params).await
                })
                .await
            }
            methods::CODEX_THREAD_START => {
                self.codex_json::<CodexThreadStartRequest, _, _, _>(
                    payload,
                    |service, request| async move { service.start_thread(request.params).await },
                )
                .await
            }
            methods::CODEX_THREAD_RESUME => {
                self.codex_json::<CodexThreadIdRequest, _, _, _>(
                    payload,
                    |service, request| async move { service.resume_thread(request.thread_id).await },
                )
                .await
            }
            methods::CODEX_THREAD_FORK => {
                self.codex_json::<CodexThreadForkRequest, _, _, _>(
                    payload,
                    |service, request| async move {
                        service
                            .fork_thread(request.thread_id, request.ephemeral)
                            .await
                    },
                )
                .await
            }
            methods::CODEX_TURN_START => {
                self.codex_json::<CodexTurnStartRequest, _, _, _>(
                    payload,
                    |service, request| async move { service.start_turn(request.params).await },
                )
                .await
            }
            methods::CODEX_TURN_PLAN_START => {
                self.codex_json::<CodexPlanTurnStartRequest, _, _, _>(
                    payload,
                    |service, request| async move {
                        service
                            .start_turn(ace_codex::CodexTurnStart::plan(
                                request.thread_id,
                                request.prompt,
                                request.model,
                            ))
                            .await
                    },
                )
                .await
            }
            methods::CODEX_TURN_INTERRUPT => {
                self.codex_json::<CodexThreadIdRequest, _, _, _>(
                    payload,
                    |service, request| async move { service.interrupt_turn(request.thread_id).await },
                )
                .await
            }
            _ => Err(WsDispatchError::UnknownMethod(method.to_string())),
        }
    }
}

#[cfg(test)]
mod tests {
    use crate::{
        codex::{CodexService, tests::FakeCodexBackend},
        git::GitService,
        github::GithubService,
    };
    use ace_git::{
        CommandOutput, CommandRequest, GitClient, GitToolError, GithubCliClient, ProcessRunner,
    };
    use ace_protocol::{
        PROTOCOL_VERSION,
        ws::{WsServerPayload, WsServerResponse, methods},
    };
    use async_trait::async_trait;
    use serde_json::json;
    use std::sync::Arc;

    use super::*;

    #[derive(Debug, Default)]
    struct FakeRunner;

    #[async_trait]
    impl ProcessRunner for FakeRunner {
        async fn run(&self, _request: CommandRequest) -> ace_git::Result<CommandOutput> {
            Err(GitToolError::Parse {
                context: "codex ws fake runner",
                message: "no git process expected".to_string(),
            })
        }
    }

    #[tokio::test]
    async fn dispatches_codex_plan_turn_over_ws_rpc() {
        let backend = Arc::new(FakeCodexBackend::default());
        let runner = Arc::new(FakeRunner);
        let state = WsApiState::new_services(
            GitService::new(GitClient::with_runner(runner.clone())),
            GithubService::new(GithubCliClient::with_runner(runner)),
        )
        .with_codex_service(CodexService::new(backend.clone()));

        let response = state
            .dispatch_text(
                &json!({
                    "version": PROTOCOL_VERSION,
                    "request_id": "codex-plan",
                    "method": methods::CODEX_TURN_PLAN_START,
                    "payload": {
                        "thread_id": "thread-1",
                        "prompt": "plan it",
                        "model": "gpt-5.5"
                    }
                })
                .to_string(),
            )
            .await;
        let response: WsServerResponse = serde_json::from_str(&response).expect("response");
        assert_eq!(response.version, PROTOCOL_VERSION);
        assert!(matches!(response.payload, WsServerPayload::Result { .. }));
        assert_eq!(
            backend.calls.lock().expect("calls").as_slice(),
            ["turn/start:thread-1"]
        );
    }
}

use super::{WsApiState, WsDispatchError};
use ace_git::ProcessRunner;
use ace_protocol::{
    PROTOCOL_VERSION,
    terminal::{
        TERMINAL_EVENT_TOPIC, TerminalClearRequest, TerminalCloseRequest, TerminalListRequest,
        TerminalOpenRequest, TerminalResizeRequest, TerminalRestartRequest,
        TerminalSubscribeRequest, TerminalTerminateRequest, TerminalWriteRequest,
    },
    ws::{WsServerPayload, WsServerResponse, methods},
};
use ace_terminal::PtyAdapter;
use serde_json::Value;
use tokio::sync::mpsc;

impl<R: ProcessRunner, A: PtyAdapter> WsApiState<R, A> {
    pub(super) async fn dispatch_terminal_method(
        &self,
        method: &str,
        payload: Value,
    ) -> Result<Value, WsDispatchError> {
        match method {
            methods::TERMINAL_OPEN => {
                self.terminal_json::<TerminalOpenRequest, _, _, _>(
                    payload,
                    |service, request| async move { service.open(request).await },
                )
                .await
            }
            methods::TERMINAL_WRITE => {
                self.terminal_json::<TerminalWriteRequest, _, _, _>(
                    payload,
                    |service, request| async move {
                        service.write(request).await?;
                        Ok(())
                    },
                )
                .await
            }
            methods::TERMINAL_RESIZE => {
                self.terminal_json::<TerminalResizeRequest, _, _, _>(
                    payload,
                    |service, request| async move {
                        service.resize(request).await?;
                        Ok(())
                    },
                )
                .await
            }
            methods::TERMINAL_CLEAR => {
                self.terminal_json::<TerminalClearRequest, _, _, _>(
                    payload,
                    |service, request| async move {
                        service.clear(request).await?;
                        Ok(())
                    },
                )
                .await
            }
            methods::TERMINAL_RESTART => {
                self.terminal_json::<TerminalRestartRequest, _, _, _>(
                    payload,
                    |service, request| async move { service.restart(request).await },
                )
                .await
            }
            methods::TERMINAL_CLOSE => {
                self.terminal_json::<TerminalCloseRequest, _, _, _>(
                    payload,
                    |service, request| async move {
                        service.close(request).await?;
                        Ok(())
                    },
                )
                .await
            }
            methods::TERMINAL_LIST => {
                self.terminal_json::<TerminalListRequest, _, _, _>(
                    payload,
                    |service, request| async move { service.list(request).await },
                )
                .await
            }
            methods::TERMINAL_TERMINATE => {
                self.terminal_json::<TerminalTerminateRequest, _, _, _>(
                    payload,
                    |service, request| async move { service.terminate(request).await },
                )
                .await
            }
            _ => Err(WsDispatchError::UnknownMethod(method.to_string())),
        }
    }

    pub(super) async fn subscribe_terminal_events(
        &self,
        payload: Value,
        outbound: Option<mpsc::Sender<String>>,
    ) -> Result<Value, WsDispatchError> {
        let request = serde_json::from_value::<TerminalSubscribeRequest>(payload)?;
        let Some(outbound) = outbound else {
            return Ok(serde_json::json!({ "subscribed": false }));
        };
        let mut subscription = self.terminal.subscribe(request).await;
        tokio::spawn(async move {
            while let Some(event) = subscription.next().await {
                let response = WsServerResponse {
                    version: PROTOCOL_VERSION,
                    request_id: String::new(),
                    payload: WsServerPayload::Event {
                        topic: TERMINAL_EVENT_TOPIC.to_string(),
                        body: serde_json::to_value(event)
                            .expect("serialize terminal websocket event"),
                    },
                };
                let Ok(text) = serde_json::to_string(&response) else {
                    continue;
                };
                if outbound.send(text).await.is_err() {
                    break;
                }
            }
        });
        Ok(serde_json::json!({ "subscribed": true }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{git::GitService, github::GithubService};
    use ace_git::{
        CommandOutput, CommandRequest, GitClient, GitToolError, GithubCliClient, ProcessRunner,
    };
    use ace_protocol::{
        PROTOCOL_VERSION,
        terminal::{DEFAULT_TERMINAL_ID, TerminalEvent},
    };
    use ace_terminal::{PtyEvent, PtyHandle, PtySpawnRequest, TerminalConfig, TerminalManager};
    use async_trait::async_trait;
    use std::{
        collections::VecDeque,
        sync::{Arc, Mutex},
    };
    use tokio::sync::mpsc;

    #[derive(Debug)]
    struct FakeRunner {
        outputs: Mutex<VecDeque<CommandOutput>>,
    }

    #[async_trait]
    impl ProcessRunner for FakeRunner {
        async fn run(&self, _request: CommandRequest) -> ace_git::Result<CommandOutput> {
            self.outputs
                .lock()
                .expect("lock outputs")
                .pop_front()
                .ok_or_else(|| GitToolError::Parse {
                    context: "fake terminal ws runner",
                    message: "no fake output queued".to_string(),
                })
        }
    }

    #[derive(Debug, Clone, Default)]
    struct FakePtyAdapter {
        spawns: Arc<Mutex<Vec<mpsc::Sender<PtyEvent>>>>,
    }

    #[async_trait]
    impl ace_terminal::PtyAdapter for FakePtyAdapter {
        async fn spawn(
            &self,
            _request: PtySpawnRequest,
            events: mpsc::Sender<PtyEvent>,
            config: &TerminalConfig,
        ) -> ace_terminal::Result<PtyHandle> {
            let (write_tx, _write_rx) = mpsc::channel(config.write_queue_limit);
            let (control_tx, _control_rx) = mpsc::channel(config.control_queue_limit);
            self.spawns.lock().expect("spawns").push(events);
            Ok(PtyHandle::new(Some(77), write_tx, control_tx))
        }
    }

    fn test_state(
        terminal: TerminalManager<FakePtyAdapter>,
    ) -> WsApiState<FakeRunner, FakePtyAdapter> {
        let runner = Arc::new(FakeRunner {
            outputs: Mutex::new(VecDeque::new()),
        });
        WsApiState::new_services(
            GitService::new_with_github(
                GitClient::with_runner(runner.clone()),
                GithubCliClient::with_runner(runner.clone()),
            ),
            GithubService::new(GithubCliClient::with_runner(runner)),
        )
        .with_terminal_manager(terminal)
    }

    #[tokio::test]
    async fn subscribes_and_pushes_terminal_events_over_ws_payloads() {
        let workspace = tempfile::tempdir().expect("workspace");
        let adapter = FakePtyAdapter::default();
        let adapter_handle = adapter.clone();
        let state = test_state(TerminalManager::new(adapter));
        let (outbound_tx, mut outbound_rx) = mpsc::channel::<String>(16);

        let subscribe = state
            .dispatch_text_with_events(
                &serde_json::json!({
                    "version": PROTOCOL_VERSION,
                    "request_id": "sub",
                    "method": methods::TERMINAL_EVENTS_SUBSCRIBE,
                    "payload": {}
                })
                .to_string(),
                Some(outbound_tx),
            )
            .await;
        let subscribe: WsServerResponse = serde_json::from_str(&subscribe).expect("subscribe");
        assert!(matches!(subscribe.payload, WsServerPayload::Result { .. }));

        let open = state
            .dispatch_text_with_events(
                &serde_json::json!({
                    "version": PROTOCOL_VERSION,
                    "request_id": "open",
                    "method": methods::TERMINAL_OPEN,
                    "payload": {
                        "thread_id": "thread-1",
                        "terminal_id": DEFAULT_TERMINAL_ID,
                        "cwd": workspace.path()
                    }
                })
                .to_string(),
                None,
            )
            .await;
        let open: WsServerResponse = serde_json::from_str(&open).expect("open");
        assert!(matches!(open.payload, WsServerPayload::Result { .. }));

        let started: WsServerResponse = serde_json::from_str(
            &tokio::time::timeout(std::time::Duration::from_secs(1), outbound_rx.recv())
                .await
                .expect("started timeout")
                .expect("started event"),
        )
        .expect("started response");
        assert_event_type(started, "started");

        let sender = adapter_handle.spawns.lock().expect("spawns")[0].clone();
        sender
            .send(PtyEvent::Output(b"hello from fake pty\n".to_vec()))
            .await
            .expect("send output");

        let output: WsServerResponse = serde_json::from_str(
            &tokio::time::timeout(std::time::Duration::from_secs(1), outbound_rx.recv())
                .await
                .expect("output timeout")
                .expect("output event"),
        )
        .expect("output response");
        assert_event_type(output, "output");
    }

    fn assert_event_type(response: WsServerResponse, expected: &str) {
        let WsServerPayload::Event { topic, body } = response.payload else {
            panic!("expected event payload");
        };
        assert_eq!(topic, TERMINAL_EVENT_TOPIC);
        let event: ace_terminal::SequencedTerminalEvent =
            serde_json::from_value(body).expect("terminal event");
        match (expected, event.event) {
            ("started", TerminalEvent::Started { .. })
            | ("output", TerminalEvent::Output { .. }) => {}
            (expected, event) => panic!("expected {expected}, got {event:?}"),
        }
    }
}

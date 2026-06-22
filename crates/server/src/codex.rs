use ace_codex::{
    CodexClient, CodexConfig, CodexPlanImplementation, CodexStdioTransport, CodexThreadStart,
    CodexTurnStart, Result,
};
use ace_runtime::provider::ProviderEvent;
use async_trait::async_trait;
use serde_json::Value;
use std::{sync::Arc, time::Duration};
use thiserror::Error;
use tokio::sync::Mutex;

#[derive(Debug, Error)]
pub enum CodexApiError {
    #[error(transparent)]
    Codex(#[from] ace_codex::CodexError),
    #[error("unsupported provider `{0}` for Codex-backed provider runtime request")]
    UnsupportedProvider(String),
}

impl CodexApiError {
    #[must_use]
    pub fn code(&self) -> &'static str {
        match self {
            Self::Codex(ace_codex::CodexError::MissingBinary(_)) => "codex_missing",
            Self::Codex(ace_codex::CodexError::RequestTimeout { .. }) => "codex_timeout",
            Self::Codex(ace_codex::CodexError::RequestFailed { .. }) => "codex_request_failed",
            Self::Codex(_) => "codex_error",
            Self::UnsupportedProvider(_) => "unsupported_provider",
        }
    }
}

#[async_trait]
pub trait CodexBackend: Send + Sync {
    async fn raw_request(&self, method: &str, params: Value) -> Result<Value>;
    async fn start_thread(&self, request: CodexThreadStart) -> Result<Value>;
    async fn resume_thread(&self, thread_id: &str) -> Result<Value>;
    async fn fork_thread(&self, thread_id: &str, ephemeral: bool) -> Result<Value>;
    async fn read_thread(&self, thread_id: &str) -> Result<Value>;
    async fn list_threads(&self, params: Value) -> Result<Value>;
    async fn list_loaded_threads(&self) -> Result<Value>;
    async fn archive_thread(&self, thread_id: &str) -> Result<Value>;
    async fn unarchive_thread(&self, thread_id: &str) -> Result<Value>;
    async fn delete_thread(&self, thread_id: &str) -> Result<Value>;
    async fn unsubscribe_thread(&self, thread_id: &str) -> Result<Value>;
    async fn set_thread_name(&self, thread_id: &str, name: &str) -> Result<Value>;
    async fn update_thread_metadata(&self, thread_id: &str, metadata: Value) -> Result<Value>;
    async fn compact_thread(&self, thread_id: &str) -> Result<Value>;
    async fn rollback_thread(&self, thread_id: &str, turn_id: &str) -> Result<Value>;
    async fn inject_thread_items(&self, thread_id: &str, items: Vec<Value>) -> Result<Value>;
    async fn start_turn(&self, request: CodexTurnStart) -> Result<Value>;
    async fn continue_plan_in_thread(&self, request: CodexPlanImplementation) -> Result<Value>;
    async fn fork_plan_for_implementation(&self, request: CodexPlanImplementation)
    -> Result<Value>;
    async fn side_implementation(&self, request: CodexPlanImplementation) -> Result<Value>;
    async fn interrupt_turn(&self, thread_id: &str) -> Result<Value>;
    async fn next_events(&self) -> Result<Option<Vec<ProviderEvent>>>;
    async fn respond_server_request_result(&self, request_id: i64, result: Value) -> Result<()>;
    async fn respond_server_request_error(
        &self,
        request_id: i64,
        code: i64,
        message: &str,
    ) -> Result<()>;
    async fn stderr_tail(&self) -> Result<Vec<String>>;
    async fn shutdown(&self, timeout: Duration) -> Result<()>;
    async fn restart(&self, timeout: Duration) -> Result<()>;
}

pub type DynCodexBackend = Arc<dyn CodexBackend>;

pub struct LiveCodexBackend {
    config: CodexConfig,
    client: Mutex<Option<CodexClient<CodexStdioTransport>>>,
}

impl LiveCodexBackend {
    #[must_use]
    pub fn production() -> Self {
        Self {
            config: CodexConfig::default(),
            client: Mutex::new(None),
        }
    }

    async fn client(&self) -> Result<CodexClient<CodexStdioTransport>> {
        let mut guard = self.client.lock().await;
        if let Some(client) = guard.as_ref() {
            return Ok(client.clone());
        }
        let client = CodexClient::spawn(self.config.clone()).await?;
        *guard = Some(client.clone());
        Ok(client)
    }
}

#[async_trait]
impl CodexBackend for LiveCodexBackend {
    async fn raw_request(&self, method: &str, params: Value) -> Result<Value> {
        self.client().await?.raw_request(method, params).await
    }

    async fn start_thread(&self, request: CodexThreadStart) -> Result<Value> {
        self.client().await?.start_thread(request).await
    }

    async fn resume_thread(&self, thread_id: &str) -> Result<Value> {
        self.client().await?.resume_thread(thread_id).await
    }

    async fn fork_thread(&self, thread_id: &str, ephemeral: bool) -> Result<Value> {
        self.client().await?.fork_thread(thread_id, ephemeral).await
    }

    async fn read_thread(&self, thread_id: &str) -> Result<Value> {
        self.client().await?.read_thread(thread_id).await
    }

    async fn list_threads(&self, params: Value) -> Result<Value> {
        self.client().await?.list_threads(params).await
    }

    async fn list_loaded_threads(&self) -> Result<Value> {
        self.client().await?.list_loaded_threads().await
    }

    async fn archive_thread(&self, thread_id: &str) -> Result<Value> {
        self.client().await?.archive_thread(thread_id).await
    }

    async fn unarchive_thread(&self, thread_id: &str) -> Result<Value> {
        self.client().await?.unarchive_thread(thread_id).await
    }

    async fn delete_thread(&self, thread_id: &str) -> Result<Value> {
        self.client().await?.delete_thread(thread_id).await
    }

    async fn unsubscribe_thread(&self, thread_id: &str) -> Result<Value> {
        self.client().await?.unsubscribe_thread(thread_id).await
    }

    async fn set_thread_name(&self, thread_id: &str, name: &str) -> Result<Value> {
        self.client().await?.set_thread_name(thread_id, name).await
    }

    async fn update_thread_metadata(&self, thread_id: &str, metadata: Value) -> Result<Value> {
        self.client()
            .await?
            .update_thread_metadata(thread_id, metadata)
            .await
    }

    async fn compact_thread(&self, thread_id: &str) -> Result<Value> {
        self.client().await?.compact_thread(thread_id).await
    }

    async fn rollback_thread(&self, thread_id: &str, turn_id: &str) -> Result<Value> {
        self.client()
            .await?
            .rollback_thread(thread_id, turn_id)
            .await
    }

    async fn inject_thread_items(&self, thread_id: &str, items: Vec<Value>) -> Result<Value> {
        self.client()
            .await?
            .inject_thread_items(thread_id, items)
            .await
    }

    async fn start_turn(&self, request: CodexTurnStart) -> Result<Value> {
        self.client().await?.start_turn(request).await
    }

    async fn continue_plan_in_thread(&self, request: CodexPlanImplementation) -> Result<Value> {
        self.client().await?.continue_plan_in_thread(request).await
    }

    async fn fork_plan_for_implementation(
        &self,
        request: CodexPlanImplementation,
    ) -> Result<Value> {
        self.client()
            .await?
            .fork_plan_for_implementation(request)
            .await
    }

    async fn side_implementation(&self, request: CodexPlanImplementation) -> Result<Value> {
        self.client().await?.side_implementation(request).await
    }

    async fn interrupt_turn(&self, thread_id: &str) -> Result<Value> {
        self.client().await?.interrupt_turn(thread_id).await
    }

    async fn next_events(&self) -> Result<Option<Vec<ProviderEvent>>> {
        Ok(self.client().await?.next_provider_events().await)
    }

    async fn respond_server_request_result(&self, request_id: i64, result: Value) -> Result<()> {
        self.client()
            .await?
            .respond_tool_result(request_id, result)
            .await
    }

    async fn respond_server_request_error(
        &self,
        request_id: i64,
        code: i64,
        message: &str,
    ) -> Result<()> {
        self.client()
            .await?
            .respond_tool_error(request_id, code, message)
            .await
    }

    async fn stderr_tail(&self) -> Result<Vec<String>> {
        Ok(self.client().await?.stderr_tail().await)
    }

    async fn shutdown(&self, timeout: Duration) -> Result<()> {
        let client = self.client.lock().await.take();
        if let Some(client) = client {
            client.shutdown(timeout).await?;
        }
        Ok(())
    }

    async fn restart(&self, timeout: Duration) -> Result<()> {
        self.shutdown(timeout).await?;
        let _ = self.client().await?;
        Ok(())
    }
}

#[derive(Clone)]
pub struct CodexService {
    backend: DynCodexBackend,
}

impl CodexService {
    #[must_use]
    pub fn production() -> Self {
        Self {
            backend: Arc::new(LiveCodexBackend::production()),
        }
    }

    #[must_use]
    pub fn new(backend: DynCodexBackend) -> Self {
        Self { backend }
    }

    pub async fn raw_request(
        &self,
        method: String,
        params: Value,
    ) -> std::result::Result<Value, CodexApiError> {
        Ok(self.backend.raw_request(&method, params).await?)
    }

    pub async fn start_thread(
        &self,
        request: CodexThreadStart,
    ) -> std::result::Result<Value, CodexApiError> {
        Ok(self.backend.start_thread(request).await?)
    }

    pub async fn resume_thread(
        &self,
        thread_id: String,
    ) -> std::result::Result<Value, CodexApiError> {
        Ok(self.backend.resume_thread(&thread_id).await?)
    }

    pub async fn fork_thread(
        &self,
        thread_id: String,
        ephemeral: bool,
    ) -> std::result::Result<Value, CodexApiError> {
        Ok(self.backend.fork_thread(&thread_id, ephemeral).await?)
    }

    pub async fn read_thread(
        &self,
        thread_id: String,
    ) -> std::result::Result<Value, CodexApiError> {
        Ok(self.backend.read_thread(&thread_id).await?)
    }

    pub async fn list_threads(&self, params: Value) -> std::result::Result<Value, CodexApiError> {
        Ok(self.backend.list_threads(params).await?)
    }

    pub async fn list_loaded_threads(&self) -> std::result::Result<Value, CodexApiError> {
        Ok(self.backend.list_loaded_threads().await?)
    }

    pub async fn archive_thread(
        &self,
        thread_id: String,
    ) -> std::result::Result<Value, CodexApiError> {
        Ok(self.backend.archive_thread(&thread_id).await?)
    }

    pub async fn unarchive_thread(
        &self,
        thread_id: String,
    ) -> std::result::Result<Value, CodexApiError> {
        Ok(self.backend.unarchive_thread(&thread_id).await?)
    }

    pub async fn delete_thread(
        &self,
        thread_id: String,
    ) -> std::result::Result<Value, CodexApiError> {
        Ok(self.backend.delete_thread(&thread_id).await?)
    }

    pub async fn unsubscribe_thread(
        &self,
        thread_id: String,
    ) -> std::result::Result<Value, CodexApiError> {
        Ok(self.backend.unsubscribe_thread(&thread_id).await?)
    }

    pub async fn set_thread_name(
        &self,
        thread_id: String,
        name: String,
    ) -> std::result::Result<Value, CodexApiError> {
        Ok(self.backend.set_thread_name(&thread_id, &name).await?)
    }

    pub async fn update_thread_metadata(
        &self,
        thread_id: String,
        metadata: Value,
    ) -> std::result::Result<Value, CodexApiError> {
        Ok(self
            .backend
            .update_thread_metadata(&thread_id, metadata)
            .await?)
    }

    pub async fn compact_thread(
        &self,
        thread_id: String,
    ) -> std::result::Result<Value, CodexApiError> {
        Ok(self.backend.compact_thread(&thread_id).await?)
    }

    pub async fn rollback_thread(
        &self,
        thread_id: String,
        turn_id: String,
    ) -> std::result::Result<Value, CodexApiError> {
        Ok(self.backend.rollback_thread(&thread_id, &turn_id).await?)
    }

    pub async fn inject_thread_items(
        &self,
        thread_id: String,
        items: Vec<Value>,
    ) -> std::result::Result<Value, CodexApiError> {
        Ok(self.backend.inject_thread_items(&thread_id, items).await?)
    }

    pub async fn start_turn(
        &self,
        request: CodexTurnStart,
    ) -> std::result::Result<Value, CodexApiError> {
        Ok(self.backend.start_turn(request).await?)
    }

    pub async fn continue_plan_in_thread(
        &self,
        request: CodexPlanImplementation,
    ) -> std::result::Result<Value, CodexApiError> {
        Ok(self.backend.continue_plan_in_thread(request).await?)
    }

    pub async fn fork_plan_for_implementation(
        &self,
        request: CodexPlanImplementation,
    ) -> std::result::Result<Value, CodexApiError> {
        Ok(self.backend.fork_plan_for_implementation(request).await?)
    }

    pub async fn side_implementation(
        &self,
        request: CodexPlanImplementation,
    ) -> std::result::Result<Value, CodexApiError> {
        Ok(self.backend.side_implementation(request).await?)
    }

    pub async fn interrupt_turn(
        &self,
        thread_id: String,
    ) -> std::result::Result<Value, CodexApiError> {
        Ok(self.backend.interrupt_turn(&thread_id).await?)
    }

    pub async fn next_events(
        &self,
    ) -> std::result::Result<Option<Vec<ProviderEvent>>, CodexApiError> {
        Ok(self.backend.next_events().await?)
    }

    pub async fn respond_server_request_result(
        &self,
        request_id: i64,
        result: Value,
    ) -> std::result::Result<(), CodexApiError> {
        Ok(self
            .backend
            .respond_server_request_result(request_id, result)
            .await?)
    }

    pub async fn respond_server_request_error(
        &self,
        request_id: i64,
        code: i64,
        message: String,
    ) -> std::result::Result<(), CodexApiError> {
        Ok(self
            .backend
            .respond_server_request_error(request_id, code, &message)
            .await?)
    }

    pub async fn stderr_tail(&self) -> std::result::Result<Vec<String>, CodexApiError> {
        Ok(self.backend.stderr_tail().await?)
    }

    pub async fn shutdown(&self, timeout: Duration) -> std::result::Result<(), CodexApiError> {
        Ok(self.backend.shutdown(timeout).await?)
    }

    pub async fn restart(&self, timeout: Duration) -> std::result::Result<(), CodexApiError> {
        Ok(self.backend.restart(timeout).await?)
    }
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use std::{collections::VecDeque, sync::Mutex as StdMutex};

    #[derive(Default)]
    pub struct FakeCodexBackend {
        pub calls: StdMutex<Vec<String>>,
        pub events: StdMutex<VecDeque<Vec<ProviderEvent>>>,
        pub server_request_responses: StdMutex<Vec<ServerRequestResponse>>,
        pub stderr_tail: StdMutex<Vec<String>>,
        pub shutdowns: StdMutex<Vec<Duration>>,
        pub restarts: StdMutex<Vec<Duration>>,
    }

    #[derive(Debug, Clone, PartialEq)]
    pub enum ServerRequestResponse {
        Result {
            request_id: i64,
            result: Value,
        },
        Error {
            request_id: i64,
            code: i64,
            message: String,
        },
    }

    impl FakeCodexBackend {
        pub fn push_events(&self, events: Vec<ProviderEvent>) {
            self.events.lock().expect("events").push_back(events);
        }
    }

    #[async_trait]
    impl CodexBackend for FakeCodexBackend {
        async fn raw_request(&self, method: &str, _params: Value) -> Result<Value> {
            self.calls.lock().expect("calls").push(method.to_string());
            Ok(serde_json::json!({ "method": method }))
        }

        async fn start_thread(&self, _request: CodexThreadStart) -> Result<Value> {
            self.calls
                .lock()
                .expect("calls")
                .push("thread/start".to_string());
            Ok(serde_json::json!({ "thread": { "id": "thread-1" } }))
        }

        async fn resume_thread(&self, thread_id: &str) -> Result<Value> {
            self.calls
                .lock()
                .expect("calls")
                .push(format!("thread/resume:{thread_id}"));
            Ok(serde_json::json!({ "thread": { "id": thread_id } }))
        }

        async fn fork_thread(&self, thread_id: &str, ephemeral: bool) -> Result<Value> {
            self.calls
                .lock()
                .expect("calls")
                .push(format!("thread/fork:{thread_id}:{ephemeral}"));
            Ok(serde_json::json!({ "thread": { "id": "fork-1" } }))
        }

        async fn read_thread(&self, thread_id: &str) -> Result<Value> {
            self.calls
                .lock()
                .expect("calls")
                .push(format!("thread/read:{thread_id}"));
            Ok(serde_json::json!({ "thread": { "id": thread_id } }))
        }

        async fn list_threads(&self, _params: Value) -> Result<Value> {
            self.calls
                .lock()
                .expect("calls")
                .push("thread/list".to_string());
            Ok(serde_json::json!({ "threads": [] }))
        }

        async fn list_loaded_threads(&self) -> Result<Value> {
            self.calls
                .lock()
                .expect("calls")
                .push("thread/loadedList".to_string());
            Ok(serde_json::json!({ "threads": [] }))
        }

        async fn archive_thread(&self, thread_id: &str) -> Result<Value> {
            self.calls
                .lock()
                .expect("calls")
                .push(format!("thread/archive:{thread_id}"));
            Ok(serde_json::json!({ "archived": true }))
        }

        async fn unarchive_thread(&self, thread_id: &str) -> Result<Value> {
            self.calls
                .lock()
                .expect("calls")
                .push(format!("thread/unarchive:{thread_id}"));
            Ok(serde_json::json!({ "archived": false }))
        }

        async fn delete_thread(&self, thread_id: &str) -> Result<Value> {
            self.calls
                .lock()
                .expect("calls")
                .push(format!("thread/delete:{thread_id}"));
            Ok(serde_json::json!({ "deleted": true }))
        }

        async fn unsubscribe_thread(&self, thread_id: &str) -> Result<Value> {
            self.calls
                .lock()
                .expect("calls")
                .push(format!("thread/unsubscribe:{thread_id}"));
            Ok(serde_json::json!({ "unsubscribed": true }))
        }

        async fn set_thread_name(&self, thread_id: &str, name: &str) -> Result<Value> {
            self.calls
                .lock()
                .expect("calls")
                .push(format!("thread/setName:{thread_id}:{name}"));
            Ok(serde_json::json!({ "name": name }))
        }

        async fn update_thread_metadata(&self, thread_id: &str, metadata: Value) -> Result<Value> {
            self.calls
                .lock()
                .expect("calls")
                .push(format!("thread/updateMetadata:{thread_id}"));
            Ok(serde_json::json!({ "metadata": metadata }))
        }

        async fn compact_thread(&self, thread_id: &str) -> Result<Value> {
            self.calls
                .lock()
                .expect("calls")
                .push(format!("thread/compact:{thread_id}"));
            Ok(serde_json::json!({ "compacted": true }))
        }

        async fn rollback_thread(&self, thread_id: &str, turn_id: &str) -> Result<Value> {
            self.calls
                .lock()
                .expect("calls")
                .push(format!("thread/rollback:{thread_id}:{turn_id}"));
            Ok(serde_json::json!({ "rolled_back": true }))
        }

        async fn inject_thread_items(&self, thread_id: &str, items: Vec<Value>) -> Result<Value> {
            self.calls
                .lock()
                .expect("calls")
                .push(format!("thread/injectItems:{thread_id}:{}", items.len()));
            Ok(serde_json::json!({ "injected": items.len() }))
        }

        async fn start_turn(&self, request: CodexTurnStart) -> Result<Value> {
            self.calls
                .lock()
                .expect("calls")
                .push(format!("turn/start:{}", request.thread_id));
            Ok(serde_json::json!({ "turn": { "id": "turn-1" } }))
        }

        async fn continue_plan_in_thread(&self, request: CodexPlanImplementation) -> Result<Value> {
            self.inject_thread_items(
                &request.thread_id,
                vec![ace_codex::accepted_plan_item(request.plan.clone())],
            )
            .await?;
            let thread_id = request.thread_id.clone();
            self.start_turn(request.into_turn_start(thread_id.clone()))
                .await?;
            Ok(serde_json::json!({ "threadId": thread_id, "forked": false }))
        }

        async fn fork_plan_for_implementation(
            &self,
            request: CodexPlanImplementation,
        ) -> Result<Value> {
            self.implement_plan_in_fake_fork(request, false).await
        }

        async fn side_implementation(&self, request: CodexPlanImplementation) -> Result<Value> {
            self.implement_plan_in_fake_fork(request, true).await
        }

        async fn interrupt_turn(&self, thread_id: &str) -> Result<Value> {
            self.calls
                .lock()
                .expect("calls")
                .push(format!("turn/interrupt:{thread_id}"));
            Ok(serde_json::json!({ "interrupted": true }))
        }

        async fn next_events(&self) -> Result<Option<Vec<ProviderEvent>>> {
            Ok(self.events.lock().expect("events").pop_front())
        }

        async fn respond_server_request_result(
            &self,
            request_id: i64,
            result: Value,
        ) -> Result<()> {
            self.server_request_responses
                .lock()
                .expect("server request responses")
                .push(ServerRequestResponse::Result { request_id, result });
            Ok(())
        }

        async fn respond_server_request_error(
            &self,
            request_id: i64,
            code: i64,
            message: &str,
        ) -> Result<()> {
            self.server_request_responses
                .lock()
                .expect("server request responses")
                .push(ServerRequestResponse::Error {
                    request_id,
                    code,
                    message: message.to_string(),
                });
            Ok(())
        }

        async fn stderr_tail(&self) -> Result<Vec<String>> {
            Ok(self.stderr_tail.lock().expect("stderr tail").clone())
        }

        async fn shutdown(&self, timeout: Duration) -> Result<()> {
            self.shutdowns.lock().expect("shutdowns").push(timeout);
            Ok(())
        }

        async fn restart(&self, timeout: Duration) -> Result<()> {
            self.restarts.lock().expect("restarts").push(timeout);
            Ok(())
        }
    }

    impl FakeCodexBackend {
        async fn implement_plan_in_fake_fork(
            &self,
            request: CodexPlanImplementation,
            ephemeral: bool,
        ) -> Result<Value> {
            let parent_thread_id = request.thread_id.clone();
            self.fork_thread(&parent_thread_id, ephemeral).await?;
            let thread_id = "fork-1".to_string();
            self.inject_thread_items(
                &thread_id,
                vec![ace_codex::accepted_plan_item(request.plan.clone())],
            )
            .await?;
            self.start_turn(request.into_turn_start(thread_id.clone()))
                .await?;
            Ok(serde_json::json!({
                "threadId": thread_id,
                "parentThreadId": parent_thread_id,
                "forked": true,
                "ephemeral": ephemeral,
            }))
        }
    }
}

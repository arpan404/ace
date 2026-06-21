use ace_codex::{
    CodexClient, CodexConfig, CodexStdioTransport, CodexThreadStart, CodexTurnStart, Result,
};
use ace_runtime::provider::ProviderEvent;
use async_trait::async_trait;
use serde_json::Value;
use std::sync::Arc;
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
    async fn start_turn(&self, request: CodexTurnStart) -> Result<Value>;
    async fn interrupt_turn(&self, thread_id: &str) -> Result<Value>;
    async fn next_events(&self) -> Result<Option<Vec<ProviderEvent>>>;
    async fn respond_server_request_result(&self, request_id: i64, result: Value) -> Result<()>;
    async fn respond_server_request_error(
        &self,
        request_id: i64,
        code: i64,
        message: &str,
    ) -> Result<()>;
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

    async fn start_turn(&self, request: CodexTurnStart) -> Result<Value> {
        self.client().await?.start_turn(request).await
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

    pub async fn start_turn(
        &self,
        request: CodexTurnStart,
    ) -> std::result::Result<Value, CodexApiError> {
        Ok(self.backend.start_turn(request).await?)
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

        async fn start_turn(&self, request: CodexTurnStart) -> Result<Value> {
            self.calls
                .lock()
                .expect("calls")
                .push(format!("turn/start:{}", request.thread_id));
            Ok(serde_json::json!({ "turn": { "id": "turn-1" } }))
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
    }
}

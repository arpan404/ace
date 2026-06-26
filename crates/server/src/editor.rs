use ace_fs::AppDirs;
use ace_lsp::{LspError, LspSessionManager, LspToolRegistry};
use ace_process::{ProcessRunner, TokioProcessRunner};
use ace_protocol::{
    editor::{BufferCloseRequest, BufferSyncRequest, LspRequest, WorkspaceSymbolsRequest},
    lsp_tools::{
        LspToolIdRequest, LspToolUninstallResult, LspToolsListRequest, LspToolsSearchRequest,
    },
    workspace::WorkspaceApplyEditRequest,
};
use std::sync::Arc;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum EditorApiError {
    #[error("editor service unavailable: {0}")]
    Unavailable(String),
    #[error("{0}")]
    Lsp(#[from] LspError),
    #[error("{0}")]
    Process(#[from] ace_process::ProcessError),
}

#[derive(Clone)]
pub struct EditorService<R: ProcessRunner = TokioProcessRunner> {
    lsp: Arc<LspSessionManager>,
    runner: Arc<R>,
}

impl EditorService<TokioProcessRunner> {
    pub fn production() -> Result<Self, EditorApiError> {
        let paths =
            AppDirs::resolve().map_err(|error| EditorApiError::Unavailable(error.to_string()))?;
        let registry = LspToolRegistry::new(paths.state_dir.join("lsp-tools"))?;
        Ok(Self::new(registry, Arc::new(TokioProcessRunner)))
    }
}

impl<R: ProcessRunner> EditorService<R> {
    #[must_use]
    pub fn new(registry: LspToolRegistry, runner: Arc<R>) -> Self {
        Self {
            lsp: Arc::new(LspSessionManager::new(registry)),
            runner,
        }
    }

    #[must_use]
    pub fn lsp(&self) -> Arc<LspSessionManager> {
        Arc::clone(&self.lsp)
    }

    pub async fn sync_buffer(
        &self,
        request: BufferSyncRequest,
    ) -> Result<ace_lsp::BufferSyncResult, EditorApiError> {
        Ok(self.lsp.sync_buffer(request).await?)
    }

    pub async fn close_buffer(
        &self,
        request: BufferCloseRequest,
    ) -> Result<serde_json::Value, EditorApiError> {
        let closed = self.lsp.close_buffer(&request.relative_path);
        Ok(serde_json::json!({ "closed": closed }))
    }

    pub async fn completion(
        &self,
        request: LspRequest,
    ) -> Result<Vec<ace_lsp::LspCompletionItem>, EditorApiError> {
        Ok(self.lsp.completion(request).await?)
    }

    pub async fn hover(
        &self,
        request: LspRequest,
    ) -> Result<Option<ace_lsp::LspHover>, EditorApiError> {
        Ok(self.lsp.hover(request).await?)
    }

    pub async fn definition(
        &self,
        request: LspRequest,
    ) -> Result<Vec<ace_lsp::LspLocation>, EditorApiError> {
        Ok(self.lsp.definition(request).await?)
    }

    pub async fn references(
        &self,
        request: LspRequest,
    ) -> Result<Vec<ace_lsp::LspLocation>, EditorApiError> {
        Ok(self.lsp.references(request).await?)
    }

    pub async fn rename(
        &self,
        request: LspRequest,
    ) -> Result<Option<ace_workspace::WorkspaceEdit>, EditorApiError> {
        Ok(self.lsp.rename(request).await?)
    }

    pub async fn formatting(
        &self,
        request: LspRequest,
    ) -> Result<Option<ace_workspace::WorkspaceEdit>, EditorApiError> {
        Ok(self.lsp.formatting(request).await?)
    }

    pub async fn code_actions(
        &self,
        request: LspRequest,
    ) -> Result<Vec<ace_lsp::LspCodeAction>, EditorApiError> {
        Ok(self.lsp.code_actions(request).await?)
    }

    pub async fn document_symbols(
        &self,
        request: LspRequest,
    ) -> Result<Vec<ace_lsp::LspSymbol>, EditorApiError> {
        Ok(self.lsp.document_symbols(request).await?)
    }

    pub async fn workspace_symbols(
        &self,
        request: WorkspaceSymbolsRequest,
    ) -> Result<Vec<ace_lsp::LspSymbol>, EditorApiError> {
        Ok(self
            .lsp
            .workspace_symbols(request.workspace_root, request.query, request.language_id)
            .await?)
    }

    pub async fn semantic_tokens(
        &self,
        request: LspRequest,
    ) -> Result<Option<ace_lsp::LspSemanticTokens>, EditorApiError> {
        Ok(self.lsp.semantic_tokens(request).await?)
    }

    pub async fn signature_help(
        &self,
        request: LspRequest,
    ) -> Result<Option<ace_lsp::LspSignatureHelp>, EditorApiError> {
        Ok(self.lsp.signature_help(request).await?)
    }

    pub async fn apply_workspace_edit(
        &self,
        request: WorkspaceApplyEditRequest,
    ) -> Result<ace_workspace::WorkspaceEditResult, EditorApiError> {
        Ok(self
            .lsp
            .apply_workspace_edit(request.workspace_root, &request.edit)?)
    }

    pub async fn list_tools(
        &self,
        _request: LspToolsListRequest,
    ) -> Result<Vec<ace_lsp::LspToolDefinition>, EditorApiError> {
        Ok(self.lsp.registry().list())
    }

    pub async fn search_tools(
        &self,
        request: LspToolsSearchRequest,
    ) -> Result<Vec<ace_lsp::LspToolDefinition>, EditorApiError> {
        Ok(self.lsp.registry().search(&request.query))
    }

    pub async fn tool_status(
        &self,
        request: LspToolIdRequest,
    ) -> Result<ace_lsp::LspToolStatus, EditorApiError> {
        Ok(self.lsp.registry().status(&request.tool_id)?)
    }

    pub async fn install_tool(
        &self,
        request: LspToolIdRequest,
    ) -> Result<ace_lsp::LspInstallResult, EditorApiError> {
        Ok(self
            .lsp
            .registry()
            .install(self.runner.as_ref(), &request.tool_id)
            .await?)
    }

    pub async fn upsert_custom_tool(
        &self,
        request: ace_lsp::LspToolDefinition,
    ) -> Result<ace_lsp::LspToolDefinition, EditorApiError> {
        Ok(self.lsp.registry().upsert_custom(request)?)
    }

    pub async fn uninstall_custom_tool(
        &self,
        request: LspToolIdRequest,
    ) -> Result<LspToolUninstallResult, EditorApiError> {
        Ok(LspToolUninstallResult {
            removed: self.lsp.registry().uninstall_custom(&request.tool_id)?,
        })
    }
}

pub use ace_lsp::{
    BufferSyncRequest, BufferSyncResult, LspCodeAction, LspCompletionItem, LspDiagnostic,
    LspDocumentId, LspHover, LspLocation, LspPosition, LspRequest, LspSemanticTokens,
    LspServerStatus, LspSignatureHelp, LspSymbol,
};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BufferCloseRequest {
    pub workspace_root: PathBuf,
    pub relative_path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DiagnosticsSubscribeRequest {
    pub workspace_root: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkspaceSymbolsRequest {
    pub workspace_root: PathBuf,
    pub query: String,
    pub language_id: Option<String>,
}

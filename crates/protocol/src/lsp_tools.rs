pub use ace_lsp::{
    LspInstallProvider, LspInstallResult, LspToolDefinition, LspToolStatus, LspToolStatusKind,
};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct LspToolsListRequest {}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LspToolsSearchRequest {
    pub query: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LspToolIdRequest {
    pub tool_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LspToolUninstallResult {
    pub removed: bool,
}

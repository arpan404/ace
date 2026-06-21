use ace_workspace::{WorkspaceEdit, WorkspaceTextRange};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LspDocumentId {
    pub workspace_root: PathBuf,
    pub relative_path: String,
    pub language_id: String,
    pub version: i32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BufferSyncRequest {
    pub workspace_root: PathBuf,
    pub relative_path: String,
    pub language_id: Option<String>,
    pub contents: String,
    pub version: i32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BufferSyncResult {
    pub document: LspDocumentId,
    pub diagnostics: Vec<LspDiagnostic>,
    pub server: Option<LspServerStatus>,
    pub install_candidates: Vec<LspToolDefinition>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LspPosition {
    pub line: u32,
    pub character: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LspRange {
    pub start: LspPosition,
    pub end: LspPosition,
}

impl From<LspRange> for WorkspaceTextRange {
    fn from(range: LspRange) -> Self {
        Self {
            start_line: range.start.line,
            start_character: range.start.character,
            end_line: range.end.line,
            end_character: range.end.character,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LspLocation {
    pub relative_path: String,
    pub range: LspRange,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LspDiagnostic {
    pub relative_path: String,
    pub range: LspRange,
    pub severity: Option<u32>,
    pub code: Option<String>,
    pub source: Option<String>,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LspCompletionItem {
    pub label: String,
    pub kind: Option<u32>,
    pub detail: Option<String>,
    pub documentation: Option<String>,
    pub insert_text: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LspHover {
    pub contents: String,
    pub range: Option<LspRange>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LspCodeAction {
    pub title: String,
    pub kind: Option<String>,
    pub diagnostics: Vec<LspDiagnostic>,
    pub edit: Option<WorkspaceEdit>,
    pub command: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LspSymbol {
    pub name: String,
    pub kind: u32,
    pub relative_path: Option<String>,
    pub range: Option<LspRange>,
    pub selection_range: Option<LspRange>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LspSignatureHelp {
    pub signatures: Vec<String>,
    pub active_signature: Option<u32>,
    pub active_parameter: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LspSemanticTokens {
    pub result_id: Option<String>,
    pub data: Vec<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LspInstallProvider {
    Npm,
    UvTool,
    GoInstall,
    Rustup,
    Custom,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LspToolDefinition {
    pub id: String,
    pub display_name: String,
    pub languages: Vec<String>,
    pub file_extensions: Vec<String>,
    pub command: String,
    pub args: Vec<String>,
    pub install_provider: LspInstallProvider,
    pub install_args: Vec<String>,
    #[serde(default)]
    pub env: Vec<(String, String)>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LspToolStatusKind {
    Installed,
    Missing,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LspToolStatus {
    pub definition: LspToolDefinition,
    pub status: LspToolStatusKind,
    pub resolved_command: Option<PathBuf>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LspInstallResult {
    pub tool_id: String,
    pub command: String,
    pub args: Vec<String>,
    pub status: i32,
    pub stdout: String,
    pub stderr: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LspServerStatus {
    pub server_id: String,
    pub initialized: bool,
    pub stderr_tail: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LspRequest {
    pub workspace_root: PathBuf,
    pub relative_path: String,
    pub language_id: Option<String>,
    pub position: Option<LspPosition>,
    pub range: Option<LspRange>,
    pub query: Option<String>,
    pub new_name: Option<String>,
}

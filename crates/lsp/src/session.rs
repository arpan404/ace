use crate::{
    LspError, Result,
    registry::LspToolRegistry,
    transport::LspTransport,
    types::{
        BufferSyncRequest, BufferSyncResult, LspCodeAction, LspCompletionItem, LspDiagnostic,
        LspDocumentId, LspHover, LspLocation, LspPosition, LspRequest, LspSemanticTokens,
        LspServerStatus, LspSignatureHelp, LspSymbol, LspToolDefinition,
    },
};
use ace_workspace::{BufferStore, WorkspaceEdit, WorkspaceService};
use lsp_types as lsp;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashMap, VecDeque},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};
use url::Url;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
const STDERR_TAIL_LINES: usize = 80;

type DiagnosticsKey = (PathBuf, String);
type DiagnosticsCache = BTreeMap<DiagnosticsKey, Vec<LspDiagnostic>>;
type StderrTailCache = BTreeMap<SessionKey, VecDeque<String>>;

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
struct SessionKey {
    workspace_root: PathBuf,
    server_id: String,
}

#[derive(Clone)]
pub struct LspSessionManager {
    registry: LspToolRegistry,
    workspace: Arc<Mutex<WorkspaceService>>,
    buffers: Arc<Mutex<BufferStore>>,
    transports: Arc<Mutex<HashMap<SessionKey, Arc<dyn LspTransport>>>>,
    diagnostics: Arc<Mutex<DiagnosticsCache>>,
    stderr_tail: Arc<Mutex<StderrTailCache>>,
}

impl LspSessionManager {
    #[must_use]
    pub fn new(registry: LspToolRegistry) -> Self {
        Self {
            registry,
            workspace: Arc::new(Mutex::new(WorkspaceService::new())),
            buffers: Arc::new(Mutex::new(BufferStore::new())),
            transports: Arc::new(Mutex::new(HashMap::new())),
            diagnostics: Arc::new(Mutex::new(BTreeMap::new())),
            stderr_tail: Arc::new(Mutex::new(BTreeMap::new())),
        }
    }

    pub fn register_transport(
        &self,
        workspace_root: impl Into<PathBuf>,
        server_id: impl Into<String>,
        transport: Arc<dyn LspTransport>,
    ) {
        let workspace_root = workspace_root.into();
        let workspace_root = workspace_root
            .canonicalize()
            .unwrap_or_else(|_| workspace_root.clone());
        let key = SessionKey {
            workspace_root,
            server_id: server_id.into(),
        };
        self.transports
            .lock()
            .expect("transports")
            .insert(key, transport);
    }

    pub fn registry(&self) -> &LspToolRegistry {
        &self.registry
    }

    pub fn close_buffer(&self, relative_path: &str) -> bool {
        self.buffers
            .lock()
            .expect("buffers")
            .close(relative_path)
            .is_some()
    }

    pub async fn sync_buffer(&self, request: BufferSyncRequest) -> Result<BufferSyncResult> {
        let root = WorkspaceService::normalize_workspace_root(&request.workspace_root, false)?;
        let language_id = request
            .language_id
            .clone()
            .unwrap_or_else(|| infer_language_id(&request.relative_path));
        let candidates = self
            .registry
            .match_file(&request.relative_path, Some(&language_id));
        let document = LspDocumentId {
            workspace_root: root.clone(),
            relative_path: request.relative_path.clone(),
            language_id: language_id.clone(),
            version: request.version,
        };
        self.buffers.lock().expect("buffers").sync(
            &request.relative_path,
            &request.contents,
            request.version,
        );
        let Some(tool) = candidates.first().cloned() else {
            return Ok(BufferSyncResult {
                document,
                diagnostics: Vec::new(),
                server: None,
                install_candidates: Vec::new(),
            });
        };
        let Some(transport) = self.transport(&root, &tool.id) else {
            return Ok(BufferSyncResult {
                document,
                diagnostics: Vec::new(),
                server: None,
                install_candidates: candidates,
            });
        };
        let uri = file_uri(&root, &request.relative_path)?;
        transport
            .notify(
                "textDocument/didOpen",
                json!({
                    "textDocument": {
                        "uri": uri,
                        "languageId": language_id,
                        "version": request.version,
                        "text": request.contents,
                    }
                }),
            )
            .await?;
        let diagnostics = self.current_diagnostics(&root, &request.relative_path);
        Ok(BufferSyncResult {
            document,
            diagnostics,
            server: Some(self.server_status(&root, &tool.id)),
            install_candidates: Vec::new(),
        })
    }

    pub async fn completion(&self, request: LspRequest) -> Result<Vec<LspCompletionItem>> {
        self.request_document::<lsp::CompletionResponse>(request, "textDocument/completion")
            .await
            .map(map_completion)
    }

    pub async fn hover(&self, request: LspRequest) -> Result<Option<LspHover>> {
        self.request_document::<Option<lsp::Hover>>(request, "textDocument/hover")
            .await
            .map(|hover| hover.map(map_hover))
    }

    pub async fn definition(&self, request: LspRequest) -> Result<Vec<LspLocation>> {
        self.request_document::<Option<lsp::GotoDefinitionResponse>>(
            request,
            "textDocument/definition",
        )
        .await
        .map(map_locations)
    }

    pub async fn references(&self, request: LspRequest) -> Result<Vec<LspLocation>> {
        self.request_document::<Option<Vec<lsp::Location>>>(request, "textDocument/references")
            .await
            .map(|locations| {
                locations
                    .unwrap_or_default()
                    .into_iter()
                    .filter_map(map_location)
                    .collect()
            })
    }

    pub async fn rename(&self, request: LspRequest) -> Result<Option<WorkspaceEdit>> {
        self.request_document::<Option<lsp::WorkspaceEdit>>(request, "textDocument/rename")
            .await
            .and_then(|edit| edit.map(normalize_workspace_edit).transpose())
    }

    pub async fn formatting(&self, request: LspRequest) -> Result<Option<WorkspaceEdit>> {
        let relative_path = request.relative_path.clone();
        self.request_document::<Option<Vec<lsp::TextEdit>>>(request, "textDocument/formatting")
            .await
            .map(|edits| {
                edits.map(|edits| WorkspaceEdit {
                    edits: edits
                        .into_iter()
                        .map(|edit| ace_workspace::WorkspaceTextEdit {
                            relative_path: relative_path.clone(),
                            range: Some(map_range(edit.range).into()),
                            new_text: edit.new_text,
                        })
                        .collect(),
                })
            })
    }

    pub async fn code_actions(&self, request: LspRequest) -> Result<Vec<LspCodeAction>> {
        self.request_document::<Option<lsp::CodeActionResponse>>(request, "textDocument/codeAction")
            .await
            .and_then(|actions| {
                actions
                    .unwrap_or_default()
                    .into_iter()
                    .map(map_code_action)
                    .collect()
            })
    }

    pub async fn document_symbols(&self, request: LspRequest) -> Result<Vec<LspSymbol>> {
        self.request_document::<Option<lsp::DocumentSymbolResponse>>(
            request,
            "textDocument/documentSymbol",
        )
        .await
        .map(map_document_symbols)
    }

    pub async fn workspace_symbols(
        &self,
        workspace_root: PathBuf,
        query: String,
        language_id: Option<String>,
    ) -> Result<Vec<LspSymbol>> {
        let root = WorkspaceService::normalize_workspace_root(&workspace_root, false)?;
        let tool = self
            .registry
            .search(language_id.as_deref().unwrap_or_default())
            .into_iter()
            .next()
            .ok_or_else(|| LspError::ServerUnavailable {
                language_id: language_id.unwrap_or_default(),
                candidates: Vec::new(),
            })?;
        let transport = self.ensure_transport(&root, &tool)?;
        let response: Option<Vec<lsp::SymbolInformation>> = request_json(
            transport.as_ref(),
            "workspace/symbol",
            json!({ "query": query }),
        )
        .await?;
        Ok(response
            .unwrap_or_default()
            .into_iter()
            .filter_map(|symbol| {
                map_location(symbol.location).map(|location| LspSymbol {
                    name: symbol.name,
                    kind: protocol_number(symbol.kind),
                    relative_path: Some(location.relative_path),
                    range: Some(location.range),
                    selection_range: None,
                })
            })
            .collect())
    }

    pub async fn semantic_tokens(&self, request: LspRequest) -> Result<Option<LspSemanticTokens>> {
        self.request_document::<Option<lsp::SemanticTokensResult>>(
            request,
            "textDocument/semanticTokens/full",
        )
        .await
        .map(|tokens| tokens.and_then(map_semantic_tokens))
    }

    pub async fn signature_help(&self, request: LspRequest) -> Result<Option<LspSignatureHelp>> {
        self.request_document::<Option<lsp::SignatureHelp>>(request, "textDocument/signatureHelp")
            .await
            .map(|help| help.map(map_signature_help))
    }

    pub fn current_diagnostics(
        &self,
        workspace_root: &Path,
        relative_path: &str,
    ) -> Vec<LspDiagnostic> {
        self.diagnostics
            .lock()
            .expect("diagnostics")
            .get(&(workspace_root.to_path_buf(), relative_path.to_string()))
            .cloned()
            .unwrap_or_default()
    }

    pub fn publish_diagnostics(
        &self,
        workspace_root: PathBuf,
        relative_path: String,
        diagnostics: Vec<LspDiagnostic>,
    ) {
        self.diagnostics
            .lock()
            .expect("diagnostics")
            .insert((workspace_root, relative_path), diagnostics);
    }

    pub fn server_status(&self, workspace_root: &Path, server_id: &str) -> LspServerStatus {
        let key = SessionKey {
            workspace_root: workspace_root.to_path_buf(),
            server_id: server_id.to_string(),
        };
        LspServerStatus {
            server_id: server_id.to_string(),
            initialized: self
                .transports
                .lock()
                .expect("transports")
                .contains_key(&key),
            stderr_tail: self
                .stderr_tail
                .lock()
                .expect("stderr")
                .get(&key)
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .collect(),
        }
    }

    pub fn append_stderr(&self, workspace_root: PathBuf, server_id: String, line: String) {
        let key = SessionKey {
            workspace_root,
            server_id,
        };
        let mut stderr = self.stderr_tail.lock().expect("stderr");
        let tail = stderr.entry(key).or_default();
        tail.push_back(line);
        while tail.len() > STDERR_TAIL_LINES {
            tail.pop_front();
        }
    }

    pub fn apply_workspace_edit(
        &self,
        workspace_root: impl AsRef<Path>,
        edit: &WorkspaceEdit,
    ) -> Result<ace_workspace::WorkspaceEditResult> {
        Ok(self
            .workspace
            .lock()
            .expect("workspace")
            .apply_edit(workspace_root, edit)?)
    }

    async fn request_document<T: DeserializeOwned>(
        &self,
        request: LspRequest,
        method: &str,
    ) -> Result<T> {
        let root = WorkspaceService::normalize_workspace_root(&request.workspace_root, false)?;
        let language_id = request
            .language_id
            .clone()
            .unwrap_or_else(|| infer_language_id(&request.relative_path));
        let candidates = self
            .registry
            .match_file(&request.relative_path, Some(&language_id));
        let tool = candidates
            .first()
            .ok_or_else(|| LspError::ServerUnavailable {
                language_id,
                candidates: candidates.iter().map(|tool| tool.id.clone()).collect(),
            })?;
        let transport = self.ensure_transport(&root, tool)?;
        let params = document_position_params(&root, &request)?;
        request_json(transport.as_ref(), method, params).await
    }

    fn ensure_transport(
        &self,
        root: &Path,
        tool: &LspToolDefinition,
    ) -> Result<Arc<dyn LspTransport>> {
        self.transport(root, &tool.id)
            .ok_or_else(|| LspError::ServerNotInstalled(tool.id.clone()))
    }

    fn transport(&self, root: &Path, server_id: &str) -> Option<Arc<dyn LspTransport>> {
        self.transports
            .lock()
            .expect("transports")
            .get(&SessionKey {
                workspace_root: root.to_path_buf(),
                server_id: server_id.to_string(),
            })
            .cloned()
    }
}

async fn request_json<T: DeserializeOwned>(
    transport: &dyn LspTransport,
    method: &str,
    params: Value,
) -> Result<T> {
    let value = transport.request(method, params, REQUEST_TIMEOUT).await?;
    Ok(serde_json::from_value(value)?)
}

fn document_position_params(root: &Path, request: &LspRequest) -> Result<Value> {
    let uri = file_uri(root, &request.relative_path)?;
    let mut params = json!({ "textDocument": { "uri": uri } });
    if let Some(position) = &request.position {
        params["position"] = json!({ "line": position.line, "character": position.character });
    }
    if let Some(range) = &request.range {
        params["range"] = serde_json::to_value(map_range_to_lsp(range.clone()))?;
    }
    if let Some(query) = &request.query {
        params["query"] = json!(query);
    }
    if let Some(new_name) = &request.new_name {
        params["newName"] = json!(new_name);
    }
    Ok(params)
}

fn file_uri(root: &Path, relative_path: &str) -> Result<Url> {
    let target = WorkspaceService::resolve_relative_path_within_root(root, relative_path)?;
    Url::from_file_path(target.absolute_path())
        .map_err(|_| LspError::InvalidResponse("file uri".to_string()))
}

fn infer_language_id(relative_path: &str) -> String {
    Path::new(relative_path)
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or("text")
        .to_string()
}

fn map_completion(response: lsp::CompletionResponse) -> Vec<LspCompletionItem> {
    let items = match response {
        lsp::CompletionResponse::Array(items) => items,
        lsp::CompletionResponse::List(list) => list.items,
    };
    items
        .into_iter()
        .map(|item| LspCompletionItem {
            label: item.label,
            kind: item.kind.map(protocol_number),
            detail: item.detail,
            documentation: item.documentation.map(|documentation| match documentation {
                lsp::Documentation::String(text) => text,
                lsp::Documentation::MarkupContent(content) => content.value,
            }),
            insert_text: item.insert_text,
        })
        .collect()
}

fn map_hover(hover: lsp::Hover) -> LspHover {
    let contents = match hover.contents {
        lsp::HoverContents::Scalar(marked) => marked_string(marked),
        lsp::HoverContents::Array(values) => values
            .into_iter()
            .map(marked_string)
            .collect::<Vec<_>>()
            .join("\n"),
        lsp::HoverContents::Markup(content) => content.value,
    };
    LspHover {
        contents,
        range: hover.range.map(map_range),
    }
}

fn marked_string(value: lsp::MarkedString) -> String {
    match value {
        lsp::MarkedString::String(text) => text,
        lsp::MarkedString::LanguageString(language) => language.value,
    }
}

fn map_locations(response: Option<lsp::GotoDefinitionResponse>) -> Vec<LspLocation> {
    match response {
        Some(lsp::GotoDefinitionResponse::Scalar(location)) => {
            map_location(location).into_iter().collect()
        }
        Some(lsp::GotoDefinitionResponse::Array(locations)) => {
            locations.into_iter().filter_map(map_location).collect()
        }
        Some(lsp::GotoDefinitionResponse::Link(links)) => links
            .into_iter()
            .filter_map(|link| {
                uri_to_relative(&link.target_uri).map(|relative_path| LspLocation {
                    relative_path,
                    range: map_range(link.target_range),
                })
            })
            .collect(),
        None => Vec::new(),
    }
}

fn map_location(location: lsp::Location) -> Option<LspLocation> {
    uri_to_relative(&location.uri).map(|relative_path| LspLocation {
        relative_path,
        range: map_range(location.range),
    })
}

fn uri_to_relative(uri: &lsp::Uri) -> Option<String> {
    let url = Url::parse(uri.as_str()).ok()?;
    let path = url.to_file_path().ok()?;
    path.file_name()
        .and_then(|name| name.to_str())
        .map(str::to_string)
}

fn map_code_action(action: lsp::CodeActionOrCommand) -> Result<LspCodeAction> {
    match action {
        lsp::CodeActionOrCommand::Command(command) => Ok(LspCodeAction {
            title: command.title,
            kind: None,
            diagnostics: Vec::new(),
            edit: None,
            command: Some(command.command),
        }),
        lsp::CodeActionOrCommand::CodeAction(action) => Ok(LspCodeAction {
            title: action.title,
            kind: action.kind.map(|kind| kind.as_str().to_string()),
            diagnostics: action
                .diagnostics
                .unwrap_or_default()
                .into_iter()
                .filter_map(map_diagnostic)
                .collect(),
            edit: action.edit.map(normalize_workspace_edit).transpose()?,
            command: action.command.map(|command| command.command),
        }),
    }
}

fn map_diagnostic(diagnostic: lsp::Diagnostic) -> Option<LspDiagnostic> {
    Some(LspDiagnostic {
        relative_path: String::new(),
        range: map_range(diagnostic.range),
        severity: diagnostic.severity.map(protocol_number),
        code: diagnostic.code.map(|code| match code {
            lsp::NumberOrString::Number(value) => value.to_string(),
            lsp::NumberOrString::String(value) => value,
        }),
        source: diagnostic.source,
        message: diagnostic.message,
    })
}

fn map_document_symbols(response: Option<lsp::DocumentSymbolResponse>) -> Vec<LspSymbol> {
    match response {
        Some(lsp::DocumentSymbolResponse::Nested(symbols)) => {
            let mut out = Vec::new();
            for symbol in symbols {
                flatten_document_symbol(symbol, &mut out);
            }
            out
        }
        Some(lsp::DocumentSymbolResponse::Flat(symbols)) => symbols
            .into_iter()
            .map(|symbol| LspSymbol {
                name: symbol.name,
                kind: protocol_number(symbol.kind),
                relative_path: None,
                range: Some(map_range(symbol.location.range)),
                selection_range: None,
            })
            .collect(),
        None => Vec::new(),
    }
}

fn flatten_document_symbol(symbol: lsp::DocumentSymbol, out: &mut Vec<LspSymbol>) {
    out.push(LspSymbol {
        name: symbol.name,
        kind: protocol_number(symbol.kind),
        relative_path: None,
        range: Some(map_range(symbol.range)),
        selection_range: Some(map_range(symbol.selection_range)),
    });
    for child in symbol.children.unwrap_or_default() {
        flatten_document_symbol(child, out);
    }
}

fn map_semantic_tokens(tokens: lsp::SemanticTokensResult) -> Option<LspSemanticTokens> {
    match tokens {
        lsp::SemanticTokensResult::Tokens(tokens) => Some(LspSemanticTokens {
            result_id: tokens.result_id,
            data: tokens
                .data
                .into_iter()
                .flat_map(|token| {
                    [
                        token.delta_line,
                        token.delta_start,
                        token.length,
                        token.token_type,
                        token.token_modifiers_bitset,
                    ]
                })
                .collect(),
        }),
        lsp::SemanticTokensResult::Partial(_) => None,
    }
}

fn map_signature_help(help: lsp::SignatureHelp) -> LspSignatureHelp {
    LspSignatureHelp {
        signatures: help
            .signatures
            .into_iter()
            .map(|signature| signature.label)
            .collect(),
        active_signature: help.active_signature,
        active_parameter: help.active_parameter,
    }
}

fn normalize_workspace_edit(edit: lsp::WorkspaceEdit) -> Result<WorkspaceEdit> {
    let mut edits = Vec::new();
    if let Some(changes) = edit.changes {
        for (uri, text_edits) in changes {
            let Some(relative_path) = uri_to_relative(&uri) else {
                return Err(LspError::EditOutsideWorkspace(PathBuf::from(
                    uri.as_str().to_string(),
                )));
            };
            for edit in text_edits {
                edits.push(ace_workspace::WorkspaceTextEdit {
                    relative_path: relative_path.clone(),
                    range: Some(map_range(edit.range).into()),
                    new_text: edit.new_text,
                });
            }
        }
    }
    Ok(WorkspaceEdit { edits })
}

fn map_range(range: lsp::Range) -> crate::types::LspRange {
    crate::types::LspRange {
        start: LspPosition {
            line: range.start.line,
            character: range.start.character,
        },
        end: LspPosition {
            line: range.end.line,
            character: range.end.character,
        },
    }
}

fn map_range_to_lsp(range: crate::types::LspRange) -> lsp::Range {
    lsp::Range {
        start: lsp::Position {
            line: range.start.line,
            character: range.start.character,
        },
        end: lsp::Position {
            line: range.end.line,
            character: range.end.character,
        },
    }
}

fn protocol_number<T: serde::Serialize>(value: T) -> u32 {
    serde_json::to_value(value)
        .ok()
        .and_then(|value| value.as_u64())
        .and_then(|value| u32::try_from(value).ok())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transport::FakeLspTransport;
    use serde_json::json;

    #[tokio::test]
    async fn sync_buffer_sends_did_open_when_transport_exists() {
        let temp = tempfile::tempdir().expect("tempdir");
        let manager = LspSessionManager::new(LspToolRegistry::in_memory());
        let transport = Arc::new(FakeLspTransport::default());
        manager.register_transport(temp.path(), "rust-analyzer", transport.clone());
        let result = manager
            .sync_buffer(BufferSyncRequest {
                workspace_root: temp.path().to_path_buf(),
                relative_path: "src/main.rs".to_string(),
                language_id: Some("rust".to_string()),
                contents: "fn main() {}".to_string(),
                version: 1,
            })
            .await
            .expect("sync");
        assert_eq!(result.server.expect("server").server_id, "rust-analyzer");
        assert_eq!(transport.notifications()[0].0, "textDocument/didOpen");
    }

    #[tokio::test]
    async fn completion_maps_lsp_items() {
        let temp = tempfile::tempdir().expect("tempdir");
        let manager = LspSessionManager::new(LspToolRegistry::in_memory());
        manager.register_transport(
            temp.path(),
            "rust-analyzer",
            Arc::new(FakeLspTransport::with_responses(vec![json!([
                {"label":"println","kind":3,"detail":"macro"}
            ])])),
        );
        let items = manager
            .completion(LspRequest {
                workspace_root: temp.path().to_path_buf(),
                relative_path: "main.rs".to_string(),
                language_id: Some("rust".to_string()),
                position: Some(LspPosition {
                    line: 0,
                    character: 0,
                }),
                range: None,
                query: None,
                new_name: None,
            })
            .await
            .expect("completion");
        assert_eq!(items[0].label, "println");
    }

    #[test]
    fn applies_workspace_edit_inside_root() {
        let temp = tempfile::tempdir().expect("tempdir");
        std::fs::write(temp.path().join("lib.rs"), "fn main() {}\n").expect("write");
        let manager = LspSessionManager::new(LspToolRegistry::in_memory());
        let result = manager
            .apply_workspace_edit(
                temp.path(),
                &WorkspaceEdit {
                    edits: vec![ace_workspace::WorkspaceTextEdit {
                        relative_path: "lib.rs".to_string(),
                        range: Some(ace_workspace::WorkspaceTextRange {
                            start_line: 0,
                            start_character: 3,
                            end_line: 0,
                            end_character: 7,
                        }),
                        new_text: "run".to_string(),
                    }],
                },
            )
            .expect("edit");
        assert_eq!(result.written_files.len(), 1);
        assert_eq!(
            std::fs::read_to_string(temp.path().join("lib.rs")).expect("read"),
            "fn run() {}\n"
        );
    }
}

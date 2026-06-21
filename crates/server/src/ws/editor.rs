use super::{WsApiState, WsDispatchError};
use ace_git::ProcessRunner;
use ace_protocol::{
    editor::{
        BufferCloseRequest, BufferSyncRequest, DiagnosticsSubscribeRequest, LspRequest,
        WorkspaceSymbolsRequest,
    },
    ws::methods,
};
use ace_terminal::PtyAdapter;
use serde_json::Value;
use tokio::sync::mpsc;

impl<R: ProcessRunner, A: PtyAdapter> WsApiState<R, A> {
    pub(super) async fn dispatch_editor_method(
        &self,
        method: &str,
        payload: Value,
    ) -> Result<Value, WsDispatchError> {
        match method {
            methods::EDITOR_BUFFER_SYNC => {
                self.editor_json::<BufferSyncRequest, _, _, _>(
                    payload,
                    |service, request| async move { service.sync_buffer(request).await },
                )
                .await
            }
            methods::EDITOR_BUFFER_CLOSE => {
                self.editor_json::<BufferCloseRequest, _, _, _>(
                    payload,
                    |service, request| async move { service.close_buffer(request).await },
                )
                .await
            }
            methods::EDITOR_COMPLETION => {
                self.editor_json::<LspRequest, _, _, _>(payload, |service, request| async move {
                    service.completion(request).await
                })
                .await
            }
            methods::EDITOR_HOVER => {
                self.editor_json::<LspRequest, _, _, _>(payload, |service, request| async move {
                    service.hover(request).await
                })
                .await
            }
            methods::EDITOR_DEFINITION => {
                self.editor_json::<LspRequest, _, _, _>(payload, |service, request| async move {
                    service.definition(request).await
                })
                .await
            }
            methods::EDITOR_REFERENCES => {
                self.editor_json::<LspRequest, _, _, _>(payload, |service, request| async move {
                    service.references(request).await
                })
                .await
            }
            methods::EDITOR_RENAME => {
                self.editor_json::<LspRequest, _, _, _>(payload, |service, request| async move {
                    service.rename(request).await
                })
                .await
            }
            methods::EDITOR_FORMATTING => {
                self.editor_json::<LspRequest, _, _, _>(payload, |service, request| async move {
                    service.formatting(request).await
                })
                .await
            }
            methods::EDITOR_CODE_ACTIONS => {
                self.editor_json::<LspRequest, _, _, _>(payload, |service, request| async move {
                    service.code_actions(request).await
                })
                .await
            }
            methods::EDITOR_DOCUMENT_SYMBOLS => {
                self.editor_json::<LspRequest, _, _, _>(payload, |service, request| async move {
                    service.document_symbols(request).await
                })
                .await
            }
            methods::EDITOR_WORKSPACE_SYMBOLS => {
                self.editor_json::<WorkspaceSymbolsRequest, _, _, _>(
                    payload,
                    |service, request| async move { service.workspace_symbols(request).await },
                )
                .await
            }
            methods::EDITOR_SEMANTIC_TOKENS => {
                self.editor_json::<LspRequest, _, _, _>(payload, |service, request| async move {
                    service.semantic_tokens(request).await
                })
                .await
            }
            methods::EDITOR_SIGNATURE_HELP => {
                self.editor_json::<LspRequest, _, _, _>(payload, |service, request| async move {
                    service.signature_help(request).await
                })
                .await
            }
            _ => Err(WsDispatchError::UnknownMethod(method.to_string())),
        }
    }

    pub(super) async fn subscribe_editor_diagnostics(
        &self,
        payload: Value,
        _outbound: Option<mpsc::Sender<String>>,
    ) -> Result<Value, WsDispatchError> {
        let _request: DiagnosticsSubscribeRequest = serde_json::from_value(payload)?;
        Ok(serde_json::json!({ "subscribed": true, "topic": "editor.diagnostics" }))
    }
}

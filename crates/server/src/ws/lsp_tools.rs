use super::{WsApiState, WsDispatchError};
use ace_git::ProcessRunner;
use ace_protocol::{
    lsp_tools::{LspToolIdRequest, LspToolsListRequest, LspToolsSearchRequest},
    ws::methods,
};
use ace_terminal::PtyAdapter;
use serde_json::Value;

impl<R: ProcessRunner, A: PtyAdapter> WsApiState<R, A> {
    pub(super) async fn dispatch_lsp_tools_method(
        &self,
        method: &str,
        payload: Value,
    ) -> Result<Value, WsDispatchError> {
        match method {
            methods::LSP_TOOLS_LIST => {
                self.editor_json::<LspToolsListRequest, _, _, _>(
                    payload,
                    |service, request| async move { service.list_tools(request).await },
                )
                .await
            }
            methods::LSP_TOOLS_SEARCH => {
                self.editor_json::<LspToolsSearchRequest, _, _, _>(
                    payload,
                    |service, request| async move { service.search_tools(request).await },
                )
                .await
            }
            methods::LSP_TOOLS_STATUS => {
                self.editor_json::<LspToolIdRequest, _, _, _>(
                    payload,
                    |service, request| async move { service.tool_status(request).await },
                )
                .await
            }
            methods::LSP_TOOLS_INSTALL => {
                self.editor_json::<LspToolIdRequest, _, _, _>(
                    payload,
                    |service, request| async move { service.install_tool(request).await },
                )
                .await
            }
            methods::LSP_TOOLS_UPSERT_CUSTOM => {
                self.editor_json::<ace_lsp::LspToolDefinition, _, _, _>(
                    payload,
                    |service, request| async move { service.upsert_custom_tool(request).await },
                )
                .await
            }
            methods::LSP_TOOLS_UNINSTALL_CUSTOM => {
                self.editor_json::<LspToolIdRequest, _, _, _>(
                    payload,
                    |service, request| async move { service.uninstall_custom_tool(request).await },
                )
                .await
            }
            _ => Err(WsDispatchError::UnknownMethod(method.to_string())),
        }
    }
}

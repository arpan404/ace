use super::{WsApiState, WsDispatchError};
use ace_git::ProcessRunner;
use ace_protocol::{workspace::WorkspaceApplyEditRequest, ws::methods};
use ace_terminal::PtyAdapter;
use serde_json::Value;
use tokio::sync::mpsc;

impl<R: ProcessRunner, A: PtyAdapter> WsApiState<R, A> {
    pub(super) async fn dispatch_workspace_method(
        &self,
        method: &str,
        payload: Value,
    ) -> Result<Value, WsDispatchError> {
        match method {
            methods::WORKSPACE_APPLY_EDIT => {
                self.editor_json::<WorkspaceApplyEditRequest, _, _, _>(
                    payload,
                    |service, request| async move { service.apply_workspace_edit(request).await },
                )
                .await
            }
            _ => Err(WsDispatchError::UnknownMethod(method.to_string())),
        }
    }

    pub(super) async fn subscribe_workspace_file_events(
        &self,
        payload: Value,
        _outbound: Option<mpsc::Sender<String>>,
    ) -> Result<Value, WsDispatchError> {
        let _request: ace_protocol::workspace::WorkspaceFileEventsSubscribeRequest =
            serde_json::from_value(payload)?;
        Ok(serde_json::json!({ "subscribed": true, "topic": "workspace.file_events" }))
    }
}

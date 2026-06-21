use super::{WsApiState, WsDispatchError};
use ace_git::ProcessRunner;
use ace_protocol::{
    checkpoint::{
        CheckpointFullThreadDiffRequest, CheckpointRequestRevertRequest, CheckpointTurnDiffRequest,
    },
    ws::methods,
};
use serde_json::Value;

impl<R: ProcessRunner> WsApiState<R> {
    pub(super) async fn dispatch_checkpoint_method(
        &self,
        method: &str,
        payload: Value,
    ) -> Result<Value, WsDispatchError> {
        match method {
            methods::CHECKPOINTS_TURN_DIFF => {
                self.checkpoint_json::<CheckpointTurnDiffRequest, _, _, _>(
                    payload,
                    |service, request| async move { service.turn_diff(request).await },
                )
                .await
            }
            methods::CHECKPOINTS_FULL_THREAD_DIFF => {
                self.checkpoint_json::<CheckpointFullThreadDiffRequest, _, _, _>(
                    payload,
                    |service, request| async move { service.full_thread_diff(request).await },
                )
                .await
            }
            methods::CHECKPOINTS_REQUEST_REVERT => {
                self.checkpoint_json::<CheckpointRequestRevertRequest, _, _, _>(
                    payload,
                    |service, request| async move { service.request_revert(request).await },
                )
                .await
            }
            _ => Err(WsDispatchError::UnknownMethod(method.to_string())),
        }
    }
}

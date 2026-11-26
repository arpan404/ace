// SPDX-License-Identifier: Apache-2.0
//! Pi's `Session` methods: send with the native command admissions and the steer fence,
//! interrupt's three requests, a dialog's answer, the close, and the model/effort selection that
//! reopens. Ported from `session.ts:383`–`:508` and `native-session.ts:428`–`:555`.

use std::sync::Arc;

use ace_adapter_api::{
    AdapterApiError, CloseReason, Delivery, InputSource, InterruptTarget, Reopen, SendInput,
    Session, assert_steer_target,
};
use ace_core::Key;
use ace_json::{JsString, Map, Value};
use ace_protocol::generated::{ExecutionSelection, GoalChange, InteractionResolution};
use futures::future::LocalBoxFuture;

use super::command::{content_part_values, native_command_inputs};
use super::inner::Inner;
use super::open::PiSessionError;
use super::resolve::{PiDialogError, dialog_response};
use crate::input::{PiInput, pi_input};

/// `clear_queue`, `abort` and `abort_bash`: the interrupt's three requests (`session.ts:429`–`:431`).
const INTERRUPT_COMMANDS: [&str; 3] = ["clear_queue", "abort", "abort_bash"];

/// One open Pi session, as the engine holds it.
pub struct PiSession {
    pub(crate) inner: Arc<Inner>,
    native_id: String,
    native_file: String,
    root_key: String,
    control_secret: String,
    model: Option<String>,
    effort: Option<String>,
}

impl PiSession {
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn new(
        inner: Arc<Inner>,
        native_id: String,
        native_file: String,
        root_key: String,
        control_secret: String,
        model: Option<String>,
        effort: Option<String>,
    ) -> Self {
        Self {
            inner,
            native_id,
            native_file,
            root_key,
            control_secret,
            model,
            effort,
        }
    }

    /// The native session file (`PiSession.nativeSessionFile` in the TypeScript).
    pub fn native_session_file(&self) -> &str {
        &self.native_file
    }

    async fn request(&self, command: &str, params: Map) -> Result<String, PiSessionError> {
        self.inner.request(command, &params).await
    }

    /// `send` up to the first write (`session.ts:394`–`:415`): the session check, the parts as
    /// raw JSON, `nativeCommandInputs`, `piInput`, and the steer fence before the first prompt.
    fn prepare_send(&self, input: &SendInput<'_>) -> Result<PreparedSend, AdapterApiError> {
        // A closed or busy session refuses before anything is built, as `check()` does.
        self.inner
            .check()
            .map_err(|error| AdapterApiError::InputRejected(error.to_string()))?;
        let values = content_part_values(input.input)
            .map_err(|error| AdapterApiError::InputRejected(error.to_string()))?;
        if matches!(input.origin, Some(InputSource::Ace)) {
            let content = pi_input(&values)
                .map_err(|error| AdapterApiError::InputRejected(error.to_string()))?;
            let encoded = base64::Engine::encode(
                &base64::engine::general_purpose::STANDARD,
                content.message.as_bytes(),
            );
            return Ok(PreparedSend::Ace(format!(
                "/ace-context {} {encoded}",
                self.control_secret
            )));
        }
        // Validate every admission before the first one can reach the harness.
        let inputs = native_command_inputs(&values)
            .map_err(|error| AdapterApiError::InputRejected(error.to_string()))?;
        let streaming = match input.delivery {
            Delivery::Steer => "steer",
            Delivery::Queue => "followUp",
        };
        let mut prepared = Vec::with_capacity(inputs.len());
        for content in inputs {
            let content = pi_input(&content)
                .map_err(|error| AdapterApiError::InputRejected(error.to_string()))?;
            prepared.push((content, streaming));
        }
        // Before the first prompt only: once one is taken, the rest belong with it.
        assert_steer_target(input.delivery, input.fence)?;
        Ok(PreparedSend::Prompts(prepared))
    }

    async fn write_send(&self, prepared: PreparedSend) -> Result<(), AdapterApiError> {
        match prepared {
            PreparedSend::Ace(message) => self
                .request("prompt", prompt_params_of(message))
                .await
                .map(|_| ())
                .map_err(|error| send_error(error, 0, true)),
            PreparedSend::Prompts(prompts) => {
                let mut accepted = 0_usize;
                for (content, streaming) in prompts {
                    match self
                        .request("prompt", prompt_params(&content, Some(streaming)))
                        .await
                    {
                        Ok(_) => accepted += 1,
                        Err(error) => return Err(send_error(error, accepted, true)),
                    }
                }
                Ok(())
            }
        }
    }
}

/// One send after admission: what the future writes, with nothing borrowed.
enum PreparedSend {
    /// ace's own input, already marked as context.
    Ace(String),
    /// One admission per native command, in order.
    Prompts(Vec<(PiInput, &'static str)>),
}

/// `send`'s catch (`session.ts:416`–`:423`): a refusal before anything was taken is the provider
/// turning the send down; a refusal after acceptance may have run and is never retryable
/// (`AdapterApiError::retryable`), so it crosses as a transport failure.
fn send_error(error: PiSessionError, accepted: usize, requested: bool) -> AdapterApiError {
    if accepted == 0 && (!requested || matches!(error, PiSessionError::Refused(_))) {
        return AdapterApiError::InputRejected(error.to_string());
    }
    match error {
        PiSessionError::Refused(message) => AdapterApiError::Transport(message),
        other => other.into_adapter(),
    }
}

/// The prompt a send writes, with Pi's images after the message (`input.ts:26`).
fn prompt_params(input: &PiInput, streaming: Option<&str>) -> Map {
    let mut params = Map::with_capacity(3);
    params.insert(
        "message",
        Value::String(JsString::from(input.message.as_str())),
    );
    if !input.images.is_empty() {
        params.insert(
            "images",
            Value::Array(
                input
                    .images
                    .iter()
                    .map(|image| {
                        let mut map = Map::with_capacity(3);
                        map.insert("type", Value::from("image"));
                        map.insert("data", Value::String(JsString::from(image.data.as_str())));
                        map.insert(
                            "mimeType",
                            Value::String(JsString::from(image.mime_type.as_str())),
                        );
                        Value::Object(map)
                    })
                    .collect::<Vec<_>>()
                    .into(),
            ),
        );
    }
    if let Some(streaming) = streaming {
        params.insert("streamingBehavior", Value::from(streaming));
    }
    params
}

fn prompt_params_of(message: String) -> Map {
    let mut params = Map::with_capacity(1);
    params.insert("message", Value::from(message.as_str()));
    params
}

impl Session for PiSession {
    fn native_session_id(&self) -> &str {
        &self.native_id
    }

    fn session_confirmed(&self) -> bool {
        true
    }

    /// Pi takes `--model`, `--thinking` and the access mode at launch only, so a changed
    /// selection is a fresh connection (the engine's `reopen`).
    fn configure(
        &self,
        selection: ExecutionSelection,
    ) -> LocalBoxFuture<'_, Result<Option<Reopen>, AdapterApiError>> {
        let model = selection.model.as_ref().map(|model| model.to_string());
        let effort = selection
            .options
            .get("effort")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned);
        let changed = model != self.model || effort != self.effort;
        Box::pin(async move { Ok(changed.then_some(Reopen::Reopen)) })
    }

    fn set_model(&self, _model: String) -> LocalBoxFuture<'_, Result<(), AdapterApiError>> {
        Box::pin(async move {
            Err(AdapterApiError::InputRejected(
                "Provider model selection unavailable".to_owned(),
            ))
        })
    }

    fn set_mode(&self, mode: String) -> LocalBoxFuture<'_, Result<(), AdapterApiError>> {
        Box::pin(async move {
            Err(AdapterApiError::InputRejected(format!(
                "Pi cannot run the permission mode {mode}"
            )))
        })
    }

    fn set_goal(&self, _change: GoalChange) -> LocalBoxFuture<'_, Result<(), AdapterApiError>> {
        Box::pin(async move {
            Err(AdapterApiError::InputRejected(
                "Provider goals unavailable".to_owned(),
            ))
        })
    }

    fn clear_goal(&self) -> LocalBoxFuture<'_, Result<(), AdapterApiError>> {
        Box::pin(async move {
            Err(AdapterApiError::InputRejected(
                "Provider goals unavailable".to_owned(),
            ))
        })
    }

    fn send(&self, input: SendInput<'_>) -> LocalBoxFuture<'_, Result<(), AdapterApiError>> {
        // Admission runs now, in the caller's synchronous turn, so the future owns every value
        // it needs and the fence is read in one step with the first write being queued.
        let prepared = self.prepare_send(&input);
        Box::pin(async move {
            match prepared {
                Err(error) => Err(error),
                Ok(prepared) => self.write_send(prepared).await,
            }
        })
    }

    fn interrupt(
        &self,
        target: InterruptTarget,
    ) -> LocalBoxFuture<'_, Result<(), AdapterApiError>> {
        Box::pin(async move {
            self.inner
                .check()
                .map_err(|error| AdapterApiError::InputRejected(error.to_string()))?;
            if target
                .agent
                .as_ref()
                .is_some_and(|agent| *agent != self.root_key)
            {
                return Err(AdapterApiError::InputRejected(
                    "Pi has no native child interrupt".to_owned(),
                ));
            }
            for command in INTERRUPT_COMMANDS {
                self.request(command, Map::new())
                    .await
                    .map_err(PiSessionError::into_adapter)?;
            }
            Ok(())
        })
    }

    fn resolve(
        &self,
        interaction: Key,
        resolution: InteractionResolution,
    ) -> LocalBoxFuture<'_, Result<(), AdapterApiError>> {
        Box::pin(async move {
            self.inner
                .check_open()
                .map_err(|error| AdapterApiError::InputRejected(error.to_string()))?;
            let key = JsString::from(interaction.as_str());
            let dialog = self.inner.core.peek_dialog(&key).ok_or_else(|| {
                AdapterApiError::InputRejected(PiDialogError::NotPending.to_string())
            })?;
            let value = ace_json::parse(&dialog)
                .map_err(|_| AdapterApiError::InputRejected(PiSessionError::State.to_string()))?;
            // Validate before reserving, so a bad answer leaves the dialog pending.
            let response = dialog_response(&value, &resolution)
                .map_err(|error| AdapterApiError::InputRejected(error.to_string()))?;
            // Reserve before writing so concurrent devices cannot answer twice.
            if !self.inner.core.take_dialog(&key) {
                return Err(AdapterApiError::InputRejected(
                    PiDialogError::NotPending.to_string(),
                ));
            }
            if let Err(error) = self.inner.write(&response, true).await {
                self.inner.fatal();
                return Err(error.into_adapter());
            }
            Ok(())
        })
    }

    fn stop_task(&self, _task: Key) -> LocalBoxFuture<'_, Result<(), AdapterApiError>> {
        Box::pin(async move {
            Err(AdapterApiError::InputRejected(
                "Pi has no individual native background-task control".to_owned(),
            ))
        })
    }

    fn close(&self, _reason: CloseReason) -> LocalBoxFuture<'_, Result<(), AdapterApiError>> {
        Box::pin(async move {
            self.inner
                .close(true)
                .await
                .map_err(PiSessionError::into_adapter)
        })
    }
}

#[cfg(test)]
mod tests {
    // `send`'s catch, case for case against `session.ts:416`–`:423`. The second case is the P1
    // review's: a refusal after the first admission must never be retryable.
    use super::*;

    #[test]
    fn a_refusal_before_acceptance_is_retryable_and_one_after_it_is_not() {
        let first = send_error(PiSessionError::Refused("No model".to_owned()), 0, true);
        assert!(matches!(first, AdapterApiError::InputRejected(_)));
        assert!(first.retryable());

        let second = send_error(PiSessionError::Refused("No model".to_owned()), 1, true);
        assert!(matches!(second, AdapterApiError::Transport(_)));
        assert!(!second.retryable());

        // An uncertain failure after acceptance stays uncertain.
        let uncertain = send_error(
            PiSessionError::Uncertain("Pi command timed out; execution uncertain".to_owned()),
            1,
            true,
        );
        assert!(!uncertain.retryable());
    }

    #[test]
    fn an_uncertain_failure_before_requesting_stays_uncertain_and_a_validation_one_is_retryable() {
        let validation = send_error(
            PiSessionError::Input(crate::input::PiInputError::FrameBudget),
            0,
            false,
        );
        assert!(validation.retryable());
        let uncertain = send_error(PiSessionError::Uncertain("write EPIPE".to_owned()), 0, true);
        assert!(!uncertain.retryable());
        // A close that began before the write is a refusal: nothing reached Pi.
        let closed = send_error(PiSessionError::Refused("Pi RPC closed".to_owned()), 0, true);
        assert!(closed.retryable());
    }
}

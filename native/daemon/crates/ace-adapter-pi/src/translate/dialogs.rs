// SPDX-License-Identifier: Apache-2.0
//! Pi dialog requests, mirroring `dialogs.ts`.

use serde::Serialize;

/// One question option inside a dialog request.
#[derive(Debug, Clone, Serialize)]
pub struct DialogOption {
    pub id: String,
    pub label: String,
}

/// One question inside a dialog request.
#[derive(Debug, Clone, Serialize)]
pub struct DialogQuestion {
    pub id: String,
    pub text: String,
    pub options: Vec<DialogOption>,
    #[serde(rename = "multiSelect")]
    pub multi_select: bool,
    #[serde(rename = "allowOther")]
    pub allow_other: bool,
    pub secret: bool,
}

/// The interaction request for a Pi dialog.
#[derive(Debug, Clone, Serialize)]
pub struct DialogRequest {
    pub kind: String,
    pub questions: Vec<DialogQuestion>,
}

/// Validated Pi dialog fields, mirroring the `Dialog` zod schema.
#[derive(Debug, Clone)]
pub struct ValidDialog {
    pub id: String,
    pub method: String,
    pub title: String,
    pub message: Option<String>,
    pub options: Option<Vec<String>>,
    pub timeout: Option<f64>,
    pub prefill: Option<String>,
}

/// Validate a dialog envelope, mirroring the `Dialog` zod schema.
pub fn parse_dialog(map: &super::native::Fields) -> Result<ValidDialog, super::PiError> {
    use super::native::{field, parse_array, raw_as_str, str_field};
    let type_name = str_field(map, "type");
    if type_name != "extension_ui_request" {
        return Err(super::PiError::InvalidDialog);
    }
    let id = str_field(map, "id");
    if id.is_empty() {
        return Err(super::PiError::InvalidDialog);
    }
    let method = str_field(map, "method");
    if !super::native::is_blocking_dialog_method(&method) {
        return Err(super::PiError::InvalidDialog);
    }
    let title = match field(map, "title") {
        Some(raw) => match raw_as_str(raw) {
            Some(value) => {
                if value.is_empty() {
                    return Err(super::PiError::InvalidDialog);
                }
                value
            }
            None => return Err(super::PiError::InvalidDialog),
        },
        None => "Pi extension".to_owned(),
    };
    let message = match field(map, "message") {
        Some(raw) => Some(raw_as_str(raw).ok_or(super::PiError::InvalidDialog)?),
        None => None,
    };
    let options = match field(map, "options") {
        Some(raw) => {
            let items = parse_array(raw).ok_or(super::PiError::InvalidDialog)?;
            let mut out = Vec::new();
            for item in &items {
                let value = raw_as_str(item).ok_or(super::PiError::InvalidDialog)?;
                out.push(value);
            }
            Some(out)
        }
        None => None,
    };
    let timeout = match field(map, "timeout") {
        Some(raw) => {
            let value: f64 = super::native::raw_as_f64(raw).ok_or(super::PiError::InvalidDialog)?;
            if !value.is_finite() || value < 0.0 {
                return Err(super::PiError::InvalidDialog);
            }
            Some(value)
        }
        None => None,
    };
    let prefill = match field(map, "prefill") {
        Some(raw) => Some(raw_as_str(raw).ok_or(super::PiError::InvalidDialog)?),
        None => None,
    };
    Ok(ValidDialog {
        id,
        method,
        title,
        message,
        options,
        timeout,
        prefill,
    })
}

/// Build the request for a validated dialog, mirroring `dialogRequest`.
pub fn dialog_request(dialog: &ValidDialog) -> DialogRequest {
    if dialog.method == "confirm" {
        let mut text = dialog.title.clone();
        if let Some(message) = &dialog.message {
            text.push('\n');
            text.push_str(message);
        }
        return DialogRequest {
            kind: "question".to_owned(),
            questions: vec![DialogQuestion {
                id: dialog.id.clone(),
                text,
                options: vec![
                    DialogOption {
                        id: "yes".to_owned(),
                        label: "Yes".to_owned(),
                    },
                    DialogOption {
                        id: "no".to_owned(),
                        label: "No".to_owned(),
                    },
                ],
                multi_select: false,
                allow_other: false,
                secret: false,
            }],
        };
    }
    let mut text = dialog.title.clone();
    if let Some(prefill) = &dialog.prefill {
        text.push('\n');
        text.push_str(prefill);
    }
    let options = match &dialog.options {
        Some(list) => list
            .iter()
            .enumerate()
            .map(|(index, label)| DialogOption {
                id: index.to_string(),
                label: label.clone(),
            })
            .collect(),
        None => Vec::new(),
    };
    DialogRequest {
        kind: "question".to_owned(),
        questions: vec![DialogQuestion {
            id: dialog.id.clone(),
            text,
            options,
            multi_select: false,
            allow_other: dialog.method != "select",
            secret: false,
        }],
    }
}

impl super::PiTranslator {
    pub(super) fn on_dialog(
        &mut self,
        seq: u64,
        map: &super::native::Fields,
        data: &ace_json::Raw,
        now: i64,
        out: &mut Vec<ace_core::Fact>,
    ) -> bool {
        use super::context_usage::pi_context_sample;
        use super::facts::{
            ContextSampleFact, InteractionOpened, NativeIdDraft, NativeIdUpsert, RawPayload,
            push_fact,
        };
        use super::native::{is_blocking_dialog_method, opt_string_field, raw_type_of, str_field};
        use super::turn_boundary::pi_turn_boundary;
        let method = str_field(map, "method");
        let message_value = opt_string_field(map, "message");
        if method == "notify" {
            if let Some(entry) = pi_turn_boundary(message_value.as_deref()) {
                if let Some(answer) = self.last_answer.clone() {
                    push_fact(
                        out,
                        "item.upsert",
                        &NativeIdUpsert {
                            fact_type: "item.upsert".to_owned(),
                            agent: self.agent.clone(),
                            item: answer,
                            draft: NativeIdDraft {
                                draft_type: "message".to_owned(),
                                native_id: entry,
                            },
                        },
                    );
                }
                return false;
            }
            if let Some(sample) = pi_context_sample(message_value.as_deref()) {
                push_fact(
                    out,
                    "context.sample",
                    &ContextSampleFact {
                        fact_type: "context.sample".to_owned(),
                        agent: self.agent.clone(),
                        used_tokens: sample.tokens,
                        window_tokens: sample.context_window,
                        model: sample.model,
                    },
                );
                return false;
            }
        }
        match parse_dialog(map) {
            Ok(dialog) => {
                if self.dialogs.contains_key(&dialog.id) {
                    return false;
                }
                let due = dialog
                    .timeout
                    .map(|timeout| now.saturating_add(timeout as i64));
                self.dialogs.insert(dialog.id.clone(), due);
                if let Some(due_value) = due
                    && self.deadline.is_none_or(|current| due_value < current)
                {
                    self.deadline = Some(due_value);
                }
                let request = dialog_request(&dialog);
                push_fact(
                    out,
                    "interaction.opened",
                    &InteractionOpened {
                        fact_type: "interaction.opened".to_owned(),
                        agent: self.agent.clone(),
                        interaction: dialog.id,
                        blocking: true,
                        request,
                        raw: vec![RawPayload {
                            payload_type: raw_type_of(data, "unknown"),
                            data,
                        }],
                    },
                );
                true
            }
            Err(_) => {
                if is_blocking_dialog_method(&method) {
                    out.extend(self.unanswerable(seq, data));
                    true
                } else if method != "notify" {
                    false
                } else {
                    let notify_type = str_field(map, "notifyType");
                    let level = match notify_type.as_str() {
                        "error" => "error",
                        "warning" => "warning",
                        _ => "info",
                    };
                    let text = {
                        let message_text = str_field(map, "message");
                        if message_text.is_empty() {
                            "Pi extension notification".to_owned()
                        } else {
                            message_text
                        }
                    };
                    if let Some(fact) = self.notice(seq, data, &text, level) {
                        out.push(fact);
                    }
                    true
                }
            }
        }
    }
}

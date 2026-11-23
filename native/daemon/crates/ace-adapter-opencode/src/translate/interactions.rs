// SPDX-License-Identifier: Apache-2.0
//! Native interactions (`interactions.ts`). Approvals, questions, and
//! elicitations open through the translator and resolve from answers.

use crate::translate::approval_target::approval_target;
use crate::translate::content::tool_key;
use crate::translate::data::{RawPayload, arr_in, fields, get, raw, s_in, truthy};
use crate::translate::requests::{
    Request, RequestKind, approval_request, form_request, request_kind,
};
use crate::translate::resolve::validate_resolution;
use crate::translate::state::{NativeState, Out, Pending, StateError};
use serde::Serialize;
use ace_json::{Map, Value};
use std::collections::BTreeMap;

/// An approval, question, or elicitation the person must answer.
#[derive(Serialize)]
struct InteractionOpened<'a> {
    #[serde(rename = "type")]
    typ: &'static str,
    agent: &'a str,
    interaction: String,
    blocking: bool,
    request: Request<'a>,
    #[serde(skip_serializing_if = "Option::is_none")]
    item: Option<String>,
    raw: Vec<RawPayload<'a>>,
}

/// An answered or withdrawn interaction.
#[derive(Serialize)]
struct InteractionClosed<'a> {
    #[serde(rename = "type")]
    typ: &'static str,
    interaction: String,
    state: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    resolution: Option<Resolution<'a>>,
}

/// The person's answer, by request kind.
#[derive(Serialize)]
#[serde(tag = "kind")]
enum Resolution<'a> {
    #[serde(rename = "approval")]
    Approval {
        #[serde(rename = "optionId")]
        option_id: &'a str,
        #[serde(skip_serializing_if = "Option::is_none")]
        message: Option<&'a str>,
    },
    #[serde(rename = "question")]
    Question {
        answers: BTreeMap<&'a str, Vec<&'a str>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        dismissed: Option<bool>,
        #[serde(skip_serializing_if = "Option::is_none")]
        feedback: Option<String>,
    },
    #[serde(rename = "elicitation")]
    Elicitation {
        action: &'static str,
        content: &'a Value,
    },
}

/// Open or resolve a native permission or form interaction.
pub fn interaction(
    state: &mut NativeState,
    typ: &str,
    p: &Map,
    evidence: &Value,
    out: &mut Out<'_>,
) -> Result<(), StateError> {
    let form: &Map = if typ == "form.created" {
        fields(get(p, "form"))
    } else {
        p
    };
    // The form's id, else the request's.
    let id = {
        let direct = s_in(form, "id");
        if direct.is_empty() {
            s_in(p, "requestID").to_owned()
        } else {
            direct.to_owned()
        }
    };
    let session = s_in(form, "sessionID").to_owned();
    let key = format!(
        "{}:{session}:{id}",
        if typ.starts_with("permission") {
            "permission"
        } else {
            "form"
        }
    );
    if id.is_empty() || !state.agents.contains_key(&session) {
        return Ok(());
    }
    if typ == "permission.asked" || typ == "form.created" {
        if state.pending.contains_key(&key) {
            return Ok(());
        }
        if state.pending.len() >= 1024 {
            return Err(StateError::Limit("interaction"));
        }
        let stored = ace_json::ser::to_string(form)?;
        state.pending.insert(
            key.clone(),
            Pending {
                session: session.clone(),
                data: ace_json::Raw::from_json(&stored)?,
                typ: typ.to_owned(),
                resolution: None,
            },
        );
        let source_value;
        let source = match form.get("source") {
            Some(source) if !matches!(source, Value::Null) => {
                source_value = source.clone();
                fields(&source_value)
            }
            _ => fields(get(fields(get(form, "metadata")), "tool")),
        };
        let item = if s_in(source, "type") == "tool" || truthy(get(source, "id")) {
            Some(tool_key(
                &session,
                s_in(source, "messageID"),
                s_in(source, "id"),
            ))
        } else {
            None
        };
        // Owned answers hoisted past the request they are read in.
        let mut approval_input: Option<Value> = None;
        let mut approval_dir: Option<String> = None;
        if typ == "permission.asked" {
            if let Some(item) = &item
                && let Some(tool) = state.tools.get(item)
                && tool.name == s_in(form, "action")
            {
                approval_input = ace_json::parse(tool.input.get()).ok();
            }
            approval_dir = state
                .agents
                .get(&session)
                .map(|meta| meta.directory.clone());
        }
        let request = if typ == "permission.asked" {
            let metadata = fields(get(form, "metadata"));
            approval_request(
                s_in(form, "action"),
                approval_target(
                    s_in(form, "action"),
                    metadata,
                    approval_input.as_ref(),
                    approval_dir.as_deref(),
                ),
                arr_in(form, "resources")
                    .iter()
                    .map(|resource| match resource {
                        Value::String(resource) => resource.to_string(),
                        _ => String::new(),
                    })
                    .collect::<Vec<_>>()
                    .join(", "),
            )
        } else {
            form_request(form)
        };
        let agent = state.key(&session).to_owned();
        out.fact(&InteractionOpened {
            typ: "interaction.opened",
            agent: &agent,
            interaction: key,
            blocking: true,
            request,
            item,
            raw: vec![raw(typ, evidence, None)],
        })?;
        return Ok(());
    }
    let pending = match state.pending.shift_remove(&key) {
        Some(pending) => pending,
        None => return Ok(()),
    };
    let pending_data: Value = ace_json::parse(pending.data.get())?;
    let pending_fields = fields(&pending_data);
    let choice: Option<Value> = pending
        .resolution
        .as_ref()
        .map(|raw| ace_json::parse(raw.get()))
        .transpose()?;
    let choice_fields = choice.as_ref().map(fields);
    let feedback: Option<String> = match get(p, "message") {
        Value::String(message) => Some(String::from(message.clone())),
        _ => match choice_fields.as_ref() {
            Some(choice) => {
                let kind = s_in(choice, "kind");
                if kind == "question" && matches!(choice.get("dismissed"), Some(Value::Bool(true)))
                {
                    match choice.get("feedback") {
                        Some(Value::String(feedback)) => Some(slice_feedback(feedback)),
                        _ => None,
                    }
                } else if kind == "elicitation"
                    && !matches!(
                        choice.get("action"),
                        Some(Value::String(action)) if action == "accept"
                    )
                {
                    match fields(get(choice, "content")).get("feedback") {
                        Some(Value::String(feedback)) if !feedback.is_empty() => {
                            Some(String::from(feedback.clone()))
                        }
                        _ => None,
                    }
                } else {
                    None
                }
            }
            None => None,
        },
    };
    // Slicing feedback to 8,192 units must not split a character.
    let state_name = if typ == "form.cancelled" {
        "cancelled"
    } else {
        "resolved"
    };
    if typ == "permission.replied" {
        let reply = s_in(p, "reply");
        out.fact(&InteractionClosed {
            typ: "interaction.closed",
            interaction: key,
            state: state_name,
            resolution: Some(Resolution::Approval {
                option_id: reply,
                message: match get(p, "message") {
                    Value::String(message) => Some(message.as_str()),
                    _ => None,
                },
            }),
        })?;
        return Ok(());
    }
    if request_kind(pending_fields) == RequestKind::Question {
        let given = fields(get(p, "answer"));
        let mut answers: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
        for (field_key, value) in given {
            let values: Vec<&str> = match value {
                Value::String(one) => vec![one.as_str()],
                Value::Array(values) => values
                    .iter()
                    .map(|entry| match entry {
                        Value::String(entry) => entry.as_str(),
                        _ => "",
                    })
                    .collect(),
                _ => vec![],
            };
            answers.insert(field_key.as_str(), values);
        }
        let (dismissed, feedback) = if typ == "form.cancelled" {
            (
                Some(true),
                feedback.map(|feedback| slice_feedback(&feedback)),
            )
        } else {
            (None, None)
        };
        out.fact(&InteractionClosed {
            typ: "interaction.closed",
            interaction: key,
            state: state_name,
            resolution: Some(Resolution::Question {
                answers,
                dismissed,
                feedback,
            }),
        })?;
        return Ok(());
    }
    // A cancelled elicitation carries only the feedback that declined it.
    let cancelled: Option<Value> = if typ == "form.cancelled" {
        Some(match feedback {
            Some(feedback) => {
                let mut map = Map::new();
                map.insert(String::from("feedback"), Value::from(feedback));
                Value::Object(map)
            }
            None => Value::Object(Map::new()),
        })
    } else {
        None
    };
    out.fact(&InteractionClosed {
        typ: "interaction.closed",
        interaction: key,
        state: state_name,
        resolution: Some(Resolution::Elicitation {
            action: if typ == "form.cancelled" {
                "cancel"
            } else {
                "accept"
            },
            content: match cancelled.as_ref() {
                Some(content) => content,
                None => get(p, "answer"),
            },
        }),
    })?;
    Ok(())
}

/// Slice feedback to 8,192 units without splitting a character.
fn slice_feedback(feedback: &str) -> String {
    let mut units = 0;
    let mut end = 0;
    for (index, ch) in feedback.char_indices() {
        units += ch.len_utf16();
        if units > 8192 {
            break;
        }
        end = index + ch.len_utf8();
    }
    feedback[..end].to_owned()
}

/// Store a resolution announced while the interaction stays open.
pub fn store_resolution(
    state: &mut NativeState,
    key: &str,
    resolution: &Value,
) -> Result<(), StateError> {
    validate_resolution(resolution)?;
    let stored = ace_json::ser::to_string(resolution)?;
    match state.pending.get_mut(key) {
        Some(pending) => {
            pending.resolution = Some(ace_json::Raw::from_json(
                &stored,
            )?);
            Ok(())
        }
        None => Ok(()),
    }
}

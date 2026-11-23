// SPDX-License-Identifier: Apache-2.0
//! Native requests (`interactions.ts`: requests). Approvals name exact
//! native inputs; questions and forms render from the provider's schema.

use crate::translate::approval_target::ApprovalTarget;
use crate::translate::data::{Num, arr_in, fields, get, s_in};
use ace_json::{Map, Value};
use serde::Serialize;
use std::collections::BTreeMap;

/// A question option the person can pick.
#[derive(Serialize)]
pub(crate) struct QuestionOption<'a> {
    id: &'a str,
    label: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    description: Option<&'a str>,
}

/// A question the agent asks.
#[derive(Serialize)]
pub(crate) struct Question<'a> {
    id: &'a str,
    text: &'a str,
    header: &'a str,
    options: Vec<QuestionOption<'a>>,
    #[serde(rename = "multiSelect")]
    multi_select: bool,
    #[serde(rename = "allowOther")]
    allow_other: bool,
    secret: bool,
}

/// An approval option: allow once, for the project, or deny.
#[derive(Serialize)]
pub(crate) struct ApprovalOption {
    id: &'static str,
    label: &'static str,
    kind: &'static str,
}

/// An elicitation property the UI can render.
#[derive(Serialize)]
#[serde(tag = "type")]
pub(crate) enum Property<'a> {
    #[serde(rename = "string")]
    String {
        #[serde(skip_serializing_if = "Option::is_none")]
        title: Option<&'a str>,
        #[serde(skip_serializing_if = "Option::is_none")]
        description: Option<&'a str>,
        #[serde(skip_serializing_if = "Option::is_none", rename = "minLength")]
        min_length: Option<i64>,
        #[serde(skip_serializing_if = "Option::is_none", rename = "maxLength")]
        max_length: Option<i64>,
        #[serde(skip_serializing_if = "Option::is_none", rename = "enum")]
        values: Option<Vec<&'a str>>,
        #[serde(skip_serializing_if = "Option::is_none", rename = "enumNames")]
        value_names: Option<Vec<&'a str>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        default: Option<&'a str>,
    },
    #[serde(rename = "number")]
    Number {
        #[serde(skip_serializing_if = "Option::is_none")]
        title: Option<&'a str>,
        #[serde(skip_serializing_if = "Option::is_none")]
        description: Option<&'a str>,
        #[serde(skip_serializing_if = "Option::is_none")]
        minimum: Option<Num>,
        #[serde(skip_serializing_if = "Option::is_none")]
        maximum: Option<Num>,
        #[serde(skip_serializing_if = "Option::is_none")]
        default: Option<Num>,
    },
    #[serde(rename = "integer")]
    Integer {
        #[serde(skip_serializing_if = "Option::is_none")]
        title: Option<&'a str>,
        #[serde(skip_serializing_if = "Option::is_none")]
        description: Option<&'a str>,
        #[serde(skip_serializing_if = "Option::is_none")]
        minimum: Option<Num>,
        #[serde(skip_serializing_if = "Option::is_none")]
        maximum: Option<Num>,
        #[serde(skip_serializing_if = "Option::is_none")]
        default: Option<Num>,
    },
    #[serde(rename = "boolean")]
    Boolean {
        #[serde(skip_serializing_if = "Option::is_none")]
        title: Option<&'a str>,
        #[serde(skip_serializing_if = "Option::is_none")]
        description: Option<&'a str>,
        #[serde(skip_serializing_if = "Option::is_none")]
        default: Option<bool>,
    },
}

/// A generic OpenCode form as the JSON Schema the elicitation UI renders.
#[derive(Serialize)]
pub(crate) struct ElicitationSchema<'a> {
    #[serde(rename = "type")]
    typ: &'static str,
    properties: BTreeMap<&'a str, Property<'a>>,
    required: Vec<&'a str>,
}

/// The person's request: an approval, a question, or an elicitation.
#[derive(Serialize)]
#[serde(tag = "kind")]
pub(crate) enum Request<'a> {
    #[serde(rename = "approval")]
    Approval {
        title: &'a str,
        #[serde(skip_serializing_if = "Option::is_none")]
        target: Option<crate::translate::approval_target::ApprovalTarget<'a>>,
        description: String,
        options: [ApprovalOption; 3],
    },
    #[serde(rename = "question")]
    Question { questions: Vec<Question<'a>> },
    #[serde(rename = "elicitation")]
    Elicitation {
        server: &'static str,
        message: &'a str,
        #[serde(skip_serializing_if = "Option::is_none")]
        schema: Option<ElicitationSchema<'a>>,
    },
}

/// An approval request with its three options: allow once, for the project,
/// or deny.
pub(crate) fn approval_request<'a>(
    title: &'a str,
    target: Option<ApprovalTarget<'a>>,
    description: String,
) -> Request<'a> {
    Request::Approval {
        title,
        target,
        description,
        options: [
            ApprovalOption {
                id: "once",
                label: "Allow once",
                kind: "allow_once",
            },
            ApprovalOption {
                id: "always",
                label: "Allow for project",
                kind: "allow_always",
            },
            ApprovalOption {
                id: "reject",
                label: "Deny",
                kind: "deny",
            },
        ],
    }
}

/// Whether a form reads as a question or an elicitation.
#[derive(PartialEq, Eq)]
pub(crate) enum RequestKind {
    Question,
    Elicitation,
}

pub(crate) fn request_kind(form: &Map) -> RequestKind {
    let metadata = fields(get(form, "metadata"));
    let field_list = arr_in(form, "fields");
    if s_in(metadata, "kind") == "question"
        && !field_list.is_empty()
        && field_list
            .iter()
            .all(|field| matches!(s_in(fields(field), "type"), "string" | "multiselect"))
    {
        RequestKind::Question
    } else {
        RequestKind::Elicitation
    }
}

/// Read a form as the question or elicitation it describes.
pub(crate) fn form_request<'a>(form: &'a Map) -> Request<'a> {
    if request_kind(form) == RequestKind::Question {
        return Request::Question {
            questions: arr_in(form, "fields")
                .iter()
                .map(|field| {
                    let f = fields(field);
                    let description = s_in(f, "description");
                    Question {
                        id: s_in(f, "key"),
                        text: if description.is_empty() {
                            s_in(f, "title")
                        } else {
                            description
                        },
                        header: s_in(f, "title"),
                        options: arr_in(f, "options")
                            .iter()
                            .map(|option| {
                                let o = fields(option);
                                QuestionOption {
                                    id: s_in(o, "value"),
                                    label: s_in(o, "label"),
                                    description: match o.get("description") {
                                        Some(Value::String(description)) => {
                                            Some(description.as_str())
                                        }
                                        _ => None,
                                    },
                                }
                            })
                            .collect(),
                        multi_select: s_in(f, "type") == "multiselect",
                        allow_other: matches!(f.get("custom"), Some(Value::Bool(true))),
                        secret: false,
                    }
                })
                .collect(),
        };
    }
    Request::Elicitation {
        server: "OpenCode",
        message: s_in(form, "title"),
        schema: elicitation_schema(form),
    }
}

/// A generic form as renderable JSON Schema, or nothing renderable.
fn elicitation_schema<'a>(form: &'a Map) -> Option<ElicitationSchema<'a>> {
    let mut properties: BTreeMap<&'a str, Property<'a>> = BTreeMap::new();
    let mut required: Vec<&'a str> = Vec::new();
    for field in arr_in(form, "fields") {
        let f = fields(field);
        let key = s_in(f, "key");
        if key.is_empty() || properties.contains_key(key) {
            continue;
        }
        if matches!(f.get("hidden"), Some(Value::Bool(true))) {
            continue;
        }
        match field_property(f) {
            Some(property) => {
                if matches!(f.get("required"), Some(Value::Bool(true))) {
                    required.push(key);
                }
                properties.insert(key, property);
            }
            None => {
                if matches!(f.get("required"), Some(Value::Bool(true))) {
                    return None;
                }
            }
        }
    }
    if properties.is_empty() {
        return None;
    }
    Some(ElicitationSchema {
        typ: "object",
        properties,
        required,
    })
}

fn field_property<'a>(field: &'a Map) -> Option<Property<'a>> {
    let title = match field.get("title") {
        Some(Value::String(title)) if !title.is_empty() => Some(title.as_str()),
        _ => None,
    };
    let description = match field.get("description") {
        Some(Value::String(description)) if !description.is_empty() => Some(description.as_str()),
        _ => None,
    };
    match s_in(field, "type") {
        "string" => {
            let mut values: Option<Vec<&str>> = None;
            let mut value_names: Option<Vec<&str>> = None;
            if !matches!(field.get("custom"), Some(Value::Bool(true))) {
                let options: Vec<&Map> = arr_in(field, "options")
                    .iter()
                    .filter_map(|option| {
                        let o = fields(option);
                        match o.get("value") {
                            Some(Value::String(_)) => Some(o),
                            _ => None,
                        }
                    })
                    .collect();
                if !options.is_empty() && options.len() <= 128 {
                    values = Some(options.iter().map(|o| s_in(o, "value")).collect());
                    if options
                        .iter()
                        .any(|o| matches!(o.get("label"), Some(Value::String(_))))
                    {
                        value_names = Some(
                            options
                                .iter()
                                .map(|o| {
                                    let label = s_in(o, "label");
                                    if label.is_empty() {
                                        s_in(o, "value")
                                    } else {
                                        label
                                    }
                                })
                                .collect(),
                        );
                    }
                }
            }
            Some(Property::String {
                title,
                description,
                min_length: count_limit(field.get("minLength")),
                max_length: count_limit(field.get("maxLength")),
                values,
                value_names,
                default: match field.get("default") {
                    Some(Value::String(default)) => Some(default.as_str()),
                    _ => None,
                },
            })
        }
        "number" | "integer" => {
            let numeric = s_in(field, "type") == "number";
            let minimum = match field.get("minimum").or_else(|| field.get("min")) {
                Some(value) => finite_number(value),
                None => None,
            };
            let maximum = match field.get("maximum").or_else(|| field.get("max")) {
                Some(value) => finite_number(value),
                None => None,
            };
            let fallback = match field.get("default") {
                Some(value) => finite_number(value),
                None => None,
            };
            let fallback = match fallback {
                Some(fallback)
                    if numeric
                        || (fallback.fract() == 0.0
                            && fallback.abs() <= 9_007_199_254_740_991.0) =>
                {
                    Some(Num(fallback))
                }
                _ => None,
            };
            if numeric {
                Some(Property::Number {
                    title,
                    description,
                    minimum: minimum.map(Num),
                    maximum: maximum.map(Num),
                    default: fallback,
                })
            } else {
                Some(Property::Integer {
                    title,
                    description,
                    minimum: minimum.map(Num),
                    maximum: maximum.map(Num),
                    default: fallback,
                })
            }
        }
        "boolean" => Some(Property::Boolean {
            title,
            description,
            default: match field.get("default") {
                Some(Value::Bool(default)) => Some(*default),
                _ => None,
            },
        }),
        _ => None,
    }
}

fn finite_number(value: &Value) -> Option<f64> {
    match value {
        Value::Number(number) => {
            let v = number.as_f64()?;
            if v.is_finite() { Some(v) } else { None }
        }
        _ => None,
    }
}

fn count_limit(value: Option<&Value>) -> Option<i64> {
    let value = value?;
    match finite_number(value) {
        Some(v) if v.fract() == 0.0 && v >= 0.0 => Some(v as i64),
        _ => None,
    }
}

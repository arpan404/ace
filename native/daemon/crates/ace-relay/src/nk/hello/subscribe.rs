// SPDX-License-Identifier: Apache-2.0
//! What an early subscribe may read and carry (`EarlyScope`, `EarlySubscribe` in
//! `packages/protocol/src/relay-handshake.ts`): strict at every depth, because a recorder can
//! replay the first message that holds it.

use ace_json::Value;

use super::{MAX_SAFE, integer, only_keys, string_at};

/// What an early subscribe may read (`EarlyScope`): a thread, or a sidebar window with its limit,
/// project and archived filter.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EarlyScope {
    Thread { thread_id: String },
    Threads { window: Window },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Window {
    pub limit: u8,
    pub project: Option<String>,
    pub archived: Option<bool>,
}

/// A bounded tail a resume may ask for (`tail`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Tail {
    pub items: u8,
    pub bytes: usize,
}

/// A read subscribe, as the main socket takes it, with nothing more (`EarlySubscribe`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EarlySubscribe {
    pub subscription_id: String,
    pub scope: EarlyScope,
    pub paced: bool,
    pub after_seq: Option<u64>,
    pub tail: Option<Tail>,
}

impl EarlySubscribe {
    pub fn parse(value: &Value) -> Option<Self> {
        let object = value.as_object()?;
        if !only_keys(
            object,
            &["subscriptionId", "scope", "paced", "afterSeq", "tail"],
        ) {
            return None;
        }
        let subscription_id = string_at(object, "subscriptionId")?;
        let length = subscription_id.chars().count();
        if !(1..=128).contains(&length) {
            return None;
        }
        let scope = parse_scope(object.get("scope")?)?;
        let paced = match object.get("paced") {
            None => false,
            Some(Value::Bool(paced)) => *paced,
            Some(_) => return None,
        };
        let after_seq = match object.get("afterSeq") {
            None => None,
            Some(value) => {
                let number = value.as_f64()?;
                if number.fract() != 0.0 || !(0.0..=MAX_SAFE as f64).contains(&number) {
                    return None;
                }
                Some(number as u64)
            }
        };
        let tail = match object.get("tail") {
            None => None,
            Some(value) => {
                let tail = value.as_object()?;
                if !only_keys(tail, &["items", "bytes"]) {
                    return None;
                }
                Some(Tail {
                    items: integer(tail, "items", 1.0, 200.0)? as u8,
                    bytes: integer(tail, "bytes", 1_024.0, 1_024.0 * 1_024.0)? as usize,
                })
            }
        };
        Some(Self {
            subscription_id: subscription_id.to_owned(),
            scope,
            paced,
            after_seq,
            tail,
        })
    }

    pub fn thread_id(&self) -> Option<&str> {
        match &self.scope {
            EarlyScope::Thread { thread_id } => Some(thread_id),
            EarlyScope::Threads { .. } => None,
        }
    }

    /// The subscribe carried to the main-socket handler, with the cursor early events ended at
    /// when they were answered (`{type: "subscribe", ...subscribe, afterSeq}`), in the schema's
    /// key order.
    pub fn to_subscribe_message(&self, after_seq: Option<u64>) -> Value {
        let mut message = ace_json::Map::new();
        message.insert("type", Value::String("subscribe".into()));
        message.insert(
            "subscriptionId",
            Value::String(self.subscription_id.clone().into()),
        );
        message.insert("scope", self.scope.to_value());
        if self.paced {
            message.insert("paced", Value::Bool(true));
        }
        if let Some(after_seq) = after_seq.or(self.after_seq) {
            message.insert("afterSeq", ace_json::to_value(&after_seq));
        }
        if let Some(tail) = self.tail {
            let mut value = ace_json::Map::new();
            value.insert("items", ace_json::to_value(&tail.items));
            value.insert("bytes", ace_json::to_value(&tail.bytes));
            message.insert("tail", Value::Object(value));
        }
        Value::Object(message)
    }
}

impl EarlyScope {
    fn to_value(&self) -> Value {
        let mut scope = ace_json::Map::new();
        match self {
            Self::Thread { thread_id } => {
                scope.insert("kind", Value::String("thread".into()));
                scope.insert("threadId", Value::String(thread_id.clone().into()));
            }
            Self::Threads { window } => {
                scope.insert("kind", Value::String("threads".into()));
                let mut value = ace_json::Map::new();
                value.insert("limit", ace_json::to_value(&window.limit));
                if let Some(project) = &window.project {
                    value.insert("project", Value::String(project.clone().into()));
                }
                if let Some(archived) = window.archived {
                    value.insert("archived", Value::Bool(archived));
                }
                scope.insert("window", Value::Object(value));
            }
        }
        Value::Object(scope)
    }
}

fn parse_scope(value: &Value) -> Option<EarlyScope> {
    let object = value.as_object()?;
    match string_at(object, "kind")? {
        "thread" => {
            if !only_keys(object, &["kind", "threadId"]) {
                return None;
            }
            let thread_id = string_at(object, "threadId")?;
            if thread_id.is_empty() {
                return None;
            }
            Some(EarlyScope::Thread {
                thread_id: thread_id.to_owned(),
            })
        }
        "threads" => {
            if !only_keys(object, &["kind", "window"]) {
                return None;
            }
            let window = object.get("window")?.as_object()?;
            if !only_keys(window, &["limit", "project", "archived"]) {
                return None;
            }
            let limit = integer(window, "limit", 1.0, 20.0)? as u8;
            let project = match window.get("project") {
                None => None,
                Some(Value::String(project)) => {
                    if project.as_str().is_empty() {
                        return None;
                    }
                    Some(project.as_str().to_owned())
                }
                Some(_) => return None,
            };
            let archived = match window.get("archived") {
                None => None,
                Some(Value::Bool(archived)) => Some(*archived),
                Some(_) => return None,
            };
            Some(EarlyScope::Threads {
                window: Window {
                    limit,
                    project,
                    archived,
                },
            })
        }
        _ => None,
    }
}

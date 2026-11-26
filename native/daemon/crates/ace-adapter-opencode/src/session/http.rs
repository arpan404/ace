// SPDX-License-Identifier: Apache-2.0
//! The tenant's one way to ask the facade for HTTP (`session.ts:514`-`:572`,
//! `recovery.ts`, `history.ts`, `ancestry.ts:94`): one `http` port per SDK
//! call, answered with `reply(id, ok, json)`.
//!
//! The body is the SDK reply's JSON text, at most 768 KiB (`observation.ts:22`),
//! and it is parsed once here: the request's params cross as a value and the
//! reply's body as text, and nothing else crosses. A refusal answers with the
//! message and, when the scoped observer saw one, the HTTP status; a shell's
//! 404 is how an absence is expressed (`session.ts:533`-`:546`). A reply for a
//! request whose owner left (the tenant closed, the probe finished) is dropped.

use ace_adapter_api::bridge::SessionEvent;
use ace_json::Value;
use indexmap::IndexMap;

use crate::translate::data::{fields, s_in};

/// A request's owner, so a reply reaches the machine that asked.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Owner {
    /// The ancestry chain for one unproven session (`ancestry.ts:94`).
    Ancestry(String),
    /// The `session.moved` refetch for one session (`session.ts:345`).
    Moved(String),
    /// The recovery pass (`recovery.ts`).
    Recovery,
    /// The replay's ancestry re-read (`prepareReplay`, `session.ts:552`).
    Replay,
}

/// One request the tenant is waiting on.
struct Waiting {
    owner: Owner,
}

/// The request id space and what each id belongs to.
#[derive(Default)]
pub struct Http {
    next: u64,
    waiting: IndexMap<u64, Waiting>,
}

impl Http {
    pub fn new() -> Self {
        Self::default()
    }

    /// Builds one `http` port: `{ id, op, params }`, `op` the SDK call's name.
    pub fn request(&mut self, owner: Owner, op: &'static str, params: Value) -> SessionEvent {
        let id = self.next;
        self.next = self.next.saturating_add(1);
        self.waiting.insert(id, Waiting { owner });
        SessionEvent::Port {
            name: "http",
            json: ace_json::to_string(&ace_json::json!({
                "id": id,
                "op": op,
                "params": params,
            })),
        }
    }

    /// `reply(id, ...)`: the owner that asked, once.
    pub fn take(&mut self, id: u64) -> Option<Owner> {
        self.waiting.shift_remove(&id).map(|waiting| waiting.owner)
    }

    /// How many requests are unanswered.
    pub fn outstanding(&self) -> usize {
        self.waiting.len()
    }
}

/// One answered request.
#[derive(Debug, Clone, PartialEq)]
pub struct Reply {
    pub ok: bool,
    /// The reply's body; `Null` when the refusal carried none.
    pub body: Value,
    /// The refusal's message, or the SDK failure's text.
    pub message: String,
    /// The HTTP status the scoped observer saw, when it saw one.
    pub status: Option<f64>,
}

impl Reply {
    /// `reply(id, ok, json)`: an `ok` reply is the SDK value; a refusal is
    /// `{ message, status? }` (`session.ts:533`-`:546`).
    pub fn parse(ok: bool, json: &str) -> Self {
        let body = ace_json::parse(json).unwrap_or(Value::Null);
        let (message, status) = if ok {
            (String::new(), None)
        } else {
            let refusal = fields(&body);
            (
                s_in(refusal, "message").to_owned(),
                refusal.get("status").and_then(Value::as_f64),
            )
        };
        Self {
            ok,
            body,
            message,
            status,
        }
    }

    /// The message a thrown refusal carries: the reply's own, or a fallback.
    pub fn refusal(&self, fallback: &'static str) -> String {
        if self.message.is_empty() {
            fallback.to_owned()
        } else {
            self.message.clone()
        }
    }

    /// The body as fields, or the shared empty object.
    pub fn fields(&self) -> &ace_json::Map {
        fields(&self.body)
    }
}

#[cfg(test)]
mod tests {
    use super::{Http, Owner, Reply};
    use ace_json::json;

    #[test]
    fn a_request_names_the_sdk_call_and_its_params() {
        let mut http = Http::new();
        let event = http.request(
            Owner::Ancestry(String::from("child")),
            "session.get",
            json!({ "sessionID": "child" }),
        );
        let ace_adapter_api::bridge::SessionEvent::Port { name, json: text } = event else {
            panic!("an http port");
        };
        assert_eq!(name, "http");
        assert_eq!(
            text,
            r#"{"id":0,"op":"session.get","params":{"sessionID":"child"}}"#
        );
        assert_eq!(http.take(0), Some(Owner::Ancestry(String::from("child"))));
        assert_eq!(http.take(0), None, "one reply per request");
        assert_eq!(http.outstanding(), 0);
    }

    #[test]
    fn a_reply_keeps_the_sdk_value_or_the_refusal() {
        let ok = Reply::parse(true, r#"{"id":"s","projectID":"p"}"#);
        assert!(ok.ok);
        assert_eq!(
            ok.fields().get("id").and_then(ace_json::Value::as_str),
            Some("s")
        );

        let refused = Reply::parse(false, r#"{"message":"gone","status":404}"#);
        assert!(!refused.ok);
        assert_eq!(refused.refusal("fallback"), "gone");
        assert_eq!(refused.status, Some(404.0));
        let bare = Reply::parse(false, "not json");
        assert_eq!(bare.refusal("fallback"), "fallback");
        assert_eq!(bare.status, None);
    }
}

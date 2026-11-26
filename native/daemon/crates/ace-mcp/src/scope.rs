// SPDX-License-Identifier: Apache-2.0
//! The outside endpoint's authorization answers, ported from `scope-challenge.ts`.
//!
//! A bearer that does not authenticate gets 401 with a `WWW-Authenticate: Bearer` challenge. A
//! tool call the principal's scope does not cover gets 403 `insufficient_scope` before anything
//! runs, with the RFC 6750 header and a JSON-RPC error the client can act on. ace never adds an
//! approval of its own: a scope here is the caller's capability set, not a permission prompt.

use ace_json::{JsString, Map, Value};

use crate::credentials::Principal;
use crate::jsonrpc::FORBIDDEN;
use crate::tool_names::dispatched_ace_call;

/// The host's answer for a scope a principal lacks (`ScopeChallenge`).
pub trait ScopeChallenge: Send + Sync {
    /// The scope `principal` lacks to call `tool` with `args` (a `tools_call` reads as the call it
    /// runs), or `None` when it may.
    fn missing_scope(&self, principal: &Principal, tool: &str, args: &Value) -> Option<String>;
    /// Extra `WWW-Authenticate` parameters for a request that arrived at `resource`.
    fn parameters(&self, _resource: Option<&str>) -> Vec<(String, String)> {
        Vec::new()
    }
}

/// What the bounded scope check decided.
pub enum ScopeCheck {
    /// The request may reach the MCP handler; its body, unchanged.
    Forward(Vec<u8>),
    /// The answer, before any tool runs.
    Refuse {
        status: u16,
        headers: Vec<(String, String)>,
        body: String,
    },
}

/// `bearer`: the credential after `Bearer `, or `""`.
pub fn bearer(header: Option<&str>) -> &str {
    header
        .and_then(|header| header.strip_prefix("Bearer "))
        .unwrap_or("")
}

/// `bearerChallenge`: `Bearer name="value", …`, leaving out values a quoted string cannot hold.
pub fn bearer_challenge(parameters: &[(String, String)]) -> String {
    let listed: Vec<String> = parameters
        .iter()
        .filter(|(_, value)| quotable(value))
        .map(|(key, value)| format!("{key}=\"{value}\""))
        .collect();
    if listed.is_empty() {
        "Bearer".to_owned()
    } else {
        format!("Bearer {}", listed.join(", "))
    }
}

/// Header parameter values are quoted strings; a host's value never breaks out of one.
fn quotable(value: &str) -> bool {
    value.chars().all(|character| {
        matches!(character as u32,
            0x20..=0x21 | 0x23..=0x5b | 0x5d..=0x7e)
    })
}

/// `scopeRefusal`: reads the request body (bounded) and refuses a tool call outside the
/// principal's scope. A body that is not JSON, or not a `tools/call`, passes through for the MCP
/// handler to answer in its own words.
pub fn scope_refusal(
    body: &[u8],
    principal: &Principal,
    challenge: &dyn ScopeChallenge,
    max_bytes: usize,
    resource: Option<&str>,
) -> ScopeCheck {
    if body.len() > max_bytes {
        return ScopeCheck::Refuse {
            status: 413,
            headers: Vec::new(),
            body: String::new(),
        };
    }
    let Ok(text) = std::str::from_utf8(body) else {
        return ScopeCheck::Forward(body.to_vec());
    };
    let Ok(value) = ace_json::parse(text) else {
        return ScopeCheck::Forward(body.to_vec());
    };
    let Some(call) = ToolCall::read(&value) else {
        return ScopeCheck::Forward(body.to_vec());
    };
    let target = dispatched_ace_call(&call.name, &call.arguments);
    let Some(scope) = challenge.missing_scope(principal, &target.name, &target.input) else {
        return ScopeCheck::Forward(body.to_vec());
    };
    let mut parameters = vec![
        ("error".to_owned(), "insufficient_scope".to_owned()),
        ("scope".to_owned(), scope.clone()),
        (
            "error_description".to_owned(),
            format!("This tool needs the {scope} scope."),
        ),
    ];
    parameters.extend(challenge.parameters(resource));
    let header = bearer_challenge(&parameters);
    let mut error = Map::with_capacity(3);
    error.insert("code", Value::from(FORBIDDEN as f64));
    error.insert(
        "message",
        Value::String(JsString::from(format!(
            "Forbidden: needs the {scope} scope"
        ))),
    );
    let mut data = Map::with_capacity(1);
    data.insert("scope", Value::String(JsString::from(scope.as_str())));
    error.insert("data", Value::Object(data));
    let mut reply = Map::with_capacity(3);
    reply.insert("jsonrpc", Value::from("2.0"));
    reply.insert("id", call.id.map(|id| id.to_value()).unwrap_or(Value::Null));
    reply.insert("error", Value::Object(error));
    ScopeCheck::Refuse {
        status: 403,
        headers: vec![
            ("content-type".to_owned(), "application/json".to_owned()),
            ("www-authenticate".to_owned(), header),
        ],
        body: ace_json::to_string(&Value::Object(reply)),
    }
}

/// The `tools/call` shape `scope-challenge.ts:28` reads.
struct ToolCall {
    id: Option<crate::jsonrpc::Id>,
    name: String,
    arguments: Value,
}

impl ToolCall {
    fn read(value: &Value) -> Option<ToolCall> {
        if value.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
            return None;
        }
        let id = match value.get("id") {
            None => None,
            Some(Value::Null) => None,
            Some(id) => Some(crate::jsonrpc::Id::from_value(id)?),
        };
        if value.get("method").and_then(Value::as_str) != Some("tools/call") {
            return None;
        }
        let params = value.get("params")?;
        let name = params.get("name").and_then(Value::as_str)?;
        if name.encode_utf16().count() > 256 {
            return None;
        }
        let arguments = params
            .get("arguments")
            .cloned()
            .unwrap_or_else(|| Value::Object(Map::new()));
        Some(ToolCall {
            id,
            name: name.to_owned(),
            arguments,
        })
    }
}

#[cfg(test)]
mod tests {
    // Ported from `scope-challenge.ts` and the (a) case "rejects a tool call outside the
    // principal's scope with 403 insufficient_scope" in `http-boundaries.process`.
    use super::*;
    use crate::credentials::{McpScope, SessionLease};
    use crate::signal::Abort;
    use std::sync::Arc;

    struct Only(Option<&'static str>);

    impl ScopeChallenge for Only {
        fn missing_scope(
            &self,
            _principal: &Principal,
            _tool: &str,
            _args: &Value,
        ) -> Option<String> {
            self.0.map(str::to_owned)
        }
    }

    fn principal() -> (Principal, SessionLease) {
        let registry = crate::credentials::CredentialRegistry::new(|| "a".repeat(64));
        let lease = registry
            .issue(
                McpScope::new("session", "thread", "agent", &[]),
                &Abort::new(),
            )
            .expect("lease");
        (lease.principal.clone(), lease)
    }

    #[test]
    fn a_challenge_is_a_bearer_list_that_leaves_unquotable_values_out() {
        assert_eq!(bearer_challenge(&[]), "Bearer");
        assert_eq!(
            bearer_challenge(&[
                ("error".to_owned(), "insufficient_scope".to_owned()),
                ("scope".to_owned(), "browser".to_owned()),
            ]),
            "Bearer error=\"insufficient_scope\", scope=\"browser\""
        );
        assert_eq!(
            bearer_challenge(&[("scope".to_owned(), "a\"b\nc".to_owned())]),
            "Bearer"
        );
    }

    #[test]
    fn a_tool_call_outside_the_scope_is_refused_before_it_runs_with_the_typescripts_bytes() {
        let (who, _lease) = principal();
        let body = br#"{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"browser_open","arguments":{"url":"https://example.com"}}}"#;
        let ScopeCheck::Refuse {
            status,
            headers,
            body,
        } = scope_refusal(body, &who, &Only(Some("browser")), 1024, None)
        else {
            panic!("the call was not refused");
        };
        assert_eq!(status, 403);
        assert_eq!(
            headers,
            vec![
                ("content-type".to_owned(), "application/json".to_owned()),
                (
                    "www-authenticate".to_owned(),
                    "Bearer error=\"insufficient_scope\", scope=\"browser\", \
                     error_description=\"This tool needs the browser scope.\""
                        .to_owned()
                ),
            ]
        );
        assert_eq!(
            body,
            "{\"jsonrpc\":\"2.0\",\"id\":7,\"error\":{\"code\":-32003,\
             \"message\":\"Forbidden: needs the browser scope\",\"data\":{\"scope\":\"browser\"}}}"
        );
    }

    #[test]
    fn a_tools_call_reads_as_the_tool_it_dispatches_and_other_bodies_pass_through() {
        let (who, _lease) = principal();
        let body = br#"{"jsonrpc":"2.0","id":"x","method":"tools/call","params":{"name":"tools_call","arguments":{"name":"browser_open","arguments":{}}}}"#;
        match scope_refusal(body, &who, &Only(Some("browser")), 1024, None) {
            ScopeCheck::Refuse { body, .. } => {
                assert!(body.contains("Forbidden: needs the browser scope"))
            }
            ScopeCheck::Forward(_) => panic!("a dispatched call was not checked"),
        }
        for other in [
            br#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"# as &[u8],
            b"not json",
            br#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"arguments":{}}}"#,
        ] {
            assert!(matches!(
                scope_refusal(other, &who, &Only(Some("browser")), 1024, None),
                ScopeCheck::Forward(_)
            ));
        }
    }

    #[test]
    fn a_body_past_the_bound_is_413_before_it_is_read() {
        let (who, _lease) = principal();
        match scope_refusal(&vec![b' '; 1025], &who, &Only(Some("browser")), 1024, None) {
            ScopeCheck::Refuse { status, body, .. } => {
                assert_eq!(status, 413);
                assert!(body.is_empty());
            }
            ScopeCheck::Forward(_) => panic!("an oversized body was forwarded"),
        }
    }

    #[test]
    fn the_challenge_keeps_the_resources_own_parameters_after_its_own() {
        struct WithMetadata;
        impl ScopeChallenge for WithMetadata {
            fn missing_scope(
                &self,
                _principal: &Principal,
                _tool: &str,
                _args: &Value,
            ) -> Option<String> {
                Some("browser".to_owned())
            }
            fn parameters(&self, resource: Option<&str>) -> Vec<(String, String)> {
                vec![(
                    "resource_metadata".to_owned(),
                    format!("{}/.well-known", resource.unwrap_or_default()),
                )]
            }
        }
        let (who, _lease) = principal();
        let body = br#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"browser_open","arguments":{}}}"#;
        let ScopeCheck::Refuse { headers, .. } = scope_refusal(
            body,
            &who,
            &WithMetadata,
            1024,
            Some("https://ace.example/mcp"),
        ) else {
            panic!("not refused");
        };
        assert_eq!(
            headers[1].1,
            "Bearer error=\"insufficient_scope\", scope=\"browser\", \
             error_description=\"This tool needs the browser scope.\", \
             resource_metadata=\"https://ace.example/mcp/.well-known\""
        );
        let _ = Arc::new(());
    }
}

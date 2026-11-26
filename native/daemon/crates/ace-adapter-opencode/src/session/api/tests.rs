// SPDX-License-Identifier: Apache-2.0
//! The call table against `@opencode/client`'s own routes. `routes.golden.json` is generated
//! by `scripts/opencode-routes.ts`, which drives the installed SDK with a capturing fetch for
//! the same params each case uses: every method, request target (path percent-encoding, query
//! fields, their order and their bracket encoding) and body field whitelist here is the SDK's,
//! so an SDK bump that moves a route fails both this test and `bun run check:daemon-native`
//! until the table follows.

use super::{ApiError, call, ops};
use crate::translate::data::{arr_in, fields, s_in};
use ace_json::{Value, json};

/// One recorded SDK request.
fn golden() -> Value {
    ace_json::parse(include_str!("routes.golden.json")).expect("the golden table is JSON")
}

#[test]
fn every_call_is_the_one_the_sdk_sends() {
    let table = golden();
    let routes = arr_in(fields(&table), "routes");
    for route in routes {
        let e = fields(route);
        let op = s_in(e, "op");
        let params = e.get("params").expect("the probe's params");
        let expected = call(op, params).unwrap_or_else(|error| panic!("{op}: {error}"));
        assert_eq!(expected.method.as_str(), s_in(e, "method"), "{op} method");
        assert_eq!(expected.target(), s_in(e, "target"), "{op} target");
        match e.get("body") {
            Some(body) => assert_eq!(
                expected.body.as_ref(),
                Some(body),
                "{op} body is the route's field whitelist"
            ),
            None => assert_eq!(expected.body, None, "{op} sends no body"),
        }
    }
}

#[test]
fn the_table_and_the_golden_table_name_the_same_calls() {
    let table = golden();
    let routes = arr_in(fields(&table), "routes");
    let mut recorded: Vec<&str> = routes
        .iter()
        .map(|route| s_in(fields(route), "op"))
        .collect();
    recorded.sort_unstable();
    let mut named: Vec<&str> = ops().collect();
    named.sort_unstable();
    assert_eq!(named, recorded, "regenerate scripts/opencode-routes.ts");
}

#[test]
fn a_body_only_carries_the_routes_fields() {
    // The TypeScript's interaction and MCP callers pass extra keys; none reaches the wire.
    let reply = call(
        "permission.reply",
        &json!({
            "kind": "permission",
            "sessionID": "s",
            "requestID": "p1",
            "decision": "once",
            "message": "yes",
            "answer": { "q": "a" },
        }),
    )
    .expect("a call");
    assert_eq!(
        reply.body,
        Some(json!({ "decision": "once", "message": "yes" }))
    );

    let cancel = call(
        "session.form.cancel",
        &json!({
            "kind": "form",
            "sessionID": "s",
            "formID": "f1",
            "cancel": true,
            "message": "dismissed",
            "answer": { "q": "a" },
        }),
    )
    .expect("a call");
    assert_eq!(cancel.body, None, "the SDK sends no body");
    assert_eq!(
        cancel.query,
        vec![(String::from("message"), String::from("dismissed"))]
    );

    // The MCP server is a path id, and connect has no body.
    assert_eq!(
        call(
            "mcp.add",
            &json!({ "server": "ace", "location": { "directory": "/w" }, "config": { "type": "remote" } })
        )
        .expect("a call"),
        super::Call {
            method: super::Method::Put,
            path: String::from("/api/experimental/mcp/ace"),
            query: vec![(
                String::from("location[directory]"),
                String::from("/w")
            )],
            body: Some(json!({ "config": { "type": "remote" } })),
        }
    );
    for op in ["mcp.connect", "mcp.disconnect"] {
        assert_eq!(
            call(
                op,
                &json!({ "server": "ace", "location": { "directory": "/w" }, "config": { "type": "remote" } })
            )
            .expect("a call")
            .body,
            None,
            "{op} sends no body"
        );
    }
    assert_eq!(
        call(
            "mcp.disconnect",
            &json!({ "server": "ace", "location": { "directory": "/w" } })
        )
        .expect("a call")
        .target(),
        "/api/experimental/mcp/ace/disconnect?location%5Bdirectory%5D=%2Fw"
    );
}

#[test]
fn both_rpcs_wrap_their_input_and_name_the_location() {
    let settle = call(
        "agent.environment.settle",
        &json!({ "location": { "directory": "/w" }, "input": { "sessionID": "s", "ok": true } }),
    )
    .expect("a call");
    assert_eq!(
        settle.target(),
        "/api/rpc/ace.agent.environment/settle?location%5Bdirectory%5D=%2Fw"
    );
    assert_eq!(
        settle.body,
        Some(json!({ "input": { "sessionID": "s", "ok": true } }))
    );
    let ready = call(
        "mcp.readiness.ready",
        &json!({ "location": { "directory": "/w" }, "input": {} }),
    )
    .expect("a call");
    assert_eq!(
        ready.target(),
        "/api/rpc/ace.mcp.readiness/ready?location%5Bdirectory%5D=%2Fw"
    );
    assert_eq!(
        ready.body,
        Some(json!({ "input": {} })),
        "not the bare params"
    );
}

#[test]
fn a_missing_id_or_an_unknown_call_is_named_before_any_request() {
    assert_eq!(
        call("session.get", &json!({})),
        Err(ApiError::Missing(String::from("session.get"), "sessionID"))
    );
    assert_eq!(
        call("session.get", &json!({ "sessionID": "" })),
        Err(ApiError::Missing(String::from("session.get"), "sessionID"))
    );
    assert_eq!(
        call("session.message.get", &json!({ "sessionID": "s" })),
        Err(ApiError::Missing(
            String::from("session.message.get"),
            "messageID"
        ))
    );
    assert_eq!(
        call(
            "session.instructions.put",
            &json!({ "sessionID": "s", "value": "v" })
        ),
        Err(ApiError::Missing(
            String::from("session.instructions.put"),
            "key"
        ))
    );
    assert_eq!(
        call("nope", &json!({})),
        Err(ApiError::Unknown(String::from("nope")))
    );
}

#[test]
fn a_path_segment_cannot_escape_its_place() {
    assert_eq!(
        call("session.get", &json!({ "sessionID": "a/b?c" }))
            .expect("a call")
            .target(),
        "/api/session/a%2Fb%3Fc"
    );
}

#[test]
fn a_query_null_is_the_text_null_and_an_array_repeats_its_key() {
    // `appendQuery` keeps a null as `null`, repeats an array's key and skips an absent field.
    assert_eq!(
        call("session.list", &json!({ "cursor": null, "limit": 2 }))
            .expect("a call")
            .target(),
        "/api/session?limit=2&cursor=null"
    );
    // No route has an array field yet, so the serializer's array rule is pinned here: the SDK
    // repeats the key rather than indexing it (`appendQuery`, `:1386`-`:1404`).
    let mut pairs = Vec::new();
    super::encode::flatten("key", &json!(["a", "b"]), &mut pairs);
    assert_eq!(
        pairs,
        [
            (String::from("key"), String::from("a")),
            (String::from("key"), String::from("b")),
        ]
    );
    assert_eq!(
        call("session.list", &json!({ "limit": 1e21 }))
            .expect("a call")
            .target(),
        "/api/session?limit=1e%2B21",
        "the SDK writes String(value)"
    );
    let mut pairs = Vec::new();
    super::encode::flatten("key", &json!({ "nested": [1, null] }), &mut pairs);
    assert_eq!(
        pairs,
        [
            (String::from("key[nested]"), String::from("1")),
            (String::from("key[nested]"), String::from("null")),
        ]
    );
}

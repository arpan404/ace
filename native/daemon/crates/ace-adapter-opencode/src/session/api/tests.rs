// SPDX-License-Identifier: Apache-2.0
//! The call table (`contract.ts` `requiredRoutes` and the SDK calls the session
//! makes): each route's method, its ids in the path, the SDK's bracket query and
//! the body with the path's ids removed.

use super::{ApiError, Method, call};
use ace_json::{Value, json};

fn target(op: &str, params: Value) -> String {
    call(op, &params).expect("a known call").target()
}

fn body(op: &str, params: Value) -> Value {
    call(op, &params)
        .expect("a known call")
        .body
        .expect("a body")
}

#[test]
fn the_sessions_own_calls_name_their_ids_in_the_path() {
    assert_eq!(
        (
            Method::Get,
            target("session.get", json!({ "sessionID": "ses_1" }))
        ),
        (Method::Get, String::from("/api/session/ses_1"))
    );
    assert_eq!(target("session.active", json!({})), "/api/session/active");
    assert_eq!(
        (
            call(
                "session.switchModel",
                &json!({ "sessionID": "s", "model": { "providerID": "p", "id": "m" } })
            )
            .expect("a call")
            .method,
            target(
                "session.switchModel",
                json!({ "sessionID": "s", "model": { "providerID": "p", "id": "m" } })
            )
        ),
        (Method::Post, String::from("/api/session/s/model"))
    );
    // The body is the params without the ids the path carries.
    assert_eq!(
        body(
            "session.switchModel",
            json!({ "sessionID": "s", "model": { "providerID": "p", "id": "m", "variant": "high" } })
        ),
        json!({ "model": { "providerID": "p", "id": "m", "variant": "high" } })
    );
    assert_eq!(
        target("session.update", json!({ "sessionID": "s" })),
        "/api/session/s"
    );
    assert_eq!(
        call("session.update", &json!({ "sessionID": "s" }))
            .expect("a call")
            .method,
        Method::Patch
    );
    assert_eq!(
        target(
            "session.switchAgent",
            json!({ "sessionID": "s", "agent": "build" })
        ),
        "/api/session/s/agent"
    );
    assert_eq!(
        target("session.interrupt", json!({ "sessionID": "s" })),
        "/api/session/s/interrupt"
    );
    assert_eq!(
        target("session.environment", json!({ "sessionID": "s" })),
        "/api/session/s/environment"
    );
    assert_eq!(
        call(
            "session.environment",
            &json!({ "sessionID": "s", "variables": { "A": "b" } })
        )
        .expect("a call")
        .method,
        Method::Put
    );
    assert_eq!(
        target(
            "session.instructions.put",
            json!({ "sessionID": "s", "key": "ace.tool-guidance", "value": "v" })
        ),
        "/api/session/s/instructions/entries/ace.tool-guidance"
    );
    assert_eq!(
        body(
            "session.instructions.put",
            json!({ "sessionID": "s", "key": "k", "value": "v" })
        ),
        json!({ "value": "v" })
    );
    assert_eq!(
        target("session.create", json!({ "title": "ace" })),
        "/api/session"
    );
    assert_eq!(
        call(
            "session.create",
            &json!({ "title": "ace", "location": { "directory": "/w" } })
        )
        .expect("a call")
        .body,
        Some(json!({ "title": "ace", "location": { "directory": "/w" } }))
    );
    assert_eq!(
        target("session.prompt", json!({ "sessionID": "s", "id": "msg_1" })),
        "/api/session/s/prompt"
    );
    assert_eq!(
        target(
            "session.command",
            json!({ "sessionID": "s", "name": "init" })
        ),
        "/api/session/s/command"
    );
}

#[test]
fn the_sessions_lists_use_the_sdks_bracket_query() {
    assert_eq!(
        target(
            "session.list",
            json!({
                "parentID": "p",
                "directory": "/work",
                "project": "pr",
                "limit": 128,
                "order": "asc",
            })
        ),
        "/api/session?parentID=p&directory=%2Fwork&project=pr&limit=128&order=asc"
    );
    assert_eq!(
        target(
            "session.list",
            json!({ "parentID": "p", "directory": "/w", "project": "pr", "limit": 128, "cursor": "children:2" })
        ),
        "/api/session?parentID=p&directory=%2Fw&project=pr&limit=128&cursor=children%3A2"
    );
    // An absent or null value is left out, as the SDK omits it.
    assert_eq!(
        target("session.list", json!({ "parentID": "p", "cursor": null })),
        "/api/session?parentID=p"
    );
    assert_eq!(
        target(
            "message.list",
            json!({ "sessionID": "s", "limit": 128, "order": "desc" })
        ),
        "/api/session/s/message?limit=128&order=desc"
    );
    // A nested object is `location[directory]`, the shape the server reads.
    assert_eq!(
        target(
            "model.list",
            json!({ "location": { "directory": "/work" } })
        ),
        "/api/model?location%5Bdirectory%5D=%2Fwork"
    );
    assert_eq!(
        target("shell.list", json!({ "location": { "directory": "/w" } })),
        "/api/shell?location%5Bdirectory%5D=%2Fw"
    );
    assert_eq!(
        target(
            "shell.get",
            json!({ "id": "sh1", "location": { "directory": "/w" } })
        ),
        "/api/shell/sh1?location%5Bdirectory%5D=%2Fw"
    );
    assert_eq!(
        call(
            "shell.remove",
            &json!({ "id": "sh1", "location": { "directory": "/w" } })
        )
        .expect("a call")
        .method,
        Method::Delete
    );
}

#[test]
fn the_messages_permissions_forms_and_inbox_name_their_ids() {
    assert_eq!(
        target(
            "session.message.get",
            json!({ "sessionID": "s", "messageID": "msg_1" })
        ),
        "/api/session/s/message/msg_1"
    );
    assert_eq!(
        target("permission.list", json!({ "sessionID": "s" })),
        "/api/session/s/permission"
    );
    assert_eq!(
        target(
            "permission.reply",
            json!({ "sessionID": "s", "requestID": "p1", "resolution": "once" })
        ),
        "/api/session/s/permission/p1/reply"
    );
    assert_eq!(
        body(
            "permission.reply",
            json!({ "sessionID": "s", "requestID": "p1", "resolution": "once" })
        ),
        json!({ "resolution": "once" })
    );
    assert_eq!(
        target(
            "session.form.reply",
            json!({ "sessionID": "s", "formID": "f1", "answer": { "a": 1 } })
        ),
        "/api/session/s/form/f1/reply"
    );
    assert_eq!(
        target(
            "session.form.cancel",
            json!({ "sessionID": "s", "formID": "f1" })
        ),
        "/api/session/s/form/f1"
    );
    assert_eq!(
        call(
            "session.form.cancel",
            &json!({ "sessionID": "s", "formID": "f1" })
        )
        .expect("a call")
        .method,
        Method::Delete
    );
    assert_eq!(
        target("session.form.list", json!({ "sessionID": "s" })),
        "/api/session/s/form"
    );
    assert_eq!(
        target("session.inbox.list", json!({ "sessionID": "s" })),
        "/api/session/s/inbox"
    );
}

#[test]
fn the_catalog_mcp_and_plugin_calls_are_the_routes_the_contract_names() {
    for op in ["skill.list", "agent.list", "plugin.list", "mcp.list"] {
        assert_eq!(
            target(op, json!({ "location": { "directory": "/w" } })),
            format!(
                "/api/{}{}",
                op.split('.').next().expect("a resource"),
                "?location%5Bdirectory%5D=%2Fw"
            )
        );
    }
    assert_eq!(
        target("command.list", json!({ "location": { "directory": "/w" } })),
        "/api/command?location%5Bdirectory%5D=%2Fw"
    );
    assert_eq!(target("integration.list", json!({})), "/api/integration");
    assert_eq!(
        call(
            "mcp.add",
            &json!({ "config": { "type": "remote" }, "location": { "directory": "/w" } })
        )
        .expect("a call")
        .method,
        Method::Put
    );
    assert_eq!(
        body(
            "mcp.add",
            json!({ "config": { "type": "remote" }, "location": { "directory": "/w" } })
        ),
        json!({ "config": { "type": "remote" } })
    );
    assert_eq!(
        body(
            "mcp.connect",
            json!({ "server": "ace", "location": { "directory": "/w" } })
        ),
        json!({ "server": "ace" })
    );
    // The two plugin RPCs wrap their argument as `input`.
    assert_eq!(
        body(
            "agent.environment.settle",
            json!({ "sessionID": "s", "ok": true })
        ),
        json!({ "input": { "sessionID": "s", "ok": true } })
    );
    assert_eq!(
        target("agent.environment.settle", json!({})),
        "/api/rpc/ace.agent.environment/settle"
    );
    assert_eq!(
        target("mcp.readiness.ready", json!({})),
        "/api/rpc/ace.mcp.readiness/ready"
    );
    assert_eq!(target("event.subscribe", json!({})), "/api/event");
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
        call("nope", &json!({})),
        Err(ApiError::Unknown(String::from("nope")))
    );
}

#[test]
fn a_path_segment_cannot_escape_its_place() {
    // A slash and a query separator stay in the segment they were given.
    assert_eq!(
        target("session.get", json!({ "sessionID": "a/b?c" })),
        "/api/session/a%2Fb%3Fc"
    );
}

// SPDX-License-Identifier: Apache-2.0
//! The table itself (`@opencode/client`'s routes): method, path ids, the query fields in the
//! SDK's order, and the body's field whitelist. `api/tests.rs` compares every entry with what the
//! SDK sends for the same params (`routes.golden.json`).

use super::Method;

/// One route of the SDK's client.
pub(super) struct Route {
    pub(super) method: Method,
    /// The path, with `{param}` where the SDK substitutes an id.
    pub(super) path: &'static str,
    /// The query fields, in the SDK's order.
    pub(super) query: &'static [&'static str],
    /// The body's fields, in the SDK's order, or `None` when there is no body.
    pub(super) body: Option<&'static [&'static str]>,
}

pub(super) const NONE: Option<&'static [&'static str]> = None;
pub(super) const fn body(fields: &'static [&'static str]) -> Option<&'static [&'static str]> {
    Some(fields)
}
pub(super) const fn route(
    method: Method,
    path: &'static str,
    query: &'static [&'static str],
    body: Option<&'static [&'static str]>,
) -> Route {
    Route {
        method,
        path,
        query,
        body,
    }
}

pub(super) const NO_QUERY: &[&str] = &[];
pub(super) const LOCATION: &[&str] = &["location"];

/// Every call, by the SDK name the session uses.
pub(super) const ROUTES: &[(&str, Route)] = &[
    // The session itself.
    (
        "session.create",
        route(
            Method::Post,
            "/api/session",
            NO_QUERY,
            body(&[
                "id",
                "parentID",
                "title",
                "agent",
                "model",
                "location",
                "metadata",
                "permissions",
            ]),
        ),
    ),
    (
        "session.get",
        route(Method::Get, "/api/session/{sessionID}", NO_QUERY, NONE),
    ),
    (
        "session.list",
        route(
            Method::Get,
            "/api/session",
            &[
                "limit",
                "order",
                "search",
                "parentID",
                "directory",
                "project",
                "subpath",
                "cursor",
            ],
            NONE,
        ),
    ),
    (
        "session.active",
        route(Method::Get, "/api/session/active", NO_QUERY, NONE),
    ),
    (
        "session.update",
        route(
            Method::Patch,
            "/api/session/{sessionID}",
            NO_QUERY,
            body(&["title", "metadata", "permissions"]),
        ),
    ),
    (
        "session.switchAgent",
        route(
            Method::Post,
            "/api/session/{sessionID}/agent",
            NO_QUERY,
            body(&["agent"]),
        ),
    ),
    (
        "session.switchModel",
        route(
            Method::Post,
            "/api/session/{sessionID}/model",
            NO_QUERY,
            body(&["model"]),
        ),
    ),
    (
        "session.interrupt",
        route(
            Method::Post,
            "/api/session/{sessionID}/interrupt",
            &["resume"],
            NONE,
        ),
    ),
    (
        "session.prompt",
        route(
            Method::Post,
            "/api/session/{sessionID}/prompt",
            NO_QUERY,
            body(&[
                "id", "text", "files", "agents", "skills", "metadata", "delivery", "resume",
            ]),
        ),
    ),
    (
        "session.command",
        route(
            Method::Post,
            "/api/session/{sessionID}/command",
            NO_QUERY,
            body(&["name", "text", "files", "agents", "skills", "delivery"]),
        ),
    ),
    (
        "session.environment",
        route(
            Method::Put,
            "/api/session/{sessionID}/environment",
            NO_QUERY,
            body(&["variables"]),
        ),
    ),
    (
        "session.instructions.put",
        route(
            Method::Put,
            "/api/experimental/session/{sessionID}/instructions/entries/{key}",
            NO_QUERY,
            body(&["value"]),
        ),
    ),
    // The session's messages, permissions, forms and inbox.
    (
        "session.message.get",
        route(
            Method::Get,
            "/api/session/{sessionID}/message/{messageID}",
            NO_QUERY,
            NONE,
        ),
    ),
    (
        "message.list",
        route(
            Method::Get,
            "/api/session/{sessionID}/message",
            &["limit", "order", "cursor", "type"],
            NONE,
        ),
    ),
    (
        "permission.list",
        route(
            Method::Get,
            "/api/session/{sessionID}/permission",
            NO_QUERY,
            NONE,
        ),
    ),
    (
        "permission.reply",
        route(
            Method::Post,
            "/api/session/{sessionID}/permission/{requestID}/reply",
            NO_QUERY,
            body(&["decision", "message"]),
        ),
    ),
    (
        "session.form.list",
        route(Method::Get, "/api/session/{sessionID}/form", NO_QUERY, NONE),
    ),
    (
        "session.form.reply",
        route(
            Method::Post,
            "/api/session/{sessionID}/form/{formID}/reply",
            NO_QUERY,
            body(&["answer"]),
        ),
    ),
    (
        "session.form.cancel",
        route(
            Method::Delete,
            "/api/session/{sessionID}/form/{formID}",
            &["message"],
            NONE,
        ),
    ),
    (
        "session.inbox.list",
        route(
            Method::Get,
            "/api/session/{sessionID}/inbox",
            NO_QUERY,
            NONE,
        ),
    ),
    // Shells.
    (
        "shell.list",
        route(Method::Get, "/api/shell", LOCATION, NONE),
    ),
    (
        "shell.get",
        route(Method::Get, "/api/shell/{id}", LOCATION, NONE),
    ),
    (
        "shell.remove",
        route(Method::Delete, "/api/shell/{id}", LOCATION, NONE),
    ),
    // The catalog.
    (
        "model.list",
        route(Method::Get, "/api/model", LOCATION, NONE),
    ),
    (
        "model.default",
        route(Method::Get, "/api/model/default", LOCATION, NONE),
    ),
    (
        "command.list",
        route(Method::Get, "/api/command", LOCATION, NONE),
    ),
    (
        "skill.list",
        route(Method::Get, "/api/skill", LOCATION, NONE),
    ),
    (
        "agent.list",
        route(Method::Get, "/api/agent", LOCATION, NONE),
    ),
    (
        "plugin.list",
        route(Method::Get, "/api/plugin", LOCATION, NONE),
    ),
    ("mcp.list", route(Method::Get, "/api/mcp", LOCATION, NONE)),
    // ace's MCP server in a location, and the plugins' two RPCs.
    (
        "mcp.add",
        route(
            Method::Put,
            "/api/experimental/mcp/{server}",
            LOCATION,
            body(&["config"]),
        ),
    ),
    (
        "mcp.connect",
        route(
            Method::Post,
            "/api/experimental/mcp/{server}/connect",
            LOCATION,
            NONE,
        ),
    ),
    (
        "mcp.disconnect",
        route(
            Method::Post,
            "/api/experimental/mcp/{server}/disconnect",
            LOCATION,
            NONE,
        ),
    ),
    (
        "agent.environment.settle",
        route(
            Method::Post,
            "/api/rpc/ace.agent.environment/settle",
            LOCATION,
            body(&["input"]),
        ),
    ),
    (
        "mcp.readiness.ready",
        route(
            Method::Post,
            "/api/rpc/ace.mcp.readiness/ready",
            LOCATION,
            body(&["input"]),
        ),
    ),
    (
        "integration.list",
        route(Method::Get, "/api/integration", LOCATION, NONE),
    ),
    // The event stream: `client.rs` reads its body as bytes, the SDK as SSE.
    (
        "event.subscribe",
        route(Method::Get, "/api/event", NO_QUERY, NONE),
    ),
];

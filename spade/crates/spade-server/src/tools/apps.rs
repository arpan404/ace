//! A bot finding and asking for the person's apps (ADR 0131, amendment 1): `apps_find {need}`
//! looks up which catalogue apps fit a need and whether each is connected, and
//! `app_connect_request {app, why}` asks the person to connect one, answered in the turn loop
//! (`engine::apps`). Neither connects anything or sees a secret.

use std::sync::Arc;

use serde_json::{Value, json};
use spade_connect::{Connectors, Ready};
use spade_core::question::connect::{APP_CONNECT_REQUEST, APPS_FIND};
use spade_core::tools::{Risk, ToolDef};
use spade_models::ToolSpec;

use super::{Tool, ToolFuture, ToolOutput};

/// The most apps `apps_find` names.
const MOST_FOUND: usize = 5;

const FIND_ABOUT: &str = "Find which of the person's apps fit a need (\"Linear board\", \"my \
inbox\", \"deploys\"): each app's id and name, whether you can use it now, and how the person \
connects it. Use it when a task needs an app you don't have.";

const REQUEST_ABOUT: &str = "Ask the person to connect an app you need, or to let you use one \
they connected for another bot. Shows them a card with your reason; only they connect it, and you \
never see their sign-in or key. Waits until they connect it (then its tools are yours: find them \
with tool_search), choose Later, or say Not now; carry on without it then. Give `app` as \
apps_find names it and `why` in one short line the person reads.";

/// `apps_find`, for one bot.
pub struct AppsFind {
    hub: Arc<Connectors>,
    agent: String,
    is_main: bool,
}

impl AppsFind {
    pub fn new(hub: Arc<Connectors>, agent: String, is_main: bool) -> Self {
        Self {
            hub,
            agent,
            is_main,
        }
    }
}

fn string(about: &str) -> Value {
    json!({ "type": "string", "description": about })
}

impl Tool for AppsFind {
    fn def(&self) -> ToolDef {
        ToolDef {
            spec: ToolSpec {
                name: APPS_FIND.to_owned(),
                description: FIND_ABOUT.to_owned(),
                schema: json!({ "type": "object",
                    "properties": { "need": string("What the app is for, in a few words.") },
                    "required": ["need"] }),
            },
            risk: Risk::Read,
            untrusted_output: false,
            deferred: false,
            background: false,
        }
    }

    fn effect(&self, _arguments: &Value) -> Option<spade_core::effect::Effect> {
        Some(spade_core::effect::Effect::Read)
    }

    fn run(&self, _key: &str, arguments: Value) -> ToolFuture {
        let (hub, agent, is_main) = (self.hub.clone(), self.agent.clone(), self.is_main);
        Box::pin(async move {
            let need = arguments.get("need").and_then(Value::as_str).unwrap_or("");
            if need.trim().is_empty() {
                return ToolOutput::error("Give `need`: what the app is for.");
            }
            ToolOutput::ok(found(&hub, &agent, is_main, need).await)
        })
    }
}

/// The apps that fit, one JSON object each, then what to do next.
async fn found(hub: &Connectors, agent: &str, is_main: bool, need: &str) -> String {
    let access = hub.access(agent, is_main);
    let connectors = hub.list();
    let listed = hub.listed().await;
    let entries: Vec<spade_connect::Entry> = listed.iter().map(|l| l.entry.clone()).collect();
    let fit = spade_connect::fit::fitting(&entries, need, MOST_FOUND);
    if fit.is_empty() {
        return "No app in Spade's catalogue fits that. The person can add any app's own MCP server \
                by address in Settings, Spade, Apps."
            .to_owned();
    }
    let lines: Vec<String> = fit
        .iter()
        .map(|entry| {
            let ready = listed
                .iter()
                .find(|l| l.entry.id == entry.id)
                .map_or(Ready::Later, |l| l.ready);
            let mine: Vec<&spade_connect::View> = connectors
                .iter()
                .filter(|c| c.catalogue.as_deref() == Some(entry.id.as_str()))
                .collect();
            let connected = if mine
                .iter()
                .any(|c| c.state != "needs_reconnect" && access.allows(&c.id))
            {
                "yours"
            } else if mine.iter().any(|c| c.state == "needs_reconnect") {
                "needs_reconnect"
            } else if !mine.is_empty() {
                "connected_for_other_bots"
            } else {
                "no"
            };
            let signs_in = match ready {
                Ready::SignIn => "sign_in",
                Ready::Key => "key",
                Ready::Later => "not_available_yet",
            };
            json!({ "id": entry.id, "name": entry.name, "connected": connected,
                    "signs_in": signs_in })
            .to_string()
        })
        .collect();
    format!(
        "{}\n\n`yours`: find its tools with tool_search. Otherwise ask the person with \
         {APP_CONNECT_REQUEST} {{app, why}}; `not_available_yet` apps can't be connected yet.",
        lines.join("\n")
    )
}

/// `app_connect_request`: offered like any tool, answered by the turn loop with a card.
pub struct AppConnectRequest;

impl Tool for AppConnectRequest {
    fn def(&self) -> ToolDef {
        ToolDef {
            spec: ToolSpec {
                name: APP_CONNECT_REQUEST.to_owned(),
                description: REQUEST_ABOUT.to_owned(),
                schema: json!({ "type": "object",
                    "properties": {
                        "app": string("The app's id or name, as apps_find lists it."),
                        "why": string("One short line for the person: what you need it for.") },
                    "required": ["app", "why"],
                    "additionalProperties": false }),
            },
            risk: Risk::Read,
            untrusted_output: false,
            deferred: false,
            background: false,
        }
    }

    fn effect(&self, _arguments: &Value) -> Option<spade_core::effect::Effect> {
        Some(spade_core::effect::Effect::Read)
    }

    fn run(&self, _key: &str, _arguments: Value) -> ToolFuture {
        Box::pin(async { ToolOutput::error("app_connect_request is answered by the person.") })
    }
}

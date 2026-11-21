//! MCP Apps pages as panels (ADR 0202 §4). When an app's tool that links a `ui://` page runs for
//! a bot, its page is read once with `resources/read`, checked (`spade_core::app_page`: none
//! that needs the network), kept by its sha256 beside packages' panel pages, and shown as a panel
//! of that app beside the bot's conversation, with the tool's input and result as its state. What
//! the page sends back reaches the bot as the page's, never the person's.

use std::collections::BTreeMap;
use std::sync::Arc;

use base64::Engine as _;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use spade_core::app_page::{self, AppTool, Refusal};
use spade_core::event::{Event, Known, PanelSender};
use spade_core::panel::{MOST_PAGE_BYTES, MOST_STATE_BYTES, Refused};
use spade_mcp::{McpTool, McpToolResult};
use spade_store::{page_key, panels_key};

use super::{Engine, PanelError};

/// The settings key that names bot `agent`'s app pages, by panel: inside the range the page
/// collection reads, so a page an app panel shows is kept.
fn apps_key(agent: &str) -> String {
    format!("{}:apps", panels_key(agent))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// The page's text and what its contents say about it, from a `resources/read` answer.
fn contents(read: &Value, uri: &str) -> Result<(String, Value, String), Refusal> {
    let listed = read["contents"].as_array().cloned().unwrap_or_default();
    let item = listed
        .iter()
        .find(|c| c["uri"] == uri)
        .or_else(|| listed.first())
        .ok_or_else(|| Refusal::Unreadable("the app sent no page".to_owned()))?;
    let mime = item["mimeType"].as_str().unwrap_or_default().to_owned();
    let text = match (item["text"].as_str(), item["blob"].as_str()) {
        (Some(text), _) => text.to_owned(),
        (None, Some(blob)) => {
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(blob)
                .map_err(|_| Refusal::Unreadable("its page isn't readable".to_owned()))?;
            String::from_utf8(bytes)
                .map_err(|_| Refusal::Unreadable("its page isn't text".to_owned()))?
        }
        (None, None) => return Err(Refusal::Unreadable("the app sent no page".to_owned())),
    };
    if text.len() > MOST_PAGE_BYTES {
        return Err(Refusal::Unreadable(
            "its page is larger than 1 MB".to_owned(),
        ));
    }
    Ok((text, item["_meta"]["ui"].clone(), mime))
}

/// The result as the page receives it, within a panel state's size.
fn bounded(result: &McpToolResult) -> Value {
    let full = spade_mcp::result_json(result);
    if serde_json::to_string(&full).map_or(usize::MAX, |t| t.len()) <= MOST_STATE_BYTES / 2 {
        return full;
    }
    json!({ "content": [{ "type": "text", "text": "The result was too large to show here." }] })
}

impl Engine {
    /// Sets the person's outside A2A agents (ADR 0202 §5), once.
    pub fn set_outside_agents(&self, agents: Arc<crate::a2a::OutsideAgents>) {
        let _ = self.outside_agents.set(agents);
    }

    /// The person's outside A2A agents, when the server set them.
    pub fn outside_agents(&self) -> Option<Arc<crate::a2a::OutsideAgents>> {
        self.outside_agents.get().cloned()
    }

    /// After app `connector` (`app` by name) ran `tool` with `arguments` for the call with `key`
    /// (`<conversation>.<call>`): its page as that app's panel, if the tool links one. What the
    /// bot reads besides the tool's answer: that the page shows, or why it doesn't.
    pub(crate) async fn show_app_page(
        self: &Arc<Self>,
        key: &str,
        connector: &str,
        app: &str,
        tool: &McpTool,
        arguments: &Value,
        result: &McpToolResult,
    ) -> Option<String> {
        let uri = tool.page.as_deref()?;
        let (conversation, call_id) = key.split_once('.')?;
        if self.helper_of(conversation).is_some() {
            return None;
        }
        let agent = self.agent_of(conversation)?;
        let hub = self.apps.get()?.clone();
        let read = hub.read_resource(connector, uri).await;
        let page = match read {
            Ok(read) => contents(&read, uri).and_then(|(text, ui, mime)| {
                app_page::check(&mime, &ui).map(|withheld| (text, withheld))
            }),
            Err(error) => Err(Refusal::Unreadable(error.to_string())),
        };
        let id = app_page::panel_id(
            connector,
            &hex(&Sha256::digest(format!("{connector}\n{uri}").as_bytes())),
        );
        let tools: Vec<AppTool> = hub
            .page_tools(connector)
            .into_iter()
            .map(|t| AppTool {
                name: t.name,
                model: t.for_model,
                app: t.for_app,
            })
            .collect();
        let (hash, withheld) = match &page {
            Ok((text, withheld)) => {
                let hash = hex(&Sha256::digest(text.as_bytes()));
                if let Err(error) = self.keep_app_page(&agent, &id, &hash, text) {
                    tracing::warn!(%error, "an app's page could not be kept");
                    return None;
                }
                (Some(hash), withheld.clone())
            }
            Err(_) => (None, Vec::new()),
        };
        let shown = match (&hash, &page) {
            (Some(hash), _) => Ok(hash.as_str()),
            (None, Err(refusal)) => Err(refusal),
            (None, Ok(_)) => return None,
        };
        let facts = app_page::facts(connector, app, &tool.name, uri, shown, &tools, &withheld);
        let data = json!({ "app": facts, "input": arguments, "result": bounded(result) });
        let stored = {
            let _order = self.record_lock.lock().unwrap_or_else(|p| p.into_inner());
            let events = self.load(conversation).ok()?;
            if spade_core::panel::updated_by(&events, call_id) {
                None
            } else {
                Some(self.append(
                    conversation,
                    &Event::Known(Known::PanelUpdated {
                        surface: id,
                        call_id: call_id.to_owned(),
                        data,
                    }),
                ))
            }
        };
        if let Some(Ok(_)) = stored {
            self.announce(conversation);
        }
        Some(match page {
            Ok((_, withheld)) if withheld.is_empty() => {
                format!("{app}'s page for this shows beside the chat, as a panel.")
            }
            Ok((_, withheld)) => format!(
                "{app}'s page for this shows beside the chat, as a panel, without {}: Spade's \
                 panels reach nothing outside the page.",
                withheld.join(", ")
            ),
            Err(refusal) => refusal.words(),
        })
    }

    fn keep_app_page(&self, agent: &str, id: &str, hash: &str, text: &str) -> Result<(), String> {
        let store = self.store();
        let key = apps_key(agent);
        let mut named: BTreeMap<String, String> = store
            .setting(&key)
            .ok()
            .flatten()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default();
        named.insert(id.to_owned(), hash.to_owned());
        let named = serde_json::to_string(&named).map_err(|e| e.to_string())?;
        let page = page_key(hash);
        store
            .set_settings(&[(page.as_str(), Some(text)), (key.as_str(), Some(&named))])
            .map_err(|error| error.to_string())
    }

    /// The app panels shown in conversation `events`, each with its app's facts and state, the
    /// latest of each.
    pub(crate) fn app_panels(events: &[Event]) -> Vec<(String, Value)> {
        let mut latest: BTreeMap<String, Value> = BTreeMap::new();
        for event in events {
            if let Event::Known(Known::PanelUpdated { surface, data, .. }) = event
                && app_page::is_app_panel(surface)
            {
                latest.insert(surface.clone(), data.clone());
            }
        }
        latest.into_iter().collect()
    }

    /// A request from app panel `surface`'s page in conversation `id`: it reaches the bot once,
    /// as the page's; context waits for the bot's next turn.
    pub(crate) fn act_on_app_panel(
        self: &Arc<Self>,
        id: &str,
        surface: &str,
        key: &str,
        action: &str,
        value: Option<Value>,
        by: PanelSender,
    ) -> Result<(), PanelError> {
        let events = self.load(id)?;
        let app = Self::app_panels(&events)
            .into_iter()
            .find(|(panel, _)| panel == surface)
            .map(|(_, data)| data["app"].clone())
            .ok_or(PanelError::Refused(Refused::NoPanel))?;
        let known =
            app_page::act(&app, surface, key, action, value, by).map_err(PanelError::Refused)?;
        let event = Event::Known(known);
        if app_page::wakes(action) {
            if let spade_store::Delivered::Stored(_) = self.deliver_as(id, &event, None)? {
                self.announce(id);
            }
            return Ok(());
        }
        let stored = {
            let _order = self.record_lock.lock().unwrap_or_else(|p| p.into_inner());
            let events = self.load(id)?;
            if spade_core::panel::acted(&events, key) {
                return Ok(());
            }
            self.append(id, &event)?
        };
        drop(stored);
        self.announce(id);
        Ok(())
    }
}

//! Connector tools (ADR 0131): each connected app's tools, offered deferred like ace's, to the
//! bots the person allowed. A conversation's bot is looked up from the database on each listing,
//! so an allow list change applies from the next step.

use std::sync::Arc;

use serde_json::Value;
use spade_connect::{CallError, ConnectorTool, Connectors};
use spade_core::context::MAYBE_RAN;
use spade_core::question::elicit;
use spade_core::tools::{Risk, ToolDef};
use spade_mcp::Risk as McpRisk;
use spade_mcp::{AskFuture, Asker, Form, Reply};
use spade_models::ToolSpec;
use spade_store::Store;

use super::{EngineHandle, Tool, ToolFuture, ToolOutput, ToolSource};
use crate::engine::Given;

/// Connector tools, limited per conversation to what its bot may use.
pub struct ConnectorSource {
    hub: Arc<Connectors>,
    /// Its own connection to Spade's database, to find a conversation's bot.
    store: Store,
    /// The engine, which shows an app's forms to the person mid-call (ADR 0202 §2). Without it
    /// every form is declined.
    forms: Option<EngineHandle>,
}

impl ConnectorSource {
    pub fn new(hub: Arc<Connectors>, store: Store) -> Self {
        Self {
            hub,
            store,
            forms: None,
        }
    }

    /// Shows a form an app sends during a call on a card from the bot, through `engine`.
    #[must_use]
    pub fn with_forms(mut self, engine: EngineHandle) -> Self {
        self.forms = Some(engine);
        self
    }
}

impl ToolSource for ConnectorSource {
    /// None without a conversation: a connector is only ever used by a bot allowed it.
    fn tools(&self) -> Vec<Arc<dyn Tool>> {
        Vec::new()
    }

    fn tools_for(&self, conversation: &str) -> Vec<Arc<dyn Tool>> {
        let agent = match self.store.agent_for_conversation(conversation) {
            Ok(Some(agent)) => agent,
            Ok(None) => return Vec::new(),
            Err(error) => {
                tracing::warn!(%error, "could not look up a conversation's bot; no connectors");
                return Vec::new();
            }
        };
        let is_main = agent.kind == crate::engine::MAIN;
        let mut tools: Vec<Arc<dyn Tool>> = vec![
            Arc::new(super::apps::AppsFind::new(
                self.hub.clone(),
                agent.id.clone(),
                is_main,
            )),
            Arc::new(super::apps::AppConnectRequest),
        ];
        tools.extend(
            self.hub
                .tools_for(&agent.id, is_main)
                .into_iter()
                .map(|tool| {
                    Arc::new(ConnectorCall {
                        def: def(&tool),
                        tool,
                        hub: self.hub.clone(),
                        forms: self.forms.clone(),
                    }) as Arc<dyn Tool>
                }),
        );
        tools
    }
}

/// How a connector tool is offered: deferred, its risk from the server's hints, and its output
/// always untrusted (it is the app's data, which strangers may have written).
pub fn def(tool: &ConnectorTool) -> ToolDef {
    let about = if tool.tool.description.is_empty() {
        tool.tool.name.clone()
    } else {
        tool.tool.description.clone()
    };
    ToolDef {
        spec: ToolSpec {
            name: tool.name.clone(),
            description: format!("{}: {about}", tool.connector_name),
            schema: tool.tool.input_schema.clone(),
        },
        risk: match tool.tool.risk {
            McpRisk::Read => Risk::Read,
            McpRisk::Write => Risk::Write,
            McpRisk::Destructive => Risk::Destructive,
        },
        untrusted_output: true,
        deferred: true,
        background: false,
    }
}

struct ConnectorCall {
    def: ToolDef,
    tool: ConnectorTool,
    hub: Arc<Connectors>,
    forms: Option<EngineHandle>,
}

impl ConnectorCall {
    /// What its server and catalogue entry say about it: its annotations, and the catalogue's
    /// word for this tool and for every tool of the app (the least it does).
    fn facts(&self) -> spade_core::effect::Mcp {
        use spade_core::effect::{Effect, Mcp};
        let entry = self
            .tool
            .catalogue
            .as_deref()
            .and_then(|id| self.hub.catalogue().iter().find(|entry| entry.id == id));
        let declared = [
            entry.and_then(|entry| entry.effects.get(&self.tool.tool.name)),
            entry.and_then(|entry| entry.every_tool.as_ref()),
        ]
        .into_iter()
        .flatten()
        .filter_map(Effect::declared)
        .max();
        Mcp {
            read_only: self.def.risk == Risk::Read,
            destructive: self.def.risk == Risk::Destructive,
            annotated: self.tool.tool.annotated,
            declared,
            // Only an entry ace reviewed vouches for its server's annotations (ADR 0202 §2).
            trusted: entry.is_some_and(|entry| entry.trusted_annotations),
        }
    }
}

impl Tool for ConnectorCall {
    fn def(&self) -> ToolDef {
        self.def.clone()
    }

    /// What its catalogue entry declares, raised by its annotations (ADR 0171): with no entry
    /// for it, a connector's tool, which holds the person's sign-in, declares nothing.
    fn effect(&self, _arguments: &Value) -> Option<spade_core::effect::Effect> {
        spade_core::effect::mcp(self.facts())
    }

    fn hints(&self) -> Option<spade_core::effect::Mcp> {
        Some(self.facts())
    }

    fn connected_app(&self) -> bool {
        true
    }

    /// The connection, its server's address, the server's own tool name and its schema.
    fn identity(&self) -> String {
        format!(
            "connector:{}@{}:{}#{}",
            self.tool.connector,
            self.tool.server,
            self.tool.tool.name,
            super::schema_hash(&self.tool.tool.input_schema)
        )
    }

    fn run(&self, key: &str, arguments: Value) -> ToolFuture {
        let hub = self.hub.clone();
        let (connector, name) = (self.tool.connector.clone(), self.tool.tool.name.clone());
        let app = self.tool.connector_name.clone();
        let forms = self.forms.clone();
        let asker = forms.clone().map(|engine| {
            Arc::new(AppForm {
                engine,
                key: key.to_owned(),
                app: app.clone(),
            }) as Arc<dyn Asker>
        });
        let key = key.to_owned();
        let tool = self.tool.tool.clone();
        Box::pin(async move {
            let answer = hub
                .call_asking(&connector, &name, arguments.clone(), asker)
                .await;
            let engine = forms.as_ref().and_then(EngineHandle::get);
            let secret = engine
                .as_ref()
                .is_some_and(|engine| engine.asked_for_secret(&key));
            match answer {
                // Its app asked for a secret: the form was never shown, and the call fails.
                Ok(result) if secret => {
                    let said = super::ace::output(Ok(result)).content;
                    ToolOutput {
                        untrusted: true,
                        ..ToolOutput::error(format!(
                            "{}, so Spade declined the form and the person never saw it. \
                             {app} answered after:\n{said}",
                            elicit::SECRET
                        ))
                    }
                }
                Ok(result) => {
                    // A tool that links an app's page shows it as a panel (ADR 0202 §4).
                    let page = match (&engine, &tool.page) {
                        (Some(engine), Some(_)) => {
                            engine
                                .show_app_page(&key, &connector, &app, &tool, &arguments, &result)
                                .await
                        }
                        _ => None,
                    };
                    let mut output = super::ace::output(Ok(result));
                    if let Some(page) = page {
                        output.content = format!("{}\n\n{page}", output.content);
                    }
                    output
                }
                Err(error @ CallError::NeedsReconnect(_)) => ToolOutput {
                    reconnect: Some(connector),
                    ..output(error)
                },
                Err(error) => output(error),
            }
        })
    }
}

/// Shows the forms an app sends during one call to the person, on a card from the bot labelled
/// with the app's name, and gives back only their answer on it (ADR 0202 §2).
struct AppForm {
    engine: EngineHandle,
    key: String,
    app: String,
}

impl Asker for AppForm {
    fn ask(&self, form: Form) -> AskFuture {
        let Some(engine) = self.engine.get() else {
            return Box::pin(std::future::ready(Reply::Cancel));
        };
        let Some(shown) = engine.show_form(&self.key, &self.app, &form.message, &form.schema)
        else {
            return Box::pin(std::future::ready(Reply::Decline));
        };
        Box::pin(async move {
            match shown.answer.await {
                Ok(Given::Answers(answers)) => {
                    match elicit::answer(&form.schema, &shown.questions, &answers) {
                        elicit::Answer::Accept(content) => Reply::Accept(content),
                        elicit::Answer::Decline => Reply::Decline,
                    }
                }
                Ok(Given::Declined) => Reply::Decline,
                Ok(Given::Cancelled) | Err(_) => Reply::Cancel,
            }
        })
    }
}

/// What a call that returned no result tells the model.
fn output(error: CallError) -> ToolOutput {
    match error {
        CallError::NotRun(why) => {
            ToolOutput::error(format!("Not run: {why}. It is safe to try again."))
        }
        CallError::MaybeRan(why) => ToolOutput::maybe_ran(format!("{MAYBE_RAN} ({why})")),
        error @ CallError::NeedsReconnect(_) => ToolOutput::error(format!(
            "Not run: {error}. Ask them with app_connect_request; never ask for a key in the chat."
        )),
        CallError::Failed(why) => ToolOutput::error(why),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_effect_the_shipped_catalogue_declares_is_one_spade_reads() {
        use spade_core::effect::Effect;
        let mut declared = 0;
        for entry in spade_connect::catalogue::shipped() {
            if let Some(said) = &entry.every_tool {
                let read = Effect::declared(said);
                assert!(read.is_some_and(|e| e != Effect::Unknown), "{}", entry.id);
                declared += 1;
            }
            for (tool, said) in &entry.effects {
                let read = Effect::declared(said);
                assert!(
                    read.is_some_and(|e| e != Effect::Unknown),
                    "{}: {tool}",
                    entry.id
                );
                declared += 1;
            }
        }
        // Every tool of a payments app pays, so they reach the person rather than the reviewer.
        let pays = |id: &str| {
            spade_connect::catalogue::shipped().iter().any(|e| {
                e.id == id && e.every_tool.as_ref().and_then(Effect::declared) == Some(Effect::Pay)
            })
        };
        assert!(pays("stripe") && pays("paypal") && pays("square") && pays("mercury"));
        assert!(declared >= 4);
    }

    #[test]
    fn an_app_wide_declaration_sends_every_tool_to_the_person_even_read_only_ones() {
        use spade_core::effect::{Effect, Mcp, mcp};
        // Payments and banking, a support inbox, mail and chat that write in the person's name.
        // (Identity and secret stores are not in the catalogue yet.)
        let table = [
            ("stripe", Effect::Pay),
            ("paypal", Effect::Pay),
            ("square", Effect::Pay),
            ("mercury", Effect::Pay),
            ("ramp", Effect::Pay),
            ("intercom", Effect::SendAsPerson),
            ("resend", Effect::SendAsPerson),
            ("google-chat", Effect::SendAsPerson),
        ];
        let entries = spade_connect::catalogue::shipped();
        for (id, want) in table {
            let entry = entries.iter().find(|e| e.id == id);
            let declared = entry
                .and_then(|e| e.every_tool.as_ref())
                .and_then(Effect::declared);
            assert_eq!(declared, Some(want), "{id}");
            for read_only in [false, true] {
                let effect = mcp(Mcp {
                    read_only,
                    annotated: true,
                    declared,
                    ..Mcp::default()
                });
                assert_eq!(effect, Some(want), "{id} read_only={read_only}");
            }
        }
    }

    #[test]
    fn a_call_cut_off_after_sending_never_reads_as_not_run() {
        let unknown = output(CallError::MaybeRan("connection reset".into()));
        assert!(unknown.uncertain && unknown.content.starts_with("Unknown outcome"));
        let not_run = output(CallError::NotRun("Linear could not be reached".into()));
        assert!(!not_run.uncertain && not_run.content.contains("safe to try again"));
        let expired = output(CallError::NeedsReconnect("Linear".into()));
        assert!(expired.content.contains("reconnect"), "{}", expired.content);
    }
}

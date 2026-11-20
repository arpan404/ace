//! A bot asking the person for an app (ADR 0131, amendment 1; docs/connectors.md "A bot asks"):
//! `app_connect_request` makes a connect card, a question card of kind `connect` (ADR 0154), from
//! the catalogue and the person's connectors. Only the person connects; Spade then lets the bot
//! that asked use the app (or every bot, when the person says so) and answers the card, and the
//! turn carries on with the app's tools. A call refused because its sign-in expired waits on a
//! Reconnect card the same way, and runs again once the app is back.

use std::sync::Arc;

use serde_json::Value;
use spade_connect::{Access, Connectors, Ready, View as ConnectorView};
use spade_core::event::{Call, Event, Known};
use spade_core::question::connect::{self, Connect, Connected, Way};
use spade_core::question::{self, Standing};

use super::{Engine, MAIN, QuestionError};
use crate::tools::ToolOutput;

/// The longest reason a bot gives for wanting an app, in characters.
pub const WHY_CHARS: usize = 300;

/// What `app_connect_request` came to.
pub(super) enum Requested {
    /// Answered at once: the bot has the app already, or its arguments were refused.
    Answered(ToolOutput),
    /// A card was stored; the turn waits on it.
    Waiting,
    /// The work was stopped first.
    Stopped,
}

/// The card for an app a bot asks for, or why there is none.
pub(super) enum Card {
    /// The bot may use it already; its name.
    Has(String),
    /// No such app: what to say.
    Unknown(String),
    Ask(Connect),
}

/// A connector the bot can use now, or a reason it can't.
fn usable(view: &ConnectorView) -> bool {
    !matches!(view.state, "needs_reconnect" | "signing_in")
}

impl Engine {
    /// The person's apps, once the server has set them.
    pub(crate) fn apps(&self) -> Option<&Arc<Connectors>> {
        self.apps.get()
    }

    /// `app_connect_request {app, why}` from call `call` of reply `reply` in `id`.
    pub(super) async fn app_connect_request(
        &self,
        id: &str,
        reply: &str,
        call: &Call,
        arguments: &Value,
    ) -> Result<Requested, String> {
        let Some(hub) = self.apps() else {
            return Ok(Requested::Answered(ToolOutput::error(
                "Apps can't be connected here.",
            )));
        };
        let (app, why) = match parse(arguments) {
            Ok(asked) => asked,
            Err(why) => return Ok(Requested::Answered(ToolOutput::error(why))),
        };
        let Some(agent) = self
            .store
            .agent_for_conversation(id)
            .map_err(|e| e.to_string())?
        else {
            return Ok(Requested::Answered(ToolOutput::error(
                "Only a bot can ask for an app.",
            )));
        };
        let card = match self.connect_card(hub, &agent, &app).await {
            Card::Has(name) => {
                return Ok(Requested::Answered(ToolOutput::ok(connect::already(&name))));
            }
            Card::Unknown(why) => return Ok(Requested::Answered(ToolOutput::error(why))),
            Card::Ask(card) => card,
        };
        let way = card.way;
        let later = way == Way::Later;
        let unavailable = connect::dismissed(&card);
        let mut events = vec![asked(reply, &call.id, why, card)];
        // Nothing can come of waiting: the card says it isn't available yet, and the bot reads
        // that at once.
        if later {
            events.push(Event::Known(Known::QuestionDismissed {
                call_id: call.id.clone(),
                late: false,
            }));
        }
        match self.record_all_unless_stopped(id, reply, &events) {
            Ok(true) if later => Ok(Requested::Answered(ToolOutput::ok(unavailable))),
            Ok(true) => Ok(Requested::Waiting),
            Ok(false) => Ok(Requested::Stopped),
            Err(error) => Err(error.to_string()),
        }
    }

    /// The connect card `agent` would show for `app` (a catalogue id or name, or a server added
    /// by address): what way it connects, from the catalogue and the person's connectors.
    /// `Has` when the bot may use it already.
    pub(super) async fn connect_card(
        &self,
        hub: &Connectors,
        agent: &spade_store::Agent,
        app: &str,
    ) -> Card {
        let access = hub.access(&agent.id, agent.kind == MAIN);
        let connectors = hub.list();
        let listed = hub.listed().await;
        let entry = listed
            .iter()
            .find(|l| l.entry.id == app || l.entry.name.eq_ignore_ascii_case(app));
        // A server the person added by address is asked for by its connector's id or name.
        let added = connectors
            .iter()
            .find(|c| c.catalogue.is_none() && (c.id == app || c.name.eq_ignore_ascii_case(app)));
        let (key, name) = match (entry, added) {
            (Some(listed), _) => (listed.entry.id.clone(), listed.entry.name.clone()),
            (None, Some(view)) => (view.id.clone(), view.name.clone()),
            (None, None) => return Card::Unknown(unknown_app(hub, app)),
        };
        let existing: Vec<&ConnectorView> = connectors
            .iter()
            .filter(|c| c.catalogue.as_deref() == Some(key.as_str()) || c.id == key)
            .collect();
        if existing.iter().any(|c| usable(c) && access.allows(&c.id)) {
            return Card::Has(name);
        }
        let usable_one = existing.iter().find(|c| usable(c));
        let expired = existing.iter().find(|c| c.state == "needs_reconnect");
        let way = match (usable_one, expired, entry.map(|l| l.ready)) {
            (Some(_), _, _) => Way::Use,
            (None, Some(_), _) => Way::Reconnect,
            (None, None, Some(Ready::SignIn)) => Way::SignIn,
            (None, None, Some(Ready::Key)) => Way::Key,
            (None, None, Some(Ready::Later)) => Way::Later,
            // Added by address, signing in now: the person finishes that sign-in.
            (None, None, None) => Way::Reconnect,
        };
        Card::Ask(Connect {
            app: key,
            name,
            way,
            can: entry
                .map(|l| spade_connect::fit::can_do(l.entry))
                .unwrap_or_default(),
            connector: usable_one.or(expired).map(|c| c.id.clone()),
            key_url: entry.and_then(|l| l.entry.key_url.clone()),
            retry: false,
        })
    }

    /// A call to `connector` refused because its sign-in expired: holds it on a Reconnect card
    /// instead of answering it, so the person reconnects and it runs again. `None` when it can't
    /// wait (no such connector), and the call is answered as it came back.
    pub(super) fn reconnect_card(
        &self,
        reply: &str,
        call: &Call,
        connector: &str,
    ) -> Option<Event> {
        let hub = self.apps()?;
        let view = hub.get(connector)?;
        let entry = view
            .catalogue
            .as_deref()
            .and_then(|c| hub.catalogue().iter().find(|e| e.id == c));
        let card = Connect {
            app: view.catalogue.clone().unwrap_or_else(|| view.id.clone()),
            name: view.name.clone(),
            way: Way::Reconnect,
            can: entry.map(spade_connect::fit::can_do).unwrap_or_default(),
            connector: Some(view.id.clone()),
            key_url: entry.and_then(|e| e.key_url.clone()),
            retry: true,
        };
        let why = format!(
            "{} signed Spade out, so this step didn't run. Reconnect it and it runs again.",
            view.name
        );
        Some(asked(reply, &call.id, why, card))
    }

    /// The person connected the app a connect card in `id` asks for, as `connector`: lets the bot
    /// that asked use it (every bot with `everyone`), then answers the card, and every other open
    /// card in the conversation for the same app. A card still waiting wakes its turn; one left
    /// for later is delivered like a late answer.
    pub fn app_connected(
        self: &Arc<Self>,
        id: &str,
        call_id: &str,
        connector: &str,
        everyone: bool,
    ) -> Result<(), QuestionError> {
        if !self.reachable(id)? {
            return Err(QuestionError::NotFound);
        }
        let hub = self
            .apps()
            .ok_or_else(|| QuestionError::Invalid("Spade has no apps here.".to_owned()))?;
        let events = self.load(id)?;
        let cards = question::views(events.iter());
        let card = cards
            .iter()
            .rev()
            .find(|c| c.call_id == call_id)
            .ok_or(QuestionError::NotOpen)?;
        let app = connect::of(&card.questions)
            .ok_or_else(|| QuestionError::Invalid("That card doesn't ask for an app.".into()))?
            .clone();
        if !matches!(card.standing, Standing::Waiting | Standing::Deferred) {
            return Err(QuestionError::NotOpen);
        }
        let view = hub
            .get(connector)
            .ok_or_else(|| QuestionError::Invalid("That app isn't connected.".into()))?;
        if view.catalogue.as_deref() != Some(app.app.as_str()) && view.id != app.app {
            return Err(QuestionError::Invalid(format!(
                "That isn't {}; connect {} itself.",
                app.name, app.name
            )));
        }
        if !usable(&view) {
            return Err(QuestionError::Invalid(format!(
                "{} isn't connected yet: finish signing in first.",
                app.name
            )));
        }
        let agent = self
            .store
            .agent_for_conversation(id)?
            .ok_or(QuestionError::NotFound)?;
        let bots: Vec<(String, bool)> = if everyone {
            self.agents()?
                .into_iter()
                .map(|v| (v.agent.id, v.agent.kind == MAIN))
                .collect()
        } else {
            vec![(agent.id, agent.kind == MAIN)]
        };
        // Granted before the answer lands, so the turn it wakes finds the app's tools.
        for (bot, is_main) in bots {
            if let Access::Only(mut ids) = hub.access(&bot, is_main) {
                ids.insert(view.id.clone());
                hub.set_access(&bot, Access::Only(ids))
                    .map_err(|e| QuestionError::Invalid(e.to_string()))?;
            }
        }
        let answer = Connected {
            connector: view.id.clone(),
            account: view.account.clone(),
            everyone,
        }
        .answer();
        // Every card in the conversation still open for this app reads the same answer.
        let open: Vec<(String, Standing)> = cards
            .iter()
            .filter(|c| matches!(c.standing, Standing::Waiting | Standing::Deferred))
            .filter(|c| connect::of(&c.questions).is_some_and(|a| a.app == app.app))
            .map(|c| (c.call_id.clone(), c.standing))
            .collect();
        for (call, standing) in open {
            let event = Event::Known(Known::QuestionAnswered {
                call_id: call,
                answers: vec![answer.clone()],
                late: standing == Standing::Deferred,
                typed: false,
            });
            self.land(id, standing, event)?;
        }
        Ok(())
    }

    /// Stores a card's answer: a waiting card's in its turn, which wakes; a deferred card's
    /// delivered like a job's result, once.
    fn land(
        self: &Arc<Self>,
        id: &str,
        standing: Standing,
        event: Event,
    ) -> Result<(), QuestionError> {
        if standing == Standing::Waiting {
            {
                let _order = self.record_lock.lock().unwrap_or_else(|p| p.into_inner());
                let Event::Known(Known::QuestionAnswered { call_id, .. }) = &event else {
                    return Err(QuestionError::NotOpen);
                };
                // Checked again under the lock every answer is stored under.
                if question::standing(self.load(id)?.iter(), call_id) != Some(Standing::Waiting) {
                    return Err(QuestionError::NotOpen);
                }
                self.append(id, &event)?;
            }
            self.live(id).wake.notify_one();
            self.announce(id);
            return Ok(());
        }
        match self.deliver_as(id, &event, None)? {
            spade_store::Delivered::Stored(_) => {
                self.announce(id);
                Ok(())
            }
            _ => Err(QuestionError::NotOpen),
        }
    }
}

/// Whether `call_id` waits, or waited, on a Reconnect card that holds it.
pub(super) fn held_for_reconnect(events: &[Event], call_id: &str) -> bool {
    question::questions_of(events, call_id)
        .as_deref()
        .and_then(connect::of)
        .is_some_and(|app| app.retry)
}

/// What a call held on a Reconnect card does once the card no longer waits.
pub(super) enum AfterReconnect {
    RunAgain,
    Answer(ToolOutput),
}

/// The person reconnected: run it again, unless it already started again (then a restart cut it
/// off, and its outcome is unknown). Otherwise it didn't run, and the bot reads why.
pub(super) fn after_reconnect(events: &[Event], call_id: &str) -> AfterReconnect {
    let asked_at = events.iter().rposition(|event| {
        matches!(event, Event::Known(Known::QuestionAsked { call_id: c, .. }) if c == call_id)
    });
    let after = &events[asked_at.unwrap_or(0)..];
    let started_again = after.iter().any(|event| {
        matches!(event, Event::Known(Known::ToolStarted { call_id: c, .. }) if c == call_id)
    });
    if started_again {
        return AfterReconnect::Answer(ToolOutput::maybe_ran(spade_core::context::MAYBE_RAN));
    }
    let card = question::views(after.iter())
        .into_iter()
        .rev()
        .find(|c| c.call_id == call_id);
    let connected = card
        .as_ref()
        .is_some_and(|c| c.standing == Standing::Answered && !c.typed && c.answers.is_some());
    if connected {
        return AfterReconnect::RunAgain;
    }
    let app = question::questions_of(events, call_id)
        .as_deref()
        .and_then(connect::of)
        .cloned();
    let said = match (&card, &app) {
        (Some(card), Some(app)) if card.typed => format!(
            "Not run: the sign-in to {} expired, and the person replied instead of reconnecting              it. Their reply follows.",
            app.name
        ),
        _ => question::call_result(events, call_id)
            .unwrap_or_else(|| spade_core::context::NOT_RUN.to_owned()),
    };
    AfterReconnect::Answer(ToolOutput::error(said))
}

/// A connect card, as `question_asked` keeps it.
pub(super) fn asked(reply: &str, call_id: &str, why: String, card: Connect) -> Event {
    let summary = connect::summary(&card, &why);
    let later = card.way == Way::Later;
    Event::Known(Known::QuestionAsked {
        reply: reply.to_owned(),
        call_id: call_id.to_owned(),
        question: summary,
        questions: vec![connect::question(why, card)],
        later,
    })
}

/// `{app, why}` and nothing else: no key, token or address. A bot never connects an app, and
/// never holds what signs in to one.
fn parse(arguments: &Value) -> Result<(String, String), String> {
    let Some(fields) = arguments.as_object() else {
        return Err("Give `app` and `why`.".to_owned());
    };
    if let Some(other) = fields
        .keys()
        .find(|k| !["app", "why"].contains(&k.as_str()))
    {
        return Err(format!(
            "Refused: `{other}` isn't taken. Only the person connects an app or gives it a key; \
             you can only ask, with `app` and `why`."
        ));
    }
    let app = fields
        .get("app")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|a| !a.is_empty())
        .ok_or("Give `app`: the catalogue id or name, as apps_find lists it.")?;
    let why = fields
        .get("why")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|w| !w.is_empty())
        .ok_or("Give `why`: one line the person reads, saying what you need it for.")?;
    if why.chars().count() > WHY_CHARS {
        return Err(format!(
            "Keep `why` to one line, under {WHY_CHARS} characters."
        ));
    }
    Ok((app.to_owned(), why.to_owned()))
}

/// What a bot reads when it asked for an app the catalogue doesn't have.
fn unknown_app(hub: &Connectors, asked: &str) -> String {
    let near: Vec<String> = spade_connect::fit::fitting(hub.catalogue(), asked, 3)
        .into_iter()
        .map(|e| format!("{} ({})", e.name, e.id))
        .collect();
    if near.is_empty() {
        format!(
            "There's no app called {asked} in Spade's catalogue. Use apps_find to look, or tell \
             the person they can add its server by address in Settings."
        )
    } else {
        format!(
            "There's no app called {asked} in Spade's catalogue. Did you mean {}?",
            near.join(", ")
        )
    }
}

//! Bots a bot makes for the person (ADR 0161, amendment 1): `bot_create {kind: standing}` makes
//! a bot of the person's own, listed at the top level, and `club_add` adds a bot to a club the
//! caller is in. Whether a call runs, asks or is refused is `spade_core::made::route`, decided
//! before the call gets here. A made bot never gets more than a new bot the person makes: the
//! auto-review, its own folder, no apps or plugins (the ones its maker suggests wait for the
//! person to connect them).

use std::sync::Arc;

use serde::Deserialize;
use serde_json::{Value, json};
use spade_core::Event;
use spade_core::event::Known;
use spade_core::made::{self, May};
use spade_store::NewAgent;

use super::groups::{GroupInput, MemberRef};
use super::{AgentError, AvatarInput, Engine};
use crate::tools::ToolOutput;

/// The per-bot setting: may it make bots (`yes`, `ask`, `no`).
fn may_key(agent: &str) -> String {
    format!("may_create_bots:{agent}")
}
/// Who made a standing bot: `{id, name, apps}`.
fn made_by_key(agent: &str) -> String {
    format!("made_by:{agent}")
}
#[derive(Deserialize)]
struct Standing {
    name: String,
    task: String,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    face: Option<Value>,
    /// Catalogue apps it will need: suggested to the person, never granted.
    #[serde(default)]
    apps: Vec<String>,
}

/// A standing bot just made.
struct Made {
    id: String,
    name: String,
}

/// The apps a maker suggested, trimmed, at most eight.
fn apps_of(asked: &[String]) -> Vec<String> {
    asked
        .iter()
        .map(|a| a.trim().to_owned())
        .filter(|a| !a.is_empty())
        .take(8)
        .collect()
}

/// The reply a made bot's suggested-app cards are filed under: none of its own replies.
const SUGGESTED: &str = "made";

#[derive(Deserialize)]
struct ClubAdd {
    club: String,
    bot: String,
}

/// What Undo did to a made bot.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Undone {
    /// Nothing it did reached outside it: it is gone.
    Removed,
    /// It had acted: kept, stopped, its routines paused.
    Archived,
}

impl Undone {
    pub const fn name(self) -> &'static str {
        match self {
            Self::Removed => "removed",
            Self::Archived => "archived",
        }
    }
}

impl Engine {
    /// Whether the bot whose conversation is `conversation` may make bots for the person.
    pub(crate) fn may_create(&self, conversation: &str) -> May {
        let Ok(Some(agent)) = self.store.agent_for_conversation(conversation) else {
            return May::No;
        };
        self.may_create_of(&agent.id, agent.kind == super::MAIN)
    }

    fn may_create_of(&self, agent: &str, main: bool) -> May {
        self.store
            .setting(&may_key(agent))
            .ok()
            .flatten()
            .and_then(|word| May::parse(&word))
            .unwrap_or(May::default_for(main))
    }

    /// The bot that made `agent` for the person, if one did.
    pub(super) fn maker_of(&self, agent: &str) -> Option<String> {
        let made_by = self.store.setting(&made_by_key(agent)).ok()??;
        let made_by: Value = serde_json::from_str(&made_by).ok()?;
        made_by.get("id")?.as_str().map(str::to_owned)
    }

    /// Sets whether `agent` may make bots.
    pub fn set_may_create(&self, agent: &str, may: May) -> Result<(), AgentError> {
        self.store.agent(agent)?.ok_or(AgentError::NotFound)?;
        self.store.set_setting(&may_key(agent), Some(may.name()))?;
        Ok(())
    }

    /// What the agent view shows of this: the setting, who made it and whether it is archived.
    pub(super) fn made_fields(&self, agent: &spade_store::Agent) -> [(&'static str, Value); 3] {
        let made_by = self
            .store
            .setting(&made_by_key(&agent.id))
            .ok()
            .flatten()
            .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
            .unwrap_or(Value::Null);
        let archived = self.archived(&agent.id);
        [
            (
                "may_create_bots",
                self.may_create_of(&agent.id, agent.kind == super::MAIN)
                    .name()
                    .into(),
            ),
            ("made_by", made_by),
            ("archived", archived.into()),
        ]
    }

    /// `bot_create {kind: standing}` from the call with `key`: a bot of the person's own, made
    /// once even when the call runs again after a restart.
    pub(crate) async fn make_standing(&self, key: &str, arguments: Value) -> ToolOutput {
        let Some((caller, _)) = key.split_once('.') else {
            return ToolOutput::error("Spade could not tell which bot asked.");
        };
        if let Some(bot) = self.made_by_call(caller, key) {
            return made_answer(&bot);
        }
        let asked: Standing = match crate::tools::parse(arguments) {
            Ok(asked) => asked,
            Err(refused) => return refused,
        };
        let maker = match self.store.agent_for_conversation(caller) {
            Ok(Some(me)) => me.name,
            Ok(None) => return ToolOutput::error("Only a bot can make bots."),
            Err(error) => return ToolOutput::error(error.to_string()),
        };
        let cards = self.suggested_cards(&apps_of(&asked.apps), &maker).await;
        match self.store_standing(caller, key, asked, &cards) {
            Ok(made) => made_answer(&(made.id, made.name)),
            Err(why) => ToolOutput::error(why),
        }
    }

    /// The apps its maker suggested, as connect cards for the made bot's own chat, each left for
    /// later: the person connects one with a click when they open it, and nothing waits on them.
    /// An app Spade doesn't know gets no card; a bot not made yet can use none, so every app Spade
    /// knows gets one. Built before the bot is made, so they are stored with it, in one write.
    async fn suggested_cards(&self, apps: &[String], maker: &str) -> Vec<Event> {
        let Some(hub) = self.apps() else {
            return Vec::new();
        };
        let mut events = Vec::new();
        for (n, app) in apps.iter().enumerate() {
            let super::apps::Card::Ask(card) = self.connect_card(hub, "", false, app).await else {
                continue;
            };
            let call = format!("made-app-{n}");
            let why = format!("{maker} thought I'd need this when it made me.");
            events.push(super::apps::asked(SUGGESTED, &call, why, card));
            events.push(Event::Known(Known::QuestionDeferred {
                call_id: call,
                by_bot: true,
            }));
        }
        events
    }

    /// The bot an earlier run of the call with `key` made, from the maker's `bot_made`.
    fn made_by_call(&self, caller: &str, key: &str) -> Option<(String, String)> {
        let events = self.load(caller).ok()?;
        events.iter().rev().find_map(|event| match event {
            Event::Known(Known::BotMade {
                bot, name, call, ..
            }) if call == key => Some((bot.clone(), name.clone())),
            _ => None,
        })
    }

    fn store_standing(
        &self,
        caller: &str,
        key: &str,
        asked: Standing,
        cards: &[Event],
    ) -> Result<Made, String> {
        let me = self
            .store
            .agent_for_conversation(caller)
            .map_err(|e| e.to_string())?
            .ok_or("Only a bot can make bots.")?;
        let name = super::agents::name(&asked.name).map_err(|e| e.to_string())?;
        let task = super::agents::task(&asked.task).map_err(|e| e.to_string())?;
        if task.is_empty() {
            return Err("Give the bot a task: what it is for, in full.".to_owned());
        }
        // A role or a model the person set up for the maker, within its allowed list.
        let model = match asked.model.as_deref().map(str::trim) {
            Some(model) if !model.is_empty() => self.pick_model(caller, model)?,
            _ => self.new_bot_default(),
        };
        let id = self.ids.next("a");
        let conversation = self.ids.next("c");
        let avatar = self
            .avatar(
                &id,
                asked
                    .face
                    .filter(Value::is_object)
                    .map(AvatarInput::Character),
            )
            .map_err(|e| e.to_string())?;
        // Its task, then the connect cards for the apps its maker suggested: stored with the bot
        // in one transaction, so it is never listed without them.
        let mut first = vec![Event::Known(Known::AgentConfigured {
            task: task.clone(),
            model: model.clone(),
            personality: None,
            change: None,
        })];
        first.extend_from_slice(cards);
        let apps = apps_of(&asked.apps);
        {
            let _order = self.record_lock.lock().unwrap_or_else(|p| p.into_inner());
            if self.deleting(caller) {
                return Err("Not made: the person is deleting this bot.".to_owned());
            }
            // Who made it and the maker's note go in the bot's own transaction: the note is how
            // a rerun of this call finds the bot, and who made it is what lets it be undone.
            let by = json!({ "id": me.id, "name": me.name, "apps": apps });
            // A packaged maker's ceiling goes with the bot it makes, in the same write: a made
            // bot never does more than its maker's package declared (ADR 0200 §3.4).
            let under = self.ceiling(caller).map(|(bot, allows)| {
                serde_json::to_string(&super::packages::MadeUnder::new(&bot, allows))
                    .unwrap_or_default()
            });
            let (made_by, under_key) = (made_by_key(&id), super::packages::made_under_key(&id));
            let mut settings = vec![(made_by.as_str(), by.to_string())];
            if let Some(under) = under {
                settings.push((under_key.as_str(), under));
            }
            let settings: Vec<(&str, &str)> = settings
                .iter()
                .map(|(key, value)| (*key, value.as_str()))
                .collect();
            let note = Event::Known(Known::BotMade {
                bot: id.clone(),
                name: name.clone(),
                task: task.clone(),
                call: key.to_owned(),
            });
            let stored = self.store.create_made_agent(
                NewAgent {
                    id: &id,
                    kind: super::BOT,
                    name: &name,
                    task: &task,
                    avatar: &avatar,
                    model: &model,
                    conversation: &conversation,
                },
                &first,
                &settings,
                caller,
                &note,
                self.now_ms(),
            );
            // Dropped whether or not the write succeeded: a failed write may still have landed.
            self.forget_activity(caller);
            let stored = stored.map_err(|e| format!("Spade could not make it: {e}"))?;
            self.publish_stored(caller, &stored);
        }
        Ok(Made { id, name })
    }

    /// Undo on a bot another bot made: removed when nothing it did reached outside it, else
    /// archived (stopped, its routines paused, marked). `409` for a bot the person made.
    pub async fn undo_made(self: &Arc<Self>, id: &str) -> Result<Undone, AgentError> {
        let agent = self.store.agent(id)?.ok_or(AgentError::NotFound)?;
        if self.store.setting(&made_by_key(id))?.is_none() {
            return Err(AgentError::Main(
                "only a bot another bot made can be undone",
            ));
        }
        let events = self.load(&agent.conversation)?;
        if !made::acted_outside(&events) {
            self.delete_agent(id).await?;
            self.store.set_setting(&made_by_key(id), None)?;
            return Ok(Undone::Removed);
        }
        self.archive_bot(id, &agent.conversation)?;
        Ok(Undone::Archived)
    }

    /// `club_add {club, bot}`: adds a bot of this machine to a club the caller is a member of.
    pub(crate) async fn club_add(&self, key: &str, arguments: Value) -> ToolOutput {
        let Some((caller, _)) = key.split_once('.') else {
            return ToolOutput::error("Spade could not tell which bot asked.");
        };
        let asked: ClubAdd = match crate::tools::parse(arguments) {
            Ok(asked) => asked,
            Err(refused) => return refused,
        };
        match self.add_to_club(caller, asked).await {
            Ok(said) => ToolOutput::ok(said),
            Err(why) => ToolOutput::error(why),
        }
    }

    async fn add_to_club(&self, caller: &str, asked: ClubAdd) -> Result<String, String> {
        let me = self
            .store
            .agent_for_conversation(caller)
            .map_err(|e| e.to_string())?
            .ok_or("Only a bot can add bots to a club.")?;
        let wanted = asked.club.trim().to_lowercase();
        let group = self
            .store
            .groups()
            .map_err(|e| e.to_string())?
            .into_iter()
            .find(|g| g.id == asked.club.trim() || g.name.to_lowercase() == wanted)
            .ok_or("There is no such club here.")?;
        if !group
            .members
            .iter()
            .any(|m| m.machine.is_empty() && m.agent_id == me.id)
        {
            return Err("Refused: you can only add bots to a club you are in.".to_owned());
        }
        let bot_word = asked.bot.trim().to_lowercase();
        let bot = self
            .store
            .agents()
            .map_err(|e| e.to_string())?
            .into_iter()
            .find(|a| a.id == asked.bot.trim() || a.name.to_lowercase() == bot_word)
            .ok_or("There is no such bot on this machine.")?;
        if group
            .members
            .iter()
            .any(|m| m.machine.is_empty() && m.agent_id == bot.id)
        {
            return Ok(format!("{} is in {} already.", bot.name, group.name));
        }
        let mut members: Vec<MemberRef> = group
            .members
            .iter()
            .map(|m| MemberRef {
                agent: m.agent_id.clone(),
                machine: (!m.machine.is_empty()).then(|| m.machine.clone()),
                name: Some(m.name.clone()),
            })
            .collect();
        members.push(MemberRef {
            agent: bot.id.clone(),
            machine: None,
            name: None,
        });
        self.update_group(
            &group.id,
            GroupInput {
                members: Some(members),
                ..GroupInput::default()
            },
        )
        .await
        .map_err(|e| format!("Not added: {e}"))?;
        let note = Event::Known(Known::ClubAdded {
            club: group.id.clone(),
            club_name: group.name.clone(),
            bot: bot.id.clone(),
            bot_name: bot.name.clone(),
        });
        if let Err(error) = self.record(caller, &note) {
            tracing::warn!(%error, "a club addition was not noted in its maker's conversation");
        }
        Ok(format!("Added {} to {}.", bot.name, group.name))
    }
}

fn made_answer((bot, name): &(String, String)) -> ToolOutput {
    ToolOutput::ok(
        json!({
            "bot": bot,
            "name": name,
            "next": "It is in the person's list now, on the auto-review, with no apps: the apps \
                     you suggested wait for the person to connect them. It starts when the \
                     person writes to it, or when you send it a bot_message.",
        })
        .to_string(),
    )
}

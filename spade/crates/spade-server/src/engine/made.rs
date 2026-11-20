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
/// A made bot the person undid after it had acted: kept, stopped, its routines paused.
fn archived_key(agent: &str) -> String {
    format!("archived:{agent}")
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
        let archived = self
            .store
            .setting(&archived_key(&agent.id))
            .ok()
            .flatten()
            .is_some();
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
    pub(crate) fn make_standing(&self, key: &str, arguments: Value) -> ToolOutput {
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
        match self.store_standing(caller, key, asked) {
            Ok(bot) => made_answer(&bot),
            Err(why) => ToolOutput::error(why),
        }
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
    ) -> Result<(String, String), String> {
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
        let first = [Event::Known(Known::AgentConfigured {
            task: task.clone(),
            model: model.clone(),
            personality: None,
            change: None,
        })];
        let apps: Vec<String> = asked
            .apps
            .iter()
            .map(|a| a.trim().to_owned())
            .filter(|a| !a.is_empty())
            .take(8)
            .collect();
        {
            let _order = self.record_lock.lock().unwrap_or_else(|p| p.into_inner());
            if self.deleting(caller) {
                return Err("Not made: the person is deleting this bot.".to_owned());
            }
            self.store
                .create_agent(
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
                    self.now_ms(),
                )
                .map_err(|e| format!("Spade could not make it: {e}"))?;
            let by = json!({ "id": me.id, "name": me.name, "apps": apps });
            if let Err(error) = self
                .store
                .set_setting(&made_by_key(&id), Some(&by.to_string()))
            {
                tracing::warn!(%error, "who made a bot was not kept");
            }
            let note = Event::Known(Known::BotMade {
                bot: id.clone(),
                name: name.clone(),
                task: task.clone(),
                call: key.to_owned(),
            });
            if let Err(error) = self.append(caller, &note) {
                tracing::warn!(%error, "a made bot was not noted in its maker's conversation");
            }
        }
        Ok((id, name))
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
        let _ = self.stop(&agent.conversation);
        for kind in [spade_store::ROUTINE, spade_store::HEARTBEAT] {
            for mut routine in self.store.routines_of(id, kind)? {
                if !routine.paused {
                    routine.paused = true;
                    routine.next_due_ms = None;
                    self.store.update_routine(&routine)?;
                }
            }
        }
        self.store.set_setting(&archived_key(id), Some("1"))?;
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

//! A group's run (ADR 0132): the person posts, the message goes to the lead or the members it
//! mentions, each answers in its own conversation, and its answer is posted in the group. Bots
//! hand work on with `group_ask`. Every ask is recorded in the group before it is delivered and
//! its end after, so a restart picks each open ask up again and Stop finds them all.

use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};
use spade_core::event::{FromAgent, FromGroup, GroupBot, Known};
use spade_core::{Event, group};
use spade_store::{StoreError, StoredGroup, StoredMember};
use tokio::sync::watch;

use super::Engine;
use super::groups::{FEWEST_MEMBERS, GroupError, bot_of};
use crate::teams::Outcome;
use crate::tools::ToolOutput;

/// How long `group_ask` waits for a member's answer.
const ASK_WAIT: Duration = Duration::from_secs(10 * 60);

impl Engine {
    /// The person posts in a group. Returns the run it starts.
    pub fn post_group(self: &Arc<Self>, id: &str, text: &str) -> Result<String, GroupError> {
        let text = text.trim();
        if text.is_empty() {
            return Err(GroupError::Invalid("the message is empty".to_owned()));
        }
        if text.chars().count() > self.limits.longest_message {
            return Err(GroupError::Invalid("the message is too long".to_owned()));
        }
        if !self.within_cap()? {
            return Err(GroupError::Conflict(
                "today's spending cap is used up".to_owned(),
            ));
        }
        let group = self.store.group(id)?.ok_or(GroupError::NotFound)?;
        if group.members.len() < FEWEST_MEMBERS {
            return Err(GroupError::Conflict(
                "this group needs at least two bots; add one first".to_owned(),
            ));
        }
        let run = self.ids.next("run");
        self.record(
            &group.conversation,
            &Event::Known(Known::GroupMessage {
                run: run.clone(),
                text: text.to_owned(),
                from: None,
            }),
        )?;
        let names: Vec<&str> = group.members.iter().map(|m| m.name.as_str()).collect();
        let mentioned = group::mentions(text, &names);
        let targets: Vec<&StoredMember> = if mentioned.is_empty() {
            group
                .members
                .iter()
                .filter(|m| m.machine.is_empty() && m.agent_id == group.lead_id)
                .collect()
        } else {
            mentioned.iter().map(|&i| &group.members[i]).collect()
        };
        for target in targets {
            if let Err(why) = self.start_ask(&group, &run, None, 1, target, text) {
                tracing::warn!(%why, "a group message was not handed on");
            }
        }
        self.announce_group(&group.conversation);
        Ok(run)
    }

    /// Records an ask in the group and delivers it; its answer is posted when it comes.
    fn start_ask(
        self: &Arc<Self>,
        group: &StoredGroup,
        run: &str,
        by: Option<GroupBot>,
        depth: u32,
        to: &StoredMember,
        text: &str,
    ) -> Result<(String, watch::Receiver<Option<Outcome>>), String> {
        let to_bot = bot_of(to);
        let (ask, context, untrusted) = {
            let _one = self
                .teams
                .group_lock
                .lock()
                .unwrap_or_else(|p| p.into_inner());
            let events = self.load(&group.conversation).map_err(|e| e.to_string())?;
            group::admit(&events, run, depth).map_err(|r| r.words())?;
            let ask = self.ids.next("ask");
            self.record(
                &group.conversation,
                &Event::Known(Known::GroupAsked {
                    run: run.to_owned(),
                    ask: ask.clone(),
                    by: by.clone(),
                    to: to_bot.clone(),
                    depth,
                }),
            )
            .map_err(|e| e.to_string())?;
            let (lines, untrusted) = group::recent(&events, &to_bot, run);
            (ask, context_for(group, &lines), untrusted)
        };
        let (sender, receiver) = watch::channel(None);
        self.teams
            .asks
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(ask.clone(), sender);
        let from_group = FromGroup {
            id: group.id.clone(),
            name: group.name.clone(),
            run: run.to_owned(),
            ask: ask.clone(),
            machine: None,
            untrusted,
        };
        let delivered = if to.machine.is_empty() {
            self.ask_here(group, &ask, to, text, context, by, depth, from_group)
        } else {
            self.ask_elsewhere(group, &ask, to, text, context, by.as_ref(), depth, run)
        };
        if let Err(why) = delivered {
            self.finish_ask(&group.id, run, &ask, &to_bot, Outcome::Failed(why));
        }
        self.announce_group(&group.conversation);
        Ok((ask, receiver))
    }

    #[allow(clippy::too_many_arguments)]
    fn ask_here(
        self: &Arc<Self>,
        group: &StoredGroup,
        ask: &str,
        to: &StoredMember,
        text: &str,
        context: String,
        by: Option<GroupBot>,
        depth: u32,
        from_group: FromGroup,
    ) -> Result<(), String> {
        let agent = self
            .store
            .agent(&to.agent_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("{} is gone.", to.name))?;
        let message = Event::Known(Known::UserMessage {
            text: text.to_owned(),
            context: Some(context),
            images: Vec::new(),
            from_agent: by.map(|b| FromAgent {
                id: b.id,
                name: b.name,
                depth,
                machine: None,
            }),
            from_routine: None,
            from_group: Some(Box::new(from_group)),
        });
        let frames = self.live(&agent.conversation).frames.subscribe();
        let delivered = self
            .deliver_as(&agent.conversation, &message, None)
            .map_err(|e| format!("The message was not delivered: {e}"))?;
        let spade_store::Delivered::Stored(stored) = delivered else {
            return Err("The message was not delivered.".to_owned());
        };
        let seq = stored
            .first()
            .map(|e| e.seq)
            .ok_or("The message was not delivered.")?;
        self.wait_here(group, ask, to, agent, seq, Some(frames));
        Ok(())
    }

    /// Waits in the background for a bot of this machine to answer an ask stored at `seq`.
    fn wait_here(
        self: &Arc<Self>,
        group: &StoredGroup,
        ask: &str,
        to: &StoredMember,
        agent: spade_store::Agent,
        seq: i64,
        frames: Option<tokio::sync::broadcast::Receiver<super::Frame>>,
    ) {
        let engine = self.clone();
        let (group, ask, to) = (group.id.clone(), ask.to_owned(), bot_of(to));
        let run = self.run_of(&group, &ask);
        tokio::spawn(async move {
            let frames =
                frames.unwrap_or_else(|| engine.live(&agent.conversation).frames.subscribe());
            let outcome = engine.wait_reply(&agent, seq, frames).await;
            engine.finish_ask(&group, &run, &ask, &to, outcome);
        });
    }

    #[allow(clippy::too_many_arguments)]
    fn ask_elsewhere(
        self: &Arc<Self>,
        group: &StoredGroup,
        ask: &str,
        to: &StoredMember,
        text: &str,
        context: String,
        by: Option<&GroupBot>,
        depth: u32,
        run: &str,
    ) -> Result<(), String> {
        let request = json!({
            "op": "ask",
            "key": ask,
            "to": to.agent_id,
            "text": text,
            "from": by.map(|b| json!({ "id": b.id, "name": b.name })),
            "depth": depth,
            "context": context,
            "group": { "id": group.id, "name": group.name, "run": run },
        });
        let machine_name = self.machine_name(&to.machine);
        self.send_remote(ask, &to.machine, &machine_name, request)
            .map_err(|e| e.to_string())?;
        self.wait_elsewhere(group, ask, to);
        Ok(())
    }

    /// Waits in the background for an ask sent to another machine; says once if it is queued.
    fn wait_elsewhere(self: &Arc<Self>, group: &StoredGroup, ask: &str, to: &StoredMember) {
        let engine = self.clone();
        let (group_id, conversation, ask, to) = (
            group.id.clone(),
            group.conversation.clone(),
            ask.to_owned(),
            bot_of(to),
        );
        let run = self.run_of(&group_id, &ask);
        tokio::spawn(async move {
            let mut said_queued = false;
            let outcome = engine
                .wait_remote(&ask, |entry| {
                    if !said_queued && entry.state == "queued" && entry.attempts > 0 {
                        said_queued = true;
                        let _ = engine.record(
                            &conversation,
                            &Event::Known(Known::GroupQueued {
                                run: run.clone(),
                                ask: ask.clone(),
                                to: to.clone(),
                                machine_name: entry.machine_name.clone(),
                            }),
                        );
                        engine.announce_group(&conversation);
                    }
                })
                .await;
            engine.finish_ask(&group_id, &run, &ask, &to, outcome);
        });
    }

    /// The run an ask belongs to, from the group's events.
    fn run_of(&self, group: &str, ask: &str) -> String {
        let Some(conversation) = self
            .store
            .group(group)
            .ok()
            .flatten()
            .map(|g| g.conversation)
        else {
            return String::new();
        };
        self.load(&conversation)
            .unwrap_or_default()
            .iter()
            .find_map(|e| match e {
                Event::Known(Known::GroupAsked { run, ask: a, .. }) if a == ask => {
                    Some(run.clone())
                }
                _ => None,
            })
            .unwrap_or_default()
    }

    /// Records how an ask ended and posts its answer, unless its run was stopped.
    fn finish_ask(&self, group: &str, run: &str, ask: &str, to: &GroupBot, outcome: Outcome) {
        if let Ok(Some(group)) = self.store.group(group) {
            let stopped = self.load(&group.conversation).is_ok_and(|events| {
                events
                    .iter()
                    .any(|e| matches!(e, Event::Known(Known::GroupStopped { run: r }) if r == run))
            });
            let detail = match &outcome {
                Outcome::Answered(_) => None,
                other => Some(other.text().chars().take(400).collect()),
            };
            let mut events = vec![Event::Known(Known::GroupAnswered {
                run: run.to_owned(),
                ask: ask.to_owned(),
                to: to.clone(),
                outcome: if stopped && matches!(outcome, Outcome::Answered(_)) {
                    "stopped".to_owned()
                } else {
                    outcome.name().to_owned()
                },
                detail,
            })];
            if let Outcome::Answered(text) = &outcome
                && !stopped
                && !text.trim().is_empty()
            {
                events.push(Event::Known(Known::GroupMessage {
                    run: run.to_owned(),
                    text: text.clone(),
                    from: Some(to.clone()),
                }));
            }
            {
                let _order = self.record_lock.lock().unwrap_or_else(|p| p.into_inner());
                if let Err(error) = self.append_events(&group.conversation, &events) {
                    tracing::warn!(%error, "could not record a group answer");
                }
            }
            self.announce_group(&group.conversation);
        }
        if let Some(sender) = self
            .teams
            .asks
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(ask)
        {
            sender.send_replace(Some(outcome));
        }
    }

    /// Stop in a group: ends its runs that still ask, stops every open ask on every machine.
    pub fn stop_group(self: &Arc<Self>, id: &str) -> Result<(), GroupError> {
        let group = self.store.group(id)?.ok_or(GroupError::NotFound)?;
        let open = {
            let _one = self
                .teams
                .group_lock
                .lock()
                .unwrap_or_else(|p| p.into_inner());
            let events = self.load(&group.conversation)?;
            let open = group::open_asks(&events);
            let mut runs: Vec<String> = open.iter().map(|a| a.run.clone()).collect();
            if let Some(latest) = events.iter().rev().find_map(|e| match e {
                Event::Known(Known::GroupMessage {
                    run, from: None, ..
                }) => Some(run.clone()),
                _ => None,
            }) {
                runs.push(latest);
            }
            runs.sort();
            runs.dedup();
            for run in runs {
                let done = events.iter().any(
                    |e| matches!(e, Event::Known(Known::GroupStopped { run: r }) if *r == run),
                );
                if !done {
                    self.record(
                        &group.conversation,
                        &Event::Known(Known::GroupStopped { run }),
                    )?;
                }
            }
            open
        };
        for ask in open {
            match &ask.to.machine {
                None => {
                    if let Some(agent) = self.store.agent(&ask.to.id)? {
                        let _ = self.stop(&agent.conversation);
                    }
                }
                Some(_) => self.stop_remote(&ask.ask)?,
            }
        }
        self.announce_group(&group.conversation);
        Ok(())
    }

    /// `group_ask` from the bot of conversation `caller`.
    pub(crate) async fn group_ask(self: &Arc<Self>, caller: &str, arguments: Value) -> ToolOutput {
        let member = arguments
            .get("member")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        let text = arguments
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        if text.is_empty() {
            return ToolOutput::error("The message is empty.");
        }
        let Ok(Some(me)) = self.store.agent_for_conversation(caller) else {
            return ToolOutput::error("Only a bot can ask a group member.");
        };
        let Some((group, run, depth)) = self.current_group(caller, &me.id) else {
            return ToolOutput::error(
                "group_ask works only while answering a message in a group on this machine.",
            );
        };
        let lower = member.to_lowercase();
        let Some(to) = group.members.iter().find(|m| {
            !(m.machine.is_empty() && m.agent_id == me.id)
                && (m.agent_id == member || m.name.to_lowercase() == lower)
        }) else {
            let names: Vec<&str> = group
                .members
                .iter()
                .filter(|m| !(m.machine.is_empty() && m.agent_id == me.id))
                .map(|m| m.name.as_str())
                .collect();
            return ToolOutput::error(format!(
                "{member:?} is not another member of this group. Members: {}.",
                names.join(", ")
            ));
        };
        let by = GroupBot {
            id: me.id.clone(),
            name: me.name.clone(),
            machine: None,
        };
        let name = to.name.clone();
        let mut ended = match self.start_ask(&group, &run, Some(by), depth + 1, to, text) {
            Ok((_, ended)) => ended,
            Err(why) => return ToolOutput::error(why),
        };
        let waited = tokio::time::timeout(ASK_WAIT, ended.wait_for(Option::is_some)).await;
        match waited {
            Ok(Ok(outcome)) => match outcome.clone() {
                Some(Outcome::Answered(text)) => ToolOutput::ok(format!(
                    "{name} answered (it is posted in the group):\n{text}"
                )),
                Some(other) => ToolOutput::error(other.text().to_owned()),
                None => ToolOutput::error(format!("{name} did not answer.")),
            },
            Ok(Err(_)) => ToolOutput::error(format!("{name} did not answer.")),
            Err(_) => ToolOutput::error(format!(
                "{name} has not answered after ten minutes; its answer will still be posted in \
                 the group. Carry on with what you have."
            )),
        }
    }

    /// The group, run and depth of the open ask the bot of `caller` is answering, latest first.
    fn current_group(&self, caller: &str, me: &str) -> Option<(StoredGroup, String, u32)> {
        let events = self.load(caller).ok()?;
        for event in events.iter().rev() {
            let Event::Known(Known::UserMessage {
                from_group: Some(from),
                ..
            }) = event
            else {
                continue;
            };
            if from.machine.is_some() {
                return None;
            }
            let Ok(Some(group)) = self.store.group(&from.id) else {
                continue;
            };
            if !group
                .members
                .iter()
                .any(|m| m.machine.is_empty() && m.agent_id == me)
            {
                continue;
            }
            let transcript = self.load(&group.conversation).ok()?;
            if let Some(open) = group::open_asks(&transcript)
                .into_iter()
                .find(|a| a.ask == from.ask)
            {
                return Some((group, open.run, open.depth));
            }
        }
        None
    }

    /// Picks up every group ask still open after a restart.
    pub(crate) fn resume_groups(self: &Arc<Self>) -> Result<(), StoreError> {
        for group in self.store.groups()? {
            let events = self.load(&group.conversation)?;
            for open in group::open_asks(&events) {
                let waiting = self
                    .teams
                    .asks
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .contains_key(&open.ask);
                if waiting {
                    continue;
                }
                self.teams
                    .asks
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .insert(open.ask.clone(), watch::channel(None).0);
                let member = group.members.iter().find(|m| {
                    m.agent_id == open.to.id
                        && m.machine == open.to.machine.clone().unwrap_or_default()
                });
                let stored = StoredMember {
                    agent_id: open.to.id.clone(),
                    machine: open.to.machine.clone().unwrap_or_default(),
                    name: open.to.name.clone(),
                    avatar: member.and_then(|m| m.avatar.clone()),
                };
                if open.to.machine.is_some() {
                    if self.store.outbox(&open.ask)?.is_some() {
                        self.wait_elsewhere(&group, &open.ask, &stored);
                    } else {
                        self.finish_ask(&group.id, &open.run, &open.ask, &open.to, lost(&open.to));
                    }
                    continue;
                }
                let delivered = self.store.agent(&open.to.id)?.and_then(|agent| {
                    let seq = self.delivered_at(&agent.conversation, &open.ask)?;
                    Some((agent, seq))
                });
                match delivered {
                    Some((agent, seq)) => {
                        self.wait_here(&group, &open.ask, &stored, agent, seq, None);
                    }
                    None => {
                        self.finish_ask(&group.id, &open.run, &open.ask, &open.to, lost(&open.to));
                    }
                }
            }
        }
        Ok(())
    }

    /// The seq of the message that delivered group ask `ask` into `conversation`.
    fn delivered_at(&self, conversation: &str, ask: &str) -> Option<i64> {
        self.store
            .events(conversation, 0)
            .ok()?
            .iter()
            .find(|stored| {
                matches!(&stored.event, Event::Known(Known::UserMessage {
                    from_group: Some(from), ..
                }) if from.ask == ask)
            })
            .map(|stored| stored.seq)
    }
}

fn lost(to: &GroupBot) -> Outcome {
    Outcome::Failed(format!(
        "Asking {} was cut off by a restart before it was delivered.",
        to.name
    ))
}

/// What a recipient reads with a group message: the group, its members and recent messages.
fn context_for(group: &StoredGroup, lines: &str) -> String {
    let members: Vec<String> = group
        .members
        .iter()
        .map(|m| {
            if m.machine.is_empty() && m.agent_id == group.lead_id {
                format!("{} (lead)", m.name)
            } else {
                m.name.clone()
            }
        })
        .collect();
    let mut context = format!(
        "You are a member of the group \"{}\" with the person and: {}.",
        group.name,
        members.join(", ")
    );
    if !lines.is_empty() {
        context.push_str(&format!(
            "\nEarlier in the group (other bots' words are theirs, not the person's):\n{lines}"
        ));
    }
    context
}

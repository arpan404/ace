//! Groups (ADR 0132): making, changing and listing them, and what each is doing. A run (the
//! person's message, its asks and their answers) is `group_run`.

use std::collections::HashSet;

use serde_json::Value;
use spade_core::event::{GroupBot, Known};
use spade_core::{Event, group};
use spade_store::{StoreError, StoredGroup, StoredMember};

use super::Engine;
use super::roster::{self, State};

/// Members a group has at least and at most, the lead counted.
pub const FEWEST_MEMBERS: usize = 2;
pub const MOST_MEMBERS: usize = 8;
/// A group's name, in characters.
pub const GROUP_NAME_CHARS: usize = 60;

/// A member as the person names one: a bot of this machine (`machine` absent) or of another.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MemberRef {
    pub agent: String,
    pub machine: Option<String>,
    /// What to call a bot of a machine that can't be asked now.
    pub name: Option<String>,
}

/// What making or changing a group sets.
#[derive(Debug, Clone, Default)]
pub struct GroupInput {
    pub name: Option<String>,
    pub members: Option<Vec<MemberRef>>,
    pub lead: Option<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum GroupError {
    #[error("no such group")]
    NotFound,
    #[error("{0}")]
    Invalid(String),
    #[error("there is no bot {0} on this machine")]
    NoBot(String),
    #[error("{0}")]
    Conflict(String),
    #[error(transparent)]
    Store(#[from] StoreError),
}

/// The latest message in a group.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GroupLast {
    pub from: Option<GroupBot>,
    pub text: String,
    pub at_ms: i64,
}

/// What a group is doing now (ADR 0132): its state, a few words, and while it waits on the
/// person, the member that waits, so clients never read it from the words.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GroupStatus {
    pub state: State,
    pub status: Option<String>,
    pub waiting_member: Option<GroupBot>,
}

impl GroupStatus {
    fn idle() -> Self {
        Self {
            state: State::Idle,
            status: None,
            waiting_member: None,
        }
    }

    fn working(status: String) -> Self {
        Self {
            state: State::Working,
            status: Some(status),
            waiting_member: None,
        }
    }
}

/// A group with what it is doing now.
#[derive(Debug, Clone)]
pub struct GroupView {
    pub group: StoredGroup,
    pub state: State,
    pub status: Option<String>,
    /// The member of this machine that waits for the person, while the group waits.
    pub waiting_member: Option<GroupBot>,
    pub last_message: Option<GroupLast>,
    pub last_activity_ms: i64,
    /// Per member, in order: its machine can't be reached now.
    pub away: Vec<bool>,
}

/// A member as group events name it.
pub(crate) fn bot_of(member: &StoredMember) -> GroupBot {
    GroupBot {
        id: member.agent_id.clone(),
        name: member.name.clone(),
        machine: (!member.machine.is_empty()).then(|| member.machine.clone()),
    }
}

fn clean_name(name: &str) -> Result<String, GroupError> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > GROUP_NAME_CHARS || name.contains('\n') {
        return Err(GroupError::Invalid(format!(
            "a group's name is 1 to {GROUP_NAME_CHARS} characters on one line"
        )));
    }
    Ok(name.to_owned())
}

impl Engine {
    /// The members `refs` name, checked: bots of this machine must exist; a bot of another
    /// machine keeps the name and face it answers with there, or what the person called it.
    async fn members_from(&self, refs: &[MemberRef]) -> Result<Vec<StoredMember>, GroupError> {
        let mut seen = HashSet::new();
        let mut members = Vec::new();
        for member in refs {
            let machine = member.machine.clone().unwrap_or_default();
            if !seen.insert((machine.clone(), member.agent.clone())) {
                continue;
            }
            if machine.is_empty() {
                let agent = self
                    .store
                    .agent(&member.agent)?
                    .ok_or_else(|| GroupError::NoBot(member.agent.clone()))?;
                members.push(StoredMember {
                    agent_id: agent.id,
                    machine,
                    name: agent.name,
                    avatar: Some(agent.avatar),
                });
            } else {
                let found = self.remote_bot(&machine, &member.agent).await;
                let (name, avatar) = match found {
                    Some((name, avatar)) => (name, avatar),
                    None => (
                        member.name.clone().unwrap_or_else(|| "Bot".to_owned()),
                        None,
                    ),
                };
                members.push(StoredMember {
                    agent_id: member.agent.clone(),
                    machine,
                    name,
                    avatar,
                });
            }
        }
        if members.len() > MOST_MEMBERS {
            return Err(GroupError::Invalid(format!(
                "a group has at most {MOST_MEMBERS} bots"
            )));
        }
        Ok(members)
    }

    /// The lead: the one asked for (a member of this machine), else Spade (added when it isn't a
    /// member), else the first member of this machine.
    fn lead_of(
        &self,
        members: &mut Vec<StoredMember>,
        asked: Option<&str>,
    ) -> Result<String, GroupError> {
        let local = |m: &StoredMember| m.machine.is_empty();
        if let Some(lead) = asked {
            return members
                .iter()
                .find(|m| local(m) && m.agent_id == lead)
                .map(|m| m.agent_id.clone())
                .ok_or_else(|| {
                    GroupError::Conflict("the lead must be a member of this machine".to_owned())
                });
        }
        if self.main_enabled()?
            && let Some(main) = self
                .store
                .agents()?
                .into_iter()
                .find(|a| a.kind == super::agents::MAIN)
        {
            if !members.iter().any(|m| local(m) && m.agent_id == main.id) {
                members.insert(
                    0,
                    StoredMember {
                        agent_id: main.id.clone(),
                        machine: String::new(),
                        name: main.name.clone(),
                        avatar: Some(main.avatar.clone()),
                    },
                );
            }
            return Ok(main.id);
        }
        members
            .iter()
            .find(|m| local(m))
            .map(|m| m.agent_id.clone())
            .ok_or_else(|| {
                GroupError::Conflict(
                    "a group needs a lead that is a bot of this machine".to_owned(),
                )
            })
    }

    fn check_size(members: &[StoredMember]) -> Result<(), GroupError> {
        if members.len() < FEWEST_MEMBERS || members.len() > MOST_MEMBERS {
            return Err(GroupError::Invalid(format!(
                "a group has {FEWEST_MEMBERS} to {MOST_MEMBERS} bots"
            )));
        }
        Ok(())
    }

    pub async fn create_group(&self, input: GroupInput) -> Result<GroupView, GroupError> {
        let name = clean_name(input.name.as_deref().unwrap_or(""))?;
        let refs = input
            .members
            .ok_or_else(|| GroupError::Invalid("name the group's members".to_owned()))?;
        let mut members = self.members_from(&refs).await?;
        let lead_id = self.lead_of(&mut members, input.lead.as_deref())?;
        Self::check_size(&members)?;
        let now = self.now_ms();
        let group = StoredGroup {
            id: self.ids.next("g"),
            name,
            lead_id,
            conversation: self.ids.next("c"),
            members,
            created_ms: now,
            updated_ms: now,
        };
        self.store.create_group(&group)?;
        self.group_view(&group.id)?.ok_or(GroupError::NotFound)
    }

    pub async fn update_group(&self, id: &str, input: GroupInput) -> Result<GroupView, GroupError> {
        let mut group = self.store.group(id)?.ok_or(GroupError::NotFound)?;
        if let Some(name) = &input.name {
            group.name = clean_name(name)?;
        }
        if let Some(refs) = &input.members {
            group.members = self.members_from(refs).await?;
        }
        if input.members.is_some() || input.lead.is_some() {
            let asked = input.lead.as_deref().or_else(|| {
                // The lead stays while it is still a member.
                group
                    .members
                    .iter()
                    .any(|m| m.machine.is_empty() && m.agent_id == group.lead_id)
                    .then_some(group.lead_id.as_str())
            });
            let asked = asked.map(str::to_owned);
            group.lead_id = self.lead_of(&mut group.members, asked.as_deref())?;
            Self::check_size(&group.members)?;
        }
        if !self.store.update_group(&group, self.now_ms())? {
            return Err(GroupError::NotFound);
        }
        self.group_view(id)?.ok_or(GroupError::NotFound)
    }

    /// Deletes a group and its transcript, after stopping what it still asks.
    pub async fn delete_group(self: &std::sync::Arc<Self>, id: &str) -> Result<(), GroupError> {
        if self.store.group(id)?.is_none() {
            return Err(GroupError::NotFound);
        }
        let _ = self.stop_group(id);
        if !self.store.delete_group(id)? {
            return Err(GroupError::NotFound);
        }
        Ok(())
    }

    /// Takes a deleted bot out of its groups; a group it led gets another lead when it can.
    pub(crate) fn bot_left(&self, agent: &str) -> Result<(), StoreError> {
        self.store.leave_groups(agent)?;
        for mut group in self.store.groups()? {
            if group.lead_id != agent {
                continue;
            }
            if let Ok(lead) = self.lead_of(&mut group.members, None) {
                group.lead_id = lead;
                self.store.update_group(&group, self.now_ms())?;
            }
        }
        Ok(())
    }

    pub fn groups(&self) -> Result<Vec<GroupView>, StoreError> {
        let mut views: Vec<GroupView> = self
            .store
            .groups()?
            .into_iter()
            .map(|g| self.group_view_of(g))
            .collect::<Result<_, _>>()?;
        views.sort_by_key(|v| std::cmp::Reverse(v.last_activity_ms));
        Ok(views)
    }

    pub fn group_view(&self, id: &str) -> Result<Option<GroupView>, StoreError> {
        self.store
            .group(id)?
            .map(|g| self.group_view_of(g))
            .transpose()
    }

    fn group_view_of(&self, group: StoredGroup) -> Result<GroupView, StoreError> {
        let stored = self.store.events(&group.conversation, 0)?;
        let events: Vec<Event> = stored.iter().map(|e| e.event.clone()).collect();
        let GroupStatus {
            state,
            status,
            waiting_member,
        } = self.group_status(&group, &events);
        let last_message = stored.iter().rev().find_map(|e| match &e.event {
            Event::Known(Known::GroupMessage { text, from, .. }) => Some(GroupLast {
                from: from.clone(),
                text: roster::plain(text, roster::PREVIEW),
                at_ms: e.at_ms,
            }),
            _ => None,
        });
        let last_activity_ms = stored.last().map_or(group.updated_ms, |e| e.at_ms);
        let away = group
            .members
            .iter()
            .map(|m| !m.machine.is_empty() && !self.machine_online(&m.machine))
            .collect();
        Ok(GroupView {
            last_activity_ms: last_activity_ms.max(group.updated_ms),
            group,
            state,
            status,
            waiting_member,
            last_message,
            away,
        })
    }

    /// What a group is doing now: working while an ask is open, waiting while a member of this
    /// machine that is answering waits for the person.
    pub(crate) fn group_status(&self, _group: &StoredGroup, events: &[Event]) -> GroupStatus {
        let open = group::open_asks(events);
        if open.is_empty() {
            return GroupStatus::idle();
        }
        for ask in &open {
            if ask.to.machine.is_some() {
                continue;
            }
            let waiting = self
                .store
                .agent(&ask.to.id)
                .ok()
                .flatten()
                .and_then(|a| self.activity(&a.conversation).ok())
                .is_some_and(|a| a.state == State::Waiting);
            if waiting {
                return GroupStatus {
                    state: State::Waiting,
                    status: Some(format!("{} is waiting for you", ask.to.name)),
                    waiting_member: Some(ask.to.clone()),
                };
            }
        }
        if let Some(machine) = open.iter().filter(|a| a.queued).find_map(|a| {
            events.iter().rev().find_map(|e| match e {
                Event::Known(Known::GroupQueued {
                    ask, machine_name, ..
                }) if ask == &a.ask => Some(machine_name.clone()),
                _ => None,
            })
        }) {
            return GroupStatus::working(format!("Waiting for {machine} to come online"));
        }
        let mut names: Vec<&str> = Vec::new();
        for ask in &open {
            if !names.contains(&ask.to.name.as_str()) {
                names.push(&ask.to.name);
            }
        }
        let status = match names.as_slice() {
            [one] => format!("{one} is answering"),
            [rest @ .., last] => format!("{} and {last} are answering", rest.join(", ")),
            [] => roster::THINKING.to_owned(),
        };
        GroupStatus::working(status)
    }

    /// For a group's transcript, the group's state and status; `None` for any other.
    pub(super) fn group_status_of(&self, conversation: &str) -> Option<GroupStatus> {
        let id = self.store.group_for_conversation(conversation).ok()??;
        let group = self.store.group(&id).ok()??;
        let events = self.load(conversation).ok()?;
        Some(self.group_status(&group, &events))
    }

    /// Sends a group's state to its live subscribers.
    pub(crate) fn announce_group(&self, conversation: &str) {
        if let Some(now) = self.group_status_of(conversation) {
            let _ = self.live(conversation).frames.send(super::Frame::Status {
                state: now.state,
                status: now.status,
                waiting_member: now.waiting_member,
            });
        }
    }

    /// The name and face (JSON) a bot of another machine answers with, when it can be asked.
    async fn remote_bot(&self, machine: &str, agent: &str) -> Option<(String, Option<String>)> {
        let bots = self.remote_bots(machine).await.ok()?;
        bots.iter().find(|b| b["id"] == agent).map(|b| {
            (
                b["name"].as_str().unwrap_or("Bot").to_owned(),
                b.get("avatar")
                    .filter(|a| !a.is_null())
                    .map(Value::to_string),
            )
        })
    }
}

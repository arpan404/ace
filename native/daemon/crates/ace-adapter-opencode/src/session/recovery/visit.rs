// SPDX-License-Identifier: Apache-2.0
//! One `visit` call and the stages that belong to it (`recovery.ts:25`-`:95`):
//! the snapshot, the child pages, the known children, the live messages, the
//! history refresh, and the interaction and inbox staging that ends it.

use ace_json::{Value, json};

use crate::translate::boundaries::{parse_page, parse_projected_message};
use crate::translate::data::{fields, get, s_in};

use indexmap::IndexSet;

use super::super::history::{Read as HistoryRead, Step as HistoryStep};
use super::super::http::Reply;
use super::super::ownership::{order_info, parse_info};
use super::{Failure, MAX_PAGES, Phase, Recovery, RecoveryError, RecoveryHost, Step, pending};

pub(super) struct Visit {
    pub(super) id: String,
    pub(super) depth: usize,
    /// `info.location.directory` and `info.projectID`, from its own `session.get`.
    pub(super) directory: String,
    pub(super) project: String,
    pub(super) page: usize,
    pub(super) cursor: Option<String>,
    pub(super) cursors: IndexSet<String>,
    /// The page's children, and how many are visited.
    pub(super) children: Vec<Value>,
    pub(super) children_at: usize,
    /// The page's `cursor.next`, once its children are all visited.
    pub(super) next: Option<String>,
    pub(super) known: Vec<String>,
    pub(super) known_at: usize,
    pub(super) live: Vec<String>,
    pub(super) live_at: usize,
    /// `started = p.watermark()` for this visit's snapshots.
    pub(super) started: u64,
    pub(super) permissions: Vec<Value>,
    pub(super) forms: Vec<Value>,
    pub(super) history: Option<HistoryRead>,
    /// The phase of the visit below, resumed when this one ends.
    pub(super) resume: Phase,
}

impl Visit {
    pub(super) fn new(id: String, depth: usize, resume: Phase) -> Self {
        Self {
            id,
            depth,
            directory: String::new(),
            project: String::new(),
            page: 0,
            cursor: None,
            cursors: IndexSet::new(),
            children: Vec::new(),
            children_at: 0,
            next: None,
            known: Vec::new(),
            known_at: 0,
            live: Vec::new(),
            live_at: 0,
            started: 0,
            permissions: Vec::new(),
            forms: Vec::new(),
            history: None,
            resume,
        }
    }
}

impl Recovery {
    pub(super) fn info_reply(
        &mut self,
        reply: &Reply,
        host: &dyn RecoveryHost,
    ) -> Result<(), RecoveryError> {
        let info = parse_info(&reply.body).ok_or_else(|| RecoveryError::envelope("info"))?;
        host.verify(&info)?;
        host.frame(
            "snapshot.info",
            &json!({ "info": order_info(&reply.body), "recovering": true }),
        )?;
        let (directory, project) = (info.directory.to_owned(), info.project_id.to_owned());
        let visit = self.last()?;
        visit.directory = directory;
        visit.project = project;
        self.phase = Phase::List;
        Ok(())
    }

    /// `Page.parse(await session.list)`: the page's children and its cursor.
    pub(super) fn list_reply(&mut self, reply: &Reply) -> Result<(), RecoveryError> {
        let children = parse_page(&reply.body)
            .map_err(|_| RecoveryError::envelope("page"))?
            .to_vec();
        let next = s_in(fields(get(fields(&reply.body), "cursor")), "next").to_owned();
        let visit = self.last()?;
        visit.children = children;
        visit.children_at = 0;
        visit.next = (!next.is_empty()).then_some(next);
        self.phase = Phase::Children;
        Ok(())
    }

    /// One child of the current page: `admit`, then a `visit` of its own. True
    /// when a visit started; false when the page is done and the walk moved on.
    pub(super) fn next_child(&mut self, host: &dyn RecoveryHost) -> Result<bool, RecoveryError> {
        let (value, parent, depth) = {
            let visit = self.last()?;
            match visit.children.get(visit.children_at).cloned() {
                Some(value) => (Some(value), visit.id.clone(), visit.depth + 1),
                None => (None, visit.id.clone(), 0),
            }
        };
        if let Some(value) = value {
            self.last()?.children_at += 1;
            let info = parse_info(&value).ok_or_else(|| RecoveryError::envelope("info"))?;
            host.admit(&info, &parent)?;
            let id = info.id.to_owned();
            return self.push(id, depth, Phase::Children);
        }
        let (next, cursors_has, page, id) = {
            let visit = self.last()?;
            let next = visit.next.clone();
            let cursors_has = next.as_ref().is_some_and(|n| visit.cursors.contains(n));
            (next, cursors_has, visit.page, visit.id.clone())
        };
        if let Some(next) = next {
            // `cursors.has(next) || page === 63` fails the pass (`:49`).
            if cursors_has || page == MAX_PAGES - 1 {
                return Err(RecoveryError::Pagination);
            }
            let visit = self.last()?;
            visit.cursors.insert(next.clone());
            visit.cursor = Some(next);
            visit.page += 1;
            visit.next = None;
            self.phase = Phase::List;
            return Ok(false);
        }
        let known = host.direct_children(&id);
        let visit = self.last()?;
        visit.known = known;
        visit.known_at = 0;
        self.phase = Phase::Known;
        Ok(false)
    }

    /// One `directChildren` id that is not visited yet, as its own `visit`.
    pub(super) fn next_known(&mut self) -> Result<bool, RecoveryError> {
        let candidate = {
            let visit = self.stack.last_mut().ok_or(RecoveryError::Stage)?;
            let mut candidate = None;
            while visit.known_at < visit.known.len() {
                let id = visit.known[visit.known_at].clone();
                visit.known_at += 1;
                if !self.visited.contains(&id) {
                    candidate = Some((id, visit.depth + 1));
                    break;
                }
            }
            candidate
        };
        match candidate {
            Some((id, depth)) => self.push(id, depth, Phase::Known),
            None => Ok(false),
        }
    }

    /// `liveMessages(id)` is read once, when the known children are done.
    pub(super) fn enter_live(&mut self, host: &dyn RecoveryHost) -> Result<(), RecoveryError> {
        let id = self.last()?.id.clone();
        let live = host.live_messages(&id);
        let visit = self.last()?;
        visit.live = live;
        visit.live_at = 0;
        self.phase = Phase::Live;
        Ok(())
    }

    /// One live message: `ProjectedMessage.parse` and its frame.
    pub(super) fn live_reply(
        &mut self,
        reply: &Reply,
        host: &dyn RecoveryHost,
    ) -> Result<(), RecoveryError> {
        let id = self.last()?.id.clone();
        let message = Value::Object(
            parse_projected_message(&reply.body)
                .map_err(|_| RecoveryError::envelope("message"))?
                .clone(),
        );
        self.last()?.live_at += 1;
        host.frame(
            "snapshot.message",
            &json!({ "sessionID": id, "message": message }),
        )
    }

    /// One history page: its messages are framed, then the head or the next page.
    pub(super) fn history_reply(
        &mut self,
        reply: &Reply,
        host: &dyn RecoveryHost,
    ) -> Result<Option<Step>, RecoveryError> {
        let (id, mut read) = {
            let visit = self.last()?;
            let read = visit.history.take().ok_or(RecoveryError::Stage)?;
            (visit.id.clone(), read)
        };
        let step = host
            .history_step(&mut read, reply, &mut |message: &Value| {
                host.frame(
                    "snapshot.message",
                    &json!({ "sessionID": id, "message": message }),
                )
            })
            .map_err(|failure| match failure {
                Failure::History(error) => RecoveryError::History(error),
                Failure::Delivery(error) => error,
            })?;
        match step {
            HistoryStep::Request(params) => {
                self.last()?.history = Some(read);
                Ok(Some(Step::Request {
                    op: "message.list",
                    params,
                }))
            }
            HistoryStep::Done => {
                // `started = p.watermark()` fences the snapshots that follow.
                let started = host.watermark();
                self.last()?.started = started;
                self.phase = Phase::Permissions;
                Ok(None)
            }
        }
    }

    /// The three pending reads, the interaction receipts, and the visit's end.
    pub(super) fn inbox_reply(
        &mut self,
        reply: &Reply,
        host: &dyn RecoveryHost,
    ) -> Result<(), RecoveryError> {
        let (id, started, permissions, forms) = {
            let visit = self.last()?;
            (
                visit.id.clone(),
                visit.started,
                std::mem::take(&mut visit.permissions),
                std::mem::take(&mut visit.forms),
            )
        };
        let inbox = pending(reply)?;
        if inbox
            .iter()
            .any(|entry| s_in(fields(entry), "sessionID") != id.as_str())
        {
            return Err(RecoveryError::InboxOwnership);
        }
        let mut keys = Vec::new();
        for (typ, values) in [("permission.asked", &permissions), ("form.created", &forms)] {
            for value in values {
                if s_in(fields(value), "sessionID") != id {
                    return Err(RecoveryError::InteractionOwnership);
                }
                let prefix = if typ == "permission.asked" {
                    "permission"
                } else {
                    "form"
                };
                let key = format!("{prefix}:{id}:{}", s_in(fields(value), "id"));
                let data = if typ == "form.created" {
                    json!({ "form": value })
                } else {
                    value.clone()
                };
                host.receive(&json!({
                    "id": format!("snapshot:{key}"),
                    "type": typ,
                    "data": data,
                }))?;
                keys.push(key);
            }
        }
        host.stage(
            "snapshot.interactions",
            &json!({ "sessionID": id, "keys": keys }),
            &id,
            started,
        )?;
        host.stage(
            "snapshot.inbox",
            &json!({ "sessionID": id, "items": inbox }),
            &id,
            started,
        )?;
        self.pop(host)
    }
}

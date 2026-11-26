// SPDX-License-Identifier: Apache-2.0
//! The recovery pass's walk (`packages/adapter-opencode/src/recovery.ts` whole):
//! the visit stack with its 64-deep and cycle bounds, the child listing with its
//! 64-page pagination bound, the live messages, the history refresh, and the
//! interaction and inbox staging. The pass's global tail, the active read and the
//! shell reads, is `recovery/shells.rs`.
//!
//! Every `await` of the TypeScript is one stage: a reply advances the machine and
//! the stage's next request is its effect. `started = watermark()` is the
//! facade's value at the reply that ends the stage before it, so nothing here
//! reads a clock, a socket or the filesystem.

use ace_json::{Value, json};
use indexmap::{IndexMap, IndexSet};

use crate::translate::boundaries::{BoundaryError, parse_pending_list};

use super::history::{Failure, HistoryError, Read as HistoryRead, Step as HistoryStep};
use super::http::Reply;
use super::ownership::Info;

mod shells;
mod visit;

use visit::Visit;

#[cfg(test)]
mod tests;

/// `visit(child.id, depth + 1)` past this depth fails (`recovery.ts:26`).
const MAX_DEPTH: usize = 64;
/// `for (let page = 0; page < 64; page++)` (`:33`).
pub(super) const MAX_PAGES: usize = 64;
/// `session.list`'s page size (`:39`).
const PAGE_LIMIT: u32 = 128;
/// A refusal with no message of its own, which the SDK does not produce.
const REFUSED: &str = "OpenCode recovery request failed";

/// Why a pass failed. The TypeScript throws these texts, and the facade's
/// `ConsumerFailure` carries them (`server.ts:59`-`:65`).
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum RecoveryError {
    #[error("OpenCode ancestry cycle/depth exceeded")]
    Cycle,
    #[error("OpenCode child pagination incomplete")]
    Pagination,
    #[error("OpenCode inbox ownership mismatch")]
    InboxOwnership,
    #[error("OpenCode interaction ownership mismatch")]
    InteractionOwnership,
    #[error("OpenCode execution settlement is unknown")]
    Settlement,
    #[error("OpenCode shell owner missing")]
    ShellOwner,
    #[error("OpenCode shell recovery incomplete")]
    ShellIncomplete,
    /// A request the pass waited on was refused; the text is the refusal's.
    #[error("{0}")]
    Refused(String),
    /// A reply failed its envelope check (a ZodError in the TypeScript).
    #[error("{0}")]
    Envelope(String),
    /// The session tree refused an admission or a verification.
    #[error("{0}")]
    Ownership(String),
    #[error("{0}")]
    History(HistoryError),
    #[error("{0}")]
    Evidence(String),
    /// The tenant's own frame or receive path refused.
    #[error("{0}")]
    Tenant(String),
    /// A reply arrived for a stage that never awaits.
    #[error("OpenCode recovery stage is out of order")]
    Stage,
}

impl RecoveryError {
    /// A reply that failed the check its stage names.
    fn envelope(field: &'static str) -> Self {
        Self::Envelope(BoundaryError::Event(field).to_string())
    }
}

/// What one stage asked for next.
#[derive(Debug, Clone, PartialEq)]
pub enum Step {
    /// One `http` request: the SDK call's name and its params.
    Request { op: &'static str, params: Value },
    /// The pass is over.
    Done,
}

/// Everything the walk reads and every effect it produces. The tenant is the
/// only implementor; `started` values arrive through [`Self::watermark`].
pub trait RecoveryHost {
    /// `server.eventWatermark` at the reply that ended the previous stage.
    fn watermark(&self) -> u64;
    fn verify(&self, info: &Info<'_>) -> Result<(), RecoveryError>;
    fn admit(&self, info: &Info<'_>, parent: &str) -> Result<(), RecoveryError>;
    fn direct_children(&self, id: &str) -> Vec<String>;
    /// `new Set([...sessions.values()].map((s) => s.directory))`, in order.
    fn session_directories(&self) -> Vec<String>;
    fn session_directory(&self, id: &str) -> Option<String>;
    fn shells(&self) -> IndexMap<String, String>;
    fn pending_shells(&self) -> IndexMap<String, String>;
    fn live_messages(&self, id: &str) -> Vec<String>;
    fn execution_observed(&self, id: &str) -> bool;
    fn history_begin(&self, id: &str) -> (HistoryRead, HistoryStep);
    fn history_step(
        &self,
        read: &mut HistoryRead,
        reply: &Reply,
        deliver: &mut dyn FnMut(&Value) -> Result<(), RecoveryError>,
    ) -> Result<HistoryStep, Failure<RecoveryError>>;
    /// `p.frame`: one `recv` frame through the tenant's `emit`.
    fn frame(&self, channel: &'static str, data: &Value) -> Result<(), RecoveryError>;
    /// `p.receive`: the tenant's own receive, with its ownership check.
    fn receive(&self, data: &Value) -> Result<(), RecoveryError>;
    /// `p.stage`: evidence for the replay, fenced by the pass's start.
    fn stage(
        &self,
        channel: &'static str,
        data: &Value,
        session: &str,
        started: u64,
    ) -> Result<(), RecoveryError>;
    /// `p.shellSnapshot`: the shell's evidence, fenced by its own read.
    fn shell_snapshot(&self, id: &str, owner: &str, started: u64) -> Result<(), RecoveryError>;
}

/// What the visit on top of the stack is doing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Phase {
    /// `await client.session.get({ sessionID })`.
    Info,
    /// `await client.session.list(...)` for one page.
    List,
    /// The page's children, one `visit` each.
    Children,
    /// `ownership.directChildren(id)`, one `visit` each.
    Known,
    /// `await client.session.message.get(...)` for one live message.
    Live,
    /// `await history.read(...)`.
    History,
    /// `await client.permission.list(...)`.
    Permissions,
    /// `await client.session.form.list(...)`.
    Forms,
    /// `await client.session.inbox.list(...)`.
    Inbox,
    /// `await client.session.active()`, the global tail's first read.
    Active,
    /// `await client.session.get(...)` in the global loop.
    ActiveInfo,
    /// `await client.shell.list(...)` for one directory.
    ShellList,
    /// `await client.shell.get(...)` for one shell the listing missed.
    ShellGet,
    /// The pass is over.
    Done,
}

/// `recoverSessions`'s walk over one server's sessions.
pub struct Recovery {
    /// `visited`, in insertion order: the global loop reads it.
    visited: IndexSet<String>,
    stack: Vec<Visit>,
    phase: Phase,
    shells: shells::Shells,
}

impl Recovery {
    /// `visit(p.ownership.root, 0)`: the pass's first `session.get`.
    pub fn begin(root: &str) -> (Self, Step) {
        let mut visited = IndexSet::new();
        visited.insert(root.to_owned());
        let recovery = Self {
            visited,
            stack: vec![Visit::new(root.to_owned(), 0, Phase::Active)],
            phase: Phase::Info,
            shells: shells::Shells::new(),
        };
        (recovery, get_request(root))
    }

    /// One `http` reply: the stage it ends and the next stage's request.
    pub fn step(&mut self, reply: &Reply, host: &dyn RecoveryHost) -> Result<Step, RecoveryError> {
        // `p.shell` answers its own refusal: a 404 is an absence.
        if !reply.ok && self.phase != Phase::ShellGet {
            return Err(RecoveryError::Refused(reply.refusal(REFUSED)));
        }
        match self.phase {
            Phase::Info => self.info_reply(reply, host)?,
            Phase::List => self.list_reply(reply)?,
            Phase::Live => self.live_reply(reply, host)?,
            Phase::History => {
                if let Some(step) = self.history_reply(reply, host)? {
                    return Ok(step);
                }
            }
            Phase::Permissions => {
                let values = pending(reply)?;
                self.last()?.permissions = values;
                self.phase = Phase::Forms;
            }
            Phase::Forms => {
                let values = pending(reply)?;
                self.last()?.forms = values;
                self.phase = Phase::Inbox;
            }
            Phase::Inbox => self.inbox_reply(reply, host)?,
            Phase::Active | Phase::ActiveInfo | Phase::ShellList | Phase::ShellGet => {
                self.shell_reply(reply, host)?;
            }
            Phase::Children | Phase::Known | Phase::Done => return Err(RecoveryError::Stage),
        }
        self.next(host)
    }

    /// Everything one stage does synchronously, up to its request or the end.
    fn next(&mut self, host: &dyn RecoveryHost) -> Result<Step, RecoveryError> {
        loop {
            match self.phase {
                Phase::Info => {
                    let id = self.last()?.id.clone();
                    return Ok(get_request(&id));
                }
                Phase::List => {
                    let params = list_params(self.last()?);
                    return Ok(Step::Request {
                        op: "session.list",
                        params,
                    });
                }
                Phase::Children => {
                    if self.next_child(host)? {
                        continue;
                    }
                }
                Phase::Known => {
                    if self.next_known()? {
                        continue;
                    }
                    self.enter_live(host)?;
                }
                Phase::Live => {
                    let visit = self.last()?;
                    if visit.live_at < visit.live.len() {
                        let message = visit.live[visit.live_at].clone();
                        return Ok(Step::Request {
                            op: "session.message.get",
                            params: json!({ "sessionID": visit.id, "messageID": message }),
                        });
                    }
                    self.phase = Phase::History;
                }
                Phase::History => {
                    let id = self.last()?.id.clone();
                    let (read, step) = host.history_begin(&id);
                    self.last()?.history = Some(read);
                    let HistoryStep::Request(params) = step else {
                        return Err(RecoveryError::Stage);
                    };
                    return Ok(Step::Request {
                        op: "message.list",
                        params,
                    });
                }
                Phase::Permissions => {
                    let id = self.last()?.id.clone();
                    return Ok(Step::Request {
                        op: "permission.list",
                        params: json!({ "sessionID": id }),
                    });
                }
                Phase::Forms => {
                    let id = self.last()?.id.clone();
                    return Ok(Step::Request {
                        op: "session.form.list",
                        params: json!({ "sessionID": id }),
                    });
                }
                Phase::Inbox => {
                    let id = self.last()?.id.clone();
                    return Ok(Step::Request {
                        op: "session.inbox.list",
                        params: json!({ "sessionID": id }),
                    });
                }
                Phase::Active | Phase::ActiveInfo | Phase::ShellList | Phase::ShellGet => {
                    return self.shell_next(host);
                }
                Phase::Done => return Ok(Step::Done),
            }
        }
    }

    /// The visit on top; every caller holds the borrow no longer than one statement.
    fn last(&mut self) -> Result<&mut Visit, RecoveryError> {
        self.stack.last_mut().ok_or(RecoveryError::Stage)
    }

    /// `SessionInfo.parse(await session.get)`; `verify`; the snapshot frame.
    fn pop(&mut self, host: &dyn RecoveryHost) -> Result<(), RecoveryError> {
        let visit = self.stack.pop().ok_or(RecoveryError::Stage)?;
        if self.stack.is_empty() {
            self.phase = Phase::Active;
            self.shells.begin(host.watermark());
        } else {
            self.phase = visit.resume;
        }
        Ok(())
    }

    /// One more `visit`: the cycle and depth bounds come first (`:26`).
    fn push(&mut self, id: String, depth: usize, resume: Phase) -> Result<bool, RecoveryError> {
        if self.visited.contains(&id) || depth > MAX_DEPTH {
            return Err(RecoveryError::Cycle);
        }
        self.visited.insert(id.clone());
        self.stack.push(Visit::new(id, depth, resume));
        self.phase = Phase::Info;
        Ok(true)
    }
}

/// `client.session.get({ sessionID })`.
fn get_request(id: &str) -> Step {
    Step::Request {
        op: "session.get",
        params: json!({ "sessionID": id }),
    }
}

/// `client.session.list`'s arguments for this page (`recovery.ts:34`-`:42`).
fn list_params(visit: &Visit) -> Value {
    match &visit.cursor {
        Some(cursor) => json!({
            "parentID": visit.id,
            "directory": visit.directory,
            "project": visit.project,
            "limit": PAGE_LIMIT,
            "cursor": cursor,
        }),
        None => json!({
            "parentID": visit.id,
            "directory": visit.directory,
            "project": visit.project,
            "limit": PAGE_LIMIT,
            "order": "asc",
        }),
    }
}

/// `PendingList.parse`: one reply's list, or its check's failure.
pub(super) fn pending(reply: &Reply) -> Result<Vec<Value>, RecoveryError> {
    parse_pending_list(&reply.body)
        .map(<[Value]>::to_vec)
        .map_err(|_| RecoveryError::envelope("pending"))
}

//! `AceSkills`: the person's skill library through `skills.request` (ADR 0103) on the daemon's
//! loopback WebSocket, authenticated by a `hello` with the local token (ADR 0030).
//!
//! One socket is kept open; answers are matched to requests by `requestId`. A socket the daemon
//! dropped is opened again on the next request, and a list or read that hit a dropped socket is
//! sent once more on a fresh one (both only read).

mod socket;
mod wire;

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use serde_json::Value;
use tokio::sync::Mutex;

use crate::secret::Secret;
use socket::Socket;
use wire::{Operation, SkillResult};

#[derive(Debug, Clone)]
pub struct SkillsConfig {
    /// `SPADE_ACE_URL`, the daemon's loopback WebSocket, for example `ws://127.0.0.1:4300/`.
    pub url: String,
    /// `SPADE_ACE_TOKEN`, the daemon's local token.
    pub token: Secret,
    /// The device id `hello` names. The local token isn't tied to one, so any stable id works.
    pub device_id: String,
    /// Connecting, the hello and each request give up after this.
    pub timeout: Duration,
}

/// Where a skill lives (`SkillScope` in `packages/protocol/src/skill-library.ts`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SkillScope {
    Project,
    Personal,
    Plugin,
    Builtin,
    /// A scope added to ace after this was written, kept as sent.
    Other(String),
}

/// One skill in the library, with what Spade needs to offer and load it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Skill {
    /// Opaque and stable, `skl_…`; `read` takes it.
    pub id: String,
    pub name: String,
    pub title: Option<String>,
    pub description: String,
    pub scope: SkillScope,
    /// Only runs when the person picks it; a model should not load it on its own.
    pub manual: bool,
    pub argument_hint: Option<String>,
    /// SHA-256 of SKILL.md.
    pub hash: String,
}

/// A skill with its full SKILL.md text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkillText {
    pub skill: Skill,
    pub text: String,
}

/// The daemon's typed refusals (`SkillErrorCode` in `packages/protocol/src/skill-library.ts`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SkillErrorCode {
    NotFound,
    /// The skill library isn't available on this daemon right now.
    Unavailable,
    /// Another ace holds the skills lock; trying again shortly works.
    Busy,
    Forbidden,
    /// Listing-only, such as a plugin's skill.
    ReadOnly,
    Invalid,
    Other(String),
}

impl SkillErrorCode {
    fn parse(code: &str) -> Self {
        match code {
            "not_found" => Self::NotFound,
            "unavailable" => Self::Unavailable,
            "busy" => Self::Busy,
            "forbidden" => Self::Forbidden,
            "read_only" => Self::ReadOnly,
            "invalid" | "invalid_message" => Self::Invalid,
            other => Self::Other(other.to_owned()),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum SkillsError {
    /// The daemon refused the local token in `hello`.
    #[error("ace refused Spade's local token")]
    Refused,
    /// The daemon could not be reached, or the socket closed before the answer came.
    #[error("ace's skill library is unreachable: {0}")]
    Unreachable(String),
    #[error("ace did not answer in time")]
    Timeout,
    #[error("ace refused the skill request ({code:?}): {message}")]
    Daemon {
        code: SkillErrorCode,
        message: String,
    },
    #[error("ace sent something Spade could not read: {0}")]
    Protocol(String),
}

pub struct AceSkills {
    config: SkillsConfig,
    socket: Mutex<Option<Socket>>,
    next_id: AtomicU64,
}

impl AceSkills {
    /// Nothing is sent until the first request.
    pub fn new(config: SkillsConfig) -> Self {
        Self {
            config,
            socket: Mutex::new(None),
            next_id: AtomicU64::new(0),
        }
    }

    /// Personal, plugin and builtin skills, and the project's when `workspace_id` names one.
    pub async fn list(&self, workspace_id: Option<&str>) -> Result<Vec<Skill>, SkillsError> {
        match self.request(Operation::List { workspace_id }).await? {
            SkillResult::List { entries } => Ok(entries.into_iter().map(skill).collect()),
            other => Err(unexpected(&other)),
        }
    }

    /// One skill and its SKILL.md text. An id the daemon doesn't know is `not_found`.
    pub async fn read(
        &self,
        id: &str,
        workspace_id: Option<&str>,
    ) -> Result<SkillText, SkillsError> {
        match self.request(Operation::Read { id, workspace_id }).await? {
            SkillResult::Skill { entry, text } => Ok(SkillText {
                skill: skill(entry),
                text,
            }),
            other => Err(unexpected(&other)),
        }
    }

    async fn request(&self, operation: Operation<'_>) -> Result<SkillResult, SkillsError> {
        let (socket, fresh) = self.socket().await?;
        let first = self.send(&socket, &operation).await;
        let raw = match first {
            Err(SkillsError::Unreachable(_)) if !fresh => {
                self.drop_socket(&socket).await;
                let (socket, _) = self.socket().await?;
                self.send(&socket, &operation).await
            }
            other => other,
        };
        let raw = raw?;
        let result: SkillResult = serde_json::from_value(raw)
            .map_err(|error| SkillsError::Protocol(self.config.token.scrub(error.to_string())))?;
        match result {
            SkillResult::Error { code, message } => Err(SkillsError::Daemon {
                code: SkillErrorCode::parse(&code),
                message: self.config.token.scrub(message),
            }),
            other => Ok(other),
        }
    }

    async fn send(&self, socket: &Socket, operation: &Operation<'_>) -> Result<Value, SkillsError> {
        let id = format!("spade-{}", self.next_id.fetch_add(1, Ordering::Relaxed) + 1);
        let result = socket.request(&id, operation, self.config.timeout).await;
        if matches!(
            result,
            Err(SkillsError::Unreachable(_) | SkillsError::Refused)
        ) {
            self.drop_socket(socket).await;
        }
        result
    }

    /// The open socket, or a new one; `true` when it was just opened.
    async fn socket(&self) -> Result<(Socket, bool), SkillsError> {
        let mut slot = self.socket.lock().await;
        if let Some(socket) = slot.as_ref()
            && socket.is_open()
        {
            return Ok((socket.clone(), false));
        }
        let socket = Socket::open(&self.config).await?;
        *slot = Some(socket.clone());
        Ok((socket, true))
    }

    async fn drop_socket(&self, socket: &Socket) {
        let mut slot = self.socket.lock().await;
        if slot.as_ref().is_some_and(|current| current.same(socket)) {
            *slot = None;
        }
    }
}

fn skill(entry: wire::SkillEntry) -> Skill {
    let scope = match entry.scope.as_str() {
        "project" => SkillScope::Project,
        "personal" => SkillScope::Personal,
        "plugin" => SkillScope::Plugin,
        "builtin" => SkillScope::Builtin,
        _ => SkillScope::Other(entry.scope),
    };
    Skill {
        id: entry.id,
        name: entry.name,
        title: entry.title,
        description: entry.description,
        scope,
        manual: entry.manual,
        argument_hint: entry.argument_hint,
        hash: entry.hash,
    }
}

fn unexpected(result: &SkillResult) -> SkillsError {
    let kind = match result {
        SkillResult::List { .. } => "list",
        SkillResult::Skill { .. } => "skill",
        SkillResult::Error { .. } => "error",
    };
    SkillsError::Protocol(format!("unexpected `{kind}` result"))
}

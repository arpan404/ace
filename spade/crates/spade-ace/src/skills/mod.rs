//! `AceSkills`: the person's skill library through `skills.request` (ADR 0103) on the daemon's
//! loopback WebSocket, authenticated by a `hello` with the local token (ADR 0030).
//!
//! One socket is kept open; answers are matched to requests by `requestId`. A socket the daemon
//! dropped is opened again on the next request, and a list or read that hit a dropped socket is
//! sent once more on a fresh one (both only read); a create or edit never is. Dropping `AceSkills` closes the socket, even
//! one stuck writing to a peer that stopped reading.

mod socket;
mod wire;

use std::sync::atomic::{AtomicU64, Ordering};

use serde_json::Value;
use tokio::sync::Mutex;

pub use crate::config::SkillsConfig;
use socket::Socket;
use wire::Operation;

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
#[derive(Debug, Clone, PartialEq)]
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
    /// The whole entry as the daemon sent it (agents, path, source, fields added later).
    pub raw: Value,
}

/// The library as the daemon listed it.
#[derive(Debug, Clone, PartialEq)]
pub struct SkillList {
    pub skills: Vec<Skill>,
    /// The daemon served a listing it could not refresh.
    pub stale: bool,
    /// Entries Spade could not read, as sent.
    pub unreadable: Vec<Value>,
    /// Every other field of the list result (fields added later), as sent.
    pub extra: serde_json::Map<String, Value>,
}

/// A skill with its full SKILL.md text.
#[derive(Debug, Clone, PartialEq)]
pub struct SkillText {
    pub skill: Skill,
    pub text: String,
    /// The whole result as the daemon sent it.
    pub raw: Value,
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
    /// The skill changed since the hash the edit was based on.
    Conflict,
    /// A skill with that name already exists.
    Exists,
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
            "conflict" => Self::Conflict,
            "exists" => Self::Exists,
            other => Self::Other(other.to_owned()),
        }
    }
}

#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum SkillsError {
    /// The daemon refused the local token in `hello`.
    #[error("ace refused Spade's local token")]
    Refused,
    /// The daemon could not be reached, or the socket closed before the answer came.
    #[error("ace's skill library is unreachable: {0}")]
    Unreachable(String),
    #[error("ace did not answer in time")]
    Timeout,
    /// Too many requests are waiting on a daemon that isn't keeping up; nothing was sent.
    #[error("too many skill requests are waiting on ace")]
    Backlogged,
    #[error("ace refused the skill request ({code:?}): {message}")]
    Daemon {
        code: SkillErrorCode,
        message: String,
    },
    /// The daemon answered with a result Spade didn't ask for or doesn't know, kept as sent.
    #[error("ace answered with an unexpected `{kind}` result")]
    UnexpectedResult { kind: String, raw: Value },
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

    /// The daemon socket this library talks to, for others that open their own (routines'
    /// thread events).
    pub fn config(&self) -> &SkillsConfig {
        &self.config
    }

    /// Personal, plugin and builtin skills, and the project's when `workspace_id` names one.
    pub async fn list(&self, workspace_id: Option<&str>) -> Result<SkillList, SkillsError> {
        let result = self.request(Operation::List { workspace_id }).await?;
        let Value::Object(mut fields) = result else {
            return Err(unexpected(result));
        };
        if fields.get("kind").and_then(Value::as_str) != Some("list") {
            return Err(unexpected(Value::Object(fields)));
        }
        let entries = match fields.remove("entries") {
            Some(Value::Array(entries)) => entries,
            other => {
                if let Some(other) = other {
                    fields.insert("entries".into(), other);
                }
                return Err(unexpected(Value::Object(fields)));
            }
        };
        fields.remove("kind");
        let stale = match fields.remove("stale") {
            Some(Value::Bool(stale)) => stale,
            Some(other) => {
                fields.insert("stale".into(), other);
                false
            }
            None => false,
        };
        let mut list = SkillList {
            skills: Vec::new(),
            stale,
            unreadable: Vec::new(),
            extra: fields,
        };
        for entry in entries {
            match skill(entry) {
                Ok(skill) => list.skills.push(skill),
                Err(raw) => list.unreadable.push(raw),
            }
        }
        Ok(list)
    }

    /// One skill and its SKILL.md text. An id the daemon doesn't know is `not_found`.
    pub async fn read(
        &self,
        id: &str,
        workspace_id: Option<&str>,
    ) -> Result<SkillText, SkillsError> {
        let result = self.request(Operation::Read { id, workspace_id }).await?;
        skill_text(result)
    }

    /// Creates a personal skill (`~/.agents/skills/<name>`) linked for `agents`, and answers it
    /// with its text. A name already taken is `exists`.
    pub async fn create(&self, new: NewSkill<'_>) -> Result<SkillText, SkillsError> {
        let result = self
            .request(Operation::Create {
                name: new.name,
                description: new.description,
                body: new.body,
                scope: wire::PERSONAL,
                agents: new.agents,
                manual: new.manual,
            })
            .await?;
        skill_text(result)
    }

    /// Replaces a skill's description and body, if its SKILL.md still has `expected_hash`;
    /// otherwise `conflict`.
    pub async fn edit(&self, edit: SkillEdit<'_>) -> Result<SkillText, SkillsError> {
        let result = self
            .request(Operation::Edit {
                id: edit.id,
                expected_hash: edit.expected_hash,
                description: edit.description,
                body: edit.body,
                manual: edit.manual,
            })
            .await?;
        skill_text(result)
    }

    /// The raw `result` of a `skills.result`, or the daemon's typed refusal.
    async fn request(&self, operation: Operation<'_>) -> Result<Value, SkillsError> {
        let (socket, fresh) = self.socket().await?;
        let first = self.send(&socket, &operation).await;
        let result = match first {
            Err(SkillsError::Unreachable(_)) if !fresh && operation.reads_only() => {
                let (socket, _) = self.socket().await?;
                self.send(&socket, &operation).await
            }
            other => other,
        }?;
        if kind(&result) == "error" {
            let code = result.get("code").and_then(Value::as_str).unwrap_or("");
            let message = result.get("message").and_then(Value::as_str).unwrap_or("");
            return Err(SkillsError::Daemon {
                code: SkillErrorCode::parse(code),
                message: self.config.token().scrub(message),
            });
        }
        Ok(result)
    }

    async fn send(&self, socket: &Socket, operation: &Operation<'_>) -> Result<Value, SkillsError> {
        let id = format!("spade-{}", self.next_id.fetch_add(1, Ordering::Relaxed) + 1);
        let result = socket.request(&id, operation, self.config.timeout()).await;
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

/// A new personal skill, for [`AceSkills::create`].
#[derive(Debug, Clone, Copy)]
pub struct NewSkill<'a> {
    /// A slug: lowercase letters, digits and single hyphens, at most 64.
    pub name: &'a str,
    pub description: &'a str,
    /// SKILL.md below its frontmatter; ace writes the frontmatter.
    pub body: &'a str,
    /// Provider kinds to link it for (`claude`, `codex`, `opencode`, `cursor`, `pi`).
    pub agents: &'a [&'a str],
    pub manual: bool,
}

/// An edit of an existing skill, for [`AceSkills::edit`].
#[derive(Debug, Clone, Copy)]
pub struct SkillEdit<'a> {
    pub id: &'a str,
    /// The SKILL.md hash the edit was made against.
    pub expected_hash: &'a str,
    pub description: &'a str,
    pub body: &'a str,
    pub manual: bool,
}

/// Every agent ace's library can link a skill for (`SkillAgent` in
/// `packages/protocol/src/skill-library.ts`).
pub const ALL_AGENTS: [&str; 5] = ["claude", "codex", "opencode", "cursor", "pi"];

fn skill_text(result: Value) -> Result<SkillText, SkillsError> {
    let text = result
        .get("text")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let entry = result.get("entry").cloned().map(skill);
    match (kind(&result) == "skill", text, entry) {
        (true, Some(text), Some(Ok(skill))) => Ok(SkillText {
            skill,
            text,
            raw: result,
        }),
        _ => Err(unexpected(result)),
    }
}

fn kind(result: &Value) -> &str {
    result.get("kind").and_then(Value::as_str).unwrap_or("")
}

fn unexpected(raw: Value) -> SkillsError {
    SkillsError::UnexpectedResult {
        kind: kind(&raw).to_owned(),
        raw,
    }
}

/// A skill from its raw entry, or the entry back when it can't be read.
fn skill(raw: Value) -> Result<Skill, Value> {
    let Ok(entry) = serde_json::from_value::<wire::SkillEntry>(raw.clone()) else {
        return Err(raw);
    };
    let scope = match entry.scope.as_str() {
        "project" => SkillScope::Project,
        "personal" => SkillScope::Personal,
        "plugin" => SkillScope::Plugin,
        "builtin" => SkillScope::Builtin,
        _ => SkillScope::Other(entry.scope),
    };
    Ok(Skill {
        id: entry.id,
        name: entry.name,
        title: entry.title,
        description: entry.description,
        scope,
        manual: entry.manual,
        argument_hint: entry.argument_hint,
        hash: entry.hash,
        raw,
    })
}

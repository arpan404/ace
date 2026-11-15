//! `AceSkills`: the person's skill library through `skills.request` (ADR 0103) on the daemon's
//! loopback WebSocket, authenticated by a `hello` with the local token (ADR 0030).
//!
//! One socket is kept open; answers are matched to requests by `requestId`. A socket the daemon
//! dropped is opened again on the next request, and a list or read that hit a dropped socket is
//! sent once more on a fresh one (both only read); a create or edit never is. Dropping `AceSkills` closes the socket, even
//! one stuck writing to a peer that stopped reading.

mod socket;
mod wire;

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use base64::Engine as _;
use serde_json::Value;
use tokio::sync::{Mutex, Notify};

pub use crate::config::SkillsConfig;
use socket::Socket;
use wire::Operation;
pub use wire::SkillFile;

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

/// A skill's files besides SKILL.md, as the daemon listed them (ADR 0151).
#[derive(Debug, Clone, PartialEq)]
pub struct SkillFiles {
    pub files: Vec<SkillFile>,
    /// What the daemon left out (too large, too many, not a file), as sent.
    pub omitted: Vec<Value>,
}

/// One of a skill's files with its content.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkillFileBytes {
    pub file: SkillFile,
    pub bytes: Vec<u8>,
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
    /// Rung by a pushed `skills.changed` and when a socket ends.
    changed: Arc<Notify>,
}

impl AceSkills {
    /// Nothing is sent until the first request.
    pub fn new(config: SkillsConfig) -> Self {
        Self {
            config,
            socket: Mutex::new(None),
            next_id: AtomicU64::new(0),
            changed: Arc::new(Notify::new()),
        }
    }

    /// Waits until the library may have changed since [`AceSkills::list_watched`]: the daemon
    /// pushed a change, or the socket it was subscribed on ended. One waiter at a time; a change
    /// that came while nobody waited is kept for the next wait.
    pub async fn changed(&self) {
        self.changed.notified().await;
    }

    /// Like [`AceSkills::list`] for personal, plugin and builtin skills, and subscribes the
    /// socket, once, so the daemon pushes later changes (see [`AceSkills::changed`]).
    pub async fn list_watched(&self) -> Result<SkillList, SkillsError> {
        let (socket, _) = self.socket().await?;
        let subscribe = socket.subscribe_once();
        let sent = self
            .send(
                &socket,
                &Operation::List {
                    workspace_id: None,
                    subscribe,
                },
            )
            .await
            .and_then(|result| self.refusal(result));
        if subscribe && sent.is_err() {
            socket.unsubscribed();
        }
        list_of(sent?)
    }

    /// A skill's files besides SKILL.md: paths, sizes and hashes (ADR 0151).
    pub async fn files(&self, id: &str) -> Result<SkillFiles, SkillsError> {
        let result = self.request(Operation::Files { id, path: None }).await?;
        if kind(&result) != "files" {
            return Err(unexpected(result));
        }
        match serde_json::from_value::<wire::FilesResult>(result.clone()) {
            Ok(listed) => Ok(SkillFiles {
                files: listed.files,
                omitted: listed.omitted,
            }),
            Err(_) => Err(unexpected(result)),
        }
    }

    /// One of a skill's files, by its relative path, with its content.
    pub async fn file(&self, id: &str, path: &str) -> Result<SkillFileBytes, SkillsError> {
        let result = self
            .request(Operation::Files {
                id,
                path: Some(path),
            })
            .await?;
        if kind(&result) != "file" {
            return Err(unexpected(result));
        }
        let Ok(read) = serde_json::from_value::<wire::FileResult>(result.clone()) else {
            return Err(unexpected(result));
        };
        match base64::engine::general_purpose::STANDARD.decode(read.content.as_bytes()) {
            Ok(bytes) => Ok(SkillFileBytes {
                file: read.file,
                bytes,
            }),
            Err(_) => Err(unexpected(result)),
        }
    }

    /// The daemon socket this library talks to, for others that open their own (routines'
    /// thread events).
    pub fn config(&self) -> &SkillsConfig {
        &self.config
    }

    /// Personal, plugin and builtin skills, and the project's when `workspace_id` names one.
    pub async fn list(&self, workspace_id: Option<&str>) -> Result<SkillList, SkillsError> {
        let result = self
            .request(Operation::List {
                workspace_id,
                subscribe: false,
            })
            .await?;
        list_of(result)
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
        self.refusal(result)
    }

    /// The result, or the daemon's typed refusal when it is an `error`.
    fn refusal(&self, result: Value) -> Result<Value, SkillsError> {
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

    /// The linked machines the daemon can call for Spade (ADR 0132): `spade.machines`. The
    /// answer's fields beside `requestId` (`machines`).
    pub async fn spade_machines(&self) -> Result<Value, SkillsError> {
        self.spade_frame(|id| serde_json::json!({ "type": "spade.machines", "requestId": id }))
            .await
    }

    /// One inbox request for another machine's Spade, by host id: `spade.remote`. The answer's
    /// `result`. Never sent twice: the sender's outbox retries.
    pub async fn spade_remote(&self, machine: &str, request: &Value) -> Result<Value, SkillsError> {
        let answer = self
            .spade_frame(|id| {
                serde_json::json!({
                    "type": "spade.remote",
                    "requestId": id,
                    "machine": machine,
                    "request": request,
                })
            })
            .await?;
        Ok(answer.get("result").cloned().unwrap_or(Value::Null))
    }

    /// A bot's computer as ace keeps it (ADR 0142): `spade.computer.get`. The answer's fields
    /// beside `requestId` (`computer`, or `error`).
    pub async fn spade_computer(&self, bot: &str) -> Result<Value, SkillsError> {
        self.spade_frame(
            |id| serde_json::json!({ "type": "spade.computer.get", "requestId": id, "bot": bot }),
        )
        .await
    }

    /// Hands a bot's browser and screen to `driver` (`person` or `bot`): `spade.computer.drive`.
    /// The frame names the mode too (ADR 0143): `exclusive` for the person, `cowork` for the bot;
    /// a daemon that knows modes goes by it, an older one by `driver`. The answer's fields beside
    /// `requestId` (`driver`, `mode`, `handback` when the person handed back, or `error`).
    /// Setting the current driver again changes nothing.
    pub async fn spade_computer_drive(
        &self,
        bot: &str,
        driver: &str,
    ) -> Result<Value, SkillsError> {
        self.spade_frame(|id| {
            serde_json::json!({
                "type": "spade.computer.drive",
                "requestId": id,
                "bot": bot,
                "driver": driver,
                "mode": if driver == "person" { "exclusive" } else { "cowork" },
            })
        })
        .await
    }

    async fn spade_frame(&self, frame: impl FnOnce(&str) -> Value) -> Result<Value, SkillsError> {
        let (socket, _) = self.socket().await?;
        let id = format!("spade-{}", self.next_id.fetch_add(1, Ordering::Relaxed) + 1);
        let text = frame(&id).to_string();
        // Long enough for the daemon's own 40 s wait on the other machine.
        let timeout = self
            .config
            .timeout()
            .max(std::time::Duration::from_secs(45));
        let result = socket.request_frame(&id, text, timeout).await;
        if matches!(
            result,
            Err(SkillsError::Unreachable(_) | SkillsError::Refused)
        ) {
            self.drop_socket(&socket).await;
        }
        result
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
        let socket = Socket::open(&self.config, self.changed.clone()).await?;
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

/// A `list` result as a [`SkillList`].
fn list_of(result: Value) -> Result<SkillList, SkillsError> {
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

//! The marketplace's skills for Spade (ADR 0168 §8, §13) through `marketplace.request` on the
//! same daemon socket as the skill library: the installed market skills with their pinned hashes
//! (`spadeSkills`), one skill's file list and one file's content (`spadeSkillFiles`). These are
//! reads the device read scope allows. The daemon pushes `marketplace.changed` to every welcomed
//! socket; [`AceSkills::market_changed`] waits for it.
//!
//! The shapes mirror `MarketOperation` and `MarketResult` in `packages/protocol/src/marketplace.ts`.
//! An entry Spade can't read is skipped, never fatal.

use base64::Engine as _;
use serde::Deserialize;
use serde_json::{Value, json};

use super::{AceSkills, SkillErrorCode, SkillsError};

/// One installed market skill (`MarketSpadeSkill`).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct MarketSkill {
    pub name: String,
    pub version: String,
    /// The pinned content hash: a change means the copy is replaced whole.
    pub hash: String,
    #[serde(default)]
    pub description: String,
}

/// One of a market skill's files (`MarketSpadeFile`), `SKILL.md` among them.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct MarketFile {
    /// Relative to the skill's folder, with `/`.
    pub path: String,
    pub bytes: u64,
    /// SHA-256 of the content.
    pub hash: String,
    #[serde(default)]
    pub executable: bool,
}

/// A listed bot package (`MarketSpadeBot`): the market's signed version manifest and the
/// `bot.json` it covers, unchecked until Spade verifies them.
#[derive(Debug, Clone, PartialEq)]
pub struct MarketBot {
    pub signed: Value,
    pub bot_json: String,
}

/// One market skill file with its content.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MarketFileBytes {
    pub file: MarketFile,
    pub bytes: Vec<u8>,
}

impl AceSkills {
    /// Waits until installed market entries may have changed: the daemon pushed
    /// `marketplace.changed`, or the socket ended. One waiter at a time; a change that came while
    /// nobody waited is kept for the next wait.
    pub async fn market_changed(&self) {
        self.changed.market.notified().await;
    }

    /// The market skills installed and on, with their pinned hashes.
    pub async fn market_skills(&self) -> Result<Vec<MarketSkill>, SkillsError> {
        let result = self.market(json!({ "op": "spadeSkills" })).await?;
        let Some(Value::Array(entries)) = result.get("skills") else {
            return Err(unexpected(result));
        };
        Ok(entries
            .iter()
            .filter_map(|entry| serde_json::from_value(entry.clone()).ok())
            .collect())
    }

    /// A market skill's files, `SKILL.md` among them.
    pub async fn market_files(&self, name: &str) -> Result<Vec<MarketFile>, SkillsError> {
        let result = self
            .market(json!({ "op": "spadeSkillFiles", "name": name }))
            .await?;
        files_of(&result).ok_or_else(|| unexpected(result))
    }

    /// One of a market skill's files, by its relative path, with its content.
    pub async fn market_file(
        &self,
        name: &str,
        path: &str,
    ) -> Result<MarketFileBytes, SkillsError> {
        let result = self
            .market(json!({ "op": "spadeSkillFiles", "name": name, "path": path }))
            .await?;
        let file = files_of(&result).and_then(|files| files.into_iter().find(|f| f.path == path));
        let bytes = result
            .get("content")
            .and_then(Value::as_str)
            .and_then(|content| {
                base64::engine::general_purpose::STANDARD
                    .decode(content.as_bytes())
                    .ok()
            });
        match (file, bytes) {
            (Some(file), Some(bytes)) => Ok(MarketFileBytes { file, bytes }),
            _ => Err(unexpected(result)),
        }
    }

    /// The version of the bot package `name` the market lists now, as a bot's suggestion reads
    /// it (`spadeBot`): its signed version manifest as served and `bot.json`'s exact text. Spade
    /// checks the signature itself. `None` when the market lists no such package.
    pub async fn market_bot(&self, name: &str) -> Result<Option<MarketBot>, SkillsError> {
        let result = match self.market(json!({ "op": "spadeBot", "name": name })).await {
            Ok(result) => result,
            Err(SkillsError::Daemon {
                code: SkillErrorCode::NotFound,
                ..
            }) => return Ok(None),
            Err(error) => return Err(error),
        };
        match (
            result.get("signed"),
            result.get("botJson").and_then(Value::as_str),
        ) {
            (Some(signed), Some(bot_json)) => Ok(Some(MarketBot {
                signed: signed.clone(),
                bot_json: bot_json.to_owned(),
            })),
            _ => Err(unexpected(result)),
        }
    }

    /// One read-only `marketplace.request`, answered with its `result`, or the daemon's typed
    /// refusal. A read that hit a dropped socket is sent once more on a fresh one.
    async fn market(&self, operation: Value) -> Result<Value, SkillsError> {
        let frame = |id: &str| json!({ "type": "marketplace.request", "requestId": id, "operation": operation });
        let result = match self.spade_frame(frame).await {
            Err(SkillsError::Unreachable(_)) => self.spade_frame(frame).await,
            other => other,
        }?;
        if result.get("op").and_then(Value::as_str) == Some("error") {
            let code = result.get("code").and_then(Value::as_str).unwrap_or("");
            let message = result.get("message").and_then(Value::as_str).unwrap_or("");
            return Err(SkillsError::Daemon {
                code: SkillErrorCode::parse(code),
                message: self.config.token().scrub(message),
            });
        }
        Ok(result)
    }
}

fn files_of(result: &Value) -> Option<Vec<MarketFile>> {
    let Value::Array(files) = result.get("files")? else {
        return None;
    };
    Some(
        files
            .iter()
            .filter_map(|file| serde_json::from_value(file.clone()).ok())
            .collect(),
    )
}

fn unexpected(raw: Value) -> SkillsError {
    SkillsError::UnexpectedResult {
        kind: raw
            .get("op")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned(),
        raw,
    }
}

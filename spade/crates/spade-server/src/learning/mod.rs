//! Skills a bot writes (ADR 0130): proposals waiting for the person, and each bot's notes on the
//! skills it used. Both are small JSON files in Spade's data folder (`skills/proposals/<id>.json`,
//! `skills/notes/<bot>.json`), written whole through a temporary file. Saving a proposal goes to
//! ace's library through [`SkillLibrary`]; until then nothing outside Spade changes.

mod tools;

use std::collections::{BTreeMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};

pub use tools::{SkillFeedback, SkillPropose};

use crate::clock::Clock;
use crate::tools::{SkillLibrary, SkillSource, WriteError};

/// Open proposals one bot may have at once.
pub const MOST_OPEN: usize = 20;
pub const NAME_CHARS: usize = 64;
pub const DESCRIPTION_CHARS: usize = 1_024;
/// ace refuses SKILL.md over 256 KiB; the body leaves room for the frontmatter.
pub const BODY_BYTES: usize = 250 * 1024;
pub const WHY_CHARS: usize = 2_000;
pub const NOTE_CHARS: usize = 1_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProposalState {
    Open,
    Saved,
    Discarded,
}

/// The skill as it was when an edit was proposed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Base {
    pub id: String,
    pub hash: String,
    pub description: String,
    pub body: String,
    pub manual: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Proposal {
    pub id: String,
    pub agent: String,
    /// The `skill_propose` call that made it, so the chat places it after that reply.
    pub call_id: String,
    pub name: String,
    pub description: String,
    pub body: String,
    /// What the bot learned, in its words.
    pub why: String,
    /// Set for an edit of an existing skill.
    pub base: Option<Base>,
    pub state: ProposalState,
    pub created_at: i64,
    pub answered_at: Option<i64>,
    /// The library's id for the skill once saved.
    pub skill_id: Option<String>,
    /// Made in a turn that had read untrusted content: what, in a few words. The app shows it
    /// beside Save.
    #[serde(default)]
    pub source: Option<String>,
    /// A Save sent to the library whose outcome is not known yet (its answer never came). The
    /// next answer first looks in the library for the skill before writing again.
    #[serde(default)]
    pub attempt: Option<Attempt>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Attempt {
    pub id: String,
    pub at: i64,
}

/// A new proposal, before it is stored.
pub struct Draft {
    pub name: String,
    pub description: String,
    pub body: String,
    pub why: String,
    pub base: Option<SkillSource>,
    /// What untrusted content the turn had read, if any.
    pub source: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Verdict {
    Helpful,
    Outdated,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Note {
    pub verdict: Verdict,
    #[serde(default)]
    pub note: String,
    pub at: i64,
    /// Written in a turn that had read untrusted content: what. Loading the skill with this
    /// note then counts as reading untrusted content.
    #[serde(default)]
    pub source: Option<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum AnswerError {
    #[error("no such proposal")]
    NotFound,
    #[error("this proposal was already answered")]
    Answered,
    #[error("this proposal is being answered")]
    Busy,
    /// The library refused; the proposal stays open.
    #[error("{0}")]
    Library(WriteError),
    #[error("{0}")]
    Io(String),
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum ProposeError {
    #[error("you have {MOST_OPEN} proposals the person has not answered yet; wait for them first")]
    TooMany,
    #[error("{0}")]
    Io(String),
}

/// Proposals and notes, in `<data folder>/skills`.
pub struct Learning {
    dir: PathBuf,
    clock: Arc<dyn Clock>,
    library: Arc<dyn SkillLibrary>,
    /// Held across reading and writing files, never across an await.
    files: Mutex<()>,
    /// Proposals being saved now, so a second Save waits for the first to finish.
    answering: Mutex<HashSet<String>>,
}

impl Learning {
    pub fn new(
        dir: impl Into<PathBuf>,
        clock: Arc<dyn Clock>,
        library: Arc<dyn SkillLibrary>,
    ) -> Self {
        Self {
            dir: dir.into(),
            clock,
            library,
            files: Mutex::default(),
            answering: Mutex::default(),
        }
    }

    pub fn library(&self) -> &Arc<dyn SkillLibrary> {
        &self.library
    }

    fn proposals_dir(&self) -> PathBuf {
        self.dir.join("proposals")
    }

    fn notes_file(&self, agent: &str) -> PathBuf {
        self.dir.join("notes").join(format!("{}.json", safe(agent)))
    }

    /// Stores a proposal made by the call `key` (`<conversation>.<call>`), replacing the bot's
    /// open one for the same name. The id comes from the key, so a retried call stores the same
    /// proposal once.
    pub fn propose(&self, agent: &str, key: &str, draft: Draft) -> Result<Proposal, ProposeError> {
        let _files = lock(&self.files);
        let id = proposal_id(key);
        let mine: Vec<Proposal> = self
            .read_all()
            .into_iter()
            .filter(|p| p.agent == agent && p.state == ProposalState::Open && p.id != id)
            .collect();
        let replaced: Vec<&Proposal> = mine.iter().filter(|p| p.name == draft.name).collect();
        if mine.len() - replaced.len() >= MOST_OPEN {
            return Err(ProposeError::TooMany);
        }
        let proposal = Proposal {
            id,
            agent: agent.to_owned(),
            call_id: key.split_once('.').map_or(key, |(_, call)| call).to_owned(),
            name: draft.name,
            description: draft.description,
            body: draft.body,
            why: draft.why,
            base: draft.base.map(|s| Base {
                id: s.id,
                hash: s.hash,
                description: s.description,
                body: s.body,
                manual: s.manual,
            }),
            state: ProposalState::Open,
            created_at: self.clock.now_ms(),
            answered_at: None,
            skill_id: None,
            source: draft.source,
            attempt: None,
        };
        self.write(&proposal)
            .map_err(|e| ProposeError::Io(e.to_string()))?;
        for old in replaced {
            let _ = std::fs::remove_file(self.proposals_dir().join(format!("{}.json", old.id)));
        }
        Ok(proposal)
    }

    /// The bot's proposals, oldest first.
    pub fn proposals(&self, agent: &str) -> Vec<Proposal> {
        let _files = lock(&self.files);
        let mut mine: Vec<Proposal> = self
            .read_all()
            .into_iter()
            .filter(|p| p.agent == agent)
            .collect();
        mine.sort_by(|a, b| (a.created_at, &a.id).cmp(&(b.created_at, &b.id)));
        mine
    }

    /// Saves the proposal to ace's library, or discards it. A refused save leaves it open. Only
    /// one answer to a proposal runs at a time: it is claimed before its state is read.
    pub async fn answer(&self, agent: &str, id: &str, save: bool) -> Result<Proposal, AnswerError> {
        if !lock(&self.answering).insert(id.to_owned()) {
            return Err(AnswerError::Busy);
        }
        let answered = match self.open_proposal(agent, id) {
            Ok(proposal) => self.answer_open(proposal, save).await,
            Err(error) => Err(error),
        };
        lock(&self.answering).remove(id);
        answered
    }

    async fn answer_open(
        &self,
        mut proposal: Proposal,
        save: bool,
    ) -> Result<Proposal, AnswerError> {
        // An earlier Save may have reached the library without its answer coming back.
        let already = match &proposal.attempt {
            Some(_) => self.reconcile(&proposal).await?,
            None => None,
        };
        if let Some(skill) = already {
            proposal.skill_id = Some(skill);
            return self.settle(proposal, ProposalState::Saved);
        }
        if !save {
            return self.settle(proposal, ProposalState::Discarded);
        }
        proposal.attempt = Some(Attempt {
            id: uuid::Uuid::new_v4().simple().to_string(),
            at: self.clock.now_ms(),
        });
        {
            let _files = lock(&self.files);
            self.write(&proposal)
                .map_err(|e| AnswerError::Io(e.to_string()))?;
        }
        let written = match &proposal.base {
            None => {
                self.library
                    .create(&proposal.name, &proposal.description, &proposal.body)
                    .await
            }
            Some(base) => {
                self.library
                    .edit(
                        &base_source(&proposal, base),
                        &proposal.description,
                        &proposal.body,
                    )
                    .await
            }
        };
        match written {
            Ok(skill) => {
                proposal.skill_id = Some(skill);
                self.settle(proposal, ProposalState::Saved)
            }
            // A refusal means nothing was written: the attempt is over.
            Err(
                error @ (WriteError::Conflict(_) | WriteError::Exists(_) | WriteError::Refused(_)),
            ) => {
                proposal.attempt = None;
                let _files = lock(&self.files);
                let _ = self.write(&proposal);
                Err(AnswerError::Library(error))
            }
            // Unreachable or timed out: it may have been written. The attempt stays recorded.
            Err(error) => Err(AnswerError::Library(error)),
        }
    }

    /// After a Save whose outcome is unknown: the skill's id when the library already holds
    /// this proposal's skill; `None` when it doesn't and writing again is safe.
    async fn reconcile(&self, proposal: &Proposal) -> Result<Option<String>, AnswerError> {
        let found = self
            .library
            .source(&proposal.name)
            .await
            .map_err(|e| AnswerError::Library(WriteError::Unavailable(e)))?;
        let same = |skill: &SkillSource| {
            skill.description.trim() == proposal.description.trim()
                && skill.body.trim_end() == proposal.body.trim_end()
        };
        match (found, &proposal.base) {
            (Some(skill), _) if same(&skill) => Ok(Some(skill.id)),
            (None, None) => Ok(None),
            (Some(skill), Some(base)) if skill.hash == base.hash => Ok(None),
            (Some(_), _) => Err(AnswerError::Library(WriteError::Conflict(
                "the skill changed".to_owned(),
            ))),
            (None, Some(_)) => Err(AnswerError::Library(WriteError::Refused(
                "the skill is no longer in the library".to_owned(),
            ))),
        }
    }

    fn settle(
        &self,
        mut proposal: Proposal,
        state: ProposalState,
    ) -> Result<Proposal, AnswerError> {
        proposal.state = state;
        proposal.attempt = None;
        proposal.answered_at = Some(self.clock.now_ms());
        let _files = lock(&self.files);
        self.write(&proposal)
            .map_err(|e| AnswerError::Io(e.to_string()))?;
        Ok(proposal)
    }

    fn open_proposal(&self, agent: &str, id: &str) -> Result<Proposal, AnswerError> {
        let _files = lock(&self.files);
        let proposal = self
            .read(id)
            .filter(|p| p.agent == agent)
            .ok_or(AnswerError::NotFound)?;
        if proposal.state != ProposalState::Open {
            return Err(AnswerError::Answered);
        }
        Ok(proposal)
    }

    /// Records the bot's latest verdict on a skill it used; `source` when the turn had read
    /// untrusted content.
    pub fn note(
        &self,
        agent: &str,
        skill: &str,
        verdict: Verdict,
        note: &str,
        source: Option<&str>,
    ) -> Result<(), String> {
        let _files = lock(&self.files);
        let mut notes = self.read_notes(agent);
        notes.insert(
            skill.to_owned(),
            Note {
                verdict,
                note: note.to_owned(),
                at: self.clock.now_ms(),
                source: source.map(str::to_owned),
            },
        );
        let text = serde_json::to_string_pretty(&notes).map_err(|e| e.to_string())?;
        crate::atomic::write_whole(&self.notes_file(agent), &text).map_err(|e| e.to_string())
    }

    /// The bot's note on `skill`, if it left one.
    pub fn note_on(&self, agent: &str, skill: &str) -> Option<Note> {
        let _files = lock(&self.files);
        self.read_notes(agent).remove(skill)
    }

    /// Forgets the bot's proposals and notes, when the bot is deleted.
    pub fn forget(&self, agent: &str) {
        let _files = lock(&self.files);
        for proposal in self.read_all().into_iter().filter(|p| p.agent == agent) {
            let _ =
                std::fs::remove_file(self.proposals_dir().join(format!("{}.json", proposal.id)));
        }
        let _ = std::fs::remove_file(self.notes_file(agent));
    }

    fn read_notes(&self, agent: &str) -> BTreeMap<String, Note> {
        std::fs::read_to_string(self.notes_file(agent))
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default()
    }

    fn read(&self, id: &str) -> Option<Proposal> {
        let text = std::fs::read_to_string(self.proposals_dir().join(format!("{}.json", safe(id))))
            .ok()?;
        serde_json::from_str(&text).ok()
    }

    /// Every stored proposal; a file that does not read is left out (and left alone).
    fn read_all(&self) -> Vec<Proposal> {
        let Ok(entries) = std::fs::read_dir(self.proposals_dir()) else {
            return Vec::new();
        };
        entries
            .filter_map(Result::ok)
            .filter(|e| e.path().extension().is_some_and(|x| x == "json"))
            .filter_map(|e| std::fs::read_to_string(e.path()).ok())
            .filter_map(|text| serde_json::from_str(&text).ok())
            .collect()
    }

    fn write(&self, proposal: &Proposal) -> std::io::Result<()> {
        let text = serde_json::to_string_pretty(proposal).map_err(std::io::Error::other)?;
        crate::atomic::write_whole(
            &self.proposals_dir().join(format!("{}.json", proposal.id)),
            &text,
        )
    }
}

/// The skill an edit proposal was made against, as the library takes it.
fn base_source(proposal: &Proposal, base: &Base) -> SkillSource {
    SkillSource {
        id: base.id.clone(),
        name: proposal.name.clone(),
        description: base.description.clone(),
        hash: base.hash.clone(),
        body: base.body.clone(),
        manual: base.manual,
        editable: true,
    }
}

/// `sp_` and the first 20 hex digits of the SHA-256 of the call's key.
fn proposal_id(key: &str) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(key.as_bytes());
    let hex: String = digest.iter().take(10).map(|b| format!("{b:02x}")).collect();
    format!("sp_{hex}")
}

/// An id as a file name: anything but letters, digits, `_` and `-` becomes `-`.
fn safe(id: &str) -> String {
    id.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '-'
            }
        })
        .collect()
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// A skill name ace accepts: lowercase letters and digits in words joined by single hyphens.
pub fn is_slug(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= NAME_CHARS
        && name.split('-').all(|word| {
            !word.is_empty()
                && word
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn skill_names_are_slugs() {
        for good in ["review", "release-notes", "a1-b2"] {
            assert!(is_slug(good), "{good}");
        }
        for bad in [
            "",
            "Review",
            "two--hyphens",
            "-lead",
            "trail-",
            "has space",
            "dot.ted",
        ] {
            assert!(!is_slug(bad), "{bad}");
        }
    }

    #[test]
    fn a_retried_call_makes_the_same_proposal_id() {
        assert_eq!(proposal_id("c_1.call_2"), proposal_id("c_1.call_2"));
        assert_ne!(proposal_id("c_1.call_2"), proposal_id("c_1.call_3"));
    }
}

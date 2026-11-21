//! Cases (ADR 0204 §1): the person keeps one of a bot's finished runs as a test. The run is read
//! from the bot's conversation, redacted (secrets, the person's own addresses and names from
//! what Spade knows about them, and every value the person marked on the review), and only then
//! written. The run itself stays in the conversation, untouched.

use serde_json::{Value, json};
use spade_core::quality::case::{self, Case, Keep, Mark, NotKept, Package};
use spade_core::quality::redact::{self, Person};
use spade_store::{Notes, StoreError, StoredCase};

use super::Engine;

/// The most cases a bot's list shows.
pub const MOST_LISTED: usize = 200;

/// The most values the person may mark to hide on one review.
pub const MOST_MARKED: usize = 50;

#[derive(Debug, thiserror::Error)]
pub enum CaseError {
    #[error("no such agent")]
    NotFound,
    #[error("no such case")]
    NoCase,
    #[error("{0}")]
    Invalid(String),
    #[error("{0}.")]
    NotKept(NotKept),
    #[error(transparent)]
    Store(#[from] StoreError),
}

/// What the person asks to keep: the reply, their mark and line of why, and the values they
/// marked to hide on the review.
#[derive(Debug, Clone, Default)]
pub struct KeepInput {
    pub reply: String,
    pub mark: Option<String>,
    pub why: Option<String>,
    pub hide: Vec<String>,
}

/// A case in a bot's list: what it was given and answered in one line each.
fn summary(stored: &StoredCase) -> Value {
    let body: Value = serde_json::from_str(&stored.body).unwrap_or(Value::Null);
    let given = body["given"]["messages"]
        .as_array()
        .and_then(|m| m.first())
        .and_then(Value::as_str)
        .map(spade_core::redact::one_line)
        .unwrap_or_default();
    let outcome = body["outcome"]["text"]
        .as_str()
        .map(spade_core::redact::one_line)
        .unwrap_or_default();
    json!({
        "id": stored.id,
        "reply": stored.reply,
        "mark": stored.mark,
        "why": body["why"],
        "trigger": body["trigger"],
        "given": given,
        "outcome": outcome,
        "made_at": stored.made_ms,
    })
}

/// A case as the API shows it whole.
pub fn case_json(stored: &StoredCase) -> Value {
    let body: Value = serde_json::from_str(&stored.body).unwrap_or(Value::Null);
    json!({ "summary": summary(stored), "case": body })
}

impl Engine {
    /// The person as what Spade knows about them names them: the shared (`about_person`) notes
    /// they kept.
    fn person(&self) -> Result<Person, StoreError> {
        let notes = self.store.notes(Notes::Shared)?;
        Ok(Person::from_facts(
            notes
                .iter()
                .filter(|n| !n.suggested)
                .map(|n| n.text.as_str()),
        ))
    }

    /// Reply `input.reply` of bot `agent` as a case, redacted, not yet kept.
    fn draft_case(&self, agent: &str, input: &KeepInput) -> Result<Case, CaseError> {
        let bot = self.store.agent(agent)?.ok_or(CaseError::NotFound)?;
        if input.hide.len() > MOST_MARKED {
            return Err(CaseError::Invalid(format!(
                "Mark at most {MOST_MARKED} values to hide"
            )));
        }
        let mark = match input.mark.as_deref() {
            None => None,
            Some(word) => Some(
                Mark::parse(word)
                    .ok_or_else(|| CaseError::Invalid("mark is right or wrong".to_owned()))?,
            ),
        };
        let events: Vec<_> = self
            .store
            .events(&bot.conversation, 0)?
            .into_iter()
            .map(|stored| stored.event)
            .collect();
        let run = case::run(&events, &input.reply).map_err(CaseError::NotKept)?;
        let package = self.bot_package(agent).map(|link| Package {
            name: link.package.name,
            version: link.package.version,
            hash: link.package.hash,
        });
        let made = case::case(
            run,
            Keep {
                id: String::new(),
                bot: bot.id,
                package,
                mark,
                why: input.why.clone(),
                made_at: self.now_ms(),
            },
        );
        Ok(redact::case(&made, &self.person()?, &input.hide))
    }

    /// What keeping reply `input.reply` would write, for the review shown before saving.
    pub fn preview_case(&self, agent: &str, input: &KeepInput) -> Result<Value, CaseError> {
        let draft = self.draft_case(agent, input)?;
        Ok(json!({ "case": draft }))
    }

    /// Keeps reply `input.reply` of bot `agent` as a test: the case it has, and whether it is
    /// new (a reply kept before keeps its first case).
    pub fn keep_case(&self, agent: &str, input: &KeepInput) -> Result<(Value, bool), CaseError> {
        let mut draft = self.draft_case(agent, input)?;
        draft.id = self.ids.next("case");
        let body = case::to_json(&draft).map_err(CaseError::NotKept)?;
        let (kept, new) = self.store.save_case(&StoredCase {
            id: draft.id.clone(),
            agent: agent.to_owned(),
            reply: draft.reply.clone(),
            mark: draft.mark.map(|m| match m {
                Mark::Right => "right".to_owned(),
                Mark::Wrong => "wrong".to_owned(),
            }),
            body,
            made_ms: draft.made_at,
        })?;
        Ok((case_json(&kept), new))
    }

    /// Bot `agent`'s kept cases, newest first.
    pub fn cases_of(&self, agent: &str) -> Result<Vec<Value>, CaseError> {
        self.store.agent(agent)?.ok_or(CaseError::NotFound)?;
        Ok(self
            .store
            .cases(agent, MOST_LISTED)?
            .iter()
            .map(summary)
            .collect())
    }

    /// Bot `agent`'s case `id`, whole.
    pub fn case_of(&self, agent: &str, id: &str) -> Result<Value, CaseError> {
        self.store.agent(agent)?.ok_or(CaseError::NotFound)?;
        let stored = self.store.case(agent, id)?.ok_or(CaseError::NoCase)?;
        Ok(case_json(&stored))
    }

    /// Removes bot `agent`'s case `id`.
    pub fn delete_case(&self, agent: &str, id: &str) -> Result<(), CaseError> {
        self.store.agent(agent)?.ok_or(CaseError::NotFound)?;
        if self.store.delete_case(agent, id)? {
            Ok(())
        } else {
            Err(CaseError::NoCase)
        }
    }
}

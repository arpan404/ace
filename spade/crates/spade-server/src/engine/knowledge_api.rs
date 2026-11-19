//! The person's side of knowledge bases (ADR 0164): they read and edit every entry, vouch for
//! one (mark it trusted), merge, link, size a base, and read episodes. Their entries are theirs:
//! no bot changes them and folding never takes them.

use std::collections::BTreeMap;

use serde_json::{Value, json};
use spade_core::knowledge::{self, Kind, Relation, SourceKind, Trust};
use spade_store::{Changed, EntryChange, EntryLink, NewEntry, StoredEntry, StoredEpisode, Written};

use super::Engine;
use super::knowledge::{KnowledgeError, limit_key};

/// What the person writes or changes; `None` keeps what an entry has.
#[derive(Debug, Clone, Default)]
pub struct KnowledgeInput {
    pub topic: Option<String>,
    pub title: Option<String>,
    pub body: Option<String>,
    pub kind: Option<String>,
    /// `true`: the person vouches for it. Only the person can.
    pub trusted: Option<bool>,
}

fn cleaned(
    raw: Option<&str>,
    clean: fn(&str) -> Option<String>,
    what: &str,
) -> Result<Option<String>, KnowledgeError> {
    raw.map(|r| clean(r).ok_or_else(|| KnowledgeError::Invalid(what.to_owned())))
        .transpose()
}

impl Engine {
    fn base_agent(&self, agent: &str) -> Result<spade_store::Agent, KnowledgeError> {
        self.store.agent(agent)?.ok_or(KnowledgeError::NoAgent)
    }

    /// One bot's entries, newest change first; ranked for `query`, or only `topic`'s.
    pub fn knowledge_entries(
        &self,
        agent: &str,
        query: Option<&str>,
        topic: Option<&str>,
    ) -> Result<Vec<StoredEntry>, KnowledgeError> {
        let agent = self.base_agent(agent)?;
        let topic = topic.and_then(knowledge::topic);
        let entries = match query.and_then(spade_core::memory::match_query) {
            Some(query) => {
                let own = self
                    .bases(&agent, false)
                    .into_iter()
                    .take(1)
                    .collect::<Vec<_>>();
                self.ranked_entries(&own, &query)?
            }
            None => self.store.knowledge(&agent.id, None)?,
        };
        Ok(entries
            .into_iter()
            .filter(|e| topic.as_ref().is_none_or(|t| &e.topic == t))
            .collect())
    }

    /// A base's topics with their counts, its size and its bound.
    pub fn knowledge_topics(&self, agent: &str) -> Result<Value, KnowledgeError> {
        let agent = self.base_agent(agent)?;
        let mut topics: BTreeMap<String, (usize, usize, usize, u64, i64)> = BTreeMap::new();
        for entry in self.store.knowledge(&agent.id, None)? {
            let line = topics.entry(entry.topic.clone()).or_default();
            line.0 += 1;
            if entry.trust == Trust::Untrusted {
                line.1 += 1;
            }
            if entry.author.is_none() {
                line.2 += 1;
            }
            line.3 += entry.as_entry().bytes();
            line.4 = line.4.max(entry.updated_ms);
        }
        let listed: Vec<Value> = topics
            .into_iter()
            .map(|(topic, (entries, untrusted, person, bytes, updated))| {
                json!({ "topic": topic, "entries": entries, "untrusted": untrusted,
                        "by_person": person, "bytes": bytes, "updated_at": updated })
            })
            .collect();
        Ok(json!({
            "topics": listed,
            "bytes": self.store.knowledge_bytes(&agent.id)?,
            "limit_bytes": self.knowledge_limit(&agent.id),
            "suggestions": self.knowledge_suggestions_of(&agent.id)?.len(),
        }))
    }

    /// The person adds an entry: trusted, theirs. The new entry and `true`, or the one that
    /// already says the same and `false`.
    pub fn add_knowledge(
        &self,
        agent: &str,
        input: &KnowledgeInput,
    ) -> Result<(StoredEntry, bool), KnowledgeError> {
        let agent = self.base_agent(agent)?;
        let topic = cleaned(
            input.topic.as_deref(),
            knowledge::topic,
            "a topic is 1 to 64 characters of words",
        )?
        .ok_or_else(|| KnowledgeError::Invalid("`topic` is needed".to_owned()))?;
        let title = cleaned(
            input.title.as_deref(),
            knowledge::title,
            "a title is one line of 1 to 200 characters",
        )?
        .ok_or_else(|| KnowledgeError::Invalid("`title` is needed".to_owned()))?;
        let body = cleaned(
            input.body.as_deref(),
            knowledge::body,
            "a body is 1 to 8,000 characters",
        )?
        .ok_or_else(|| KnowledgeError::Invalid("`body` is needed".to_owned()))?;
        let id = self.ids.next("k");
        let new = NewEntry {
            id: &id,
            agent: &agent.id,
            topic: &topic,
            title: &title,
            body: &body,
            kind: Kind::parse(input.kind.as_deref().unwrap_or("fact")),
            source: SourceKind::Person,
            source_detail: None,
            trust: Trust::Trusted,
            author: None,
            now_ms: self.now_ms(),
        };
        let mut digests = || self.ids.next("k");
        match self
            .store
            .write_knowledge(new, self.knowledge_limit(&agent.id), &mut digests)?
        {
            Written::New { entry, .. } => Ok((entry, true)),
            Written::Exists(entry) => Ok((entry, false)),
            Written::Full => Err(KnowledgeError::Full),
        }
    }

    /// One entry with its links.
    pub fn knowledge_view(
        &self,
        id: &str,
    ) -> Result<(StoredEntry, Vec<EntryLink>), KnowledgeError> {
        let entry = self
            .store
            .knowledge_entry(id)?
            .ok_or(KnowledgeError::NotFound)?;
        let links = self.store.knowledge_links(&entry.id)?;
        Ok((entry, links))
    }

    /// The person changes an entry, any entry. With `expected` (the `updated_at` the edit
    /// started from), one changed since is left as it is: [`KnowledgeError::Moved`].
    pub fn edit_knowledge(
        &self,
        id: &str,
        input: &KnowledgeInput,
        expected: Option<i64>,
    ) -> Result<StoredEntry, KnowledgeError> {
        let topic = cleaned(
            input.topic.as_deref(),
            knowledge::topic,
            "a topic is 1 to 64 characters of words",
        )?;
        let title = cleaned(
            input.title.as_deref(),
            knowledge::title,
            "a title is one line of 1 to 200 characters",
        )?;
        let body = cleaned(
            input.body.as_deref(),
            knowledge::body,
            "a body is 1 to 8,000 characters",
        )?;
        let change = EntryChange {
            topic: topic.as_deref(),
            title: title.as_deref(),
            body: body.as_deref(),
            kind: input.kind.as_deref().map(Kind::parse),
            trust: input
                .trusted
                .map(|t| if t { Trust::Trusted } else { Trust::Untrusted }),
        };
        match self
            .store
            .change_knowledge(id, &change, expected, self.now_ms())?
        {
            Changed::Done(entry) => Ok(entry),
            Changed::Moved(entry) => Err(KnowledgeError::Moved(Box::new(entry))),
            Changed::Missing => Err(KnowledgeError::NotFound),
        }
    }

    /// The person deletes an entry.
    pub fn remove_knowledge(&self, id: &str) -> Result<(), KnowledgeError> {
        if self.store.delete_knowledge(id)? {
            Ok(())
        } else {
            Err(KnowledgeError::NotFound)
        }
    }

    /// The person links two entries of one base.
    pub fn link_knowledge(
        &self,
        from: &str,
        to: &str,
        relation: &str,
    ) -> Result<(), KnowledgeError> {
        let relation = Relation::parse(relation).ok_or_else(|| {
            KnowledgeError::Invalid(
                "relation is related, supports, contradicts, supersedes or part_of".to_owned(),
            )
        })?;
        let (a, _) = self.knowledge_view(from)?;
        let (b, _) = self.knowledge_view(to)?;
        if a.agent != b.agent || a.id == b.id {
            return Err(KnowledgeError::Invalid(
                "link two different entries of one bot".to_owned(),
            ));
        }
        Ok(self.store.link_knowledge(&a.id, &b.id, relation)?)
    }

    pub fn unlink_knowledge(&self, from: &str, to: &str) -> Result<(), KnowledgeError> {
        if self.store.unlink_knowledge(from, to)? {
            Ok(())
        } else {
            Err(KnowledgeError::NotFound)
        }
    }

    /// The person folds entries of one base into `into`.
    pub fn merge_knowledge(
        &self,
        into: &str,
        from: &[String],
    ) -> Result<StoredEntry, KnowledgeError> {
        let (target, _) = self.knowledge_view(into)?;
        for id in from {
            let (other, _) = self.knowledge_view(id)?;
            if other.agent != target.agent {
                return Err(KnowledgeError::Invalid(
                    "merge entries of one bot".to_owned(),
                ));
            }
        }
        self.store
            .merge_knowledge(&target.id, from, self.now_ms())?
            .ok_or_else(|| {
                KnowledgeError::Invalid("together they pass 8,000 characters".to_owned())
            })
    }

    fn knowledge_suggestions_of(
        &self,
        agent: &str,
    ) -> Result<Vec<(String, String, f64)>, KnowledgeError> {
        let entries: Vec<_> = self
            .store
            .knowledge(agent, None)?
            .iter()
            .map(StoredEntry::as_entry)
            .collect();
        Ok(knowledge::merge_suggestions(&entries))
    }

    /// Pairs of a base's entries alike enough to merge, most alike first.
    pub fn knowledge_suggestions(&self, agent: &str) -> Result<Value, KnowledgeError> {
        let agent = self.base_agent(agent)?;
        let pairs: Vec<Value> = self
            .knowledge_suggestions_of(&agent.id)?
            .into_iter()
            .map(|(a, b, overlap)| json!({ "a": a, "b": b, "overlap": (overlap * 100.0).round() / 100.0 }))
            .collect();
        Ok(json!({ "merges": pairs }))
    }

    /// The person sizes a bot's base, or with `None` goes back to the default.
    pub fn set_knowledge_limit(
        &self,
        agent: &str,
        bytes: Option<u64>,
    ) -> Result<u64, KnowledgeError> {
        let agent = self.base_agent(agent)?;
        if bytes == Some(0) {
            return Err(KnowledgeError::Invalid(
                "the size must be above zero".to_owned(),
            ));
        }
        let value = bytes.map(|b| b.to_string());
        self.store
            .set_setting(&limit_key(&agent.id), value.as_deref())?;
        Ok(self.knowledge_limit(&agent.id))
    }

    /// One bot's episodes, newest first, or those matching `query`.
    pub fn agent_episodes(
        &self,
        agent: &str,
        query: Option<&str>,
    ) -> Result<Vec<StoredEpisode>, KnowledgeError> {
        let agent = self.base_agent(agent)?;
        let query = query.and_then(spade_core::memory::match_query);
        Ok(self.store.episodes(&[agent.id], query.as_deref(), 200)?)
    }

    pub fn episode_view(&self, id: &str) -> Result<StoredEpisode, KnowledgeError> {
        self.store.episode(id)?.ok_or(KnowledgeError::NotFound)
    }
}

//! "Why do you think that?": where a bot's notes and knowledge came from, per item and per
//! source, and forgetting everything learned from one source (a conversation, a site, an app, an
//! import). The keys are `spade_core::provenance`'s; this reads the store and labels them.

use std::collections::BTreeMap;

use serde_json::{Value, json};
use spade_core::event::{Event, Known};
use spade_core::knowledge::SourceKind;
use spade_core::memory::Source;
use spade_core::provenance::{self, Origin};
use spade_store::{Notes, StoreError, StoredEntry, StoredNote};

use super::Engine;

/// The source keys of a note.
pub fn note_keys(note: &StoredNote) -> Vec<String> {
    provenance::keys(note.origin.as_ref(), note.source == Source::Person, None)
}

/// The source keys of a knowledge entry.
pub fn entry_keys(entry: &StoredEntry) -> Vec<String> {
    let detail = match entry.source {
        SourceKind::Web | SourceKind::Tool | SourceKind::Untrusted => {
            entry.source_detail.as_deref()
        }
        _ => None,
    };
    provenance::keys(entry.origin.as_ref(), entry.author.is_none(), detail)
}

/// What one source taught a bot: its key, a label, and how many notes and entries.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Learned {
    pub key: String,
    pub label: String,
    pub notes: usize,
    pub entries: usize,
}

/// What forgetting a source removed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Forgotten {
    pub notes: usize,
    pub entries: usize,
}

impl Engine {
    /// A source key in words: "Your conversation with Flights", "example.com", "gmail", "the
    /// Inbox recipe".
    fn source_label(&self, key: &str) -> String {
        let (kind, rest) = key.split_once(':').unwrap_or(("", key));
        match kind {
            "conversation" => match self.store.agent_for_conversation(rest) {
                Ok(Some(agent)) if agent.conversation == rest => {
                    format!("Your conversation with {}", shown_name(&agent))
                }
                Ok(Some(agent)) => format!("A helper of {}", shown_name(&agent)),
                _ => "A conversation that's gone".to_owned(),
            },
            _ => rest.to_owned(),
        }
    }

    /// The notes a bot sees (its own and the shared "About you" ones) and its own knowledge.
    fn learned_items(
        &self,
        agent: &str,
    ) -> Result<(Vec<StoredNote>, Vec<StoredEntry>), StoreError> {
        Ok((
            self.store.notes(Notes::VisibleTo(agent))?,
            self.store.knowledge(agent, None)?,
        ))
    }

    /// Every source a bot's notes and knowledge came from, most items first. The person's own
    /// words aren't listed: they have no source to forget them by.
    pub fn learned(&self, agent: &str) -> Result<Vec<Learned>, StoreError> {
        let (notes, entries) = self.learned_items(agent)?;
        let mut counted: BTreeMap<String, (usize, usize)> = BTreeMap::new();
        for note in &notes {
            for key in note_keys(note) {
                counted.entry(key).or_default().0 += 1;
            }
        }
        for entry in &entries {
            for key in entry_keys(entry) {
                counted.entry(key).or_default().1 += 1;
            }
        }
        let mut out: Vec<Learned> = counted
            .into_iter()
            .map(|(key, (notes, entries))| Learned {
                label: self.source_label(&key),
                key,
                notes,
                entries,
            })
            .collect();
        out.sort_by(|a, b| {
            (b.notes + b.entries)
                .cmp(&(a.notes + a.entries))
                .then_with(|| a.label.cmp(&b.label))
        });
        Ok(out)
    }

    /// Forgets every note and entry a bot learned from `key`: its own and shared notes, and its
    /// own knowledge. The person's own words stay.
    pub fn forget_source(&self, agent: &str, key: &str) -> Result<Forgotten, StoreError> {
        let (notes, entries) = self.learned_items(agent)?;
        let notes: Vec<String> = notes
            .iter()
            .filter(|note| note_keys(note).iter().any(|k| k == key))
            .map(|note| note.id.clone())
            .collect();
        let mut forgotten = Forgotten {
            notes: self.store.delete_notes(&notes)?,
            entries: 0,
        };
        for entry in entries
            .iter()
            .filter(|entry| entry_keys(entry).iter().any(|k| k == key))
        {
            if self.store.delete_knowledge(&entry.id)? {
                forgotten.entries += 1;
            }
        }
        Ok(forgotten)
    }

    /// Where a note or entry came from, as the person reads it: its sources labelled, the
    /// conversation and the person's message it answered (its words), and the call.
    pub fn provenance(&self, origin: Option<&Origin>, keys: &[String]) -> Value {
        let sources: Vec<Value> = keys
            .iter()
            .map(|key| json!({ "key": key, "label": self.source_label(key) }))
            .collect();
        let Some(origin) = origin else {
            return json!({ "sources": sources });
        };
        let conversation = origin.conversation.as_deref().map(|id| {
            let agent = self.store.agent_for_conversation(id).ok().flatten();
            json!({
                "id": id,
                "agent": agent.as_ref().map(|a| a.id.clone()),
                "name": agent.as_ref().map(shown_name),
            })
        });
        let message = match (origin.conversation.as_deref(), origin.message) {
            (Some(conversation), Some(seq)) => self.message_at(conversation, seq),
            _ => None,
        };
        json!({
            "sources": sources,
            "conversation": conversation,
            "message": message,
            "call": origin.call,
            "read": origin.read,
            "import": origin.import,
        })
    }

    /// Where note `id` came from, with its words, source and when; `None` for no such note.
    pub fn note_provenance(&self, id: &str) -> Result<Option<Value>, StoreError> {
        let Some(note) = self.store.note(id)? else {
            return Ok(None);
        };
        let mut shown = self.provenance(note.origin.as_ref(), &note_keys(&note));
        shown["text"] = json!(note.text);
        shown["source"] = json!(note.source.name());
        shown["at"] = json!(note.created_ms);
        shown["trust"] = json!(if note.suggested { "suggested" } else { "kept" });
        Ok(Some(shown))
    }

    /// Where knowledge entry `id` came from, with its source, trust and when.
    pub fn entry_provenance(&self, id: &str) -> Result<Option<Value>, StoreError> {
        let Some(entry) = self.store.knowledge_entry(id)? else {
            return Ok(None);
        };
        let mut shown = self.provenance(entry.origin.as_ref(), &entry_keys(&entry));
        shown["text"] = json!(entry.title);
        shown["source"] = json!({ "kind": entry.source.name(), "detail": entry.source_detail });
        shown["at"] = json!(entry.created_ms);
        shown["trust"] = json!(entry.trust.name());
        shown["author"] = match &entry.author {
            None => json!("person"),
            Some(bot) => json!({ "bot": bot }),
        };
        Ok(Some(shown))
    }

    /// The person's message at `seq`: its first 300 characters and when.
    fn message_at(&self, conversation: &str, seq: i64) -> Option<Value> {
        let stored = self
            .store
            .events_window(conversation, seq, 1)
            .ok()?
            .into_iter()
            .find(|stored| stored.seq == seq)?;
        let Event::Known(Known::UserMessage { text, .. }) = &stored.event else {
            return None;
        };
        Some(json!({
            "seq": seq,
            "at": stored.at_ms,
            "text": text.chars().take(300).collect::<String>(),
        }))
    }
}

fn shown_name(agent: &spade_store::Agent) -> String {
    if agent.kind == super::MAIN {
        "Spade".to_owned()
    } else {
        agent.name.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn note(source: Source, origin: Option<Origin>) -> StoredNote {
        StoredNote {
            id: "n_1".into(),
            agent: Some("a_1".into()),
            text: "Prefers aisle seats".into(),
            source,
            created_ms: 0,
            updated_ms: 0,
            used_ms: None,
            uses: 0,
            suggested: false,
            origin,
        }
    }

    #[test]
    fn a_note_the_bot_saved_answers_to_its_conversation_and_what_it_read() {
        let origin = Origin::conversation(
            "c_1",
            Some(3),
            Some("call_1"),
            vec!["the result of gmail__read".into()],
        );
        assert_eq!(
            note_keys(&note(Source::Bot, Some(origin))),
            vec!["app:gmail", "conversation:c_1"]
        );
        assert!(note_keys(&note(Source::Person, None)).is_empty());
    }
}

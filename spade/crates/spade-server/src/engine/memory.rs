//! Memory in the engine (ADR 0128, docs/memory.md): the person's and the bots' notes, recall at
//! the tail of each message, the frozen index in the cached top, notes extracted at compaction,
//! past-text search, and waking a turn that asked the person a question.

use std::sync::Arc;

use serde_json::{Value, json};
use spade_core::Transcript;
use spade_core::event::{Event, Known};
use spade_core::memory::{self, MOST_NOTES, RECALLED, Source};
use spade_store::{NewNote, Notes, Saved, StoreError, StoredNote, Updated};

use super::Engine;
use crate::tools::ToolOutput;

/// The longest question `ask_user` takes, in characters.
const QUESTION_CHARS: usize = 2_000;
/// The most matches a search returns.
const FOUND: usize = 10;
/// The most events `history_read` returns at once.
const MOST_READ: usize = 20;

/// Whose notes: one bot's own, or the shared "About you" set.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NoteScope {
    Agent(String),
    Shared,
}

#[derive(Debug, thiserror::Error)]
pub enum NoteError {
    #[error("no such note")]
    NotFound,
    #[error("no such agent")]
    NoAgent,
    #[error("a note must be 1 to {} characters", memory::NOTE_CHARS)]
    Invalid,
    #[error("this set of notes is full ({MOST_NOTES}); delete some first")]
    Full,
    /// It changed since the version the edit started from; this is the note now.
    #[error("the note changed since it was opened")]
    Moved(Box<StoredNote>),
    #[error(transparent)]
    Store(#[from] StoreError),
}

/// The memory tools, which [`Engine::memory_call`] runs for the calling bot.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MemoryCall {
    Save,
    Update,
    Forget,
    Search,
    HistorySearch,
    HistoryRead,
}

/// What the agent waits on the person for.
pub(super) fn waiting_for(transcript: &Transcript) -> Option<&'static str> {
    if transcript.asking() {
        Some("question")
    } else if !transcript.awaiting.is_empty() {
        Some("approval")
    } else {
        None
    }
}

/// The question an `ask_user` call asks, or why it cannot be asked.
pub(super) fn question(arguments: &Value) -> Result<String, ToolOutput> {
    let question = arguments
        .get("question")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if question.is_empty() {
        return Err(ToolOutput::error("Give the question to ask in `question`."));
    }
    if question.chars().count() > QUESTION_CHARS {
        return Err(ToolOutput::error(format!(
            "The question is too long; keep it under {QUESTION_CHARS} characters."
        )));
    }
    Ok(question.to_owned())
}

/// A message from the person reaches a turn waiting on them at once. A routine's message is not
/// the person answering.
pub(super) fn wake_on_message(engine: &Engine, id: &str, event: &Event) {
    if matches!(
        event,
        Event::Known(Known::UserMessage {
            from_agent: None,
            from_routine: None,
            from_group: None,
            ..
        })
    ) {
        engine.live(id).wake.notify_one();
    }
}

/// The person's message with the notes most relevant to it fixed in its per-turn context,
/// leaving out notes the prompt already shows. A routine's message (the person's own instruction)
/// recalls too. Unchanged when nothing matches or memory cannot be read: recall never stops a
/// message.
pub(super) fn with_recall(engine: &Engine, id: &str, event: Event) -> Event {
    let Event::Known(Known::UserMessage {
        text,
        context: None,
        images,
        from_agent: None,
        from_routine,
    }) = event
    else {
        return event;
    };
    let context = recall(engine, id, &text).unwrap_or_else(|error| {
        tracing::warn!(%error, "no notes recalled for this message");
        None
    });
    Event::Known(Known::UserMessage {
        text,
        context,
        images,
        from_agent: None,
        from_routine,
    })
}

fn recall(engine: &Engine, id: &str, text: &str) -> Result<Option<String>, StoreError> {
    let Some(query) = memory::match_query(text) else {
        return Ok(None);
    };
    let Some(agent) = engine.store.agent_for_conversation(id)? else {
        return Ok(None);
    };
    let shown = memory::shown(&engine.load(id)?);
    let found = engine
        .store
        .search_notes(Notes::VisibleTo(&agent.id), &query, 4 * FOUND)?;
    let now = engine.now_ms();
    let picked: Vec<memory::Note> = memory::rank(
        found.iter().map(|(n, bm25)| (n.as_note(), *bm25)).collect(),
        now,
    )
    .into_iter()
    .filter(|note| !shown.contains(&note.id))
    .take(RECALLED)
    .collect();
    if picked.is_empty() {
        return Ok(None);
    }
    let ids: Vec<String> = picked.iter().map(|n| n.id.clone()).collect();
    engine.store.mark_used(&ids, now)?;
    Ok(Some(memory::recall(&picked)))
}

/// Stores the notes index for the cached top if none is in effect since the last compaction.
/// Returns whether it stored one.
pub(super) fn index_if_due(engine: &Arc<Engine>, id: &str, events: &[Event]) -> bool {
    if !memory::index_due(events) {
        return false;
    }
    let notes = match engine.store.agent_for_conversation(id) {
        Ok(Some(agent)) => engine.store.notes_by_use(Notes::VisibleTo(&agent.id)),
        Ok(None) => Ok(Vec::new()),
        Err(error) => Err(error),
    };
    // Stored even when empty, so the top is fixed before the first model call: notes added while
    // that call is cut off (a pause) cannot change a prompt the cache already holds.
    let text = match notes {
        Ok(notes) => memory::index(&notes.iter().map(StoredNote::as_note).collect::<Vec<_>>()),
        Err(error) => {
            // Without its notes the prompt goes on; the next compaction indexes them.
            tracing::warn!(%error, "no notes index for this conversation");
            String::new()
        }
    };
    match engine.record(id, &Event::Known(Known::MemoryIndexed { text })) {
        Ok(_) => true,
        Err(error) => {
            tracing::error!(%error, "could not store the notes index");
            false
        }
    }
}

/// Saves the notes a compaction extracted into the bot's own scope, each unless a note it can
/// see already says it. From a span with untrusted content they are only suggested: the person
/// keeps or dismisses each, and no bot sees one meanwhile.
pub(super) fn keep_extracted(engine: &Engine, id: &str, notes: &[String], untrusted: bool) {
    if notes.is_empty() {
        return;
    }
    let agent = match engine.store.agent_for_conversation(id) {
        Ok(Some(agent)) => agent,
        _ => return,
    };
    for text in notes {
        let saved = if untrusted {
            engine.suggest(&agent.id, text)
        } else {
            engine.save(Some(&agent.id), text, Source::Compaction)
        };
        match saved {
            Ok(_) | Err(NoteError::Invalid) => {}
            Err(error) => {
                tracing::warn!(%error, "could not keep a note from compaction");
                return;
            }
        }
    }
}

/// A note as the API shows it.
pub fn note_json(note: &StoredNote) -> Value {
    json!({
        "id": note.id,
        "text": note.text,
        "scope": if note.agent.is_some() { "agent" } else { "shared" },
        "agent": note.agent,
        "source": note.source.name(),
        "created_at": note.created_ms,
        "updated_at": note.updated_ms,
        "last_used_at": note.used_ms,
        "suggested": note.suggested,
    })
}

/// A note as a tool result shows it.
fn tool_note(note: &StoredNote) -> Value {
    json!({ "id": note.id, "text": note.text, "shared": note.agent.is_none() })
}

impl Engine {
    fn scope_agent(&self, scope: &NoteScope) -> Result<Option<String>, NoteError> {
        match scope {
            NoteScope::Shared => Ok(None),
            NoteScope::Agent(id) => match self.store.agent(id)? {
                Some(agent) => Ok(Some(agent.id)),
                None => Err(NoteError::NoAgent),
            },
        }
    }

    /// One scope's notes, most recently changed first, or ranked for `query`.
    pub fn notes(
        &self,
        scope: &NoteScope,
        query: Option<&str>,
    ) -> Result<Vec<StoredNote>, NoteError> {
        let agent = self.scope_agent(scope)?;
        let which = match &agent {
            Some(agent) => Notes::Own(agent),
            None => Notes::Shared,
        };
        match query.map(str::trim).filter(|q| !q.is_empty()) {
            None => Ok(self.store.notes(which)?),
            Some(query) => Ok(self.ranked(which, query)?),
        }
    }

    fn ranked(&self, which: Notes<'_>, query: &str) -> Result<Vec<StoredNote>, StoreError> {
        let Some(query) = memory::match_query(query) else {
            return Ok(Vec::new());
        };
        let mut found = self.store.search_notes(which, &query, 4 * FOUND)?;
        let order: Vec<String> = memory::rank(
            found.iter().map(|(n, bm25)| (n.as_note(), *bm25)).collect(),
            self.now_ms(),
        )
        .into_iter()
        .map(|n| n.id)
        .collect();
        found.sort_by_key(|(n, _)| order.iter().position(|id| id == &n.id));
        Ok(found.into_iter().map(|(n, _)| n).collect())
    }

    /// The person adds a note to one scope: the new note and `true`, or the note that already
    /// says the same and `false`.
    pub fn add_note(&self, scope: &NoteScope, text: &str) -> Result<(StoredNote, bool), NoteError> {
        let agent = self.scope_agent(scope)?;
        match self.save(agent.as_deref(), text, Source::Person)? {
            Saved::New(note) => Ok((note, true)),
            // The person saying it themselves keeps a matching suggestion.
            Saved::Exists(note) if note.suggested => Ok((self.accept_note(&note.id)?, false)),
            Saved::Exists(note) => Ok((note, false)),
            Saved::Full => Err(NoteError::Full),
        }
    }

    /// The person rewrites a note. With `expected` (the `updated_at` the edit started from), a
    /// note changed since is left as it is: [`NoteError::Moved`].
    pub fn change_note(
        &self,
        id: &str,
        text: &str,
        expected: Option<i64>,
    ) -> Result<StoredNote, NoteError> {
        let text = memory::clean(text).ok_or(NoteError::Invalid)?;
        match self.store.update_note(id, &text, expected, self.now_ms())? {
            Updated::Changed(note) => Ok(note),
            Updated::Moved(note) => Err(NoteError::Moved(Box::new(note))),
            Updated::Missing => Err(NoteError::NotFound),
        }
    }

    /// The person keeps a suggested note.
    pub fn accept_note(&self, id: &str) -> Result<StoredNote, NoteError> {
        self.store.accept_note(id)?.ok_or(NoteError::NotFound)
    }

    /// The person deletes a note.
    pub fn forget_note(&self, id: &str) -> Result<(), NoteError> {
        if self.store.delete_note(id)? {
            Ok(())
        } else {
            Err(NoteError::NotFound)
        }
    }

    /// Saves a note into `agent`'s scope (shared with `None`), unless a note there already says
    /// the same; checked and stored as one, so concurrent saves never duplicate or overfill.
    fn save(&self, agent: Option<&str>, text: &str, source: Source) -> Result<Saved, NoteError> {
        self.store_note(agent, text, source, false)
    }

    /// Stores a fact from untrusted text as a suggestion in `agent`'s own scope.
    fn suggest(&self, agent: &str, text: &str) -> Result<Saved, NoteError> {
        self.store_note(Some(agent), text, Source::Compaction, true)
    }

    fn store_note(
        &self,
        agent: Option<&str>,
        text: &str,
        source: Source,
        suggested: bool,
    ) -> Result<Saved, NoteError> {
        let text = memory::clean(text).ok_or(NoteError::Invalid)?;
        let id = self.ids.next("n");
        let new = NewNote {
            id: &id,
            agent,
            text: &text,
            source,
            suggested,
            now_ms: self.now_ms(),
        };
        Ok(self.store.save_note(new, memory::same, MOST_NOTES)?)
    }

    /// Runs a memory tool for the bot whose conversation is `caller`.
    pub(crate) fn memory_call(
        &self,
        caller: &str,
        call: MemoryCall,
        arguments: &Value,
    ) -> ToolOutput {
        let agent = match self.store.agent_for_conversation(caller) {
            Ok(Some(agent)) => agent,
            Ok(None) => return ToolOutput::error("This conversation has no bot."),
            Err(error) => return ToolOutput::error(format!("Memory is unavailable: {error}")),
        };
        let text = |key: &str| arguments.get(key).and_then(Value::as_str).unwrap_or("");
        let result = match call {
            MemoryCall::Save => self.tool_save(&agent.id, text("text"), arguments),
            MemoryCall::Update => self.tool_update(&agent.id, text("id"), text("text")),
            MemoryCall::Forget => self.tool_forget(&agent.id, text("id")),
            MemoryCall::Search => self.tool_search(&agent.id, text("query")),
            MemoryCall::HistorySearch => self.history_search(caller, text("query")),
            MemoryCall::HistoryRead => self.history_read(caller, arguments),
        };
        result.unwrap_or_else(|error| match error {
            NoteError::Store(error) => ToolOutput::error(format!("Memory is unavailable: {error}")),
            other => ToolOutput::error(format!("{}.", capitalised(&other.to_string()))),
        })
    }

    fn tool_save(
        &self,
        agent: &str,
        text: &str,
        arguments: &Value,
    ) -> Result<ToolOutput, NoteError> {
        let shared = arguments
            .get("about_person")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let scope = (!shared).then_some(agent);
        Ok(match self.save(scope, text, Source::Bot)? {
            Saved::New(note) => ToolOutput::ok(json!({ "saved": tool_note(&note) }).to_string()),
            // A suggestion the person has not kept stays out of the bot's sight.
            Saved::Exists(note) if note.suggested => {
                ToolOutput::ok("A note like this waits for the person to keep it.")
            }
            Saved::Exists(note) => {
                ToolOutput::ok(json!({ "exists": tool_note(&note) }).to_string())
            }
            Saved::Full => return Err(NoteError::Full),
        })
    }

    /// A note `agent` may change: its own or a shared one.
    fn visible_note(&self, agent: &str, id: &str) -> Result<StoredNote, NoteError> {
        match self.store.note(id.trim())? {
            Some(note) if !note.suggested && note.agent.as_deref().is_none_or(|a| a == agent) => {
                Ok(note)
            }
            _ => Err(NoteError::NotFound),
        }
    }

    fn tool_update(&self, agent: &str, id: &str, text: &str) -> Result<ToolOutput, NoteError> {
        let note = self.visible_note(agent, id)?;
        let changed = self.change_note(&note.id, text, None)?;
        Ok(ToolOutput::ok(
            json!({ "updated": tool_note(&changed) }).to_string(),
        ))
    }

    fn tool_forget(&self, agent: &str, id: &str) -> Result<ToolOutput, NoteError> {
        let note = self.visible_note(agent, id)?;
        self.forget_note(&note.id)?;
        Ok(ToolOutput::ok(json!({ "forgotten": note.id }).to_string()))
    }

    fn tool_search(&self, agent: &str, query: &str) -> Result<ToolOutput, NoteError> {
        let found: Vec<StoredNote> = self
            .ranked(Notes::VisibleTo(agent), query)?
            .into_iter()
            .take(FOUND)
            .collect();
        if found.is_empty() {
            return Ok(ToolOutput::ok("No notes matched."));
        }
        let ids: Vec<String> = found.iter().map(|n| n.id.clone()).collect();
        self.store.mark_used(&ids, self.now_ms())?;
        let listed: Vec<Value> = found.iter().map(tool_note).collect();
        Ok(ToolOutput::ok(Value::Array(listed).to_string()))
    }

    fn history_search(&self, caller: &str, query: &str) -> Result<ToolOutput, NoteError> {
        let Some(query) = memory::match_query(query) else {
            return Ok(ToolOutput::error("Give some words to look for in `query`."));
        };
        let found = self.store.search_history(caller, &query, FOUND)?;
        if found.is_empty() {
            return Ok(ToolOutput::ok("Nothing in this conversation matched."));
        }
        let mut out = String::from("Matches, by position (read one with history_read):\n");
        for found in found {
            out.push_str(&format!("\n[position {}] {}", found.seq, found.snippet));
        }
        Ok(ToolOutput::ok(out))
    }

    fn history_read(&self, caller: &str, arguments: &Value) -> Result<ToolOutput, NoteError> {
        let from = arguments
            .get("from")
            .and_then(Value::as_i64)
            .unwrap_or(1)
            .max(1);
        let count = arguments
            .get("count")
            .and_then(Value::as_u64)
            .map_or(10, |c| usize::try_from(c).unwrap_or(MOST_READ))
            .clamp(1, MOST_READ);
        let events = self.store.events_window(caller, from, count)?;
        let mut out = String::new();
        for stored in &events {
            if let Some(text) = memory::searchable(&stored.event) {
                out.push_str(&format!("[position {}] {text}\n\n", stored.seq));
            }
        }
        if out.is_empty() {
            return Ok(ToolOutput::ok("No messages or results at those positions."));
        }
        Ok(ToolOutput::ok(out.trim_end().to_owned()))
    }
}

fn capitalised(text: &str) -> String {
    let mut chars = text.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().chain(chars).collect(),
        None => String::new(),
    }
}

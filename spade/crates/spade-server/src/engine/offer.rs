//! What each conversation is offered, frozen (spade/docs/harness.md, Tools).
//!
//! The tool list sits at the top of every prompt, so a conversation keeps the same one for its
//! whole life: it is worked out at the first model call, and again only when a compaction
//! republishes it (docs/design.md, Caching). The list is stored as the ordered, serialized
//! definitions themselves ([`spade_core::tools::snapshot`]), so a live tool source coming, going
//! or changing its schema cannot change the bytes mid-conversation or after a restart.
//!
//! A bot's list carries the deferred tools it has learned to keep: a tool it ran twice is offered
//! up front from its next list, at most [`pinning::LIMIT`]. A lane or helper captures its bot's
//! list as it stands when it starts and keeps it, so a parent's compaction never changes a
//! running one. One small setting per bot holds how often it ran each deferred tool
//! ([`pinning::uses_key`]); one per conversation holds the frozen list, replaced in place and
//! deleted with the conversation.

use spade_core::tools::pinning;
use spade_core::tools::snapshot::{self, Snapshot};
use spade_models::ToolSpec;
use spade_store::{StoreError, StoredEvent};

use super::Engine;
use spade_core::Event;

impl Engine {
    /// The tools `id` is offered, from its stored snapshot. A conversation without one (its first
    /// model call, or one stored before snapshots) gets one now and keeps it until its next
    /// compaction.
    pub(super) fn offered_for(&self, id: &str) -> Vec<ToolSpec> {
        match self.snapshot(id) {
            Some(snapshot) => snapshot.tools,
            None => {
                let snapshot = self.offer_now(id, 0);
                self.store_offer(id, &snapshot);
                snapshot.tools
            }
        }
    }

    /// The snapshot to publish with `id`'s next compaction. A bot's list is worked out again from
    /// the deferred tools it has learned; a lane's or helper's stays what it captured.
    pub(super) fn offer_for_compaction(&self, id: &str) -> Snapshot {
        let generation = self
            .snapshot(id)
            .map_or(0, |snapshot| snapshot.generation + 1);
        self.offer_now(id, generation)
    }

    /// Stores `event` and the conversation's new offered-tools snapshot in one write: the list is
    /// never published without the compaction that explains it, or the other way (ADR 0170).
    pub(super) fn record_with_offer(
        &self,
        id: &str,
        event: &Event,
        snapshot: &Snapshot,
    ) -> Result<StoredEvent, StoreError> {
        let _order = self.record_lock.lock().unwrap_or_else(|p| p.into_inner());
        let key = snapshot::key(id);
        let value = snapshot.to_json();
        let now = self.now_ms();
        self.live_before_reply(id, std::slice::from_ref(event))?;
        let mut stored = self.store.append_all_with_settings(
            id,
            std::slice::from_ref(event),
            &[(&key, &value)],
            now,
        )?;
        // Dropped whether or not the write succeeded: a failed write may still have landed.
        self.forget_activity(id);
        self.publish_stored(id, &stored);
        stored
            .pop()
            .ok_or_else(|| StoreError::NoConversation(id.to_owned()))
    }

    /// Notes that `id` ran `name`, for its bot's next list. Only deferred tools count: the core
    /// ones are offered anyway.
    pub(super) fn note_tool_use(&self, id: &str, name: &str) {
        let Some(agent) = self.tool_agent(id) else {
            return;
        };
        let key = pinning::uses_key(&agent);
        let mut uses = match self.store.setting(&key) {
            Ok(Some(text)) => pinning::Uses::parse(&text),
            Ok(None) => pinning::Uses::default(),
            Err(error) => {
                tracing::warn!(%error, "could not read a bot's tool uses");
                return;
            }
        };
        uses.record(name);
        if let Err(error) = self.store.set_setting(&key, Some(&uses.text())) {
            tracing::warn!(%error, "could not store a bot's tool uses");
        }
    }

    /// The list `id` is offered now, before it is stored.
    fn offer_now(&self, id: &str, generation: u64) -> Snapshot {
        let tools = match self.hidden_of(id) {
            Some(hidden) => match self.snapshot(&hidden.parent) {
                Some(parent) => parent.tools,
                None => self.bot_offer(&hidden.parent),
            },
            None => self.bot_offer(id),
        };
        Snapshot::new(generation, tools)
    }

    /// Spade's own list for a bot: its core tools, then the deferred ones it has learned to keep.
    fn bot_offer(&self, conversation: &str) -> Vec<ToolSpec> {
        let pins = match self.agent_of(conversation) {
            Some(agent) => self.learned_pins(&agent),
            None => Vec::new(),
        };
        self.tools.registry().pin(&pins).offered()
    }

    /// The deferred tools a bot has run often enough to pin.
    fn learned_pins(&self, agent: &str) -> Vec<String> {
        match self.store.setting(&pinning::uses_key(agent)) {
            Ok(Some(text)) => pinning::Uses::parse(&text).pinned(),
            Ok(None) => Vec::new(),
            Err(error) => {
                tracing::warn!(%error, "could not read a bot's tool uses");
                Vec::new()
            }
        }
    }

    /// The agent whose tools `id` shares: a helper's or a lane's is its bot's.
    fn tool_agent(&self, id: &str) -> Option<String> {
        match self.hidden_of(id) {
            Some(hidden) => self.agent_of(&hidden.parent),
            None => self.agent_of(id),
        }
    }

    /// The conversation's stored snapshot, when it has a readable one.
    fn snapshot(&self, id: &str) -> Option<Snapshot> {
        let text = self.store.setting(&snapshot::key(id)).ok().flatten()?;
        Snapshot::parse(&text)
    }

    fn store_offer(&self, id: &str, snapshot: &Snapshot) {
        if let Err(error) = self
            .store
            .set_setting(&snapshot::key(id), Some(&snapshot.to_json()))
        {
            tracing::warn!(%error, "could not store what a conversation is offered");
        }
    }
}

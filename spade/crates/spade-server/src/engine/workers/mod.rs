//! Orchestration trees (ADR 0161): a bot's workers. Bots it made (`bot_create`), ace children of
//! its `delegate` and its helpers form a tree under it, folded from events:
//!
//! - each worker bot's conversation starts with `worker_of`, which names its parent; the tree is
//!   that link per conversation, read once at start (`Store::worker_links`) and kept current as
//!   events are stored ([`Engine::workers_stored`]);
//! - state rolls up: a bot reads waiting or working while anything under it does
//!   ([`Engine::roll_up`]);
//! - a worker that settles is reported once to its parent (`report`), and queued workers start
//!   as slots free;
//! - what each subtree spent is shown, never bounded (`spend`, ADR 0166);
//! - grants pass down as subsets (`create`, [`Engine::narrow_registry`]); there is one access level, so
//!   none is narrowed.

mod coordinate;
mod create;
mod lifecycle;
mod report;
mod spend;
mod view;

pub use create::ConnectorGrants;
pub use lifecycle::Workers;

use std::collections::{BTreeSet, HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};

use spade_core::Event;
use spade_core::running::rolled;
use spade_core::tools::Registry;
use spade_core::tree::{self, Link};

use super::roster::State;
use super::{Activity, Engine};

/// The deepest tree Spade follows: a guard against a link loop a damaged database could hold,
/// far past any real tree (bot-to-bot messages stop at 16 hops).
const DEEPEST: usize = 64;

/// The workers' state the engine keeps in memory.
#[derive(Default)]
pub(super) struct Shared {
    /// Each worker conversation's link, and each parent's workers; folded once, then kept.
    index: Mutex<Option<Index>>,
    /// Workers whose events changed since they were last checked for a report.
    dirty: Mutex<BTreeSet<String>>,
    kick: Arc<tokio::sync::Notify>,
    /// Set once the loop that checks them runs.
    running: AtomicBool,
    /// Held while queued workers are started, so a brief is delivered once.
    admitting: Mutex<()>,
    /// Where connectors are granted, once the server has set it.
    grants: OnceLock<Arc<dyn ConnectorGrants>>,
    /// Ace children (bot conversation, thread) whose cancel is being tried until ace confirms.
    cancelling: Mutex<HashSet<(String, String)>>,
}

#[derive(Default)]
struct Index {
    /// Worker conversation → its link.
    links: HashMap<String, Link>,
    /// Parent conversation → its workers' conversations, oldest first.
    children: HashMap<String, Vec<String>>,
}

impl Index {
    fn put(&mut self, conversation: &str, link: Option<Link>) {
        if let Some(old) = self.links.remove(conversation)
            && let Some(siblings) = self.children.get_mut(&old.parent_conversation)
        {
            siblings.retain(|c| c != conversation);
        }
        if let Some(link) = link {
            let siblings = self
                .children
                .entry(link.parent_conversation.clone())
                .or_default();
            if !siblings.iter().any(|c| c == conversation) {
                siblings.push(conversation.to_owned());
            }
            self.links.insert(conversation.to_owned(), link);
        }
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|p| p.into_inner())
}

/// What `activity`'s ace children add to its state: waiting while one waits on the person,
/// else working while one may still run (working, or being stopped), until ace says it settled.
fn ace_state(activity: &Activity) -> State {
    if activity.ace_waiting {
        State::Waiting
    } else if activity.ace_working {
        State::Working
    } else {
        State::Idle
    }
}

impl Engine {
    /// Forgets the folded index, so it is read again: bots came or went whole (ADR 0187).
    pub(crate) fn forget_tree(&self) {
        *lock(&self.workers.index) = None;
    }

    /// The index, folded from the stored links the first time it is needed.
    fn tree_index(&self) -> MutexGuard<'_, Option<Index>> {
        let mut index = lock(&self.workers.index);
        if index.is_none() {
            let mut folded = Index::default();
            match self.store.worker_links() {
                Ok(links) => {
                    let mut by_conversation: Vec<(String, Vec<Event>)> = Vec::new();
                    for (conversation, event) in links {
                        match by_conversation.last_mut() {
                            Some((last, events)) if *last == conversation => events.push(event),
                            _ => by_conversation.push((conversation, vec![event])),
                        }
                    }
                    for (conversation, events) in by_conversation {
                        folded.put(&conversation, tree::linked(&events));
                    }
                    *index = Some(folded);
                }
                // Not remembered, so the next look reads again.
                Err(error) => tracing::error!(%error, "could not read the bots' worker links"),
            }
        }
        index
    }

    /// The link of worker conversation `id`; `None` for a bot that is no worker (or a helper's).
    pub(crate) fn worker_link(&self, id: &str) -> Option<Link> {
        self.tree_index().as_ref()?.links.get(id).cloned()
    }

    /// The conversations of `id`'s worker bots, oldest first.
    pub(crate) fn worker_children(&self, id: &str) -> Vec<String> {
        self.tree_index()
            .as_ref()
            .and_then(|index| index.children.get(id).cloned())
            .unwrap_or_default()
    }

    /// `id`'s parent, grandparent and so on, nearest first.
    pub(crate) fn worker_ancestors(&self, id: &str) -> Vec<String> {
        let index = self.tree_index();
        let Some(index) = index.as_ref() else {
            return Vec::new();
        };
        let mut up = Vec::new();
        let mut at = id.to_owned();
        while let Some(link) = index.links.get(&at) {
            if up.len() >= DEEPEST
                || up.contains(&link.parent_conversation)
                || link.parent_conversation == id
            {
                break;
            }
            up.push(link.parent_conversation.clone());
            at = link.parent_conversation.clone();
        }
        up
    }

    /// What the reviewer reads as the person's words for `id` (`events` its own): for a worker,
    /// the person's messages up its tree, root first, so a maker's brief or message never reads
    /// as the person's request.
    pub(super) fn person_words(&self, id: &str, events: &[Event]) -> Vec<String> {
        let ancestors = self.worker_ancestors(id);
        if ancestors.is_empty() {
            return spade_core::review::person_words(events);
        }
        let loaded: Vec<Arc<Vec<Event>>> = ancestors
            .iter()
            .rev()
            .filter_map(|up| self.load(up).ok())
            .collect();
        let mut chain: Vec<&[Event]> = loaded.iter().map(|e| e.as_slice()).collect();
        chain.push(events);
        spade_core::review::person_words_in(&chain)
    }

    /// `id` and every worker conversation under it, parents before their workers.
    pub(crate) fn worker_subtree(&self, id: &str) -> Vec<String> {
        let index = self.tree_index();
        let mut all = vec![id.to_owned()];
        let Some(index) = index.as_ref() else {
            return all;
        };
        let mut at = 0;
        while at < all.len() && all.len() < 100_000 {
            if let Some(children) = index.children.get(&all[at]) {
                for child in children {
                    if !all.contains(child) {
                        all.push(child.clone());
                    }
                }
            }
            at += 1;
        }
        all
    }

    /// After events were stored in `id`: the tree follows its link changes, and `id` and its
    /// ancestors are checked for reports. Called under the record lock; takes no other lock
    /// but the workers' own.
    pub(super) fn workers_stored(&self, id: &str, events: &[Event]) {
        let watched = {
            let mut index = self.tree_index();
            let Some(index) = index.as_mut() else { return };
            if events.iter().any(tree::changes_link) {
                let link = events
                    .iter()
                    .fold(index.links.get(id).cloned(), tree::apply);
                index.put(id, link);
            }
            index.links.contains_key(id)
        };
        if !watched {
            return;
        }
        let mut dirty = lock(&self.workers.dirty);
        dirty.insert(id.to_owned());
        drop(dirty);
        self.workers.kick.notify_one();
    }

    /// What `id` is doing with everything under it rolled up: the agent's own activity, read
    /// waiting or working while a worker of it (or an ace child) waits or works, and its
    /// task never done meanwhile.
    pub(super) fn roll_up(&self, id: &str, own: Activity) -> Activity {
        let children = self.worker_children(id);
        // The callees of its open contract calls (ADR 0200 §6.2).
        let callees: Vec<String> = own
            .calls
            .iter()
            .filter_map(|bot| self.store.agent(bot).ok().flatten())
            .map(|agent| agent.conversation)
            .collect();
        // A callee on another machine waits on the person, as that machine last said.
        let remote = (!own.remote_calls.is_empty()).then(|| {
            if self.remote_waiting(&own.remote_calls) {
                State::Waiting
            } else {
                State::Working
            }
        });
        if children.is_empty()
            && callees.is_empty()
            && remote.is_none()
            && !own.ace_waiting
            && !own.ace_working
        {
            return own;
        }
        let mut activity = own;
        if !callees.is_empty() || remote.is_some() {
            let states = callees
                .iter()
                .map(|callee| self.node_state(callee, 0))
                .chain(remote);
            let state = spade_core::contract::caller_state(activity.state, states);
            if state == State::Waiting && activity.state != State::Waiting {
                activity.waiting_for = Some("callee");
            }
            activity.state = state;
        }
        let mut under = ace_state(&activity);
        let mut working = 0;
        for child in &children {
            let state = self.node_state(child, 0);
            if matches!(state, State::Working | State::Waiting | State::Sleeping) {
                working += 1;
            }
            under = rolled(under, state);
        }
        activity.workers = working;
        let state = rolled(activity.state, under);
        if state == State::Waiting && activity.state != State::Waiting {
            activity.waiting_for = Some("worker");
        }
        if state != State::Idle
            && activity.task_progress.state == spade_core::goal::view::State::Done
        {
            activity.task_progress.state = spade_core::goal::view::State::Working;
        }
        activity.state = state;
        activity
    }

    /// A worker's rolled-up state: its own, working while its task will carry on by itself or
    /// its brief waits for a slot, and its own workers'.
    fn node_state(&self, id: &str, depth: usize) -> State {
        let Ok(own) = self.own_activity(id) else {
            return State::Idle;
        };
        let mut state = spade_core::running::held(own.state, self.paused(id));
        if state == State::Idle && self.continuing(id, false) {
            state = State::Working;
        }
        state = rolled(state, ace_state(&own));
        if depth < DEEPEST {
            for child in self.worker_children(id) {
                state = rolled(state, self.node_state(&child, depth + 1));
            }
        }
        state
    }

    /// Tools `id` may use with its grants: a worker's (or a worker's helper's) are its own
    /// grant's, and only those its parent may use now, so taking a tool from a parent takes it
    /// from everything under it. A bot made from a recipe is narrowed to the recipe's tools.
    pub(super) fn narrow_registry(&self, id: &str, registry: Registry) -> Registry {
        let owner = self
            .helper_of(id)
            .map_or_else(|| id.to_owned(), |h| h.parent);
        let Some(link) = self.worker_link(&owner) else {
            // A top-level bot made from a recipe that named its tools has only those (ADR 0168),
            // and a packaged one only its `uses` modules' (ADR 0200 §4.3).
            let registry = match self.recipe_tools(&owner) {
                Some(tools) => {
                    registry.retain(|def| tree::allows(Some(&tools), def.spec.name.as_str()))
                }
                None => registry,
            };
            return match self.package_uses(&owner) {
                Some(uses) => registry.retain(|def| {
                    let name = def.spec.name.as_str();
                    let app = self
                        .tools
                        .get_for(&owner, name)
                        .is_some_and(|tool| tool.hints().is_some());
                    spade_core::effect::runtime::uses_allow(&uses, name, app)
                }),
                None => registry,
            };
        };
        let parent = self.registry_for(&link.parent_conversation);
        let granted = link.grants.tools.clone();
        registry.retain(|def| {
            let name = def.spec.name.as_str();
            tree::allows(granted.as_deref(), name) && parent.get(name).is_some()
        })
    }

    /// Starts checking workers for reports: every worker is looked at now (a report owed from
    /// before a restart is delivered once), then each whose events change. The loop starts once.
    pub(super) fn start_workers(self: &Arc<Self>) {
        // Each time Spade opens for work (after an update's pause too), every worker is looked
        // at: a queued one may start, an owed report goes out.
        let all: Vec<String> = self
            .tree_index()
            .as_ref()
            .map(|i| i.links.keys().cloned().collect())
            .unwrap_or_default();
        lock(&self.workers.dirty).extend(all);
        self.workers.kick.notify_one();
        // A cancel ace never confirmed before Spade stopped is tried again.
        self.resume_ace_stops();
        if self.workers.running.swap(true, Ordering::SeqCst) {
            return;
        }
        let weak = Arc::downgrade(self);
        tokio::spawn(async move {
            loop {
                let Some(engine) = weak.upgrade() else { return };
                let kick = engine.workers.kick.clone();
                let kicked = kick.notified();
                tokio::pin!(kicked);
                kicked.as_mut().enable();
                let batch: Vec<String> = std::mem::take(&mut *lock(&engine.workers.dirty))
                    .into_iter()
                    .collect();
                if batch.is_empty() {
                    // Not held while idle, so the engine can go.
                    drop(engine);
                    kicked.await;
                    continue;
                }
                for id in batch {
                    engine.check_worker(&id);
                    // Its parents read the change in their rolled-up state.
                    for up in engine.worker_ancestors(&id) {
                        engine.announce(&up);
                    }
                }
            }
        });
    }
}

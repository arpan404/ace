use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;
use std::time::Duration;

use serde_json::json;
use spade_core::escalation::Level;
use spade_core::reach::batch::{self, AskKind, PendingAsk, TreeRoot};
use spade_core::reach::notable::{engaged, notable};
use spade_core::reach::{self, AgentReach, Category, Moment, Reach};
use spade_core::{Event, event::Known};
use spade_store::{StoreError, StoredEvent};

use super::{Engine, HELD, Held, SENT, agent_key, trim_held};

type Source = (String, StoredEvent);
type Tree = (TreeRoot, Vec<Source>);

impl Engine {
    pub(in crate::engine) fn kick_reach_batcher(&self) {
        self.reach.batch_kick.notify_one();
    }

    pub(in crate::engine) fn start_reach_batcher(self: &Arc<Self>) {
        let weak = Arc::downgrade(self);
        let kick = self.reach.batch_kick.clone();
        tokio::spawn(async move {
            let mut deadlines = HashMap::new();
            loop {
                let Some(engine) = weak.upgrade() else { return };
                let wait = if engine.digests.notices.receiver_count() == 0 {
                    deadlines.clear();
                    None
                } else {
                    match engine.reach_batch_tick(&mut deadlines) {
                        Ok(wait) => wait,
                        Err(error) => {
                            tracing::error!(%error, "could not read pending notices");
                            Some(batch_wait(batch::WINDOW_MS))
                        }
                    }
                };
                drop(engine);
                match wait {
                    Some(wait) => tokio::select! {
                        () = tokio::time::sleep(wait) => {}
                        () = kick.notified() => {}
                    },
                    None => kick.notified().await,
                }
            }
        });
    }

    fn reach_batch_tick(
        &self,
        deadlines: &mut HashMap<String, i64>,
    ) -> Result<Option<Duration>, StoreError> {
        let mut trees: BTreeMap<String, Tree> = BTreeMap::new();
        for (conversation, event) in self.store.pending_ask_notices()? {
            let Some(agent) = self.store.agent_for_conversation(&conversation)? else {
                continue;
            };
            let mut root = agent;
            if let Some(ancestor) = self.worker_ancestors(&conversation).last()
                && let Some(owner) = self.store.agent_for_conversation(ancestor)?
            {
                root = owner;
            }
            trees
                .entry(root.id.clone())
                .or_insert_with(|| {
                    (
                        TreeRoot {
                            agent: root.id,
                            name: root.name,
                            conversation: root.conversation,
                        },
                        Vec::new(),
                    )
                })
                .1
                .push((conversation, event));
        }
        if trees.is_empty() {
            deadlines.clear();
            return Ok(None);
        }
        let now = self.monotonic_ms();
        deadlines.retain(|agent, _| trees.contains_key(agent));
        for (agent, (root, sources)) in trees {
            let deadline = deadlines
                .entry(agent.clone())
                .or_insert(now + batch::WINDOW_MS);
            if *deadline > now {
                continue;
            }
            match self.flush_ask_notices(&root, &sources) {
                Ok(()) => {
                    deadlines.remove(&agent);
                }
                Err(error) => {
                    tracing::error!(%error, %agent, "could not flush pending notices");
                    *deadline = now + batch::WINDOW_MS;
                }
            }
        }
        Ok(deadlines
            .values()
            .min()
            .map(|at| batch_wait(at.saturating_sub(self.monotonic_ms()))))
    }

    fn flush_ask_notices(&self, root: &TreeRoot, sources: &[Source]) -> Result<(), StoreError> {
        let _lock = self.reach.lock.lock().unwrap_or_else(|p| p.into_inner());
        let settings = self.reach_settings()?;
        let now = self.now_ms();
        let minute = self.reach_minute_in(now, &self.read_zone()?);
        let mut sent: Vec<i64> = self.read_json(SENT)?;
        reach::keep_sent(&mut sent, now);

        let mut contexts = HashMap::new();
        let mut items = Vec::new();
        for (conversation, source) in sources {
            let context = match contexts.entry(conversation) {
                std::collections::hash_map::Entry::Occupied(entry) => entry.into_mut(),
                std::collections::hash_map::Entry::Vacant(entry) => {
                    let Some(agent) = self.store.agent_for_conversation(conversation)? else {
                        continue;
                    };
                    let (events, times): (Vec<_>, Vec<_>) = self
                        .store
                        .events(conversation, 0)?
                        .into_iter()
                        .map(|row| (row.event, row.at_ms))
                        .unzip();
                    let engaged = engaged(&events, &times, now - reach::ENGAGED_MS);
                    let own: AgentReach = self.read_json(&agent_key(&agent.id))?;
                    entry.insert((agent, events, engaged, own))
                }
            };
            let (agent, events, engaged, own) = context;
            let kind = match &source.event {
                Event::Known(Known::ApprovalRequested { .. }) => AskKind::Approval,
                Event::Known(Known::QuestionAsked { .. }) => AskKind::Question,
                _ => continue,
            };
            let Some(found) = notable(std::slice::from_ref(&source.event), &[source.at_ms], 0)
            else {
                continue;
            };
            let (Some(level), Some(request)) = (found.level, found.request) else {
                continue;
            };
            let item = PendingAsk {
                id: format!("event:{conversation}:{}", source.seq),
                agent: agent.id.clone(),
                name: agent.name.clone(),
                conversation: conversation.clone(),
                seq: source.seq,
                at_ms: source.at_ms,
                kind,
                level,
                request,
                text: found.text,
                engaged: level == Level::Ask && *engaged,
                bot_on: own.notify.unwrap_or(true),
                approvals: own.approvals.unwrap_or(settings.approvals),
            };
            if batch::still_open(events, &item) {
                items.push(item);
            }
        }
        let planned = batch::plan(
            &settings,
            root,
            &items,
            Moment {
                now_ms: now,
                minute,
                sent: &sent,
            },
        );
        let mut updates = Vec::new();
        if planned.iter().any(|one| one.decision.counts) {
            sent.push(now);
            updates.push((SENT, json!(sent).to_string()));
        }
        if planned.iter().any(|one| one.decision.reach == Reach::Held) {
            let mut held: Vec<Held> = self.read_json(HELD)?;
            for one in &planned {
                if let (Reach::Held, Some(why)) = (one.decision.reach, one.decision.why) {
                    held.push(Held {
                        id: one.id.clone(),
                        agent: one.agent.clone(),
                        name: one.name.clone(),
                        at_ms: now,
                        category: Category::NeedsYou,
                        text: one.text.clone(),
                        why,
                        summarized: false,
                        digested: false,
                    });
                }
            }
            trim_held(&mut held);
            updates.push((HELD, json!(held).to_string()));
        }
        let updates: Vec<_> = updates
            .iter()
            .map(|(key, value)| (*key, value.as_str()))
            .collect();
        let sources: Vec<_> = sources
            .iter()
            .map(|(id, event)| (id.clone(), event.seq))
            .collect();
        self.store.finish_ask_notices(&sources, &updates, || {
            let mut delivered = true;
            for one in planned {
                let mut notice = one.notice;
                notice["id"] = json!(one.id);
                notice["category"] = json!(Category::NeedsYou);
                notice["reach"] = json!(one.decision.reach);
                if let Some(why) = one.decision.why {
                    notice["why"] = json!(why);
                }
                let sent = self.digests.notices.send(notice).is_ok();
                delivered &= one.decision.reach != Reach::Now || sent;
            }
            delivered
        })
    }
}

fn batch_wait(ms: i64) -> Duration {
    Duration::from_millis(u64::try_from(ms).unwrap_or(0))
}

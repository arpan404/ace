//! The task manager's one read (ADR 0200 §6.3): every top-level bot with its workers under it,
//! what it does now in words, what it holds open, its spend against its alert line, its network
//! today and when it next does something by itself. This gathers the facts; the fold and its
//! order are `spade_core::running`'s.

use spade_core::reach::spend;
use spade_core::running::{self, Egress, Facts, NextWake, Row, Spend, Uses, Worker};
use spade_store::{Agent, HEARTBEAT, ROUTINE, StoreError};

use super::{Activity, Engine};

/// The most egress log entries read per bot for today's network use.
const EGRESS_ENTRIES: usize = 5_000;

impl Engine {
    /// `GET /v1/running`: one row per bot that is no worker, its workers under it.
    pub fn running(&self) -> Result<Vec<Row>, StoreError> {
        let enabled = self.main_enabled()?;
        let mut facts = Vec::new();
        for agent in self.store.agents()? {
            if (!enabled && agent.kind == "main") || self.worker_link(&agent.conversation).is_some()
            {
                continue;
            }
            facts.push(self.running_facts(&agent)?);
        }
        Ok(running::rows(facts))
    }

    fn running_facts(&self, agent: &Agent) -> Result<Facts, StoreError> {
        let id = &agent.conversation;
        let activity = self.activity(id)?;
        Ok(Facts {
            id: agent.id.clone(),
            name: agent.name.clone(),
            kind: agent.kind.clone(),
            conversation: id.clone(),
            state: activity.state,
            status: self.status_for(id, &activity),
            waiting_for: activity.waiting_for.map(str::to_owned),
            failure: activity.failure.clone(),
            paused_at_ms: self.paused_since(&agent.id),
            uses: Uses {
                answering: activity.answering,
                jobs: activity.jobs,
                workers: activity.workers,
                services: activity.services,
                agents: activity.ace_working,
            },
            spend: self.running_spend(agent)?,
            network: self.network_today(&agent.id),
            next_wake: running::sooner(self.next_wake(&activity), self.next_slot(&agent.id)?),
            workers: self.running_workers(id),
        })
    }

    fn running_spend(&self, agent: &Agent) -> Result<Spend, StoreError> {
        let spent = self.spent(agent)?;
        let rule = self.reach_settings()?.spend;
        let hours = self.store.spent_by_hour(
            &agent.conversation,
            self.now_ms(),
            spend::TRAILING_HOURS + 1,
        )?;
        let (last_hour, trailing) = hours.split_last().map_or((0, &[][..]), |(l, t)| (*l, t));
        let line = rule.on.then(|| spend::line(rule, spend::median(trailing)));
        Ok(Spend {
            today_micros: spent.today_micros,
            month_micros: spent.month_micros,
            last_hour_micros: last_hour,
            alert_line_micros: line,
            unusual: line.is_some_and(|line| last_hour > line),
        })
    }

    fn network_today(&self, agent: &str) -> running::Network {
        let Some(security) = self.security() else {
            return running::Network::default();
        };
        let entries = security.egress(agent, EGRESS_ENTRIES);
        running::network_today(
            entries.iter().map(|e| Egress {
                at_ms: e.at,
                host: &e.host,
                allowed: e.allowed,
                sent: e.sent,
                received: e.received,
            }),
            self.periods().day_start,
        )
    }

    /// The bot's soonest wake by time, with what it is for.
    fn next_wake(&self, activity: &Activity) -> Option<NextWake> {
        let open = activity.wake.as_ref()?;
        Some(NextWake {
            at_ms: open.due_ms?,
            what: if open.reason.is_empty() {
                spade_core::wake::words(open, |ms| self.short_time(ms))
            } else {
                open.reason.clone()
            },
        })
    }

    /// The bot's next routine slot (its heartbeat's included), with the routine's name.
    fn next_slot(&self, agent: &str) -> Result<Option<NextWake>, StoreError> {
        let mut next: Option<NextWake> = None;
        for kind in [ROUTINE, HEARTBEAT] {
            for r in self.store.routines_of(agent, kind)? {
                let (false, Some(at_ms)) = (r.paused, r.next_due_ms) else {
                    continue;
                };
                let what = if kind == HEARTBEAT {
                    "Heartbeat".to_owned()
                } else {
                    r.name
                };
                next = running::sooner(next, Some(NextWake { at_ms, what }));
            }
        }
        Ok(next)
    }

    fn running_workers(&self, id: &str) -> Vec<Worker> {
        self.worker_children(id)
            .into_iter()
            .filter_map(|child| {
                let agent = self.store.agent_for_conversation(&child).ok().flatten()?;
                let activity = self.activity(&child).ok()?;
                let reads = running::reads(activity.state, activity.failure.as_deref());
                let status = self.status_for(&child, &activity);
                Some(Worker {
                    id: agent.id,
                    name: agent.name,
                    state: activity.state,
                    doing: running::doing(
                        reads,
                        status.as_deref(),
                        activity.waiting_for,
                        activity.failure.as_deref(),
                    ),
                })
            })
            .collect()
    }
}

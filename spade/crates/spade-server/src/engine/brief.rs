//! The morning brief and spend alerts (ADR 0195, amending ADR 0165 and ADR 0166), run on the
//! digests' timer. The brief is stored beside the main bot's conversation as a digest row of
//! kind `brief`, so the main chat shows it as a bubble and the bot never reads it; a spend alert
//! is a row of kind `spend` in that bot's chat. Both go out on the notice stream.

use std::collections::HashMap;

use jiff::Timestamp;
use serde_json::{Value, json};
use spade_core::reach::brief::{self, Away, BotInput, Planned};
use spade_core::reach::{Category, spend};
use spade_store::{Agent, BRIEF, NewDigest, ROUTINE, SPEND_ALERT, StoreError};

use super::Engine;
use super::agents::MAIN;
use super::reach::Outgoing;

const HOUR_MS: i64 = 3_600_000;
const DAY_MS: i64 = 24 * HOUR_MS;
/// A brief Spade missed (down at the time) is still made this long after its time.
const BRIEF_GRACE_MS: i64 = 3 * HOUR_MS;
/// How often each bot's spend rate is looked at.
const SPEND_EVERY_MS: i64 = 5 * 60_000;
/// Which bots are in an unusual spend episode.
const SPEND_EPISODES: &str = "reach:spend";

impl Engine {
    /// One pass of the reach timer: the summary once quiet ends, the brief when due, the spend
    /// check every few minutes. Answers when it wants to look again.
    pub(super) async fn reach_tick(self: &std::sync::Arc<Self>) -> Option<i64> {
        if let Err(error) = self.summarize_quiet() {
            tracing::error!(%error, "could not send the summary of what waited");
        }
        let now = self.now_ms();
        let next_brief = match self.brief_due(now) {
            Ok(Due::Now) => {
                if let Err(error) = self.make_brief(now).await {
                    tracing::error!(%error, "could not make the morning brief");
                }
                self.brief_due(now).ok().and_then(Due::at)
            }
            Ok(due) => due.at(),
            Err(_) => None,
        };
        let spend_at = {
            let mut last = self
                .digests
                .spend_checked
                .lock()
                .unwrap_or_else(|p| p.into_inner());
            if last.is_none_or(|at| now - at >= SPEND_EVERY_MS) {
                *last = Some(now);
                drop(last);
                if let Err(error) = self.check_spend(now) {
                    tracing::error!(%error, "could not check spend rates");
                }
            }
            now + SPEND_EVERY_MS
        };
        Some(next_brief.map_or(spend_at, |at| at.min(spend_at)))
    }

    fn brief_due(&self, now: i64) -> Result<Due, StoreError> {
        let settings = self.reach_settings()?;
        if !settings.brief.on {
            return Ok(Due::Off);
        }
        let zone = self.zone();
        let today = Timestamp::from_millisecond(now)
            .unwrap_or(Timestamp::UNIX_EPOCH)
            .to_zoned(zone.clone())
            .date();
        let at_on = |date: jiff::civil::Date| {
            date.at(
                i8::try_from(settings.brief.at / 60).unwrap_or(8),
                i8::try_from(settings.brief.at % 60).unwrap_or(0),
                0,
                0,
            )
            .to_zoned(zone.clone())
            .map(|z| z.timestamp().as_millisecond())
            .ok()
        };
        let Some(slot) = at_on(today) else {
            return Ok(Due::Off);
        };
        let last = self.store.last_brief()?.unwrap_or(i64::MIN);
        if now >= slot && now - slot < BRIEF_GRACE_MS && last < slot {
            return Ok(Due::Now);
        }
        if now < slot {
            return Ok(Due::At(slot));
        }
        Ok(today
            .tomorrow()
            .ok()
            .and_then(at_on)
            .map_or(Due::Off, Due::At))
    }

    /// Makes the morning brief now, over the time since the last one (a day for the first),
    /// stores it beside the main bot's conversation and sends it.
    pub async fn make_brief(self: &std::sync::Arc<Self>, now: i64) -> Result<Value, StoreError> {
        let settings = self.reach_settings()?;
        let from = self.store.last_brief()?.unwrap_or(now - DAY_MS);
        let agents = self.store.agents()?;
        let Some(main) = agents.iter().find(|a| a.kind == MAIN).cloned() else {
            return Ok(Value::Null);
        };
        let covered = self.brief_bots(&agents, settings.brief.bots.as_deref())?;
        let end_of_day = Timestamp::from_millisecond(now)
            .unwrap_or(Timestamp::UNIX_EPOCH)
            .to_zoned(self.zone())
            .tomorrow()
            .and_then(|z| z.start_of_day())
            .map_or(now + DAY_MS, |z| z.timestamp().as_millisecond());
        let mut histories = Vec::new();
        let mut today = Vec::new();
        for agent in &covered {
            let (events, stamps) = self.load_stamped(&agent.conversation)?;
            let at_ms: Vec<i64> = stamps.iter().map(|(_, at)| *at).collect();
            let seqs: Vec<i64> = stamps.iter().map(|(seq, _)| *seq).collect();
            let spent = self.store.spent_by(&agent.conversation, from)?;
            histories.push((agent, events, at_ms, seqs, spent));
            for routine in self.store.routines_of(&agent.id, ROUTINE)? {
                if let Some(due) = routine
                    .next_due_ms
                    .filter(|due| *due >= now && *due < end_of_day)
                    && !routine.paused
                {
                    today.push(Planned {
                        agent: agent.id.clone(),
                        name: agent.name.clone(),
                        routine: routine.name.clone(),
                        at_ms: due,
                    });
                }
            }
        }
        let inputs: Vec<BotInput<'_>> = histories
            .iter()
            .map(|(agent, events, at_ms, seqs, spent)| BotInput {
                agent: &agent.id,
                name: &agent.name,
                conversation: &agent.conversation,
                events,
                at_ms,
                seqs,
                spent_micros: *spent,
            })
            .collect();
        let away: Vec<Away> = self
            .take_away(None)?
            .into_iter()
            .map(|h| Away {
                agent: h.agent,
                name: h.name,
                at_ms: h.at_ms,
                text: h.text,
            })
            .collect();
        let total = self.store.spent_since(from)?;
        let made = brief::build(from, now, &inputs, today, away, total);
        let time = |ms: i64| self.short_time(ms);
        let plain = brief::text(&made, &time);
        let polished = if settings.brief.polish {
            self.polish(&main.conversation, &plain).await
        } else {
            None
        };
        let body = serde_json::to_string(&made).unwrap_or_else(|_| "{}".to_owned());
        let id = self.store.add_digest(&NewDigest {
            agent: &main.id,
            kind: BRIEF,
            scheduled: true,
            from_ms: from,
            to_ms: now,
            made_ms: now,
            body: &body,
            text: &plain,
            polished: polished.as_deref(),
        })?;
        let headline = brief::headline(&made);
        self.reach_out(Outgoing {
            notice: json!({
                "kind": "brief", "agent": main.id, "name": main.name,
                "conversation": main.conversation, "digest": id, "at": now,
                "text": headline,
            }),
            id: format!("brief:{id}"),
            agent: main.id.clone(),
            name: main.name.clone(),
            category: Category::Brief,
            level: None,
            engaged: false,
            text: headline.clone(),
        });
        Ok(self.digest_by_id(id)?.unwrap_or(Value::Null))
    }

    /// The bots a brief covers: the chosen ones (a club's id stands for its members on this
    /// machine), else every bot that isn't a worker.
    fn brief_bots(
        &self,
        agents: &[Agent],
        chosen: Option<&[String]>,
    ) -> Result<Vec<Agent>, StoreError> {
        let Some(chosen) = chosen else {
            return Ok(agents
                .iter()
                .filter(|a| self.worker_link(&a.conversation).is_none())
                .cloned()
                .collect());
        };
        let mut ids: Vec<String> = Vec::new();
        for id in chosen {
            match self.store.group(id)? {
                Some(group) => ids.extend(
                    group
                        .members
                        .into_iter()
                        .filter(|m| m.machine.is_empty())
                        .map(|m| m.agent_id),
                ),
                None => ids.push(id.clone()),
            }
        }
        Ok(agents
            .iter()
            .filter(|a| ids.contains(&a.id))
            .cloned()
            .collect())
    }

    /// Looks at each bot's last hour against its usual, and alerts once per unusual episode:
    /// a line in its chat and a notice. Information only (ADR 0166).
    fn check_spend(&self, now: i64) -> Result<(), StoreError> {
        let rule = self.reach_settings()?.spend;
        if !rule.on {
            return Ok(());
        }
        let mut episodes: HashMap<String, bool> = self
            .store
            .setting(SPEND_EPISODES)?
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default();
        let before = episodes.clone();
        for agent in self.store.agents()? {
            let hours =
                self.store
                    .spent_by_hour(&agent.conversation, now, spend::TRAILING_HOURS + 1)?;
            let Some((last, trailing)) = hours.split_last() else {
                continue;
            };
            let open = episodes.get(&agent.id).copied().unwrap_or(false);
            let checked = spend::check(rule, *last, trailing, open);
            if checked.episode {
                episodes.insert(agent.id.clone(), true);
            } else {
                episodes.remove(&agent.id);
            }
            if checked.alert {
                self.spend_alert(&agent, now, *last, checked.median, rule.factor)?;
            }
        }
        if episodes != before {
            let raw = serde_json::to_string(&episodes).unwrap_or_else(|_| "{}".to_owned());
            self.store.set_setting(SPEND_EPISODES, Some(&raw))?;
        }
        Ok(())
    }

    fn spend_alert(
        &self,
        agent: &Agent,
        now: i64,
        last_hour: u64,
        median: u64,
        factor: u32,
    ) -> Result<(), StoreError> {
        let text = spend::alert_text(last_hour, median);
        let body = json!({
            "last_hour_micros": last_hour, "usual_micros": median, "factor": factor,
        })
        .to_string();
        let id = self.store.add_digest(&NewDigest {
            agent: &agent.id,
            kind: SPEND_ALERT,
            scheduled: false,
            from_ms: now - HOUR_MS,
            to_ms: now,
            made_ms: now,
            body: &body,
            text: &text,
            polished: None,
        })?;
        self.reach_out(Outgoing {
            notice: json!({
                "kind": "spend", "agent": agent.id, "name": agent.name,
                "conversation": agent.conversation, "digest": id, "at": now, "text": text,
            }),
            id: format!("spend:{id}"),
            agent: agent.id.clone(),
            name: agent.name.clone(),
            category: Category::Spend,
            level: None,
            engaged: false,
            text,
        });
        Ok(())
    }
}

enum Due {
    Off,
    Now,
    At(i64),
}

impl Due {
    fn at(self) -> Option<i64> {
        match self {
            Self::At(at) => Some(at),
            Self::Off | Self::Now => None,
        }
    }
}

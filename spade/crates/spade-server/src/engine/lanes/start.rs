//! Starting a lane (ADR 0217 §2, §2a, §3): `task_start` from main's model, and Spade moving main's
//! long work to a lane by itself. Either way the lane's row, its first events and main's record of
//! it are stored in one write, under the record lock Stop and steering use, so a restart finds
//! the move whole or not at all, and a call run again finds the lane it made.

use std::sync::Arc;

use serde_json::{Value, json};
use spade_core::context;
use spade_core::event::{FromAgent, Known};
use spade_core::lane::{self, Link, Moved, Started};
use spade_core::{Event, Transcript};
use spade_store::StoredHelper;

use super::super::Engine;
use crate::tools::ToolOutput;

/// `task_start`'s arguments.
#[derive(serde::Deserialize)]
struct Arguments {
    title: String,
    #[serde(default)]
    brief: String,
    /// The person's asks (ids from the asks block) the task takes over.
    #[serde(default)]
    asks: Vec<String>,
}

impl Engine {
    /// `task_start`, run with `key` (`<main>.<call>`): opens a lane for the asks it names, or
    /// finds the one this call made before a restart.
    pub(crate) fn task_start(self: &Arc<Self>, key: &str, arguments: Value) -> ToolOutput {
        let Some((main, _)) = key.split_once('.') else {
            return ToolOutput::error("Spade could not tell which bot asked.");
        };
        if self.hidden_of(main).is_some() {
            return ToolOutput::error(
                "Only the main conversation starts tasks; carry this one on yourself.",
            );
        }
        let arguments: Arguments = match crate::tools::parse(arguments) {
            Ok(arguments) => arguments,
            Err(refused) => return refused,
        };
        if let Ok(Some(found)) = self.store.helper_for_job(main, key) {
            return self.started_answer(&found);
        }
        let title = lane::title_of(&arguments.title);
        if arguments.title.trim().is_empty() {
            return ToolOutput::error("Give the task a short title in the person's words.");
        }
        if arguments.brief.chars().count() > lane::BRIEF_CHARS {
            return ToolOutput::error(format!(
                "The brief is longer than {} characters; give the task less.",
                lane::BRIEF_CHARS
            ));
        }
        let events = match self.load(main) {
            Ok(events) => events,
            Err(error) => return ToolOutput::error(format!("Spade could not start it: {error}")),
        };
        let ledger = self.asks_of(main, &events);
        let mut asks: Vec<String> = arguments
            .asks
            .iter()
            .map(|a| a.trim().to_owned())
            .filter(|a| ledger.ask(a).is_some())
            .collect();
        // Named none the ledger holds: the newest open ask is the one it was asked for.
        if asks.is_empty()
            && let Some(newest) = ledger.open_asks().last()
        {
            asks.push(newest.id.clone());
        }
        let words: Vec<String> = asks
            .iter()
            .filter_map(|id| {
                lane::persons_words(&events, id).or_else(|| Some(ledger.ask(id)?.words.clone()))
            })
            .collect();
        let registry = self.registry_for(main);
        let untrusted = !context::untrusted_in_view(&events, &registry).is_empty();
        let brief = arguments.brief.trim();
        let link = Link {
            parent_conversation: main.to_owned(),
            call: key.to_owned(),
            title: title.clone(),
            asks: asks.clone(),
            untrusted,
            person_source: lane::person_source(&events, &asks),
            copied_events: 2,
            moved_from: None,
        };
        let mut told = lane::told(&title);
        explain_person_source(&mut told, link.person_source.as_ref());
        let has_person_source = link.person_source.is_some();
        let mut first = vec![Event::Known(Known::LaneOf(link))];
        // The person's own words first, as theirs, so the lane's reviewer reads the person's
        // request and not a bot's (ADR 0217 §3).
        let text = match words.is_empty() {
            true => brief.to_owned(),
            false => words.join("\n\n"),
        };
        if !brief.is_empty() && !untrusted && !words.is_empty() {
            told.push_str(&format!(
                "\n<task_brief from=\"bot\">\n{brief}\n</task_brief>"
            ));
        }
        let mut opening = if has_person_source {
            Event::user_message(text)
        } else {
            self.bots_message(main, &text)
        };
        if let Event::Known(Known::UserMessage { context, .. }) = &mut opening {
            *context = Some(told);
        }
        first.push(opening);
        // A brief written with untrusted content in view reaches the lane as the bot's message,
        // which taints the lane's turn (ADR 0161's rule).
        if untrusted && !brief.is_empty() {
            first.push(self.bots_message(
                main,
                &format!("<task_brief from=\"bot\">\n{brief}\n</task_brief>"),
            ));
        }
        let opened = Opened {
            title,
            asks,
            moved_from: None,
            adopt_jobs: Vec::new(),
        };
        match self.open_lane(main, key, self.ids.next("l"), |_| {
            Some((opened, first, Vec::new()))
        }) {
            Ok(Some(row)) => self.started_answer(&row),
            Ok(None) => ToolOutput::error("Spade could not start it."),
            Err(refused) => refused,
        }
    }

    /// A bot-authored message, even when the initiating bot is no longer listed.
    fn bots_message(&self, main: &str, text: &str) -> Event {
        let mut message = Event::user_message(text);
        if let Event::Known(Known::UserMessage { from_agent, .. }) = &mut message {
            let (id, name) = self
                .store
                .agent_for_conversation(main)
                .ok()
                .flatten()
                .map_or_else(
                    || (main.to_owned(), "Spade".to_owned()),
                    |agent| (agent.id, agent.name),
                );
            *from_agent = Some(FromAgent {
                id,
                name,
                depth: 0,
                machine: None,
                contract: None,
            });
        }
        message
    }

    /// Stores a lane and main's record of it in one write, under the record lock, then starts it
    /// if a slot is free. `build` reads main's events under that lock and gives the lane's first
    /// events and what follows `lane_started` in main (a move's `reply_moved` and close), or
    /// `None` when there is nothing to do any more.
    fn open_lane(
        self: &Arc<Self>,
        main: &str,
        call: &str,
        lane_id: String,
        build: impl FnOnce(&[Event]) -> Option<(Opened, Vec<Event>, Vec<Event>)>,
    ) -> Result<Option<StoredHelper>, ToolOutput> {
        let row = self.store_lane(main, call, lane_id, build)?;
        if row.is_some() {
            self.lane_opened(main);
        }
        Ok(row)
    }

    /// After a lane was stored: it starts if a slot is free, and main's state goes out.
    fn lane_opened(self: &Arc<Self>, main: &str) {
        self.fill_lanes(main);
        self.announce(main);
    }

    /// The write of [`Engine::open_lane`] alone, under the record lock: the lane's row and first
    /// events and main's record of it. `Some` with the lane this call made or found.
    fn store_lane(
        self: &Arc<Self>,
        main: &str,
        call: &str,
        lane_id: String,
        build: impl FnOnce(&[Event]) -> Option<(Opened, Vec<Event>, Vec<Event>)>,
    ) -> Result<Option<StoredHelper>, ToolOutput> {
        // Read before the record lock, which reading a lane's state takes; it only says whether
        // `lane_started` reads queued: `fill_lanes` decides what starts.
        let running_before = self
            .live_lanes_of(main)
            .iter()
            .filter(|l| {
                let state = self.lane_state(&l.conversation);
                state.live() && state != lane::State::Queued
            })
            .count();
        let created = {
            let _order = self.record_lock.lock().unwrap_or_else(|p| p.into_inner());
            if self.deleting(main) {
                return Err(ToolOutput::error(context::NOT_RUN));
            }
            let events = self
                .load(main)
                .map_err(|error| ToolOutput::error(format!("Spade could not start it: {error}")))?;
            let Some((opened, first, then_main)) = build(&events) else {
                return Ok(None);
            };
            let opened_adopt = opened.adopt_jobs.clone();
            let reply = Transcript::fold(events.iter())
                .open_reply()
                .and_then(|m| m.reply.clone())
                .unwrap_or_default();
            let row = StoredHelper {
                conversation: lane_id,
                parent: main.to_owned(),
                job: call.to_owned(),
                reply,
                profile: lane::PROFILE.to_owned(),
                system: String::new(),
                reads_only: false,
                tools: None,
                model: self.lane_model(main),
                created_ms: self.now_ms(),
            };
            let running = running_before;
            let started = Event::Known(Known::LaneStarted(Started {
                lane: row.conversation.clone(),
                conversation: row.conversation.clone(),
                title: opened.title,
                call: call.to_owned(),
                asks: opened.asks,
                moved_from: opened.moved_from,
                queued: running >= self.limits.tasks_at_once.max(1),
            }));
            let mut parent = vec![started];
            parent.extend(then_main);
            let stored =
                self.store
                    .create_lane(&row, &first, &parent, &opened_adopt, self.now_ms());
            // Dropped whether or not the write succeeded: a failed write may still have landed.
            self.forget_activity(main);
            self.forget_activity(&row.conversation);
            match stored {
                Ok(Some((own, parent))) => {
                    self.publish_stored(&row.conversation, &own);
                    self.publish_stored(main, &parent);
                    Ok(Some(row))
                }
                Ok(None) => Ok(None),
                Err(error) => Err(error),
            }
        };
        match created {
            Ok(Some(row)) => Ok(Some(row)),
            // Made meanwhile by another run of this call: that one is the lane.
            Ok(None) => match self.store.helper_for_job(main, call) {
                Ok(found) => Ok(found),
                Err(_) => Err(ToolOutput::error("Spade could not start it.")),
            },
            Err(error) => Err(ToolOutput::error(format!(
                "Spade could not start it: {error}"
            ))),
        }
    }

    /// What `task_start` answers: the task, its title and whether it runs or waits for a slot.
    fn started_answer(&self, row: &StoredHelper) -> ToolOutput {
        let state = self.lane_state(&row.conversation);
        let title = self.lane_title(&row.conversation);
        let mut answer = json!({ "task": row.conversation, "title": title, "state": state.name() });
        if state == lane::State::Queued {
            answer["note"] = json!(format!(
                "Queued behind {} running tasks; it starts when one ends. Its card shows this; say nothing of it.",
                self.limits.tasks_at_once
            ));
        }
        ToolOutput::ok(answer.to_string())
    }

    /// Moves main's open `reply` to a lane when it is due (ADR 0217 §2a): `true` once moved, and
    /// the turn ends. Decided and stored under the record lock, so a message or a Stop that comes
    /// at the same moment lands before the move (and is carried into the lane) or after it. The
    /// reply's jobs and wakes move with it, under the lock a job takes to store its end, so
    /// each job reports exactly once, to main before the move or to the lane after it. Jobs whose
    /// work main tracks (ace's `delegate` and `wait`, contract calls) stay with main.
    pub(in super::super) fn move_if_due(
        self: &Arc<Self>,
        main: &str,
        reply: &str,
        elapsed_ms: i64,
    ) -> bool {
        if self.hidden_of(main).is_some() || !self.limits.move_long_work {
            return false;
        }
        // A cheap look first, without the locks: most steps are nowhere near a move.
        match self.load(main) {
            Ok(events) if lane::move_due(&events, reply, elapsed_ms) => {}
            _ => return false,
        }
        let registry = self.registry_for(main);
        let lane_id = self.ids.next("l");
        let call = format!("moved.{reply}");
        // The lock a job takes to store its end, then (in `open_lane`) the record lock: the order
        // starting a job and Stop take them in.
        let live = self.live(main);
        let mut live_jobs = live.jobs.lock().unwrap_or_else(|p| p.into_inner());
        let mut work: Option<(Vec<String>, Vec<String>)> = None;
        let build = |events: &[Event]| {
            if !lane::move_due(events, reply, elapsed_ms)
                || spade_core::turn::stop_requested(events, reply)
            {
                return None;
            }
            let (mut moved, asks) = lane::moved(events, reply)?;
            let (candidates, mut kept, wakes) = lane::work_of(events, reply, stays_with_main);
            // A job already storing its result reports to main: it stays.
            let (jobs, finishing): (Vec<String>, Vec<String>) =
                candidates.into_iter().partition(|job| {
                    !matches!(
                        live_jobs.get(job),
                        Some(super::super::jobs::Job::Finishing { .. })
                    )
                });
            kept.extend(finishing);
            let title = match moved.first() {
                Some(Event::Known(Known::UserMessage { text, .. })) => lane::title_of(text),
                _ => lane::title_of(""),
            };
            let person_source = lane::moved_person_source(events, reply);
            if person_source.is_none()
                && let Some(event @ Event::Known(Known::UserMessage { .. })) = moved.first_mut()
                && let Event::Known(Known::UserMessage { text, context, .. }) = event
            {
                let mut message = self.bots_message(main, text);
                if let Event::Known(Known::UserMessage {
                    context: copied, ..
                }) = &mut message
                {
                    *copied = context.take();
                }
                *event = message;
            }
            if let Some(Event::Known(Known::UserMessage { context, .. })) = moved.first_mut() {
                let mut told = lane::told(&title);
                explain_person_source(&mut told, person_source.as_ref());
                *context = Some(match context.take() {
                    Some(recent) => format!("{told}\n{recent}"),
                    None => told,
                });
            }
            let link = Link {
                parent_conversation: main.to_owned(),
                call: call.clone(),
                title: title.clone(),
                asks: asks.clone(),
                untrusted: !context::untrusted_in_view(events, &registry).is_empty(),
                moved_from: Some(reply.to_owned()),
                person_source,
                copied_events: moved.len() + 1,
            };
            let mut first = vec![Event::Known(Known::LaneOf(link))];
            first.append(&mut moved);
            // The jobs that stay are closed in the lane with words saying where they are.
            for job in &kept {
                first.push(Event::Known(Known::JobFinished {
                    job: job.clone(),
                    name: super::super::wakes::job_name(events, job),
                    content: lane::KEPT_JOB.to_owned(),
                    is_error: false,
                    uncertain: false,
                    files: Vec::new(),
                    untrusted: false,
                    cost_micros: None,
                }));
            }
            let mut then_main = vec![Event::Known(Known::ReplyMoved(Moved {
                reply: reply.to_owned(),
                lane: lane_id.clone(),
                title: title.clone(),
                asks: asks.clone(),
                jobs: jobs.clone(),
                kept_jobs: kept.clone(),
                wakes: wakes.clone(),
            }))];
            then_main.extend(wakes.iter().map(|wake| {
                Event::Known(Known::WakeCancelled {
                    wake: wake.clone(),
                    by: spade_core::wake::CancelledBy::Moved,
                })
            }));
            then_main.push(Event::Known(Known::ReplyFinished {
                reply: reply.to_owned(),
                text: String::new(),
                input_tokens: None,
                output_tokens: None,
                cost_micros: 0,
            }));
            let opened = Opened {
                title,
                asks,
                moved_from: Some(reply.to_owned()),
                adopt_jobs: jobs.clone(),
            };
            work = Some((jobs, wakes));
            Some((opened, first, then_main))
        };
        let moved = matches!(
            self.store_lane(main, &call, lane_id.clone(), build),
            Ok(Some(row)) if row.conversation == lane_id
        );
        if !moved {
            return false;
        }
        let (jobs, wakes) = work.unwrap_or_default();
        {
            let lane_live = self.live(&lane_id);
            let mut lane_jobs = lane_live.jobs.lock().unwrap_or_else(|p| p.into_inner());
            let mut homes = self
                .lanes
                .moved_jobs
                .lock()
                .unwrap_or_else(|p| p.into_inner());
            for job in &jobs {
                if let Some(running) = live_jobs.remove(job) {
                    lane_jobs.insert(job.clone(), running);
                }
                homes.insert(format!("{main}.{job}"), lane_id.clone());
            }
        }
        drop(live_jobs);
        self.lane_opened(main);
        // Helpers those jobs run answer to the lane now; what was known of them is read again.
        for helper in self.store.helpers_of(&lane_id).unwrap_or_default() {
            self.forget_hidden(&helper.conversation);
        }
        // The wakes fire in the lane now.
        let opens = self
            .load(&lane_id)
            .map(|events| spade_core::wake::open(events.iter()))
            .unwrap_or_default();
        for open in opens.into_iter().filter(|o| wakes.contains(&o.wake)) {
            self.disarm(main, &open.wake);
            self.arm(&lane_id, open);
        }
        self.name_lane(main, &lane_id);
        true
    }

    /// Names a moved lane with the `title` role, in the background (ADR 0217 §2a): the lane runs
    /// under the person's first line meanwhile, and keeps it when the call fails.
    fn name_lane(self: &Arc<Self>, main: &str, lane_id: &str) {
        let (engine, main, lane_id) = (self.clone(), main.to_owned(), lane_id.to_owned());
        tokio::spawn(async move {
            let words = engine.load(&lane_id).ok().and_then(|events| {
                events.iter().find_map(|e| match e {
                    Event::Known(Known::UserMessage { text, .. }) => Some(text.clone()),
                    _ => None,
                })
            });
            let Some(words) = words else { return };
            use spade_core::routing::Role;
            let model = engine.role_model(&main, Role::Title);
            let prompt = spade_core::title::task_prompt(&words)
                .session(&lane_id)
                .effort(engine.role_effort(&main, Role::Title));
            let admitted = engine.admit(&lane_id, &model).for_role(Role::Title);
            let named = match engine
                .models
                .generate::<spade_core::title::Suggestion>(&model, &prompt)
                .await
            {
                Ok(generated) => {
                    admitted.settle(&generated.usage);
                    spade_core::title::clean(&generated.value.title)
                }
                Err(error) => {
                    admitted.settle_if(error.usage());
                    None
                }
            };
            let Some(title) = named.map(|t| lane::title_of(&t)) else {
                return;
            };
            if title == engine.lane_title(&lane_id) {
                return;
            }
            let titled = Event::Known(Known::LaneTitled(lane::Titled {
                lane: lane_id.clone(),
                title,
            }));
            for at in [&lane_id, &main] {
                if let Err(error) = engine.record(at, &titled) {
                    tracing::error!(%error, "could not store a task lane's title");
                }
            }
            engine.announce(&main);
        });
    }
}

/// What `lane_started` says of a lane being opened, and the jobs whose helpers it takes over.
struct Opened {
    title: String,
    asks: Vec<String>,
    moved_from: Option<String>,
    adopt_jobs: Vec<String>,
}

/// Jobs whose work main tracks in its own events, so they stay with main when its reply moves:
/// ace's `delegate` and `wait` (its children are main's) and contract calls (their callees answer
/// main's call).
fn stays_with_main(name: &str) -> bool {
    name == spade_core::contract::CONTRACT_CALL || crate::tools::reattaches(name)
}

fn explain_person_source(context: &mut String, source: Option<&lane::PersonSource>) {
    if let Some(source) = source {
        use std::fmt::Write as _;
        let _ = write!(
            context,
            "\nFor a verbatim standing instruction, the latest copied person message has original id {}.",
            source.id
        );
    }
}

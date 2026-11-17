//! The auto-review (ADR 0144, amended by ADR 0163; spade/docs/autonomy.md): the reviewer that
//! approves or refuses a call on the person's behalf, and the move of levels Spade no longer has
//! to it. What the rules decide is `spade_core::autonomy`; this is the I/O around it.

use std::sync::Arc;

use serde_json::Value;
use spade_core::Event;
use spade_core::autonomy::{self, Access, Case, Judgment, Outcome, refusals};

use super::judge::Judged;
use spade_core::context;
use spade_core::event::{Call, Known, Verdict};
use spade_core::review;
use spade_core::tools::{Registry, ToolDef};
use tokio::sync::watch;

use super::Engine;

/// What the status line says while the reviewer reads a call.
const REVIEWING: &str = "Checking a step";

/// Whether the latest reply was one Spade started for the bot's task.
/// `at` gives the event at an index of `len`.
pub(super) fn continued<'a>(len: usize, at: impl Fn(usize) -> &'a Event) -> bool {
    let Some(start) =
        (0..len).rfind(|&i| matches!(at(i), Event::Known(Known::ReplyStarted { .. })))
    else {
        return false;
    };
    start > 0 && matches!(at(start - 1), Event::Known(Known::TaskContinued { .. }))
}

/// The setting the first build with levels (ADR 0144) stored once it pinned every bot to `ask`.
const LEVELS_PINNED: &str = "access_levels_pinned";
/// The setting stored once the levels Spade no longer has were moved forward (ADR 0163).
const LEVELS_RETIRED: &str = "access_levels_retired";

impl Engine {
    /// Once: every conversation whose latest stored level is one Spade no longer has (`ask`,
    /// `full_access`) gets an `access_changed` to `auto_review`, so its history says what it is on
    /// from here and the activity log shows the change. Those words read as the auto-review
    /// anyway; this moves the stored data forward.
    pub(super) fn retire_levels(&self) -> Result<(), spade_store::StoreError> {
        if self.store.setting(LEVELS_RETIRED)?.is_some() {
            return Ok(());
        }
        for (conversation, level) in self.store.latest_field("access_changed", "level")? {
            if level.as_deref().is_some_and(Access::retired) {
                let _order = self.record_lock.lock().unwrap_or_else(|p| p.into_inner());
                self.append(
                    &conversation,
                    &Event::Known(Known::AccessChanged {
                        level: Access::AutoReview,
                    }),
                )?;
            }
        }
        self.store.set_setting(LEVELS_PINNED, None)?;
        self.store.set_setting(LEVELS_RETIRED, Some("1"))
    }
}

/// What the auto-review came to.
pub(super) enum Reviewed {
    Run,
    Refuse(String),
    Escalate(String),
    Stopped,
}

/// Stores a verdict the rules reached without a model (a call the reviewer can't read whole, or
/// one that reaches credentials), so the activity log shows it and a restart reaches it again.
#[allow(clippy::too_many_arguments)]
pub(super) fn record_rule(
    engine: &Engine,
    id: &str,
    reply: &str,
    call: &Call,
    name: &str,
    verdict: Verdict,
    reason: &str,
    bound: Option<String>,
) -> Result<bool, spade_store::StoreError> {
    let event = Event::Known(Known::CallReviewed {
        reply: reply.to_owned(),
        call_id: call.id.clone(),
        name: name.to_owned(),
        verdict,
        reason: reason.to_owned(),
        model: String::new(),
        cost_micros: 0,
        bound,
    });
    engine.record_unless_stopped(id, reply, &event)
}

/// What one call under review is.
pub(super) struct Under<'a> {
    pub call: &'a Call,
    pub name: &'a str,
    pub arguments: &'a Value,
    pub def: &'a ToolDef,
    /// Files the call runs, shown to the reviewer; an approval is bound to them.
    pub shown: &'a [spade_core::autonomy::shell::Shown],
    /// Why the rules singled the call out, told to the reviewer.
    pub concern: Option<&'a str>,
}

/// The hash a call's shown files are bound by; `None` when it runs none.
pub(super) fn binding(shown: &[spade_core::autonomy::shell::Shown]) -> Option<String> {
    if shown.is_empty() {
        return None;
    }
    let mut text = Vec::new();
    for file in shown {
        text.extend_from_slice(file.path.as_bytes());
        text.push(0);
        text.extend_from_slice(file.content.as_bytes());
        text.push(0);
    }
    Some(crate::workspace::trust::hash(&text))
}

/// Has the reviewer judge one call, storing its verdict first. A verdict already stored for the
/// call is used again, so a restart never reviews (or pays for) a call twice. A refusal goes back
/// to the bot unless it retries a refused step (`refusals`); anything but a clear answer (a
/// failure, a timeout, an answer that doesn't parse twice) goes to the person: an unreviewed
/// call never runs.
pub(super) async fn review(
    engine: &Arc<Engine>,
    id: &str,
    reply: &str,
    events: &[Event],
    registry: &Registry,
    under: Under<'_>,
    stop: &mut watch::Receiver<bool>,
) -> Reviewed {
    if let Some((verdict, reason)) = review::stored(events, &under.call.id) {
        return of(verdict, reason);
    }
    let model = engine.review_model(id);
    engine.set_status(id, Some(REVIEWING.to_owned()));
    let agent = engine.store.agent_for_conversation(id).ok().flatten();
    let (bot, task, agent_id) = agent.as_ref().map_or(("the bot", "", ""), |a| {
        (a.name.as_str(), a.task.as_str(), a.id.as_str())
    });
    let folder =
        format!("its own workspace folder (workspace/{agent_id}), where shell commands run");
    // Everything untrusted the prompt still shows, from any turn since compaction: the same view
    // the memory gate answers to, so a page read before the person's latest message still counts.
    let untrusted = context::untrusted_in_view(events, registry);
    let refused = refusals::Run::of(events);
    let case = Case {
        bot,
        task,
        person: engine.person_words(id, events),
        untrusted: untrusted.clone(),
        folder: &folder,
        tool: under.name,
        description: &under.def.spec.description,
        arguments: under.arguments,
        shown: under.shown,
        concern: under.concern,
        refused: refused.shown(),
    };
    let prompt = autonomy::prompt(&case).session(id);
    let (outcome, cost) = match super::judge::judge::<Judgment>(
        engine,
        id,
        &model,
        &prompt,
        engine.limits.review_timeout,
        stop,
    )
    .await
    {
        Judged::Answer(judgment, cost) => (autonomy::judged(&judgment, &refused, under.call), cost),
        Judged::Failed(why, cost) => (Outcome::Escalate(why.to_owned()), cost),
        Judged::TimedOut(cost) => (
            Outcome::Escalate("The review took too long, so you decide.".to_owned()),
            cost,
        ),
        Judged::Stopped => return Reviewed::Stopped,
    };
    // The check is over: until the call starts or the person is asked, the bot is thinking, not
    // still checking (a stale "Checking a step" showed after an approval).
    engine.set_status(id, Some(super::roster::THINKING.to_owned()));
    let (verdict, reason) = match &outcome {
        Outcome::Run => (Verdict::Allow, String::new()),
        Outcome::Refuse(reason) => (Verdict::Refuse, reason.clone()),
        Outcome::Escalate(reason) => (Verdict::Escalate, reason.clone()),
    };
    let reviewed = Event::Known(Known::CallReviewed {
        reply: reply.to_owned(),
        call_id: under.call.id.clone(),
        name: under.name.to_owned(),
        verdict,
        reason: reason.clone(),
        model,
        cost_micros: cost,
        bound: binding(under.shown),
    });
    match engine.record_unless_stopped(id, reply, &reviewed) {
        Ok(true) => of(verdict, reason),
        Ok(false) => Reviewed::Stopped,
        // Not stored: the person decides rather than the call running unrecorded.
        Err(_) => Reviewed::Escalate("Spade couldn't store the review, so you decide.".to_owned()),
    }
}

fn of(verdict: Verdict, reason: String) -> Reviewed {
    match verdict {
        Verdict::Allow => Reviewed::Run,
        Verdict::Refuse => Reviewed::Refuse(reason),
        Verdict::Escalate => Reviewed::Escalate(reason),
    }
}

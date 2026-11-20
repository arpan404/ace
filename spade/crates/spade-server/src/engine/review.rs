//! The model review (ADR 0135): a second model judges a write the gate would run. Only ever
//! stricter: anything but a clear `allow` asks the person, with the review's reason
//! (ADR 0163, amendment 3).

use std::sync::Arc;
use std::time::Duration;

use serde_json::Value;
use spade_core::Event;
use spade_core::context;
use spade_core::event::{Call, Known, Verdict};
use spade_core::review::{self, Case, Judgment};
use spade_core::tools::{Registry, ToolDef};
use tokio::sync::watch;

use super::Engine;
use super::autonomy::{TOOK_TOO_LONG, line};
use super::judge::Judged;
use spade_core::autonomy::escalate::Stop;

/// Longest a review may take before the call goes to the person.
const REVIEW_TIMEOUT: Duration = Duration::from_secs(60);
pub(super) const CHECKING: &str = "Checking a step";

/// What the review came to.
pub(super) enum Reviewed {
    Allow,
    /// The person decides, with the request's line.
    Escalate(String),
    Stopped,
}

/// Reviews one call, storing the verdict first. A verdict already stored for the call is used
/// again, so a restart never reviews (or pays for) a call twice.
#[allow(clippy::too_many_arguments)]
pub(super) async fn call(
    engine: &Arc<Engine>,
    id: &str,
    reply: &str,
    events: &[Event],
    registry: &Registry,
    call: &Call,
    name: &str,
    arguments: &Value,
    def: &ToolDef,
    launch: spade_core::event::Authorized,
    stop: &mut watch::Receiver<bool>,
) -> Reviewed {
    if let Some((verdict, reason)) = review::stored(events, &call.id, launch) {
        return of(verdict, reason);
    }
    let model = engine.review_model(id);
    engine.set_status(id, Some(CHECKING.to_owned()));
    let agent = engine.store.agent_for_conversation(id).ok().flatten();
    let (bot, task) = agent
        .as_ref()
        .map_or(("the bot", ""), |a| (a.name.as_str(), a.task.as_str()));
    let case = Case {
        bot,
        task,
        person: engine.person_words(id, events),
        untrusted: context::untrusted_in_view(events, registry),
        tool: name,
        description: &def.spec.description,
        arguments,
    };
    let prompt = review::prompt(&case).session(id);
    let (verdict, reason, cost) =
        match super::judge::judge::<Judgment>(engine, id, &model, &prompt, REVIEW_TIMEOUT, stop)
            .await
        {
            // Stored as the line the person reads, so a restart asks with the same words.
            Judged::Answer(judgment, cost) => {
                let verdict = Verdict::from(judgment.verdict);
                let reason = match verdict {
                    Verdict::Allow => judgment.reason.trim().to_owned(),
                    _ => line(Stop::SecondReview(&judgment.reason)),
                };
                (verdict, reason, cost)
            }
            Judged::Failed(why, cost) => (
                Verdict::Escalate,
                line(Stop::SecondReviewUndecided(why)),
                cost,
            ),
            Judged::TimedOut(cost) => (
                Verdict::Escalate,
                line(Stop::SecondReviewUndecided(TOOK_TOO_LONG)),
                cost,
            ),
            Judged::Stopped => return Reviewed::Stopped,
        };
    // The check is over: until the call starts or the person is asked, the bot is thinking, not
    // still checking (a stale "Checking a step" showed after an approval).
    engine.set_status(id, Some(super::roster::THINKING.to_owned()));
    let reviewed = Event::Known(Known::CallReviewed {
        reply: reply.to_owned(),
        call_id: call.id.clone(),
        name: name.to_owned(),
        verdict,
        reason: reason.clone(),
        model,
        cost_micros: cost,
        bound: None,
        acts_in: None,
        launch: Some(launch),
        raised: None,
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
        Verdict::Allow => Reviewed::Allow,
        // This review never refuses; a refusal stored for the call is still not a run.
        Verdict::Escalate | Verdict::Refuse => Reviewed::Escalate(reason),
    }
}

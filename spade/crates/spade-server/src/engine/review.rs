//! The model review (ADR 0135): a second model judges a write the gate would run. Only ever
//! stricter: anything but a clear `allow` asks the person.

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
use super::judge::Judged;

/// Longest a review may take before the call goes to the person.
const REVIEW_TIMEOUT: Duration = Duration::from_secs(60);
pub(super) const CHECKING: &str = "Checking a step";

/// What the review came to.
pub(super) enum Reviewed {
    Allow,
    Escalate,
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
    stop: &mut watch::Receiver<bool>,
) -> Reviewed {
    if let Some((verdict, _)) = review::stored(events, &call.id) {
        return of(verdict);
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
            Judged::Answer(judgment, cost) => (
                Verdict::from(judgment.verdict),
                judgment.reason.trim().to_owned(),
                cost,
            ),
            Judged::Failed(why, cost) => (Verdict::Escalate, why.to_owned(), cost),
            Judged::TimedOut(cost) => (
                Verdict::Escalate,
                "The review took too long, so you decide.".to_owned(),
                cost,
            ),
            Judged::Stopped => return Reviewed::Stopped,
        };
    let reviewed = Event::Known(Known::CallReviewed {
        reply: reply.to_owned(),
        call_id: call.id.clone(),
        name: name.to_owned(),
        verdict,
        reason,
        model,
        cost_micros: cost,
        bound: None,
    });
    match engine.record_unless_stopped(id, reply, &reviewed) {
        Ok(true) => of(verdict),
        Ok(false) => Reviewed::Stopped,
        // Not stored: the person decides rather than the call running unrecorded.
        Err(_) => Reviewed::Escalate,
    }
}

fn of(verdict: Verdict) -> Reviewed {
    match verdict {
        Verdict::Allow => Reviewed::Allow,
        // This review never refuses; a refusal stored for the call is still not a run.
        Verdict::Escalate | Verdict::Refuse => Reviewed::Escalate,
    }
}

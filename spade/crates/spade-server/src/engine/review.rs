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
    let (verdict, reason, cost) = match engine.may_spend(id) {
        Err(why) => (
            Verdict::Escalate,
            format!("The review couldn't run: the bot reached {why}."),
            0,
        ),
        Ok(()) => {
            let agent = engine.store.agent_for_conversation(id).ok().flatten();
            let (bot, task) = agent
                .as_ref()
                .map_or(("the bot", ""), |a| (a.name.as_str(), a.task.as_str()));
            let case = Case {
                bot,
                task,
                person: review::person_words(events),
                untrusted: context::untrusted_in_view(events, registry),
                tool: name,
                description: &def.spec.description,
                arguments,
            };
            let prompt = review::prompt(&case).session(id);
            let asked = tokio::select! {
                answer = tokio::time::timeout(
                    REVIEW_TIMEOUT,
                    engine.models.generate::<Judgment>(&model, &prompt),
                ) => answer,
                _ = stop.wait_for(|stopped| *stopped) => return Reviewed::Stopped,
            };
            match asked {
                Ok(Ok(generated)) => {
                    let cost = engine.charge(id, &model, &generated.usage);
                    let reason = generated.value.reason.trim().to_owned();
                    (generated.value.verdict, reason, cost)
                }
                Ok(Err(error)) => {
                    let cost = error.usage().map_or(0, |u| engine.charge(id, &model, &u));
                    (
                        Verdict::Escalate,
                        format!("The review couldn't run: {error}"),
                        cost,
                    )
                }
                Err(_) => (
                    Verdict::Escalate,
                    "The review took too long, so you decide.".to_owned(),
                    0,
                ),
            }
        }
    };
    let reviewed = Event::Known(Known::CallReviewed {
        reply: reply.to_owned(),
        call_id: call.id.clone(),
        name: name.to_owned(),
        verdict,
        reason,
        model,
        cost_micros: cost,
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
        Verdict::Escalate => Reviewed::Escalate,
    }
}

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
use super::autonomy::line;
use super::judge::Judged;
use super::stream_calls::{ReviewResult, Work};
use spade_core::autonomy::escalate::Stop;

/// Longest a review may take before the call goes to the person.
const REVIEW_TIMEOUT: Duration = Duration::from_secs(60);
pub(super) const CHECKING: &str = "Checking a step";

/// What the review came to.
pub(super) enum Reviewed {
    Allow,
    Refuse(String),
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
    // What the verdict holds for: a connected app's tool's definition (ADR 0202, amendment 5).
    bound: Option<String>,
    identity: Option<String>,
    reuse_review: bool,
    reuse_person: bool,
    stop: &mut watch::Receiver<bool>,
    work: &mut Work<'_>,
) -> Reviewed {
    let model = engine.review_model(id);
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
    let effort = engine.role_effort(id, spade_core::routing::Role::Review);
    let memo = identity.and_then(|identity| {
        review::second_review_memo_key(
            arguments,
            (
                "second/v1",
                identity,
                name,
                launch,
                &bound,
                &model,
                effort,
                case.bot,
                case.task,
                &case.person,
                &case.untrusted,
                case.description,
            ),
        )
    });
    let prior = memo.as_deref().map_or(review::Prior::Fresh, |key| {
        review::prior_attempt(events, reply, key)
    });
    let unchanged = review::unchanged_events(events, registry);
    if let Some((verdict, reason)) = review::stored(events, &call.id, launch)
        && (verdict == Verdict::Refuse
            || (verdict == Verdict::Allow && review::stored(unchanged, &call.id, launch).is_some())
            || review::retry_escalation(events, &call.id, memo.as_deref(), prior))
    {
        return of(verdict, reason);
    }
    if reuse_person && prior == review::Prior::DeniedByPerson {
        return Reviewed::Refuse("The person declined this action.".to_owned());
    }
    let person_allowed = reuse_person
        && prior == review::Prior::AllowedByPerson
        && memo.as_deref().is_some_and(|key| {
            review::prior_attempt(unchanged, reply, key) == review::Prior::AllowedByPerson
        });
    if person_allowed
        || (reuse_review
            && memo
                .as_deref()
                .is_some_and(|key| review::memo_allowed(unchanged, reply, key)))
    {
        if work.early() {
            return Reviewed::Stopped;
        }
        return match super::autonomy::record_rule(
            engine,
            id,
            reply,
            call,
            name,
            Verdict::Allow,
            if person_allowed {
                "Reused the person's approval from this reply."
            } else {
                "Reused a model review from this reply."
            },
            bound,
            launch,
        ) {
            Ok(true) => Reviewed::Allow,
            Ok(false) => Reviewed::Stopped,
            Err(_) => Reviewed::Refuse("Spade couldn't store the review.".to_owned()),
        };
    }
    let refused = if prior == review::Prior::Refused {
        Verdict::Escalate
    } else {
        Verdict::Refuse
    };
    let prompt = review::prompt(&case).session(id).effort(effort);
    let reviewed = Event::Known(Known::CallReviewed {
        memo,
        reply: reply.to_owned(),
        call_id: call.id.clone(),
        name: name.to_owned(),
        verdict: refused,
        reason: String::new(),
        model: model.clone(),
        cost_micros: 0,
        bound,
        acts_in: None,
        launch: Some(launch),
        raised: None,
    });
    let early = work.early();
    let judge = async {
        if !early {
            engine.set_status(id, Some(CHECKING.to_owned()));
        }
        let (verdict, reason, cost, judged) = match super::judge::judge::<Judgment>(
            engine,
            id,
            &model,
            &prompt,
            REVIEW_TIMEOUT,
            stop,
        )
        .await
        {
            // Stored as the line the person reads, so a restart asks with the same words.
            Judged::Answer(judgment, cost) => {
                let verdict = Verdict::from(judgment.verdict);
                let reason = match verdict {
                    Verdict::Allow => judgment.reason.trim().to_owned(),
                    _ => line(Stop::SecondReview(&judgment.reason)),
                };
                let verdict = if verdict == Verdict::Escalate {
                    refused
                } else {
                    verdict
                };
                (verdict, reason, cost, true)
            }
            Judged::Failed(why, cost) => (Verdict::Refuse, why.to_owned(), cost, false),
            Judged::TimedOut(cost) => (
                Verdict::Refuse,
                "The review took too long. Retry when the reviewer is available.".to_owned(),
                cost,
                false,
            ),
            Judged::Stopped => return None,
        };
        if !early {
            engine.set_status(id, Some(super::roster::THINKING.to_owned()));
        }
        Some((verdict, reason, cost, judged))
    };
    match work.review(engine, id, &prompt, reviewed, judge).await {
        ReviewResult::Decided(verdict, reason) => of(verdict, reason),
        ReviewResult::Stopped => Reviewed::Stopped,
        ReviewResult::Unstored => Reviewed::Refuse("Spade couldn't store the review.".to_owned()),
    }
}

fn of(verdict: Verdict, reason: String) -> Reviewed {
    match verdict {
        Verdict::Allow => Reviewed::Allow,
        // This review never refuses; a refusal stored for the call is still not a run.
        Verdict::Escalate => Reviewed::Escalate(reason),
        Verdict::Refuse => Reviewed::Refuse(reason),
    }
}

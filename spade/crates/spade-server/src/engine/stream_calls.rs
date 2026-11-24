//! Work that can overlap one model stream. Its results become eligible only after the provider's
//! final call list agrees with the close frame and the ordinary gate reaches the same decision.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use spade_core::Event;
use spade_core::event::{Call, Known, Verdict};
use spade_core::maintenance::Pause;
use spade_core::turn::{CallIds, Pending, Status};
use spade_models::{Endpoint, Prompt, ToolCall};
use tokio::sync::watch;
use tokio::task::JoinHandle;

use super::calls::run::Ran;
use super::{Engine, calls};
use crate::tools::Tool;

pub(super) enum Prepared {
    Read(Arc<dyn Tool>, Ran),
    Review(Box<Event>),
}

struct ReviewRequest {
    prompt: Prompt,
    draft: Box<Event>,
    endpoint: Option<Endpoint>,
}

impl ReviewRequest {
    fn new(engine: &Engine, model: &str, prompt: &Prompt, draft: &Event) -> Self {
        Self {
            prompt: prompt.clone(),
            draft: Box::new(draft.clone()),
            endpoint: engine.models.resolve(model).map(|(endpoint, _)| endpoint),
        }
    }

    fn matches(&self, other: &Self) -> bool {
        self.prompt == other.prompt && self.draft == other.draft && self.endpoint == other.endpoint
    }
}

type ReviewSlot = Arc<Mutex<Option<ReviewRequest>>>;

pub(super) struct Preparing {
    pub(super) result: Option<Prepared>,
    review: ReviewSlot,
}

pub(super) enum Work<'a> {
    Early(&'a mut Preparing),
    Stored(&'a mut StreamCalls),
}

impl Work<'_> {
    pub(super) fn early(&self) -> bool {
        matches!(self, Self::Early(_))
    }

    async fn prepared_review(&mut self, id: &str, request: ReviewRequest) -> Option<Event> {
        match self {
            Self::Early(prepared) => {
                *prepared.review.lock().unwrap_or_else(|p| p.into_inner()) = Some(request);
                None
            }
            Self::Stored(calls) => {
                let task = calls.take_task(id)?;
                // A steer or setting change can change the question. Skip mismatched work
                // immediately, even while its reviewer is still answering.
                if !task
                    .review
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .as_ref()
                    .is_some_and(|previous| previous.matches(&request))
                {
                    return None;
                }
                let Prepared::Review(event) = task.result().await? else {
                    return None;
                };
                Some(*event)
            }
        }
    }

    /// Reuse a matching review or ask now. The draft carries the normal event fields before
    /// the reviewer fills in the verdict, reason and cost.
    pub(super) async fn review(
        &mut self,
        engine: &Engine,
        id: &str,
        prompt: &Prompt,
        mut draft: Event,
        judge: impl Future<Output = Option<(Verdict, String, u64)>>,
    ) -> ReviewResult {
        let Event::Known(Known::CallReviewed { model, call_id, .. }) = &draft else {
            return ReviewResult::Stopped;
        };
        let request = ReviewRequest::new(engine, model, prompt, &draft);
        if let Some(previous) = self.prepared_review(call_id, request).await {
            draft = previous;
        } else {
            let Some((verdict, reason, cost)) = judge.await else {
                return ReviewResult::Stopped;
            };
            if let Event::Known(Known::CallReviewed {
                verdict: stored,
                reason: line,
                cost_micros,
                ..
            }) = &mut draft
            {
                *stored = verdict;
                *line = reason;
                *cost_micros = cost;
            }
        }
        if let Self::Early(prepared) = self {
            prepared.result = Some(Prepared::Review(Box::new(draft)));
            return ReviewResult::Stopped;
        }
        let Event::Known(Known::CallReviewed {
            reply,
            verdict,
            reason,
            ..
        }) = &draft
        else {
            return ReviewResult::Stopped;
        };
        match engine.record_unless_stopped(id, reply, &draft) {
            Ok(true) => ReviewResult::Decided(*verdict, reason.clone()),
            Ok(false) => ReviewResult::Stopped,
            Err(_) => ReviewResult::Unstored,
        }
    }
}

pub(super) enum ReviewResult {
    Decided(Verdict, String),
    Unstored,
    Stopped,
}

pub(super) struct Task {
    task: JoinHandle<Option<Prepared>>,
    review: ReviewSlot,
}

impl Task {
    pub(super) async fn result(mut self) -> Option<Prepared> {
        (&mut self.task).await.ok().flatten()
    }
}

impl Drop for Task {
    fn drop(&mut self) {
        self.task.abort();
    }
}

struct Closed {
    raw: ToolCall,
    assigned: Call,
    task: Task,
}

#[derive(Default)]
pub(super) struct StreamCalls {
    ids: Option<CallIds>,
    events: Option<Arc<[Event]>>,
    closed: Vec<Closed>,
    matched: HashMap<String, Task>,
}

impl StreamCalls {
    #[allow(clippy::too_many_arguments)]
    pub(super) fn closed(
        &mut self,
        engine: &Arc<Engine>,
        id: &str,
        reply: &str,
        events: &[Event],
        raw: ToolCall,
        mut stop: watch::Receiver<bool>,
        mut pause: watch::Receiver<Pause>,
    ) {
        if *stop.borrow()
            || self.closed.len() >= engine.limits.max_parallel_tools.max(1)
            || self.closed.iter().any(|call| call.raw.id == raw.id)
        {
            return;
        }
        let (name, _) = calls::resolve(&as_call(raw.clone()));
        if !spade_core::turn::can_gate_while_streaming(&name)
            || name == spade_core::tools::CALL_TOOL
        {
            return;
        }
        let assigned = self
            .ids
            .get_or_insert_with(|| CallIds::from_events(events))
            .assign(as_call(raw.clone()), || engine.ids.next("call"));
        let call = assigned.clone();
        let events = self.events.get_or_insert_with(|| Arc::from(events)).clone();
        let (engine, id, reply) = (engine.clone(), id.to_owned(), reply.to_owned());
        let review = ReviewSlot::default();
        let worker_review = review.clone();
        let task = tokio::spawn(async move {
            if *stop.borrow()
                || !super::plugin_hooks::can_gate_while_streaming(&engine, &id, &call.name).await
            {
                return None;
            }
            let mut prepared = Preparing {
                result: None,
                review: worker_review,
            };
            calls::handle_calls(
                &engine,
                &id,
                &reply,
                &events,
                vec![Pending {
                    call,
                    status: Status::New,
                }],
                &mut stop,
                &mut pause,
                Work::Early(&mut prepared),
            )
            .await;
            prepared.result
        });
        self.closed.push(Closed {
            raw,
            assigned,
            task: Task { task, review },
        });
    }

    pub(super) fn finish(
        &mut self,
        engine: &Engine,
        events: &[Event],
        calls: Vec<ToolCall>,
    ) -> Vec<Call> {
        if calls.is_empty() {
            return Vec::new();
        }
        let mut ids = self
            .ids
            .take()
            .unwrap_or_else(|| CallIds::from_events(events));
        let calls = calls
            .into_iter()
            .map(|raw| {
                if let Some(index) = self.closed.iter().position(|closed| closed.raw == raw) {
                    let Closed { assigned, task, .. } = self.closed.swap_remove(index);
                    self.matched.insert(assigned.id.clone(), task);
                    assigned
                } else {
                    ids.assign(as_call(raw), || engine.ids.next("call"))
                }
            })
            .collect();
        self.closed.clear();
        self.events = None;
        calls
    }

    pub(super) async fn discard(&mut self) {
        let mut tasks: Vec<_> = self.closed.drain(..).map(|call| call.task).collect();
        tasks.extend(self.matched.drain().map(|(_, task)| task));
        for task in &tasks {
            task.task.abort();
        }
        for task in tasks {
            task.result().await;
        }
    }

    pub(super) fn keep(&mut self, mut pending: impl FnMut(&str) -> bool) {
        self.matched.retain(|id, _| pending(id));
    }

    pub(super) fn take_task(&mut self, id: &str) -> Option<Task> {
        self.matched.remove(id)
    }
}

fn as_call(raw: ToolCall) -> Call {
    Call {
        id: raw.id,
        name: raw.name,
        arguments: raw.arguments,
    }
}

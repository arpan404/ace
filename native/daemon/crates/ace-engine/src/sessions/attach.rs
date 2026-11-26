// SPDX-License-Identifier: Apache-2.0
//! The open flow's engine half: a provider session's frames, identity, failures and exit, taken
//! from its `SessionObserver` queue in order and folded into the thread's actor. The opener (E3
//! per provider) makes the session; this module owns everything that happens after it exists.

use ace_adapter_api::{
    Frame, FrameDirection, Session, SessionContext, SessionObserver, Translator,
};
use ace_json::Value;
use std::rc::Rc;
use std::sync::Arc;
use std::task::Poll;

use crate::actor::deps::ActorTranslator;
use crate::actor::intake::{self, FrameInput, Measure};
use crate::actor::state::FrameRef;
use crate::actor::{failure, fold, get_or_create};
use crate::frames::envelope::Envelope;
use crate::futures::future::LocalBoxFuture;
use crate::ports::PortError;
use crate::sessions::metadata;
use crate::sessions::observer::{Inbox, QueueObserver};
use crate::{Core, EngineError, ThreadId};

/// What an opener needs to start a provider session.
#[derive(Debug, Clone, Default)]
pub struct OpenRequest {
    pub thread_id: ThreadId,
    pub cwd: String,
    pub model: Option<String>,
    pub instance_id: Option<String>,
    pub env: Vec<(String, String)>,
    pub executable: Option<String>,
    pub instance_home_dir: Option<String>,
    pub store_generation: Option<u64>,
    pub resume_native_session_id: Option<String>,
}

impl OpenRequest {
    /// The context a provider's `open` takes (`SessionContext`).
    pub fn context(&self) -> SessionContext {
        SessionContext {
            thread_id: self.thread_id.clone(),
            cwd: self.cwd.clone(),
            env: self.env.clone(),
            instance_id: self.instance_id.clone(),
            model: self.model.clone(),
            executable: self.executable.clone(),
            instance_home_dir: self.instance_home_dir.clone(),
            store_generation: self.store_generation,
            resume_native_session_id: self.resume_native_session_id.clone(),
        }
    }
}

/// What a provider hands back: its session and the translator its frames translate through.
pub struct Opened {
    pub session: Box<dyn Session>,
    pub translator: Box<dyn Translator>,
    pub native_session_id: String,
}

/// One provider's session opener (E3): it receives the engine's observer and starts the session.
pub trait SessionOpener {
    fn open(
        &self,
        request: OpenRequest,
        observer: Arc<dyn SessionObserver>,
    ) -> LocalBoxFuture<'static, Result<Opened, String>>;
}

/// One attached session, as the engine holds it.
pub struct Attached {
    pub session: Box<dyn Session>,
    pub inbox: Arc<Inbox>,
    pub native_session_id: String,
    pub generation: u64,
}

/// `sessions.open`: make the observer and the queue, open the provider session, then attach it to
/// the thread's actor and drain its queue. A failed open leaves the actor as it was.
pub async fn open(
    core: &Rc<Core>,
    opener: &dyn SessionOpener,
    request: OpenRequest,
) -> Result<(), String> {
    let inbox = Inbox::new();
    let observer: Arc<dyn SessionObserver> = Arc::new(QueueObserver::new(Arc::clone(&inbox)));
    let opened = opener.open(request.clone(), observer).await?;
    attach(core, request, opened, inbox).map_err(|error| error.to_string())
}

/// Attaches an opened session: the translator the actor's folds use, the session on the thread,
/// and the drain task that folds its queue in order.
pub fn attach(
    core: &Rc<Core>,
    request: OpenRequest,
    opened: Opened,
    inbox: Arc<Inbox>,
) -> Result<(), EngineError> {
    let thread = request.thread_id;
    get_or_create(core, &thread)?;
    let generation = core
        .with_state(|state| {
            let Some(actor) = state.actors.by_thread.get_mut(&thread) else {
                return 0;
            };
            actor.session_attached = true;
            actor.generation
        })
        .unwrap_or(0);
    core.actor_deps.borrow().translators.borrow_mut().insert(
        thread.clone(),
        (generation, ActorTranslator::Native(opened.translator)),
    );
    core.with_state(|state| {
        state.sessions.attached.insert(
            thread.clone(),
            Attached {
                session: opened.session,
                inbox: Arc::clone(&inbox),
                native_session_id: opened.native_session_id,
                generation,
            },
        );
    })?;
    core.record_wake(&thread);
    let task_core = Rc::clone(core);
    let task = core
        .executor
        .spawn(crate::executor::Lane::Work, async move {
            drain(task_core, thread, inbox).await;
        });
    task.detach();
    Ok(())
}

/// One session's drain: every queued event in order, then park until the producer pushes again.
async fn drain(core: Rc<Core>, thread: ThreadId, inbox: Arc<Inbox>) {
    loop {
        let events = crate::futures::future::poll_fn(|cx| {
            let batch = inbox.poll();
            if matches!(batch, Poll::Pending) {
                inbox.register(cx.waker());
            }
            batch
        })
        .await;
        let mut exited = false;
        for event in events {
            match event {
                crate::sessions::observer::Event::Frame(frame) => {
                    intake_native(&core, &thread, frame);
                }
                crate::sessions::observer::Event::Identity(native_id) => {
                    identity(&core, &thread, &native_id);
                }
                crate::sessions::observer::Event::Fatal(message) => {
                    failure::fail(&core, &thread, EngineError::Port(PortError::Threw(message)));
                }
                crate::sessions::observer::Event::Exit(exit) => {
                    settle(&core, &thread, &exit);
                    exited = true;
                }
            }
        }
        if exited {
            return;
        }
    }
}

/// One frame through the same intake a JavaScript session's frames take.
fn intake_native(core: &Rc<Core>, thread: &ThreadId, frame: ace_adapter_api::SessionFrame) {
    let generation = core
        .with_state(|state| {
            state
                .actors
                .by_thread
                .get(thread)
                .filter(|actor| actor.session_attached)
                .map(|actor| actor.generation)
        })
        .ok()
        .flatten();
    let Some(generation) = generation else {
        return;
    };
    let frame = frame_of(frame);
    let envelope = Envelope::from(&frame);
    let bytes = frame.data.get().len();
    let channel_sdk = channel_is_sdk(&frame.channel);
    let _ = intake::frame(
        core,
        thread,
        generation,
        FrameInput {
            frame: FrameRef::Native(Box::new(frame)),
            envelope,
            channel_sdk,
            measure: Measure::Bounded(Ok(bytes)),
            native_ack: None,
        },
    );
}

/// `onSessionIdentity`: the provider's own id is pinned to the durable binding.
fn identity(core: &Rc<Core>, thread: &ThreadId, native_id: &str) {
    let at = core.ports.now();
    let outcome = metadata::native_session(&core.store, thread, Some(native_id), None, None)
        .and_then(|event| match event {
            Some(event) => core.store.write_events(
                thread,
                &ace_json::to_string(&Value::Array(vec![event].into())),
                at,
            ),
            None => Ok(()),
        });
    if let Err(error) = outcome {
        core.ports.report(error.to_string());
    }
    core.with_state(|state| {
        if let Some(attached) = state.sessions.attached.get_mut(thread) {
            attached.native_session_id = native_id.to_owned();
        }
    })
    .ok();
}

/// `onExit`: the process exit the provider reported settles the thread, and the session goes.
fn settle(core: &Rc<Core>, thread: &ThreadId, exit: &ace_adapter_api::SessionExit) {
    let facts = exit_facts(exit);
    if let Err(error) = fold::apply(core, thread, &facts) {
        core.ports.report(error.to_string());
    }
    detach(core, thread);
}

/// Drops the attached session and its translator, leaving the thread without one.
pub fn detach(core: &Rc<Core>, thread: &ThreadId) {
    core.with_state(|state| {
        state.sessions.attached.shift_remove(thread);
        if let Some(actor) = state.actors.by_thread.get_mut(thread) {
            actor.session_attached = false;
        }
    })
    .ok();
    core.actor_deps
        .borrow()
        .translators
        .borrow_mut()
        .remove(thread);
    core.record_wake(thread);
}

/// The session's frame as the intake's typed frame.
pub fn frame_of(frame: ace_adapter_api::SessionFrame) -> Frame {
    Frame {
        seq: frame.seq,
        t: frame.t,
        dir: frame.dir,
        channel: frame.channel,
        data: frame.data,
        payload: None,
        usage_account: None,
    }
}

/// The `process.exited` fact a session's exit writes.
pub fn exit_facts(exit: &ace_adapter_api::SessionExit) -> Vec<Value> {
    let fact = if exit.deliberate {
        ace_json::json!({"type": "process.exited", "deliberate": true})
    } else {
        ace_json::json!({"type": "process.exited", "deliberate": false, "message": exit.message})
    };
    vec![fact]
}

/// The channel a frame arrived on, for an SDK batch's rules (`"sdk"` only on the SDK channel).
pub fn channel_is_sdk(channel: &str) -> bool {
    channel == "sdk"
}

/// The direction name an intake envelope checks against.
pub fn direction_name(direction: FrameDirection) -> &'static str {
    match direction {
        FrameDirection::Send => "send",
        FrameDirection::Recv => "recv",
        FrameDirection::Stderr => "stderr",
        FrameDirection::Note => "note",
    }
}

#[cfg(test)]
mod tests;

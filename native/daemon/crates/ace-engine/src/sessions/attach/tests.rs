// SPDX-License-Identifier: Apache-2.0
//! The open flow's engine half: the request a provider is handed, the frame it becomes, and the
//! process exit its observer reports. Moved from `open-failure.process`'s exit and resume shapes.

use super::{OpenRequest, channel_is_sdk, direction_name, exit_facts, frame_of};
use ace_adapter_api::{FrameDirection, SessionExit, SessionFrame};
use ace_json::{Raw, Value};

fn frame(seq: u64) -> SessionFrame {
    SessionFrame {
        seq,
        t: 42,
        dir: FrameDirection::Recv,
        channel: "sdk".to_owned(),
        data: Raw::from_json("{\"type\":\"x\"}").expect("json"),
    }
}

#[test]
fn the_open_request_carries_everything_the_provider_is_told() {
    let request = OpenRequest {
        thread_id: "t".to_owned(),
        provider: "pi".to_owned(),
        cwd: "/repo".to_owned(),
        model: Some("model".to_owned()),
        instance_id: Some("account".to_owned()),
        backend: Some("acp".to_owned()),
        env: vec![("ACE_THREAD_ID".to_owned(), "t".to_owned())],
        executable: Some("/bin/pi".to_owned()),
        instance_home_dir: Some("/home/a".to_owned()),
        store_generation: Some(3),
        resume_native_session_id: Some("native".to_owned()),
    };
    let context = request.context();
    assert_eq!(context.thread_id, "t");
    assert_eq!(context.cwd, "/repo");
    assert_eq!(context.model.as_deref(), Some("model"));
    assert_eq!(context.instance_id.as_deref(), Some("account"));
    assert_eq!(request.backend.as_deref(), Some("acp"));
    assert_eq!(context.env, [("ACE_THREAD_ID".to_owned(), "t".to_owned())]);
    assert_eq!(context.executable.as_deref(), Some("/bin/pi"));
    assert_eq!(context.instance_home_dir.as_deref(), Some("/home/a"));
    assert_eq!(context.store_generation, Some(3));
    assert_eq!(
        context.resume_native_session_id.as_deref(),
        Some("native"),
        "a resume names the native session it continues"
    );
}

#[test]
fn a_session_frame_becomes_the_intakes_typed_frame() {
    let typed = frame_of(frame(7));
    assert_eq!(typed.seq, 7);
    assert_eq!(typed.t, 42);
    assert_eq!(typed.dir, FrameDirection::Recv);
    assert_eq!(typed.channel, "sdk");
    assert_eq!(typed.data.get(), "{\"type\":\"x\"}");
    assert!(channel_is_sdk(&typed.channel));
    assert!(!channel_is_sdk("stdio"));
}

#[test]
fn a_deliberate_exit_marks_the_process_as_ace_closed() {
    let facts = exit_facts(&SessionExit {
        deliberate: true,
        message: "closed".to_owned(),
    });
    assert_eq!(facts.len(), 1);
    assert_eq!(
        ace_json::to_string(&facts[0]),
        "{\"type\":\"process.exited\",\"deliberate\":true}"
    );
    let facts = exit_facts(&SessionExit {
        deliberate: false,
        message: "Pi process exit, code 1".to_owned(),
    });
    assert_eq!(
        facts[0].get("deliberate"),
        Some(&Value::Bool(false)),
        "an unexpected exit is not deliberate"
    );
    assert_eq!(
        facts[0].get("message").and_then(Value::as_str),
        Some("Pi process exit, code 1")
    );
}

#[test]
fn directions_keep_their_names() {
    assert_eq!(direction_name(FrameDirection::Send), "send");
    assert_eq!(direction_name(FrameDirection::Recv), "recv");
    assert_eq!(direction_name(FrameDirection::Stderr), "stderr");
    assert_eq!(direction_name(FrameDirection::Note), "note");
}

mod engine {
    use super::super::{OpenFailure, OpenRequest, OpenSteps, Opened, SessionOpener};
    use crate::actor::deps::ActorDeps;
    use crate::actor::state::ActorInstance;
    use crate::executor::{Budget, Notified, Notifier};
    use crate::repository::testsupport::{Shell, header, home};
    use crate::sessions::open_session::OpenView;
    use crate::{Engine, Inputs};
    use ace_adapter_api::session::{InterruptTarget, SendInput};
    use ace_adapter_api::{
        AdapterApiError, CloseReason, FrameDirection, Reopen, Session, SessionExit, SessionFrame,
        SessionObserver, Translator,
    };
    use ace_core::{Key, RawFact};
    use ace_json::Raw;
    use ace_protocol::generated::{ExecutionSelection, GoalChange, InteractionResolution};
    use futures::future::LocalBoxFuture;
    use std::cell::RefCell as StdRefCell;
    use std::cell::{Cell, RefCell};
    use std::rc::Rc;
    use std::sync::Arc;

    struct ManualPump;

    impl Notifier for ManualPump {
        fn notify(&self) -> Notified {
            Notified::Posted
        }
    }

    struct Turn;

    impl Budget for Turn {
        fn start(&mut self) {}
        fn spent(&self, started: usize) -> bool {
            started >= 64
        }
    }

    type ClosingAction = Box<dyn FnOnce(&dyn SessionObserver)>;

    struct SilentSession {
        observer: Arc<dyn SessionObserver>,
        on_close: RefCell<Option<ClosingAction>>,
        stopped: Rc<RefCell<Vec<String>>>,
    }

    impl Session for SilentSession {
        fn native_session_id(&self) -> &str {
            "native"
        }
        fn configure(
            &self,
            _selection: ExecutionSelection,
        ) -> LocalBoxFuture<'_, Result<Option<Reopen>, AdapterApiError>> {
            Box::pin(async { Ok(None) })
        }
        fn set_model(&self, _model: String) -> LocalBoxFuture<'_, Result<(), AdapterApiError>> {
            Box::pin(async { Ok(()) })
        }
        fn set_mode(&self, _mode: String) -> LocalBoxFuture<'_, Result<(), AdapterApiError>> {
            Box::pin(async { Ok(()) })
        }
        fn set_goal(&self, _change: GoalChange) -> LocalBoxFuture<'_, Result<(), AdapterApiError>> {
            Box::pin(async { Ok(()) })
        }
        fn clear_goal(&self) -> LocalBoxFuture<'_, Result<(), AdapterApiError>> {
            Box::pin(async { Ok(()) })
        }
        fn send(&self, _input: SendInput<'_>) -> LocalBoxFuture<'_, Result<(), AdapterApiError>> {
            Box::pin(async { Ok(()) })
        }
        fn interrupt(
            &self,
            _target: InterruptTarget,
        ) -> LocalBoxFuture<'_, Result<(), AdapterApiError>> {
            Box::pin(async { Ok(()) })
        }
        fn resolve(
            &self,
            _interaction: Key,
            _resolution: InteractionResolution,
        ) -> LocalBoxFuture<'_, Result<(), AdapterApiError>> {
            Box::pin(async { Ok(()) })
        }
        fn stop_task(&self, task: Key) -> LocalBoxFuture<'_, Result<(), AdapterApiError>> {
            Box::pin(async move {
                self.stopped.borrow_mut().push(task);
                Ok(())
            })
        }
        fn close(&self, _reason: CloseReason) -> LocalBoxFuture<'_, Result<(), AdapterApiError>> {
            Box::pin(async move {
                crate::actor::yield_once().await;
                if let Some(action) = self.on_close.take() {
                    action(self.observer.as_ref());
                }
                Ok(())
            })
        }
    }

    /// One fact per frame: a turn start, which the fold records as a run.
    struct TurnTranslator;

    impl Translator for TurnTranslator {
        fn take_diagnostics(&mut self) -> Vec<String> {
            Vec::new()
        }
        fn next_deadline(&self) -> Option<i64> {
            None
        }
        fn translate(&mut self, frame: &ace_adapter_api::Frame, _now: i64) -> Vec<RawFact> {
            vec![RawFact {
                fact_type: "turn.started".to_owned(),
                data: Raw::from_json(&format!(
                    "{{\"agent\":\"root\",\"nativeTurnId\":\"turn-{}\",\"trigger\":\"user\"}}",
                    frame.seq
                ))
                .expect("json"),
            }]
        }
        fn tick(&mut self, _now: i64) -> Vec<RawFact> {
            Vec::new()
        }
    }

    struct FakeOpener {
        calls: Cell<u32>,
        failure: Option<String>,
        observer: RefCell<Option<Arc<dyn SessionObserver>>>,
        on_close: RefCell<Option<ClosingAction>>,
        stopped: Rc<RefCell<Vec<String>>>,
    }

    impl FakeOpener {
        fn ok() -> FakeOpener {
            FakeOpener {
                calls: Cell::new(0),
                failure: None,
                observer: RefCell::new(None),
                on_close: RefCell::new(None),
                stopped: Rc::default(),
            }
        }
    }

    impl SessionOpener for FakeOpener {
        fn open(
            &self,
            _request: OpenRequest,
            observer: Arc<dyn SessionObserver>,
        ) -> LocalBoxFuture<'static, Result<Opened, String>> {
            self.calls.set(self.calls.get() + 1);
            if let Some(error) = &self.failure {
                let error = error.clone();
                return Box::pin(async move { Err(error) });
            }
            observer.identity("native-1");
            observer.frame(SessionFrame {
                seq: 0,
                t: 0,
                dir: FrameDirection::Recv,
                channel: "stdio".to_owned(),
                data: Raw::from_json("{\"kind\":\"turn\"}").expect("json"),
            });
            *self.observer.borrow_mut() = Some(Arc::clone(&observer));
            let on_close = RefCell::new(self.on_close.take());
            let stopped = Rc::clone(&self.stopped);
            Box::pin(async move {
                Ok(Opened {
                    session: Box::new(SilentSession {
                        observer,
                        on_close,
                        stopped,
                    }),
                    translator: Box::new(TurnTranslator),
                    native_session_id: "native-1".to_owned(),
                })
            })
        }
    }

    /// A live store the gate always lets through: a test has no buffer to flush.
    struct TestLive;

    impl crate::frames::live::LiveStore for TestLive {
        fn writable_now(&self) -> bool {
            true
        }
        fn writable(&self) -> LocalBoxFuture<'static, ()> {
            Box::pin(async {})
        }
        fn history_writing(&self) -> bool {
            false
        }
        fn live_write_blocked(&self) -> bool {
            false
        }
        fn prepare_live_write(&self, _bytes: f64) -> Result<(), crate::EngineError> {
            Ok(())
        }
        fn buffer_live_write(
            &self,
            _thread: &str,
            _events: &[ace_json::Value],
            _at: f64,
            _snapshot: Rc<dyn crate::frames::live::LiveSnapshot>,
        ) -> Result<(), crate::EngineError> {
            Ok(())
        }
        fn run_scheduled(&self) {}
        fn flush_live_writes(&self) {}
        fn is_store_retry(&self, _error: &crate::EngineError) -> bool {
            false
        }
    }

    fn engine_on(conn: &std::sync::Arc<ace_store::Connection>) -> (Engine, Rc<Shell>) {
        let (_, shell) = Shell::store_with_controls(conn);
        let engine = Engine::new(
            shell.clone(),
            shell.clone(),
            Inputs::default(),
            "[]",
            Box::new(ManualPump),
            conn,
            Rc::new(ActorDeps::production(Rc::new(TestLive), 0.0)),
        )
        .expect("engine");
        // E5.7's interaction gates are another item's; their pass-through answers them.
        engine
            .core()
            .with_state(|state| state.repo.probe_passthrough = true)
            .expect("the state is free");
        (engine, shell)
    }

    fn install_actor(core: &Rc<crate::Core>) {
        let actor = Rc::new(StdRefCell::new(ActorInstance::new("t".to_owned(), 0)));
        actor.borrow_mut().instance = 1;
        core.with_state(|state| {
            state
                .actors
                .by_thread
                .insert("t".to_owned(), Rc::clone(&actor));
        })
        .expect("the state is free");
        // A real actor's mailbox task exists from creation; the fold runs on it.
        crate::actor::spawn_mailbox(core, &"t".to_owned());
    }

    fn pump(engine: &Engine) {
        for _ in 0..12 {
            let mut budget = Turn;
            engine.pump(&mut budget);
        }
    }

    fn request() -> OpenRequest {
        OpenRequest {
            thread_id: "t".to_owned(),
            cwd: "/tmp".to_owned(),
            ..OpenRequest::default()
        }
    }

    fn ready_view() -> OpenView {
        OpenView {
            workspace_ready: true,
            ..OpenView::default()
        }
    }

    fn thread_state(conn: &std::sync::Arc<ace_store::Connection>) -> ace_json::Value {
        let row = ace_store::stmt_cache::get_row(
            conn,
            "SELECT state FROM thread_state WHERE thread_id='t'",
            vec![],
        )
        .expect("read");
        let text = row
            .and_then(|row| match row.get("state") {
                Some(ace_store::Value::Text(text)) => Some(text.clone()),
                _ => None,
            })
            .expect("a state row");
        ace_json::parse(&text).expect("state json")
    }

    #[test]
    fn a_refused_open_never_starts_the_provider() {
        let conn = home("t", &header("t"));
        let (engine, shell) = engine_on(&conn);
        let core = engine.core();
        install_actor(core);
        let opener = FakeOpener::ok();
        let mut view = ready_view();
        view.fenced = true;
        let steps = OpenSteps {
            view: &view,
            prepare_workspace: None,
            writable: None,
            recheck: None,
        };
        let outcome = crate::futures::executor::block_on(super::super::open(
            core,
            &opener,
            request(),
            &steps,
        ));
        assert_eq!(
            outcome,
            Err(OpenFailure::Refused(
                crate::sessions::open_session::OpenRefusal::Fenced
            ))
        );
        assert_eq!(opener.calls.get(), 0, "the provider was never asked");
        assert!(
            core.with_state(|state| state.sessions.attached.is_empty())
                .expect("the state is free")
        );
        assert!(
            shell.reports().is_empty(),
            "a refusal is not an error report"
        );
    }

    #[test]
    fn an_open_that_attaches_folds_its_queued_frames_in_order() {
        let conn = home("t", &header("t"));
        let (engine, _shell) = engine_on(&conn);
        let core = engine.core();
        install_actor(core);
        let opener = FakeOpener::ok();
        let view = ready_view();
        let steps = OpenSteps {
            view: &view,
            prepare_workspace: None,
            writable: None,
            recheck: None,
        };
        crate::futures::executor::block_on(super::super::open(core, &opener, request(), &steps))
            .expect("open");
        assert_eq!(opener.calls.get(), 1);
        assert!(
            core.with_state(|state| state.sessions.attached.contains_key("t"))
                .expect("the state is free"),
            "the session is attached"
        );
        pump(&engine);
        // The batch timer is the shell's; a seal is the flush a client's read would trigger.
        crate::actor::intake::seal(core, &"t".to_owned());
        pump(&engine);
        let state = thread_state(&conn);
        assert_eq!(
            state.get("hasRun"),
            Some(&ace_json::Value::Bool(true)),
            "the frame's turn start folded: {state}"
        );
        assert_eq!(
            state.get("rootKey").and_then(ace_json::Value::as_str),
            Some("root"),
            "the root agent exists: {state}"
        );
        // The session's exit is the terminal barrier: the thread detaches and the exit folds.
        let observer = opener
            .observer
            .borrow()
            .clone()
            .expect("the opener kept the observer");
        observer.exit(SessionExit {
            deliberate: true,
            message: "closed".to_owned(),
        });
        pump(&engine);
        assert!(
            core.with_state(|state| state.sessions.attached.is_empty())
                .expect("the state is free"),
            "the exit detaches the session"
        );
        let state = thread_state(&conn);
        assert_eq!(
            state
                .get("processExit")
                .and_then(|exit| exit.get("deliberate")),
            Some(&ace_json::Value::Bool(true)),
            "the deliberate exit folded"
        );
    }

    #[test]
    fn a_delivery_completed_during_provider_close_fences_off_the_old_settles_exit() {
        let conn = home("t", &header("t"));
        let (engine, _shell) = engine_on(&conn);
        let engine = Rc::new(engine);
        pump(&engine);
        assert!(engine.is_ready());
        install_actor(engine.core());

        let opener = FakeOpener::ok();
        let database = Arc::clone(&conn);
        opener.on_close.replace(Some(Box::new(move |observer| {
            database
                .exec(
                    "INSERT INTO intents (command_id,thread_id,kind,payload,status)
                 VALUES ('new-work','t','thread.send','{}','done')",
                )
                .expect("a new delivery completed");
            observer.exit(SessionExit {
                deliberate: true,
                message: "closed old session".to_owned(),
            });
        })));
        let view = ready_view();
        let steps = OpenSteps {
            view: &view,
            prepare_workspace: None,
            writable: None,
            recheck: None,
        };
        crate::futures::executor::block_on(super::super::open(
            engine.core(),
            &opener,
            request(),
            &steps,
        ))
        .expect("open");
        pump(&engine);
        conn.exec(r#"UPDATE threads SET client='{"settledAt":5}' WHERE id='t'"#)
            .expect("commit settle");

        let outcome = Rc::new(RefCell::new(None));
        let result = Rc::clone(&outcome);
        let owner = Rc::clone(&engine);
        let task = engine
            .core()
            .executor
            .spawn(crate::executor::Lane::Control, async move {
                result.replace(Some(owner.stop_settled("t").await));
            });
        task.detach();
        pump(&engine);
        assert!(
            outcome.borrow().as_ref().is_some_and(Result::is_ok),
            "{outcome:?}"
        );
        assert_eq!(
            crate::intents::store::command_status(&conn, "new-work")
                .unwrap()
                .as_deref(),
            Some("done")
        );
        assert!(
            thread_state(&conn).get("processExit").is_none(),
            "the old settle must not publish an exit over the new delivery"
        );
    }

    #[test]
    fn a_committed_background_stop_reaches_its_owning_provider_session() {
        let conn = home("t", &header("t"));
        let (engine, _shell) = engine_on(&conn);
        pump(&engine);
        assert!(engine.is_ready());
        let core = engine.core();
        install_actor(core);
        let opener = FakeOpener::ok();
        let view = ready_view();
        let steps = OpenSteps {
            view: &view,
            prepare_workspace: None,
            writable: None,
            recheck: None,
        };
        crate::futures::executor::block_on(super::super::open(core, &opener, request(), &steps))
            .expect("open");
        pump(&engine);
        conn.exec(
            r#"INSERT INTO engine_state_records VALUES ('t','tasks','provider-task',
                 '{"id":"task-id","agentId":"agent","kind":"shell","title":"A shell","status":"running","ambient":false,"stoppable":true,"startedAt":1}');
               INSERT INTO view_entities VALUES ('t','backgroundTasks','task-id','{}');
               UPDATE thread_state SET seq=seq+1 WHERE thread_id='t';"#,
        ).unwrap();
        let command = ace_json::parse(
            r#"{"id":"stop-task","deviceId":"device","payload":{"type":"background_task.stop","taskId":"task-id"}}"#,
        ).unwrap();
        let accepted = core
            .store
            .atomic(|_| {
                core.with_state(|state| crate::commands::prelude::handle(core, state, &command))?
            })
            .unwrap()
            .unwrap();
        assert_eq!(
            accepted.get("ok").and_then(ace_json::Value::as_bool),
            Some(true),
            "{accepted}"
        );
        core.release_after_commit();
        pump(&engine);
        assert_eq!(opener.stopped.borrow().as_slice(), ["provider-task"]);
        assert_eq!(
            crate::intents::store::command_status(&conn, "stop-task")
                .unwrap()
                .as_deref(),
            Some("done")
        );
    }

    #[test]
    fn a_failed_provider_open_leaves_no_session_and_no_open_mark() {
        let conn = home("t", &header("t"));
        let (engine, _shell) = engine_on(&conn);
        let core = engine.core();
        install_actor(core);
        let opener = FakeOpener {
            calls: Cell::new(0),
            failure: Some("spawn failed".to_owned()),
            observer: RefCell::new(None),
            on_close: RefCell::new(None),
            stopped: Rc::default(),
        };
        let view = ready_view();
        let steps = OpenSteps {
            view: &view,
            prepare_workspace: None,
            writable: None,
            recheck: None,
        };
        let outcome = crate::futures::executor::block_on(super::super::open(
            core,
            &opener,
            request(),
            &steps,
        ));
        assert_eq!(
            outcome,
            Err(OpenFailure::Provider("spawn failed".to_owned()))
        );
        assert!(
            core.with_state(
                |state| state.sessions.attached.is_empty() && state.repo.opening.is_empty()
            )
            .expect("the state is free"),
            "no session and no open mark"
        );
    }
}

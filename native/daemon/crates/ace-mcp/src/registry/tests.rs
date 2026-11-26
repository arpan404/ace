// Ported from the registry contract of `registry.ts` and the cases that guard it:
// "rejects registration beyond the tool limit while admitted tools remain callable",
// "revocation aborts a running tool and prevents a late success", "timeouts abort the tool
// using an injected timer and suppress late results", "retains capacity for a backend that
// ignores timeout until it finishes", "validates both tool boundaries and never exposes
// backend errors", "rejects oversized, cyclic and deeply nested results", "a host's hook and
// the tool share one deadline", "a stalled observation of a result never holds the reply or
// the slot past the call's deadline", "one busy thread cannot consume another thread's tool
// slots", and "filters unauthorized tools and rejects direct capability bypasses".
use super::*;
use crate::credentials::{CredentialRegistry, McpScope, Principal, SessionLease};
use crate::signal::ManualScheduler;
use std::sync::atomic::{AtomicBool, AtomicUsize};
use std::time::Duration;

struct Fixture {
    registry: Arc<ToolRegistry>,
    scheduler: Arc<ManualScheduler>,
    leases: Mutex<Vec<SessionLease>>,
    secrets: Arc<AtomicUsize>,
}

impl Fixture {
    fn new(max_calls: usize, max_calls_per_thread: usize) -> Fixture {
        let scheduler = Arc::new(ManualScheduler::default());
        let registry = Arc::new(
            ToolRegistry::new(Arc::clone(&scheduler) as Arc<dyn Scheduler>)
                .with_call_limits(max_calls, max_calls_per_thread),
        );
        Fixture {
            registry,
            scheduler,
            leases: Mutex::new(Vec::new()),
            secrets: Arc::new(AtomicUsize::new(0)),
        }
    }

    fn with_hooks(hooks: Hooks) -> Fixture {
        Fixture::with_hooks_and_limits(hooks, MAX_CALLS, MAX_CALLS_PER_THREAD)
    }

    fn with_hooks_and_limits(
        hooks: Hooks,
        max_calls: usize,
        max_calls_per_thread: usize,
    ) -> Fixture {
        let scheduler = Arc::new(ManualScheduler::default());
        let registry = Arc::new(
            ToolRegistry::new(Arc::clone(&scheduler) as Arc<dyn Scheduler>)
                .with_call_limits(max_calls, max_calls_per_thread)
                .with_hooks(hooks),
        );
        Fixture {
            registry,
            scheduler,
            leases: Mutex::new(Vec::new()),
            secrets: Arc::new(AtomicUsize::new(0)),
        }
    }

    fn principal(&self, thread: &str, capabilities: &[&str], agent: &str) -> Principal {
        let secrets = Arc::clone(&self.secrets);
        let credentials = CredentialRegistry::new(move || {
            let next = secrets.fetch_add(1, Ordering::SeqCst);
            format!("{next:064x}")
        });
        let lease = credentials
            .issue(
                McpScope::new("session", thread, agent, capabilities),
                &Abort::new(),
            )
            .expect("lease");
        let principal = lease.principal.clone();
        self.leases
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .push(lease);
        principal
    }

    fn register(&self, name: &str, timeout_ms: u64, handler: Arc<dyn ToolHandler>) {
        self.registry
            .register(ToolEntry::new(
                descriptor(
                    name,
                    None,
                    "A tool",
                    "read-only",
                    None,
                    timeout_ms,
                    ace_json::parse("{\"type\":\"object\"}").expect("schema"),
                    Some(ace_json::parse("{\"type\":\"object\"}").expect("schema")),
                ),
                handler,
            ))
            .expect("registration");
    }
}

fn code(result: &CallToolResult) -> String {
    let value = ace_json::parse(&result.content[0].text).expect("json");
    value
        .get("code")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

fn echo() -> Arc<dyn ToolHandler> {
    Arc::new(FnTool(|input: Value, _context: ToolContext| async move {
        Ok(input)
    }))
}

async fn settle() {
    for _ in 0..50 {
        tokio::task::yield_now().await;
    }
}

#[tokio::test]
async fn a_call_is_refused_in_the_typescripts_order_and_nothing_runs() {
    // session_ended: the provider session is gone.
    let fixture = Fixture::new(1024, 256);
    fixture.register("ace_echo", 1_000, echo());
    let principal = fixture.principal("thread", &[], "root");
    principal.lifetime.abort();
    let ended = fixture
        .registry
        .call(
            "ace_echo",
            Value::Null,
            &principal,
            &Abort::new(),
            CallOptions::default(),
        )
        .await;
    assert_eq!(code(&ended), "session_ended");

    // tool_unavailable: not registered, or a capability the caller does not hold.
    let fixture = Fixture::new(1024, 256);
    let ran = Arc::new(AtomicBool::new(false));
    let flag = Arc::clone(&ran);
    fixture
        .registry
        .register(ToolEntry::new(
            descriptor(
                "browser_open",
                None,
                "Open",
                "external-effect",
                Some("browser"),
                1_000,
                ace_json::parse("{\"type\":\"object\"}").expect("schema"),
                None,
            ),
            Arc::new(FnTool(move |input: Value, _context: ToolContext| {
                let flag = Arc::clone(&flag);
                async move {
                    flag.store(true, Ordering::SeqCst);
                    Ok(input)
                }
            })),
        ))
        .expect("registration");
    let denied = fixture.principal("thread", &[], "root");
    let missing = fixture
        .registry
        .call(
            "nope",
            Value::Null,
            &denied,
            &Abort::new(),
            CallOptions::default(),
        )
        .await;
    assert_eq!(code(&missing), "tool_unavailable");
    let bypass = fixture
        .registry
        .call(
            "browser_open",
            Value::Null,
            &denied,
            &Abort::new(),
            CallOptions::default(),
        )
        .await;
    assert_eq!(code(&bypass), "tool_unavailable");
    assert!(!ran.load(Ordering::SeqCst));

    // host_policy_refused: the host's admission.
    let admit: CallAdmission = Arc::new(|_tool, _input, _caller| false);
    let refused = Fixture::with_hooks(Hooks {
        admit: Some(admit),
        ..Hooks::default()
    });
    refused.register("ace_echo", 1_000, echo());
    let principal = refused.principal("thread", &[], "root");
    let policy = refused
        .registry
        .call(
            "ace_echo",
            Value::Null,
            &principal,
            &Abort::new(),
            CallOptions::default(),
        )
        .await;
    assert_eq!(code(&policy), "host_policy_refused");

    // cancelled: the request was aborted before anything was taken.
    let fixture = Fixture::new(1024, 256);
    fixture.register("ace_echo", 1_000, echo());
    let principal = fixture.principal("thread", &[], "root");
    let request = Abort::new();
    request.abort();
    let cancelled = fixture
        .registry
        .call(
            "ace_echo",
            Value::Null,
            &principal,
            &request,
            CallOptions::default(),
        )
        .await;
    assert_eq!(code(&cancelled), "cancelled");
}

#[tokio::test]
async fn calls_limit_holds_per_thread_and_recovers_when_a_call_ends() {
    let fixture = Fixture::new(16, 1);
    let gate = Arc::new(tokio::sync::Notify::new());
    let started = Arc::new(tokio::sync::Notify::new());
    let waiting = {
        let gate = Arc::clone(&gate);
        let started = Arc::clone(&started);
        Arc::new(FnTool(move |input: Value, _context: ToolContext| {
            let gate = Arc::clone(&gate);
            let started = Arc::clone(&started);
            async move {
                started.notify_one();
                gate.notified().await;
                Ok(input)
            }
        })) as Arc<dyn ToolHandler>
    };
    fixture.register("ace_wait", 60_000, waiting);
    fixture.register("ace_echo", 60_000, echo());
    let thread = fixture.principal("thread", &[], "root");
    let owner = thread.clone();
    let other = fixture.principal("other", &[], "root");
    let registry = Arc::clone(&fixture.registry);
    let first = tokio::spawn(async move {
        registry
            .call(
                "ace_wait",
                Value::Null,
                &thread,
                &Abort::new(),
                CallOptions::default(),
            )
            .await
    });
    started.notified().await;
    // The same thread is at its bound; another thread is not.
    let blocked = fixture
        .registry
        .call(
            "ace_echo",
            Value::Null,
            &owner,
            &Abort::new(),
            CallOptions::default(),
        )
        .await;
    assert_eq!(code(&blocked), "calls_limit");
    let allowed = fixture
        .registry
        .call(
            "ace_echo",
            Value::Null,
            &other,
            &Abort::new(),
            CallOptions::default(),
        )
        .await;
    assert!(!allowed.is_error, "another thread was refused");
    gate.notify_waiters();
    let _ = first.await.expect("call");
    settle().await;
    let recovered = fixture
        .registry
        .call(
            "ace_echo",
            Value::Null,
            &owner,
            &Abort::new(),
            CallOptions::default(),
        )
        .await;
    assert!(!recovered.is_error, "the slot never came back");
}

#[tokio::test]
async fn a_timeout_frees_the_reply_and_holds_the_slot_until_the_backend_settles() {
    let fixture = Fixture::new(1, 256);
    let gate = Arc::new(tokio::sync::Notify::new());
    let started = Arc::new(tokio::sync::Notify::new());
    let hanging = {
        let gate = Arc::clone(&gate);
        let started = Arc::clone(&started);
        Arc::new(FnTool(move |input: Value, _context: ToolContext| {
            let gate = Arc::clone(&gate);
            let started = Arc::clone(&started);
            async move {
                started.notify_one();
                gate.notified().await;
                Ok(input)
            }
        })) as Arc<dyn ToolHandler>
    };
    fixture.register("ace_hang", 1_000, hanging);
    fixture.register("ace_echo", 1_000, echo());
    let principal = fixture.principal("thread", &[], "root");
    let owner = principal.clone();
    let registry = Arc::clone(&fixture.registry);
    let call = tokio::spawn(async move {
        registry
            .call(
                "ace_hang",
                Value::Null,
                &principal,
                &Abort::new(),
                CallOptions::default(),
            )
            .await
    });
    started.notified().await;
    fixture.scheduler.fire_all();
    let timed_out = call.await.expect("call");
    assert_eq!(code(&timed_out), "tool_timeout");
    // The backend is still running, so its slot is still taken.
    let retained = fixture
        .registry
        .call(
            "ace_echo",
            Value::Null,
            &owner,
            &Abort::new(),
            CallOptions::default(),
        )
        .await;
    assert_eq!(code(&retained), "calls_limit");
    gate.notify_waiters();
    settle().await;
    let recovered = fixture
        .registry
        .call(
            "ace_echo",
            Value::Null,
            &owner,
            &Abort::new(),
            CallOptions::default(),
        )
        .await;
    assert!(!recovered.is_error, "the slot never came back");
}

#[tokio::test]
async fn revocation_aborts_a_running_tool_and_a_late_success_never_arrives() {
    let fixture = Fixture::new(1024, 256);
    let gate = Arc::new(tokio::sync::Notify::new());
    let started = Arc::new(tokio::sync::Notify::new());
    let slow = {
        let gate = Arc::clone(&gate);
        let started = Arc::clone(&started);
        Arc::new(FnTool(move |input: Value, _context: ToolContext| {
            let gate = Arc::clone(&gate);
            let started = Arc::clone(&started);
            async move {
                started.notify_one();
                gate.notified().await;
                Ok(input)
            }
        })) as Arc<dyn ToolHandler>
    };
    fixture.register("ace_slow", 60_000, slow);
    let principal = fixture.principal("thread", &[], "root");
    let registry = Arc::clone(&fixture.registry);
    let call = tokio::spawn(async move {
        registry
            .call(
                "ace_slow",
                Value::Null,
                &principal,
                &Abort::new(),
                CallOptions::default(),
            )
            .await
    });
    started.notified().await;
    let principal = {
        let leases = fixture
            .leases
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        leases.first().expect("lease").principal.clone()
    };
    principal.lifetime.abort();
    let cancelled = call.await.expect("call");
    assert_eq!(code(&cancelled), "cancelled");
    gate.notify_waiters();
    settle().await;
}

#[tokio::test]
async fn the_hosts_hook_and_the_tool_share_one_deadline_from_the_start() {
    let ran = Arc::new(AtomicBool::new(false));
    let flag = Arc::clone(&ran);
    let actor: CallActor = Arc::new(|_tool, _capability, _caller, _acting| {
        Box::pin(async move {
            std::future::pending::<()>().await;
            Ok(None)
        })
    });
    let fixture = Fixture::with_hooks(Hooks {
        act_as: Some(actor),
        ..Hooks::default()
    });
    fixture
        .registry
        .register(ToolEntry::new(
            descriptor(
                "ace_echo",
                None,
                "Echo",
                "read-only",
                None,
                1_000,
                ace_json::parse("{\"type\":\"object\"}").expect("schema"),
                None,
            ),
            Arc::new(FnTool(move |input: Value, _context: ToolContext| {
                let flag = Arc::clone(&flag);
                async move {
                    flag.store(true, Ordering::SeqCst);
                    Ok(input)
                }
            })),
        ))
        .expect("registration");
    let principal = fixture.principal("thread", &[], "root");
    let registry = Arc::clone(&fixture.registry);
    let call = tokio::spawn(async move {
        registry
            .call(
                "ace_echo",
                Value::Null,
                &principal,
                &Abort::new(),
                CallOptions::default(),
            )
            .await
    });
    settle().await;
    fixture.scheduler.fire_all();
    let timed_out = call.await.expect("call");
    assert_eq!(code(&timed_out), "tool_timeout");
    assert!(
        !ran.load(Ordering::SeqCst),
        "the tool ran past the hook's deadline"
    );
}

#[tokio::test]
async fn a_stalled_observation_never_holds_the_reply_or_the_slot_past_the_deadline() {
    let observe: CallObserver = Arc::new(|_name, _input, _context| {
        Some(Box::new(|_result: &CallToolResult| {
            Box::pin(async {
                std::future::pending::<()>().await;
            })
        }))
    });
    let fixture = Fixture::with_hooks_and_limits(
        Hooks {
            observe_call: Some(observe),
            ..Hooks::default()
        },
        1,
        256,
    );
    let registry = Arc::clone(&fixture.registry);
    registry
        .register(ToolEntry::new(
            descriptor(
                "ace_echo",
                None,
                "Echo",
                "read-only",
                None,
                1_000,
                ace_json::parse("{\"type\":\"object\"}").expect("schema"),
                None,
            ),
            echo(),
        ))
        .expect("registration");
    let principal = fixture.principal("thread", &[], "root");
    let call = {
        let registry = Arc::clone(&registry);
        let principal = principal.clone();
        tokio::spawn(async move {
            registry
                .call(
                    "ace_echo",
                    Value::Null,
                    &principal,
                    &Abort::new(),
                    CallOptions::default(),
                )
                .await
        })
    };
    settle().await;
    fixture.scheduler.fire_all();
    let result = tokio::time::timeout(Duration::from_secs(1), call)
        .await
        .expect("the reply waited for the observation")
        .expect("call");
    assert!(
        !result.is_error,
        "the tool's success was replaced by its stall"
    );
    settle().await;
    // The same stalled record applies to the next call, so its own deadline ends it.
    let registry_for_call = Arc::clone(&registry);
    let principal_for_call = principal.clone();
    let recovered = tokio::spawn(async move {
        registry_for_call
            .call(
                "ace_echo",
                Value::Null,
                &principal_for_call,
                &Abort::new(),
                CallOptions::default(),
            )
            .await
    });
    settle().await;
    fixture.scheduler.fire_all();
    let recovered = tokio::time::timeout(Duration::from_secs(1), recovered)
        .await
        .expect("the slot was never released")
        .expect("call");
    assert!(!recovered.is_error, "a recovered call failed");
}

#[tokio::test]
async fn both_tool_boundaries_are_checked_and_a_backend_error_stays_private() {
    let fixture = Fixture::new(1024, 256);
    fixture
        .registry
        .register(
            ToolEntry::new(
                descriptor(
                    "ace_bad_output",
                    None,
                    "Bad output",
                    "read-only",
                    None,
                    1_000,
                    ace_json::parse("{\"type\":\"object\"}").expect("schema"),
                    Some(ace_json::parse("{\"type\":\"object\"}").expect("schema")),
                ),
                Arc::new(FnTool(|_input: Value, _context: ToolContext| async move {
                    Ok(ace_json::parse("{\"wrong\":true}").expect("json"))
                })),
            )
            .check_output(|value| {
                if value.get("value").is_some() {
                    Ok(())
                } else {
                    Err("value (invalid_type)".to_owned())
                }
            }),
        )
        .expect("registration");
    let report: FailureReporter = Arc::new(|_tool, _caller, _failure| Some("err-1".to_owned()));
    let fixture_with_report = Fixture::with_hooks(Hooks {
        report_failure: Some(report),
        ..Hooks::default()
    });
    fixture_with_report
        .registry
        .register(ToolEntry::new(
            descriptor(
                "ace_private",
                None,
                "Private",
                "read-only",
                None,
                1_000,
                ace_json::parse("{\"type\":\"object\"}").expect("schema"),
                None,
            ),
            Arc::new(FnTool(|_input: Value, _context: ToolContext| async move {
                Err(ToolFailure::Private("disk on fire".to_owned()))
            })),
        ))
        .expect("registration");
    let owner = fixture.principal("thread", &[], "root");
    let invalid = fixture
        .registry
        .call(
            "ace_bad_output",
            Value::Null,
            &owner,
            &Abort::new(),
            CallOptions::default(),
        )
        .await;
    assert_eq!(code(&invalid), "invalid_data");
    let owner = fixture_with_report.principal("thread", &[], "root");
    let private = fixture_with_report
        .registry
        .call(
            "ace_private",
            Value::Null,
            &owner,
            &Abort::new(),
            CallOptions::default(),
        )
        .await;
    assert_eq!(code(&private), "execution_failed");
    let text = &private.content[0].text;
    assert!(text.contains("\"errorId\":\"err-1\""), "{text}");
    assert!(!text.contains("disk on fire"), "the private cause leaked");
}

#[tokio::test]
async fn oversized_and_deep_results_are_refused_before_output_validation() {
    let fixture = Fixture::new(1024, 256);
    for (name, value) in [
        ("ace_huge", {
            let mut map = ace_json::Map::new();
            map.insert(
                "value",
                Value::from("x".repeat(MAX_STRUCTURED_RESULT_BYTES + 1)),
            );
            Value::Object(map)
        }),
        ("ace_deep", {
            let mut value = Value::Null;
            for _ in 0..70 {
                let mut map = ace_json::Map::new();
                map.insert("next", value);
                value = Value::Object(map);
            }
            value
        }),
    ] {
        let returned = value.clone();
        fixture
            .registry
            .register(ToolEntry::new(
                descriptor(
                    name,
                    None,
                    "Big",
                    "read-only",
                    None,
                    1_000,
                    ace_json::parse("{\"type\":\"object\"}").expect("schema"),
                    None,
                ),
                Arc::new(FnTool(move |_input: Value, _context: ToolContext| {
                    let returned = returned.clone();
                    async move { Ok(returned) }
                })),
            ))
            .expect("registration");
    }
    let owner = fixture.principal("thread", &[], "root");
    for name in ["ace_huge", "ace_deep"] {
        let result = fixture
            .registry
            .call(
                name,
                Value::Null,
                &owner,
                &Abort::new(),
                CallOptions::default(),
            )
            .await;
        assert_eq!(code(&result), "result_too_large", "{name}");
    }
}

#[tokio::test]
async fn input_past_a_tools_own_budget_is_a_public_limit_before_it_runs() {
    let fixture = Fixture::new(1024, 256);
    let ran = Arc::new(AtomicBool::new(false));
    let flag = Arc::clone(&ran);
    fixture
        .registry
        .register(
            ToolEntry::new(
                descriptor(
                    "ace_echo",
                    None,
                    "Echo",
                    "read-only",
                    None,
                    1_000,
                    ace_json::parse("{\"type\":\"object\"}").expect("schema"),
                    None,
                ),
                Arc::new(FnTool(move |input: Value, _context: ToolContext| {
                    let flag = Arc::clone(&flag);
                    async move {
                        flag.store(true, Ordering::SeqCst);
                        Ok(input)
                    }
                })),
            )
            .max_input_bytes(16),
        )
        .expect("registration");
    let owner = fixture.principal("thread", &[], "root");
    let large = ace_json::parse(&format!("{{\"value\":\"{}\"}}", "x".repeat(64))).expect("json");
    let result = fixture
        .registry
        .call(
            "ace_echo",
            large,
            &owner,
            &Abort::new(),
            CallOptions::default(),
        )
        .await;
    assert_eq!(code(&result), "limit");
    assert!(!ran.load(Ordering::SeqCst));
}

#[tokio::test]
async fn a_calls_acting_for_comes_from_the_client_and_never_the_arguments() {
    let fixture = Fixture::new(1024, 256);
    fixture
        .registry
        .register(ToolEntry::new(
            descriptor(
                "ace_whom",
                None,
                "Whom",
                "read-only",
                None,
                1_000,
                ace_json::parse("{\"type\":\"object\"}").expect("schema"),
                None,
            ),
            Arc::new(FnTool(|_input: Value, context: ToolContext| async move {
                let mut map = ace_json::Map::new();
                map.insert(
                    "actingFor",
                    Value::from(context.acting_for.as_deref().unwrap_or("nobody")),
                );
                Ok(Value::Object(map))
            })),
        ))
        .expect("registration");
    let owner = fixture.principal("thread", &[], "root");
    let named = fixture
        .registry
        .call(
            "ace_whom",
            ace_json::parse("{\"for\":\"fares\"}").expect("json"),
            &owner,
            &Abort::new(),
            CallOptions {
                acting_for: Some("fares".to_owned()),
                ..CallOptions::default()
            },
        )
        .await;
    assert_eq!(
        named
            .structured
            .as_ref()
            .and_then(|value| value.get("actingFor"))
            .and_then(Value::as_str),
        Some("fares")
    );
    let unnamed = fixture
        .registry
        .call(
            "ace_whom",
            ace_json::parse("{\"for\":\"fares\"}").expect("json"),
            &owner,
            &Abort::new(),
            CallOptions::default(),
        )
        .await;
    assert_eq!(
        unnamed
            .structured
            .as_ref()
            .and_then(|value| value.get("actingFor"))
            .and_then(Value::as_str),
        Some("nobody")
    );
}

#[test]
fn registration_refuses_bad_names_duplicates_capacity_and_bad_timeouts() {
    let fixture = Fixture::new(1024, 256);
    for bad in [
        descriptor("Thread_read", None, "x", "read-only", None, 1, json(), None),
        descriptor(
            "browser_open",
            None,
            "x",
            "read-only",
            None,
            1,
            json(),
            None,
        ),
        descriptor("ace_echo", None, "x", "read-only", None, 0, json(), None),
        descriptor(
            "ace_echo",
            None,
            "x",
            "read-only",
            None,
            MAX_TOOL_TIMEOUT_MS + 1,
            json(),
            None,
        ),
    ] {
        assert!(
            fixture
                .registry
                .register(ToolEntry::new(bad, echo()))
                .is_err()
        );
    }
    assert!(
        fixture
            .registry
            .register(ToolEntry::new(
                descriptor(
                    "ace_echo",
                    None,
                    "x",
                    "read-only",
                    None,
                    1_000,
                    json(),
                    None
                ),
                echo(),
            ))
            .is_ok()
    );
    // The same bare name in another spelling is the same tool.
    assert_eq!(
        fixture
            .registry
            .register(ToolEntry::new(
                descriptor(
                    "ace_ace_echo",
                    None,
                    "x",
                    "read-only",
                    None,
                    1_000,
                    json(),
                    None
                ),
                echo(),
            ))
            .unwrap_err(),
        RegistrationError::Name
    );
    let small = Arc::new(ToolRegistry::with_limits(
        Arc::new(ManualScheduler::default()) as Arc<dyn Scheduler>,
        1,
    ));
    assert!(
        small
            .register(ToolEntry::new(
                descriptor("ace_one", None, "x", "read-only", None, 1_000, json(), None),
                echo(),
            ))
            .is_ok()
    );
    assert_eq!(
        small
            .register(ToolEntry::new(
                descriptor("ace_two", None, "x", "read-only", None, 1_000, json(), None),
                echo(),
            ))
            .unwrap_err(),
        RegistrationError::Capacity
    );
}

fn json() -> Value {
    ace_json::parse("{\"type\":\"object\"}").expect("schema")
}

#[test]
fn a_descriptor_states_every_annotation_and_its_meta_in_order() {
    let mut tool = descriptor(
        "thread_merge",
        Some("Merge a fork back"),
        "Merge",
        "thread-write",
        Some("thread_control"),
        630_000,
        ace_json::parse("{\"type\":\"object\",\"properties\":{}}").expect("schema"),
        Some(ace_json::parse("{\"type\":\"object\"}").expect("schema")),
    );
    tool.toolset = Some("ace-threads".to_owned());
    let served = descriptor_json(&tool, true, None);
    let text = ace_json::to_string(&served);
    for expected in [
        "\"title\":\"Merge a fork back\"",
        "\"readOnlyHint\":false",
        "\"destructiveHint\":true",
        "\"idempotentHint\":false",
        "\"openWorldHint\":false",
        "\"ace/timeoutMs\":630000",
        "\"ace/riskClass\":\"thread-write\"",
    ] {
        assert!(text.contains(expected), "missing {expected} in {text}");
    }
    // A missing destructiveHint reads as true in MCP, so every tool states it.
    assert!(
        text.contains("\"destructiveHint\":false") || text.contains("\"destructiveHint\":true")
    );
    let read = descriptor_json(
        &descriptor(
            "context",
            None,
            "Context",
            "read-only",
            None,
            30_000,
            json(),
            None,
        ),
        false,
        None,
    );
    let text = ace_json::to_string(&read);
    assert!(text.contains("\"readOnlyHint\":true"));
    assert!(text.contains("\"anthropic/alwaysLoad\":true"));
    assert!(text.contains("\"antigravity/alwaysLoad\":true"));
}

#[test]
fn listing_filters_by_capability_and_availability() {
    let fixture = Fixture::new(1024, 256);
    fixture.register("ace_echo", 1_000, echo());
    fixture
        .registry
        .register(ToolEntry::new(
            descriptor(
                "browser_open",
                None,
                "Open",
                "external-effect",
                Some("browser"),
                1_000,
                json(),
                None,
            ),
            echo(),
        ))
        .expect("registration");
    let plain = fixture.principal("thread", &[], "root");
    assert_eq!(fixture.registry.list(&plain).len(), 1);
    let browser = fixture.principal("thread", &["browser"], "root");
    let names: Vec<String> = fixture
        .registry
        .list(&browser)
        .into_iter()
        .map(|tool| tool.name)
        .collect();
    assert_eq!(names, vec!["ace_echo", "browser_open"]);
    assert!(
        fixture
            .registry
            .input_schema("browser_open", &plain)
            .is_none()
    );
    assert!(
        fixture
            .registry
            .input_schema("browser_open", &browser)
            .is_some()
    );

    let hidden: Availability = Arc::new(|_caller, name, _capability| name != "ace_echo");
    let hidden_fixture = Fixture::with_hooks(Hooks {
        availability: Some(hidden),
        ..Hooks::default()
    });
    hidden_fixture.register("ace_echo", 1_000, echo());
    let owner = hidden_fixture.principal("thread", &[], "root");
    assert!(hidden_fixture.registry.list(&owner).is_empty());
}

#[test]
fn an_approval_target_reads_a_dispatched_call_as_the_tool_it_runs() {
    let fixture = Fixture::new(1024, 256);
    fixture
        .registry
        .register(ToolEntry::new(
            descriptor(
                "thread_read",
                Some("Read a thread"),
                "Read a thread",
                "read-only",
                None,
                1_000,
                ace_json::parse("{\"type\":\"object\"}").expect("schema"),
                None,
            ),
            echo(),
        ))
        .expect("registration");
    let dispatched =
        ace_json::parse("{\"name\":\"mcp__ace__thread_read\",\"arguments\":{\"threadId\":\"t\"}}")
            .expect("json");
    let target = fixture
        .registry
        .action("tools_call", &dispatched)
        .expect("an approval target");
    assert_eq!(
        target.get("tool").and_then(Value::as_str),
        Some("thread_read")
    );
    assert_eq!(
        target.get("riskClass").and_then(Value::as_str),
        Some("read-only")
    );
    assert_eq!(
        target
            .get("input")
            .and_then(|input| input.get("threadId"))
            .and_then(Value::as_str),
        Some("t")
    );
    assert!(fixture.registry.action("missing", &Value::Null).is_none());
}

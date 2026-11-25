// SPDX-License-Identifier: Apache-2.0
//! The pool's cases. `shared-host.process.test.ts` moved here: sessions on one
//! account share one app-server and see only their own threads, closing one
//! leaves its neighbours working, a child that speaks before its parent
//! reveals it reaches only the parent, a turn-routed request finds its turn's
//! owner, a crash ends every session and the next open starts a new process,
//! and an oversized generated image is elided before it reaches a channel.
//!
//! The host pool's own table (`HostPool`) is here too: one start per key, a
//! live key reused, an idle or crashed key started again.

use std::sync::Arc;
use std::time::{Duration, Instant};

use ace_json::Value;

use super::*;
use crate::session::harness::{Event, HostRun, Scratch, WAIT_MS};
use crate::session::host::Retirement;

fn started(name: &str) -> HostRun {
    HostRun::start(
        Scratch::new(name),
        shared_config(DEFAULT_HOST_IDLE_MS),
        CODEX_ELISION,
        None,
    )
}

fn request(run: &HostRun, tenant: u64, method: &str, params: Value) -> u64 {
    run.request(tenant, method, &params)
}

/// The thread the last open reply named, once it arrives.
fn opened(run: &HostRun, tenant: u64) -> Option<String> {
    let deadline = Instant::now() + Duration::from_millis(WAIT_MS);
    while Instant::now() < deadline {
        let thread = run.frames(tenant).into_iter().rev().find_map(|data| {
            data.get("result")?
                .get("thread")?
                .get("id")?
                .as_str()
                .map(str::to_owned)
        });
        if thread.is_some() {
            return thread;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    None
}

fn completed(run: &HostRun, tenant: u64, thread: &str) -> bool {
    run.events.until(WAIT_MS, |event| match event {
        Event::Frame {
            tenant: who, data, ..
        } if *who == tenant => {
            data.get("method").and_then(Value::as_str) == Some("turn/completed")
                && data
                    .get("params")
                    .and_then(|params| params.get("threadId"))
                    .and_then(Value::as_str)
                    == Some(thread)
        }
        _ => false,
    })
}

/// Every thread a channel's received frames name.
fn threads(run: &HostRun, tenant: u64) -> Vec<String> {
    let mut named: Vec<String> = run
        .frames(tenant)
        .into_iter()
        .filter_map(|data| {
            data.get("params")?
                .get("threadId")?
                .as_str()
                .map(str::to_owned)
        })
        .collect();
    named.sort();
    named.dedup();
    named
}

/// The app-server's pid, from the initialize reply every channel is replayed.
fn pid(run: &HostRun, tenant: u64) -> Option<f64> {
    run.frames(tenant)
        .into_iter()
        .find_map(|data| data.get("result")?.get("pid").and_then(Value::as_f64))
}

#[test]
fn a_live_host_is_reused_and_a_finished_one_is_started_again() {
    let mut pool = HostPool::new(None).expect("the default idle time is valid");
    assert_eq!(pool.idle_ms(), DEFAULT_HOST_IDLE_MS);
    assert_eq!(pool.open_channel("key"), Channel::Start);
    assert!(pool.claim("key"));
    assert!(!pool.claim("key"), "one start per key");
    assert_eq!(pool.open_channel("key"), Channel::Waiting);

    let run = started("pool-reuse");
    pool.started("key", Arc::clone(&run.host));
    assert_eq!(pool.open_channel("key"), Channel::Reuse);

    // The host retired itself: the key is free for the next open.
    run.apply(run.host.retire(Retirement::Shutdown));
    pool.released("key", &run.host);
    assert_eq!(pool.open_channel("key"), Channel::Start);

    // A start that failed frees the key without a host.
    assert!(pool.claim("key"));
    pool.start_failed("key");
    assert_eq!(pool.open_channel("key"), Channel::Start);
    run.stop();
}

#[test]
fn an_idle_time_the_pool_refuses_is_the_typescript_error() {
    for idle in [-1.0, 1.5, f64::NAN, f64::INFINITY] {
        assert_eq!(
            HostPool::new(Some(idle)).err(),
            Some(PoolError::InvalidIdle),
            "idle {idle}"
        );
    }
    assert!(HostPool::new(Some(0.0)).is_ok());
}

#[test]
fn a_spawn_key_is_the_executable_arguments_and_environment_without_the_bearer() {
    let empty: Vec<String> = Vec::new();
    let env = vec![
        ("B".to_owned(), "2".to_owned()),
        ("ACE_MCP_BEARER_TOKEN".to_owned(), "secret".to_owned()),
        ("A".to_owned(), "1".to_owned()),
    ];
    assert_eq!(
        spawn_key(&SpawnIdentity {
            executable: Some("/usr/bin/codex"),
            builtin_skills_args: &empty,
            tool_config_args: &empty,
            env: &env,
        }),
        r#"["/usr/bin/codex",[],[],[["A","1"],["B","2"]]]"#
    );
    assert_eq!(
        spawn_key(&SpawnIdentity {
            executable: None,
            builtin_skills_args: &empty,
            tool_config_args: &empty,
            env: &[],
        }),
        r#"[null,[],[],[]]"#
    );
}

/// `shared-host.process.test.ts`: "threads on one account share an app-server
/// and see only their own events".
#[test]
fn threads_on_one_account_share_an_app_server_and_see_only_their_own_events() {
    let run = started("shared");
    let a = run.attach(1);
    let b = run.attach(2);
    let _ = (a, b);
    assert!(run.wait_ready(1) && run.wait_ready(2));

    let _ = request(&run, 1, "thread/start", ace_json::json!({"cwd": "/tmp/a"}));
    let thread_a = opened(&run, 1).expect("a opens its thread");
    let _ = request(&run, 2, "thread/start", ace_json::json!({"cwd": "/tmp/b"}));
    let thread_b = opened(&run, 2).expect("b opens its thread");
    assert_ne!(thread_a, thread_b);

    request(
        &run,
        1,
        "turn/start",
        ace_json::json!({"threadId": thread_a, "input": [{"type": "text", "text": "from a"}]}),
    );
    request(
        &run,
        2,
        "turn/start",
        ace_json::json!({"threadId": thread_b, "input": [{"type": "text", "text": "from b"}]}),
    );
    assert!(completed(&run, 1, &thread_a));
    assert!(completed(&run, 2, &thread_b));

    assert_eq!(threads(&run, 1), vec![thread_a]);
    assert_eq!(threads(&run, 2), vec![thread_b]);
    assert_eq!(pid(&run, 1), pid(&run, 2), "one process serves both");
}

/// `shared-host.process.test.ts`: "closing one idle thread leaves its
/// neighbour working on the same process".
#[test]
fn closing_one_idle_thread_leaves_its_neighbour_working_on_the_same_process() {
    let run = started("neighbour");
    let _ = run.attach(1);
    let _ = run.attach(2);
    assert!(run.wait_ready(1) && run.wait_ready(2));

    let _ = request(&run, 1, "thread/start", ace_json::json!({"cwd": "/tmp/a"}));
    let thread_a = opened(&run, 1).expect("a opens its thread");
    let _ = request(&run, 2, "thread/start", ace_json::json!({"cwd": "/tmp/b"}));
    let thread_b = opened(&run, 2).expect("b opens its thread");

    run.apply(run.host.detach(1, Retirement::Idle, "idle"));
    assert!(
        run.events.until(WAIT_MS, |event| matches!(
            event,
            Event::Exited { tenant: 1, .. }
        )),
        "closing a thread reports its exit"
    );

    request(
        &run,
        2,
        "turn/start",
        ace_json::json!({"threadId": thread_b, "input": [{"type": "text", "text": "still here"}]}),
    );
    assert!(completed(&run, 2, &thread_b), "the neighbour keeps working");

    // A later session joins the same process, so a closed thread's channel
    // never took the app-server with it.
    let _ = run.attach(3);
    assert!(run.wait_ready(3));
    assert_eq!(pid(&run, 3), pid(&run, 1), "the same process still serves");
    let _ = thread_a;
}

/// `shared-host.process.test.ts`: "a child that speaks before its parent
/// reveals it reaches only the parent's session".
#[test]
fn a_child_that_speaks_before_its_parent_reveals_it_reaches_only_the_parent() {
    let run = started("child");
    let _ = run.attach(1);
    let _ = run.attach(2);
    assert!(run.wait_ready(1) && run.wait_ready(2));

    let _ = request(&run, 1, "thread/start", ace_json::json!({"cwd": "/tmp/a"}));
    let thread = opened(&run, 1).expect("a opens its thread");
    let child = format!("{thread}-child");
    request(
        &run,
        1,
        "turn/start",
        ace_json::json!({
            "threadId": thread,
            "input": [{"type": "text", "text": "spawn-child"}],
        }),
    );

    assert!(completed(&run, 1, &child), "the child's turn reaches a");
    assert!(completed(&run, 1, &thread));
    assert!(threads(&run, 1).contains(&child));
    assert!(!threads(&run, 2).contains(&child), "b never sees it");
}

/// `shared-host.process.test.ts`: "a request that names only its turn reaches
/// the session that owns the turn".
#[test]
fn a_request_that_names_only_its_turn_reaches_the_sessions_owner() {
    let run = started("turn-request");
    let _ = run.attach(1);
    let _ = run.attach(2);
    assert!(run.wait_ready(1) && run.wait_ready(2));

    let _ = request(&run, 2, "thread/start", ace_json::json!({"cwd": "/tmp/b"}));
    let thread = opened(&run, 2).expect("b opens its thread");
    request(
        &run,
        2,
        "turn/start",
        ace_json::json!({
            "threadId": thread,
            "input": [{"type": "text", "text": "ask-by-turn"}],
        }),
    );

    assert!(
        run.events.until(WAIT_MS, |event| matches!(
            event,
            Event::Request { tenant: 2, method, .. }
                if method.as_str() == "mcpServer/elicitation/request"
        )),
        "the turn's owner answers it"
    );
    assert!(
        !run.events
            .snapshot()
            .iter()
            .any(|event| matches!(event, Event::Request { tenant: 1, .. })),
        "no other session hears the request"
    );
}

/// `shared-host.process.test.ts`: "a crashed app-server ends every session on
/// it and the next open starts a new one".
#[test]
fn a_crashed_app_server_ends_every_session_and_the_next_open_starts_a_new_one() {
    let mut pool = HostPool::new(None).expect("the default idle time");
    let run = started("crash");
    pool.started("key", Arc::clone(&run.host));
    let _ = run.attach(1);
    let _ = run.attach(2);
    assert!(run.wait_ready(1) && run.wait_ready(2));

    let _ = request(&run, 1, "thread/start", ace_json::json!({"cwd": "/tmp/a"}));
    let thread = opened(&run, 1).expect("a opens its thread");
    let before = pid(&run, 1);
    request(
        &run,
        1,
        "turn/start",
        ace_json::json!({"threadId": thread, "input": [{"type": "text", "text": "crash"}]}),
    );

    assert!(run.wait_exit(1) && run.wait_exit(2), "every session ends");
    for tenant in [1, 2] {
        assert!(run.events.until(WAIT_MS, |event| matches!(
            event,
            Event::Exited {
                tenant: who,
                exit: crate::session::host::HostExit { code: Some(3), .. },
            } if *who == tenant
        )));
    }

    // The pool drops the dead host and the next open starts a fresh process.
    pool.released("key", &run.host);
    assert_eq!(pool.open_channel("key"), Channel::Start);

    let next = started("crash-next");
    assert!(
        next.wait_ready(1) || {
            let _ = next.attach(1);
            next.wait_ready(1)
        }
    );
    assert_ne!(pid(&next, 1), before, "a new app-server, not the dead one");
    run.stop();
    next.stop();
}

/// `shared-host.process.test.ts`: "a thread whose generated images outgrow the
/// line limit resumes beside a working neighbour". The pool's elision limits
/// replace the base64 before the line limit counts it.
#[test]
fn a_thread_with_generated_images_resumes_beside_a_working_neighbour() {
    let run = started("images");
    let _ = run.attach(1);
    assert!(run.wait_ready(1));
    let _ = request(&run, 1, "thread/start", ace_json::json!({"cwd": "/tmp/a"}));
    let neighbour = opened(&run, 1).expect("a opens its thread");

    let _ = run.attach(2);
    assert!(run.wait_ready(2));
    let _ = request(
        &run,
        2,
        "thread/resume",
        ace_json::json!({"threadId": "images-thread"}),
    );
    assert_eq!(
        opened(&run, 2).as_deref(),
        Some("images-thread"),
        "the images thread resumes"
    );

    let items: Vec<Value> = run
        .frames(2)
        .into_iter()
        .filter_map(|data| {
            data.get("result")?
                .get("thread")?
                .get("turns")?
                .clone()
                .into()
        })
        .flat_map(|turns| match turns {
            Value::Array(turns) => turns.into_vec(),
            _ => Vec::new(),
        })
        .filter_map(|turn| turn.get("items").cloned())
        .flat_map(|items| match items {
            Value::Array(items) => items.into_vec(),
            _ => Vec::new(),
        })
        .collect();
    assert_eq!(items.len(), 6, "six generated images");
    for (index, item) in items.iter().enumerate() {
        assert_eq!(
            item.get("savedPath").and_then(Value::as_str),
            Some(format!("/generated/image-{index}.png").as_str())
        );
        let result = item
            .get("result")
            .and_then(Value::as_str)
            .expect("the base64 became a placeholder");
        assert!(
            result.starts_with("[ace: ") && result.ends_with("bytes of base64 data elided]"),
            "{result}"
        );
    }

    // Both channels still work on one process.
    request(
        &run,
        1,
        "turn/start",
        ace_json::json!({"threadId": neighbour, "input": [{"type": "text", "text": "hi"}]}),
    );
    assert!(completed(&run, 1, &neighbour));
    request(
        &run,
        2,
        "turn/start",
        ace_json::json!({"threadId": "images-thread", "input": [{"type": "text", "text": "again"}]}),
    );
    assert!(completed(&run, 2, "images-thread"));
}

/// `host-pool.ts:53`: the retirement callback removes the host it was made
/// for, never a replacement already installed under the same key.
#[test]
fn a_late_retirement_callback_never_evicts_a_replacement_host() {
    let mut pool = HostPool::new(None).expect("the default idle time");
    let (old, _) = Host::new(shared_config(60_000.0));
    let old = Arc::new(old);
    let (replacement, _) = Host::new(shared_config(60_000.0));
    let replacement = Arc::new(replacement);

    assert!(pool.claim("key"));
    pool.started("key", Arc::clone(&old));
    pool.released("key", &old);
    assert_eq!(pool.open_channel("key"), Channel::Start);

    assert!(pool.claim("key"));
    pool.started("key", Arc::clone(&replacement));
    // The old host's delayed callback arrives after the replacement is in.
    pool.released("key", &old);
    assert_eq!(
        pool.open_channel("key"),
        Channel::Reuse,
        "a stale callback leaves the replacement alone"
    );
    pool.released("key", &replacement);
    assert_eq!(pool.open_channel("key"), Channel::Start);
}

/// Whether a `turn/interrupt` for `thread` went out on the wire.
fn interrupted_sent(run: &HostRun, thread: &str) -> bool {
    run.events.snapshot().iter().any(|event| match event {
        Event::Line { text } => {
            text.contains("\"method\":\"turn/interrupt\"")
                && text.contains(&format!("\"threadId\":\"{thread}\""))
        }
        _ => false,
    })
}

/// `shared-host.process.test.ts`: "stopping a busy thread interrupts its own
/// turn and not its neighbour's". The close itself sends the interrupt.
#[test]
fn stopping_a_busy_thread_interrupts_its_turn_and_not_its_neighbours() {
    let run = started("busy-stop");
    let _ = run.attach(1);
    let _ = run.attach(2);
    assert!(run.wait_ready(1) && run.wait_ready(2));

    let _ = request(&run, 1, "thread/start", ace_json::json!({"cwd": "/tmp/a"}));
    let thread_a = opened(&run, 1).expect("a opens its thread");
    let _ = request(&run, 2, "thread/start", ace_json::json!({"cwd": "/tmp/b"}));
    let thread_b = opened(&run, 2).expect("b opens its thread");
    for (tenant, thread) in [(1u64, thread_a.as_str()), (2, thread_b.as_str())] {
        request(
            &run,
            tenant,
            "turn/start",
            ace_json::json!({
                "threadId": thread,
                "input": [{"type": "text", "text": "hold"}],
            }),
        );
    }
    assert!(run.events.until(WAIT_MS, |event| matches!(
        event,
        Event::Frame { tenant: 1, data, .. }
            if data.get("method").and_then(Value::as_str) == Some("item/completed")
    )));
    assert!(run.events.until(WAIT_MS, |event| matches!(
        event,
        Event::Frame { tenant: 2, data, .. }
            if data.get("method").and_then(Value::as_str) == Some("item/completed")
    )));

    // A's close interrupts A's turn, and its completion is A's alone.
    run.apply(run.host.detach(1, Retirement::User, "user closed"));
    assert!(
        interrupted_sent(&run, &thread_a),
        "the close itself sends the interrupt"
    );
    assert!(interrupted(&run, 1, &thread_a));
    assert!(
        !interrupted(&run, 2, &thread_b),
        "b's turn is untouched by a's stop"
    );
    assert!(run.events.until(WAIT_MS, |event| matches!(
        event,
        Event::Exited { tenant: 1, .. }
    )));

    // B's own stop interrupts its own turn.
    run.apply(run.host.detach(2, Retirement::User, "user closed"));
    assert!(interrupted_sent(&run, &thread_b));
    assert!(interrupted(&run, 2, &thread_b));
}

/// `shared-host.process.test.ts`: "cancelling a busy thread's session
/// interrupts its tree and keeps its neighbour's process". The cancellation's
/// close sends the interrupt too.
#[test]
fn cancelling_a_busy_threads_session_keeps_its_neighbours_process() {
    let run = started("busy-cancel");
    let _ = run.attach(1);
    let _ = run.attach(2);
    assert!(run.wait_ready(1) && run.wait_ready(2));

    let _ = request(&run, 1, "thread/start", ace_json::json!({"cwd": "/tmp/a"}));
    let thread_a = opened(&run, 1).expect("a opens its thread");
    let _ = request(&run, 2, "thread/start", ace_json::json!({"cwd": "/tmp/b"}));
    let thread_b = opened(&run, 2).expect("b opens its thread");
    request(
        &run,
        1,
        "turn/start",
        ace_json::json!({
            "threadId": thread_a,
            "input": [{"type": "text", "text": "hold"}],
        }),
    );
    let before = pid(&run, 1);
    assert!(run.events.until(WAIT_MS, |event| matches!(
        event,
        Event::Frame { tenant: 1, data, .. }
            if data.get("method").and_then(Value::as_str) == Some("item/completed")
    )));

    // The cancellation closes the session, which interrupts its turn first.
    run.apply(run.host.detach(1, Retirement::Aborted, "Thread deleted"));
    assert!(
        interrupted_sent(&run, &thread_a),
        "the cancellation interrupts the turn"
    );
    assert!(interrupted(&run, 1, &thread_a));
    assert!(run.events.until(WAIT_MS, |event| matches!(
        event,
        Event::Exited { tenant: 1, .. }
    )));

    // The neighbour still works, on the same process.
    request(
        &run,
        2,
        "turn/start",
        ace_json::json!({
            "threadId": thread_b,
            "input": [{"type": "text", "text": "still running"}],
        }),
    );
    assert!(completed(&run, 2, &thread_b));
    let _ = run.attach(3);
    assert!(run.wait_ready(3));
    assert_eq!(
        pid(&run, 3),
        before,
        "the cancelled session kept the process"
    );
}

/// Whether one channel saw `thread`'s turn completed as interrupted.
fn interrupted(run: &HostRun, tenant: u64, thread: &str) -> bool {
    run.events.until(WAIT_MS, |event| match event {
        Event::Frame {
            tenant: who, data, ..
        } if *who == tenant => {
            data.get("method").and_then(Value::as_str) == Some("turn/completed")
                && data
                    .get("params")
                    .and_then(|params| params.get("threadId"))
                    .and_then(Value::as_str)
                    == Some(thread)
                && data
                    .get("params")
                    .and_then(|params| params.get("turn"))
                    .and_then(|turn| turn.get("status"))
                    .and_then(Value::as_str)
                    == Some("interrupted")
        }
        _ => false,
    })
}

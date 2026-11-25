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
    pool.released("key");
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
    pool.released("key");
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

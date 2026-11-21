//! A real `spade-wasm`, started as Spade starts it (inside the bot's sandbox where this machine
//! holds one offline), running a real component: its answers, its bounds, Stop, and a worker
//! that dies with a call open (ADR 0203 §4).

mod fixture;

use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

use spade_core::package::code::Bounds;
use spade_sandbox::Runner;
use spade_wasm::launch::{self, Place};
use spade_wasm::{BotCode, Cut, Event, HostRequest, HostValue, Outcome, Target};

const PROGRAM: &str = env!("CARGO_BIN_EXE_spade-wasm");

/// A call's bounds: `deadline_ms` of running, the default fuel and 128 MiB.
fn bounds(deadline_ms: u64) -> Bounds {
    Bounds {
        deadline_ms,
        fuel: 10_000_000_000,
        memory_bytes: 128 * 1024 * 1024,
    }
}

fn tool(name: &str) -> Target {
    Target::Tool {
        name: name.to_owned(),
    }
}

/// One bot's code in `dir`, with the fixture component added; its id.
async fn bot(dir: &Path) -> (BotCode, String) {
    let place = Place {
        program: Path::new(PROGRAM).to_path_buf(),
        args: Vec::new(),
        folder: dir.join("data/code/bot1"),
        home: dir.join("home"),
        spade_data: dir.join("data"),
        ace_data: None,
    };
    std::fs::create_dir_all(&place.folder).unwrap_or_else(|e| panic!("{e}"));
    let runner = Runner::probe(Some(place.program.clone()));
    // On a Mac the sandbox always holds it; elsewhere it runs sandboxed when the kernel allows.
    if cfg!(target_os = "macos") {
        assert!(runner.holds_offline(), "{:?}", runner.status());
    }
    let folder = place.folder.clone();
    let code = BotCode::new(
        &folder,
        Box::new(move || {
            if runner.holds_offline() {
                launch::command(&runner, &place)
            } else {
                Ok(tokio::process::Command::new(&place.program))
            }
        }),
    );
    code.worker().await.unwrap_or_else(|e| panic!("{e}"));
    let component = code
        .add(&fixture::component())
        .await
        .unwrap_or_else(|e| panic!("{e}"));
    (code, component)
}

async fn run(
    code: &BotCode,
    component: &str,
    target: Target,
    input: &str,
    bounds: Bounds,
) -> Outcome {
    code.call(component, target, input, bounds)
        .await
        .unwrap_or_else(|e| panic!("{e}"))
        .finish(|call| async move { Err(format!("no host in this test: {call:?}")) })
        .await
}

fn cut_and_message(outcome: &Outcome) -> (Cut, String) {
    match outcome {
        Outcome::Failed { cut, message, .. } => (*cut, message.clone()),
        Outcome::Done { output, .. } => panic!("it answered {output:?}"),
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_components_tool_answers_from_the_sandboxed_worker() {
    let dir = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
    let (code, component) = bot(dir.path()).await;
    let outcome = run(
        &code,
        &component,
        tool("echo"),
        r#"{"to":"LHR"}"#,
        bounds(30_000),
    )
    .await;
    let Outcome::Done { output, stats, .. } = outcome else {
        panic!("{outcome:?}");
    };
    assert_eq!(output, Ok(r#"{"to":"LHR"}"#.to_owned()));
    assert!(stats.fuel > 0, "{stats:?}");
    assert!(stats.peak_memory >= 64 * 1024, "{stats:?}");
    let listed = run(&code, &component, Target::Tools, "", bounds(30_000)).await;
    assert!(
        matches!(&listed, Outcome::Done { output: Ok(json), .. } if json == fixture::TOOLS_JSON),
        "{listed:?}"
    );
    // A tool's own failure is an answer, not a cut.
    let failed = run(
        &code,
        &component,
        tool("fail"),
        "no fares that day",
        bounds(30_000),
    )
    .await;
    assert!(
        matches!(&failed, Outcome::Done { output: Err(why), .. } if why == "no fares that day"),
        "{failed:?}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn an_endless_loop_ends_at_its_deadline_and_says_so() {
    let dir = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
    let (code, component) = bot(dir.path()).await;
    let started = Instant::now();
    let outcome = run(&code, &component, tool("spin"), "", bounds(300)).await;
    let (cut, message) = cut_and_message(&outcome);
    assert_eq!(cut, Cut::Deadline);
    assert_eq!(message, "it ran longer than 1 s");
    assert!(
        started.elapsed() < Duration::from_secs(3),
        "{:?}",
        started.elapsed()
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn an_endless_loop_with_little_fuel_runs_out_of_it() {
    let dir = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
    let (code, component) = bot(dir.path()).await;
    let little = Bounds {
        fuel: 5_000_000,
        ..bounds(60_000)
    };
    let outcome = run(&code, &component, tool("spin"), "", little).await;
    assert_eq!(cut_and_message(&outcome).0, Cut::Fuel);
}

#[tokio::test(flavor = "multi_thread")]
async fn growing_memory_past_its_bound_traps_and_the_worker_serves_on() {
    let dir = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
    let (code, component) = bot(dir.path()).await;
    let small = Bounds {
        memory_bytes: 4 * 1024 * 1024,
        ..bounds(30_000)
    };
    let outcome = run(&code, &component, tool("grow"), "", small).await;
    let (cut, message) = cut_and_message(&outcome);
    assert_eq!(cut, Cut::Memory);
    assert_eq!(message, "it grew its memory past 4 MiB");
    let next = run(
        &code,
        &component,
        tool("echo"),
        "still here",
        bounds(30_000),
    )
    .await;
    assert!(
        matches!(next, Outcome::Done { output: Ok(_), .. }),
        "{next:?}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn stop_ends_a_running_call_within_a_second_and_it_reads_stopped() {
    let dir = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
    let (code, component) = bot(dir.path()).await;
    let code = Arc::new(code);
    let running = code
        .call(&component, tool("spin"), "", bounds(120_000))
        .await
        .unwrap_or_else(|e| panic!("{e}"));
    let pid = running.worker().pid();
    let call = tokio::spawn(running.finish(|_| async { Err("no host".to_owned()) }));
    tokio::time::sleep(Duration::from_millis(300)).await;
    let stopped = Instant::now();
    code.stop().await;
    let outcome = tokio::time::timeout(Duration::from_secs(1), call)
        .await
        .unwrap_or_else(|_| panic!("the call ran on past a second after Stop"))
        .unwrap_or_else(|e| panic!("{e}"));
    assert!(stopped.elapsed() < Duration::from_secs(1));
    assert_eq!(
        cut_and_message(&outcome),
        (Cut::Stopped, "it was stopped".to_owned())
    );
    // The epoch ended it, so the worker lives on for the next call.
    let next = run(&code, &component, tool("echo"), "next", bounds(30_000)).await;
    assert!(
        matches!(next, Outcome::Done { output: Ok(_), .. }),
        "{next:?}"
    );
    assert_eq!(code.worker().await.ok().and_then(|w| w.pid()), pid);
}

#[tokio::test(flavor = "multi_thread")]
async fn waiting_on_spade_isnt_counted_against_the_deadline() {
    let dir = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
    let (code, component) = bot(dir.path()).await;
    let asked = Arc::new(std::sync::Mutex::new(Vec::new()));
    let seen = Arc::clone(&asked);
    let outcome = code
        .call(&component, tool("ask"), "fares_lookup", bounds(300))
        .await
        .unwrap_or_else(|e| panic!("{e}"))
        .finish(move |call| {
            let seen = Arc::clone(&seen);
            async move {
                if let Ok(mut seen) = seen.lock() {
                    seen.push(call);
                }
                // A slow tool: three times the call's deadline.
                tokio::time::sleep(Duration::from_millis(900)).await;
                Ok(HostValue::Json {
                    json: r#"{"cheapest":212}"#.to_owned(),
                })
            }
        })
        .await;
    let Outcome::Done { output, stats, .. } = &outcome else {
        panic!("{outcome:?}");
    };
    assert_eq!(output, &Ok(r#"{"cheapest":212}"#.to_owned()));
    assert!(stats.run_ms < 300, "{stats:?}");
    assert_eq!(
        *asked.lock().unwrap_or_else(|e| e.into_inner()),
        vec![HostRequest::Tools {
            name: "fares_lookup".to_owned(),
            input: "fares_lookup".to_owned()
        }]
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn stop_ends_a_call_waiting_on_spade() {
    let dir = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
    let (code, component) = bot(dir.path()).await;
    let mut running = code
        .call(&component, tool("ask"), "never_answered", bounds(30_000))
        .await
        .unwrap_or_else(|e| panic!("{e}"));
    // The component asks Spade, and Spade never answers.
    assert!(matches!(running.next().await, Event::Host { .. }));
    let stopped = Instant::now();
    code.stop().await;
    let end = tokio::time::timeout(Duration::from_secs(1), running.next())
        .await
        .unwrap_or_else(|_| panic!("the call ran on past a second after Stop"));
    let Event::End(outcome) = end else {
        panic!("{end:?}");
    };
    assert_eq!(outcome.cut(), Some(Cut::Stopped), "{outcome:?}");
    assert!(stopped.elapsed() < Duration::from_secs(1));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_killed_worker_reports_its_call_lost_never_done_and_the_next_call_starts_afresh() {
    let dir = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
    let (code, component) = bot(dir.path()).await;
    let running = code
        .call(&component, tool("spin"), "", bounds(120_000))
        .await
        .unwrap_or_else(|e| panic!("{e}"));
    let pid = running.worker().pid().unwrap_or_else(|| panic!("no pid"));
    let call = tokio::spawn(running.finish(|_| async { Err("no host".to_owned()) }));
    tokio::time::sleep(Duration::from_millis(300)).await;
    let killed = std::process::Command::new("kill")
        .args(["-9", &pid.to_string()])
        .status()
        .unwrap_or_else(|e| panic!("{e}"));
    assert!(killed.success());
    let outcome = tokio::time::timeout(Duration::from_secs(5), call)
        .await
        .unwrap_or_else(|_| panic!("the call never ended"))
        .unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(outcome.cut(), Some(Cut::Lost), "{outcome:?}");
    let next = run(&code, &component, tool("echo"), "afresh", bounds(30_000)).await;
    assert!(
        matches!(&next, Outcome::Done { output: Ok(text), .. } if text == "afresh"),
        "{next:?}"
    );
    let fresh = code.worker().await.ok().and_then(|w| w.pid());
    assert!(fresh.is_some() && fresh != Some(pid), "{fresh:?}");
}

#[tokio::test(flavor = "multi_thread")]
async fn the_worker_refuses_to_compile_a_component_outside_spades_world() {
    let dir = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
    let (code, _) = bot(dir.path()).await;
    let reaching = wat::parse_str(
        r#"(component
            (import "wasi:filesystem/types@0.2.0" (instance))
            (instance $box)
            (export "spade:package/toolbox@1.0.0" (instance $box)))"#,
    )
    .unwrap_or_else(|e| panic!("{e}"));
    let refused = code.add(&reaching).await;
    assert!(
        refused
            .as_ref()
            .is_err_and(|why| why.contains("no file system or sockets")),
        "{refused:?}"
    );
}

/// Runs to its end, or panics after `within`: a call that can't end would hang the test.
async fn ends_within(running: spade_wasm::Running, answer: HostValue, within: Duration) -> Outcome {
    let answer = Arc::new(answer);
    tokio::time::timeout(
        within,
        running.finish(move |_| {
            let answer = Arc::clone(&answer);
            async move { Ok((*answer).clone()) }
        }),
    )
    .await
    .unwrap_or_else(|_| panic!("the call never ended"))
}

#[tokio::test(flavor = "multi_thread")]
async fn an_answer_too_large_for_the_pipe_reads_failed_and_never_hangs() {
    let dir = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
    let (code, component) = bot(dir.path()).await;
    let running = code
        .call(&component, tool("big"), "", bounds(10_000))
        .await
        .unwrap_or_else(|e| panic!("{e}"));
    let none = HostValue::Done;
    let outcome = ends_within(running, none, Duration::from_secs(30)).await;
    let Outcome::Failed { cut, message, .. } = &outcome else {
        panic!("{outcome:?}");
    };
    assert_eq!(*cut, Cut::Trap);
    assert!(message.contains("16 MiB"), "{message}");
    // The worker serves on.
    let echoed = run(&code, &component, tool("echo"), "hi", bounds(5_000)).await;
    assert!(matches!(echoed, Outcome::Done { .. }), "{echoed:?}");
}

#[tokio::test(flavor = "multi_thread")]
async fn spades_answer_too_large_for_the_pipe_reaches_the_component_as_a_failure() {
    let dir = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
    let (code, component) = bot(dir.path()).await;
    let running = code
        .call(&component, tool("ask"), "fares_lookup", bounds(10_000))
        .await
        .unwrap_or_else(|e| panic!("{e}"));
    let huge = HostValue::Json {
        json: "a".repeat(17 * 1024 * 1024),
    };
    let outcome = ends_within(running, huge, Duration::from_secs(30)).await;
    let Outcome::Done { output, .. } = &outcome else {
        panic!("{outcome:?}");
    };
    assert!(
        output.as_ref().is_err_and(|why| why.contains("16 MiB")),
        "{output:?}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn memory_is_bounded_across_all_of_a_calls_memories() {
    let dir = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
    let (code, _) = bot(dir.path()).await;
    let two = code
        .add(&fixture::two_memories())
        .await
        .unwrap_or_else(|e| panic!("{e}"));
    let outcome = run(&code, &two, tool("grow"), "", bounds(10_000)).await;
    let Outcome::Failed { cut, stats, .. } = &outcome else {
        panic!("{outcome:?}");
    };
    assert_eq!(*cut, Cut::Memory);
    // The peak is both memories' together, never past the bound.
    assert!(stats.peak_memory > 64 * 1024 * 1024, "{stats:?}");
    assert!(stats.peak_memory <= 128 * 1024 * 1024, "{stats:?}");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_worker_started_outside_spades_sandbox_compiles_nothing() {
    let dir = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
    let folder = dir.path().join("code");
    std::fs::create_dir_all(&folder).unwrap_or_else(|e| panic!("{e}"));
    // As anyone could start it by hand: no sandbox, the network reachable.
    let worker = spade_wasm::Worker::start(tokio::process::Command::new(PROGRAM))
        .await
        .unwrap_or_else(|e| panic!("{e}"));
    let bytes = fixture::component();
    let sha: String =
        sha2::Digest::finalize(<sha2::Sha256 as sha2::Digest>::new_with_prefix(&bytes))
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
    let path = folder.join(format!("{sha}.wasm"));
    std::fs::write(&path, &bytes).unwrap_or_else(|e| panic!("{e}"));
    let loaded = worker.load(&sha, &path).await;
    assert!(
        loaded
            .as_ref()
            .is_err_and(|why| why == spade_wasm::confine::NOT_CONFINED),
        "{loaded:?}"
    );
}

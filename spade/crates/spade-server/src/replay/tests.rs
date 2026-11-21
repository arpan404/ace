//! Replays of kept cases on the real engine (ADR 0204 §2): a version passes the cases its own
//! runs made, and one that drops an effect a run used or changes a contract's output fails them.
//! Every outside call answers from the recording: a local server the kept run fetched from
//! receives nothing during a replay. A model replay runs on a fake endpoint standing in for the
//! person's model, counts the calls outside the recording and writes only to its own copy of the
//! bot's workspace.

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use serde_json::{Value, json};
use spade_core::quality::case::{
    Case, Given, Outcome, Step, StepCall, ToolResult, Trigger, TriggerKind,
};
use spade_testkit::{FakeProvider, Script};

use super::{Model, Version};

type Result<T = ()> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;

/// A server on this machine that counts every connection it is sent.
async fn listening() -> Result<(String, Arc<AtomicUsize>)> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let address = format!("http://{}", listener.local_addr()?);
    let reached = Arc::new(AtomicUsize::new(0));
    let count = reached.clone();
    tokio::spawn(async move {
        while let Ok((socket, _)) = listener.accept().await {
            count.fetch_add(1, Ordering::SeqCst);
            drop(socket);
        }
    });
    Ok((address, reached))
}

fn watcher(effects: Value, output: Value) -> Result<Version> {
    let recipe = json!({
        "format": "spade-bot",
        "version": 3,
        "requires": { "runtime": "1" },
        "name": "Flight watcher",
        "blurb": "Watches fares.",
        "task": "You watch flight fares for the person.",
        "effects": effects,
        "contracts": [{
            "name": "cheapest_fare",
            "summary": "The cheapest fare seen for a route this week.",
            "input": { "type": "object", "properties": { "from": { "type": "string", "maxLength": 3 } }, "required": ["from"] },
            "output": output
        }],
        "pricing": { "kind": "free" }
    });
    let manifest = crate::packages::manifest(&recipe)?;
    Ok(Version {
        recipe,
        manifest,
        pages: json!({}),
    })
}

fn sends() -> Value {
    json!([{ "effect": "send_as_person", "why": "Mails your travel agent the fare." }])
}

fn fare() -> Value {
    json!({ "type": "object", "properties": { "fare": { "type": "number" } }, "required": ["fare"] })
}

fn call(id: &str, tool: &str, arguments: Value) -> StepCall {
    StepCall {
        id: id.into(),
        tool: tool.into(),
        arguments,
    }
}

/// A kept run that fetched a fare page from `site`, mailed the fare and answered.
fn fetched(site: &str) -> Case {
    let arguments = json!({ "url": format!("{site}/ktm-del") });
    let mail = json!({ "to": "agent@example.com", "text": "KTM-DEL is 182 USD." });
    Case {
        id: "case_1".into(),
        bot: "bot_1".into(),
        reply: "r_1".into(),
        package: None,
        trigger: Trigger {
            kind: TriggerKind::Message,
            name: None,
        },
        given: Given {
            messages: vec!["What does KTM to DEL cost?".into()],
            input: None,
        },
        steps: vec![
            Step {
                text: String::new(),
                calls: vec![call("c1", "web_fetch", arguments.clone())],
            },
            Step {
                text: String::new(),
                calls: vec![call("c2", "send_message", mail.clone())],
            },
            Step {
                text: "182 USD.".into(),
                calls: Vec::new(),
            },
        ],
        tool_results: vec![
            ToolResult {
                call: "c1".into(),
                tool: "web_fetch".into(),
                arguments,
                content: "KTM-DEL 182 USD".into(),
                is_error: false,
            },
            ToolResult {
                call: "c2".into(),
                tool: "send_message".into(),
                arguments: mail,
                content: "Sent.".into(),
                is_error: false,
            },
        ],
        outcome: Outcome {
            text: "182 USD.".into(),
            cards: Vec::new(),
            contract: None,
            effects: vec!["read".into(), "send_as_person".into()],
            verdict: None,
        },
        mark: None,
        why: None,
        made_at: 0,
    }
}

/// A kept run that answered a contract call with a fare.
fn answered() -> Case {
    let mut case = fetched("http://unused.example");
    case.trigger = Trigger {
        kind: TriggerKind::Contract,
        name: Some("cheapest_fare".into()),
    };
    case.given = Given {
        messages: Vec::new(),
        input: Some(json!({ "from": "KTM" })),
    };
    case.steps = vec![Step {
        text: String::new(),
        calls: vec![call(
            "c1",
            "contract_return",
            json!({ "call": "cc.c_9.p1", "output": { "fare": 182 } }),
        )],
    }];
    case.tool_results = vec![ToolResult {
        call: "c1".into(),
        tool: "contract_return".into(),
        arguments: json!({ "call": "cc.c_9.p1", "output": { "fare": 182 } }),
        content: "Returned. The caller has the answer.".into(),
        is_error: false,
    }];
    case.outcome.effects = Vec::new();
    case.outcome.contract = Some(json!({ "status": "returned", "output": { "fare": 182 } }));
    case
}

#[tokio::test]
async fn the_version_a_run_came_from_passes_its_case_and_nothing_reaches_the_network() -> Result {
    let (site, reached) = listening().await?;
    let cases = [fetched(&site), answered()];
    let report = super::run(&cases, &watcher(sends(), fare())?, &Model::Recorded).await;
    assert_eq!(report.failed, 0, "{:?}", report.cases);
    assert_eq!(report.summary, "All 2 kept runs replay the same.");
    assert_eq!(reached.load(Ordering::SeqCst), 0, "the replay reached out");
    Ok(())
}

#[tokio::test]
async fn a_version_that_drops_an_effect_the_run_used_fails_its_case() -> Result {
    let (site, reached) = listening().await?;
    let report = super::run(
        &[fetched(&site)],
        &watcher(json!([]), fare())?,
        &Model::Recorded,
    )
    .await;
    let lines = &report.cases[0].lines;
    assert!(
        lines
            .iter()
            .any(|l| l.starts_with("send_message was refused:")),
        "{lines:?}"
    );
    assert_eq!(
        report.summary,
        "0 of 1 kept run replay the same. 1 doesn't: see why."
    );
    assert_eq!(reached.load(Ordering::SeqCst), 0);
    Ok(())
}

#[tokio::test]
async fn a_version_that_changes_a_contracts_output_fails_the_case_that_called_it() -> Result {
    let wider = json!({ "type": "object",
        "properties": { "fare": { "type": "number" }, "currency": { "type": "string", "maxLength": 3 } },
        "required": ["fare", "currency"] });
    let report = super::run(&[answered()], &watcher(sends(), wider)?, &Model::Recorded).await;
    let lines = &report.cases[0].lines;
    assert!(!report.cases[0].passed);
    assert!(
        lines
            .iter()
            .any(|l| l.starts_with("contract_return answered an error")
                && l.contains("output.currency: is missing")),
        "{lines:?}"
    );
    Ok(())
}

#[tokio::test]
async fn a_case_whose_routine_is_gone_in_the_new_version_fails_without_running() -> Result {
    let mut case = fetched("http://unused.example");
    case.trigger = Trigger {
        kind: TriggerKind::Routine,
        name: Some("Morning fares".into()),
    };
    let report = super::run(&[case], &watcher(sends(), fare())?, &Model::Recorded).await;
    assert_eq!(
        report.cases[0].lines,
        vec!["This version has no routine named \"Morning fares\"".to_owned()]
    );
    Ok(())
}

#[tokio::test]
async fn a_model_replay_answers_from_the_recording_counts_what_it_lacks_and_keeps_the_real_workspace()
-> Result {
    let (site, reached) = listening().await?;
    let case = fetched(&site);
    // The person's model, played by a fake endpoint: it asks for the recorded page, then one the
    // run never fetched, writes a file, and answers.
    let fake = FakeProvider::start_turns(
        vec![
            Script::reply("").call(
                "m1",
                "web_fetch",
                json!({ "url": format!("{site}/ktm-del") }),
            ),
            Script::reply("").call(
                "m2",
                "web_fetch",
                json!({ "url": format!("{site}/ktm-bom") }),
            ),
            Script::reply("").call(
                "m3",
                "workspace_write",
                json!({ "path": "notes.txt", "content": "KTM-DEL 182" }),
            ),
            Script::reply("The cheapest is 182 USD."),
        ],
        Script::reply("").plain(r#"{"title":"Replay"}"#),
    )
    .await?;
    let models = spade_models::Models::new(
        crate::bot_test::throwaway::catalog(&fake.root)?,
        spade_keys::Keys::keychain_then_env(
            |_| None,
            |var| (var == "SPADE_BOT_TEST_KEY").then(|| "scripted".to_owned()),
        ),
        crate::home::VERSION,
    )?;
    let real = tempfile::tempdir()?;
    std::fs::write(real.path().join("kept.txt"), "the bot's own file")?;
    let chosen = Model::Chosen {
        models,
        model: "fake/m".into(),
        workspace: Some(real.path().to_path_buf()),
    };
    let report = super::run(&[case], &watcher(sends(), fare())?, &chosen).await;
    let replayed = &report.cases[0];
    assert!(replayed.passed, "{:?}", replayed.lines);
    assert_eq!(replayed.outside, 1);
    assert_eq!(replayed.reply, "The cheapest is 182 USD.");
    assert_eq!(
        report.summary,
        "The 1 kept run the same or better. 1 call was outside the recording."
    );
    // The recorded page came from the recording, the other was answered as not in it.
    let results: Vec<String> = fake
        .seen()
        .iter()
        .flat_map(|seen| {
            seen.body["messages"]
                .as_array()
                .cloned()
                .unwrap_or_default()
        })
        .filter(|m| m["role"] == "tool")
        .filter_map(|m| m["content"].as_str().map(str::to_owned))
        .collect();
    assert!(
        results.iter().any(|r| r.contains("KTM-DEL 182 USD")),
        "{results:?}"
    );
    assert!(
        results.iter().any(|r| r.contains("Not in the recording")),
        "{results:?}"
    );
    assert_eq!(reached.load(Ordering::SeqCst), 0, "the replay reached out");
    let left: Vec<String> = std::fs::read_dir(real.path())?
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(left, vec!["kept.txt".to_owned()]);
    assert_eq!(
        std::fs::read_to_string(real.path().join("kept.txt"))?,
        "the bot's own file"
    );
    Ok(())
}

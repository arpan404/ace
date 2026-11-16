//! Decisions on effects, not words (ADR 0171), through the API: a tool that declares nothing asks
//! the person once and Spade keeps the answer; a typed send goes to the person; a push runs within
//! its grant and goes to the person outside it; a bot set to run outside the sandbox has its
//! commands reviewed; a per-call request to run outside runs that call once; the machine's
//! defaults are inherited and a bot's own wins. The sandbox tests start real shells on macOS.

mod support;

use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use spade_core::tools::Risk;
use spade_server::tools::Tool;
use spade_testkit::Script;
use support::{FakeTool, Result, Spade};

const TITLE: &str = r#"{"title":"Work"}"#;
const APPROVE: &str = r#"{"verdict":"approve","reason":"It serves the task."}"#;

fn ran(calls: &Arc<std::sync::Mutex<Vec<Value>>>) -> usize {
    calls.lock().map(|c| c.len()).unwrap_or(0)
}

fn requests(events: &[Value]) -> Vec<&Value> {
    events
        .iter()
        .filter(|e| e["type"] == "approval_requested")
        .collect()
}

async fn answer(spade: &Spade, conversation: &str, call: &str, body: Value) -> Result {
    let (status, answered) = spade
        .post(
            &format!("/v1/conversations/{conversation}/approvals/{call}"),
            body,
        )
        .await?;
    assert_eq!(status, 202, "{answered}");
    Ok(())
}

/// Waits until `calls` has `n` calls.
async fn until_ran(calls: &Arc<std::sync::Mutex<Vec<Value>>>, n: usize) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while ran(calls) < n && Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[tokio::test]
async fn a_tool_that_declares_nothing_asks_once_and_spade_keeps_the_answer() -> Result {
    let mystery = FakeTool::new("mystery", Risk::Write, "done").unannotated_app("Does a thing");
    let other = FakeTool::new("other", Risk::Write, "done").unannotated_app("Does another");
    let (mysteries, others) = (mystery.calls(), other.calls());
    let spade = Spade::start(
        vec![
            Script::reply("").call("c1", "mystery", json!({})),
            Script::reply("Done."),
            Script::reply("").plain(TITLE),
            Script::reply("").call("c2", "mystery", json!({ "again": true })),
            Script::reply("Done again."),
            Script::reply("").call("c3", "other", json!({})),
            Script::reply("Asked."),
            Script::reply("").call("c4", "other", json!({})),
            Script::reply("Refused."),
        ],
        vec![
            Arc::new(mystery) as Arc<dyn Tool>,
            Arc::new(other) as Arc<dyn Tool>,
        ],
    )
    .await?;
    let agent = spade.new_agent("Builder", "").await?;
    let conversation = agent["conversation"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    spade.say(&conversation, "Do the thing").await?;
    let events = spade.wait_for(&conversation, "approval_requested").await?;
    let asked = requests(&events);
    assert_eq!(asked[0]["ask"], "undeclared", "{asked:?}");
    assert_eq!(
        asked[0]["reviewer_reason"],
        "It doesn't say what it does, so you decide once for this bot."
    );
    answer(&spade, &conversation, "c1", json!({ "allowed": true })).await?;
    until_ran(&mysteries, 1).await;
    spade.wait_for(&conversation, "reply_finished").await?;
    // The next call of it runs without asking.
    spade.say(&conversation, "Again").await?;
    until_ran(&mysteries, 2).await;
    assert_eq!(ran(&mysteries), 2);
    let events = spade
        .wait_for_count(&conversation, "reply_finished", 2)
        .await?;
    assert_eq!(requests(&events).len(), 1, "asked once");
    // A tool the person declined is refused from then on, without asking again.
    spade.say(&conversation, "Try the other").await?;
    spade
        .wait_for_count(&conversation, "approval_requested", 2)
        .await?;
    answer(&spade, &conversation, "c3", json!({ "allowed": false })).await?;
    spade
        .wait_for_count(&conversation, "reply_finished", 3)
        .await?;
    spade.say(&conversation, "Try it once more").await?;
    let events = spade
        .wait_for_count(&conversation, "reply_finished", 4)
        .await?;
    assert_eq!(requests(&events).len(), 2, "not asked again");
    let refused = events
        .iter()
        .find(|e| e["type"] == "tool_finished" && e["call_id"] == "c4")
        .and_then(|e| e["content"].as_str())
        .unwrap_or_default();
    assert!(refused.contains("declined this tool"), "{refused}");
    assert_eq!(ran(&others), 0);
    Ok(())
}

#[tokio::test]
async fn a_typed_send_goes_to_the_person_and_no_reviewer() -> Result {
    let send = FakeTool::new("send_message", Risk::Write, "Sent");
    let sent = send.calls();
    let spade = Spade::start(
        vec![
            Script::reply("").call(
                "c1",
                "send_message",
                json!({ "app": "messages", "to": "+15551234567", "body": "On my way" }),
            ),
            // Only reached if a reviewer were asked: it would approve.
            Script::reply("").plain(APPROVE),
        ],
        vec![Arc::new(send) as Arc<dyn Tool>],
    )
    .await?;
    let agent = spade.new_agent("Builder", "").await?;
    let conversation = agent["conversation"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    spade.say(&conversation, "Text Sam I'm on my way").await?;
    let events = spade.wait_for(&conversation, "approval_requested").await?;
    let asked = requests(&events);
    assert_eq!(
        asked[0]["reviewer_reason"],
        "It sends something in your name, so you decide."
    );
    assert_eq!(spade.fake.seen().len(), 1, "no reviewer was asked");
    assert_eq!(ran(&sent), 0);
    Ok(())
}

#[cfg(target_os = "macos")]
mod sandboxed {
    use super::*;
    use support::sandbox::{output, reviewed_world, world};

    #[tokio::test]
    async fn a_push_inside_its_grant_runs_and_any_other_goes_to_the_person() -> Result {
        let push = FakeTool::new("git_push", Risk::Write, "Pushed");
        let pushes = push.calls();
        let w = world(false, vec![Arc::new(push)], |_| {
            vec![
                Script::reply("").call(
                    "c1",
                    "git_push",
                    json!({ "repo": "acme/app", "branch": "spade/fix" }),
                ),
                Script::reply("Pushed."),
                Script::reply("").plain(TITLE),
                Script::reply("").call(
                    "c2",
                    "git_push",
                    json!({ "repo": "acme/app", "branch": "main" }),
                ),
            ]
        })
        .await?;
        let (status, granted) = w
            .spade
            .post(
                &format!("/v1/agents/{}/grants", w.bot),
                json!({ "kind": "git_push", "repo": "acme/*", "branch": "spade/*" }),
            )
            .await?;
        assert_eq!(status, 201, "{granted}");
        w.spade.say(&w.conversation, "Push the fix").await?;
        w.spade.wait_for(&w.conversation, "reply_finished").await?;
        assert_eq!(ran(&pushes), 1);
        w.spade.say(&w.conversation, "Now push main").await?;
        let events = w
            .spade
            .wait_for(&w.conversation, "approval_requested")
            .await?;
        let asked = requests(&events);
        assert_eq!(asked.len(), 1, "only the push outside the grant asks");
        assert_eq!(asked[0]["call_id"], "c2");
        assert_eq!(
            asked[0]["reviewer_reason"],
            "It pushes with your sign-in, so you decide."
        );
        assert_eq!(ran(&pushes), 1);
        Ok(())
    }

    #[tokio::test]
    async fn a_bot_set_to_run_outside_the_sandbox_has_its_commands_reviewed() -> Result {
        let w = reviewed_world(true, vec![], |at| {
            let tax = at.home.join("Documents/tax.txt");
            vec![
                Script::reply("").call(
                    "c1",
                    "shell",
                    json!({ "command": format!("cat '{}'", tax.display()) }),
                ),
                Script::reply("").plain(APPROVE),
                Script::reply("Read it."),
            ]
        })
        .await?;
        let (status, view) = w
            .spade
            .put(
                &format!("/v1/agents/{}/security/commands", w.bot),
                json!({ "commands": "outside" }),
            )
            .await?;
        assert_eq!(status, 200, "{view}");
        assert_eq!(view["commands"], "outside");
        w.spade.say(&w.conversation, "Read my tax file").await?;
        let events = w.spade.wait_for(&w.conversation, "reply_finished").await?;
        let reviewed = events
            .iter()
            .find(|e| e["type"] == "call_reviewed")
            .ok_or_else(|| format!("not reviewed: {events:?}"))?;
        assert_eq!(reviewed["verdict"], "allow", "{reviewed}");
        assert_ne!(reviewed["model"], "", "a reviewer judged it");
        // It ran outside the sandbox: the person's file was readable.
        assert!(output(&events, "c1").contains("TAX-SECRET"), "{events:?}");
        Ok(())
    }

    #[tokio::test]
    async fn a_request_to_run_outside_runs_that_call_once_after_allow() -> Result {
        let w = world(true, vec![], |at| {
            let read = format!("cat '{}'", at.home.join("Documents/tax.txt").display());
            vec![
                Script::reply("").call(
                    "c1",
                    "shell",
                    json!({ "command": read, "outside_sandbox": true }),
                ),
                Script::reply("Read it."),
                Script::reply("").plain(TITLE),
                Script::reply("").call("c2", "shell", json!({ "command": read })),
                Script::reply("Blocked."),
                Script::reply("").call(
                    "c3",
                    "shell",
                    json!({ "command": read, "outside_sandbox": true }),
                ),
                Script::reply("Read it again."),
            ]
        })
        .await?;
        w.spade.say(&w.conversation, "Read my tax file").await?;
        let events = w
            .spade
            .wait_for(&w.conversation, "approval_requested")
            .await?;
        let asked = requests(&events);
        assert_eq!(asked[0]["ask"], "outside_sandbox", "{asked:?}");
        answer(&w.spade, &w.conversation, "c1", json!({ "allowed": true })).await?;
        let events = w.spade.wait_for(&w.conversation, "reply_finished").await?;
        assert!(output(&events, "c1").contains("TAX-SECRET"), "{events:?}");
        // Once: the next command runs sandboxed, and is told the sandbox stopped it.
        w.spade.say(&w.conversation, "And again").await?;
        let events = w
            .spade
            .wait_for_count(&w.conversation, "reply_finished", 2)
            .await?;
        let blocked = output(&events, "c2");
        assert!(!blocked.contains("TAX-SECRET"), "{blocked}");
        assert!(blocked.contains("outside_sandbox: true"), "{blocked}");
        assert_eq!(requests(&events).len(), 1);
        // Always for this bot: it runs, and the bot's commands run outside from then on.
        w.spade.say(&w.conversation, "Ask once more").await?;
        w.spade
            .wait_for_count(&w.conversation, "approval_requested", 2)
            .await?;
        answer(
            &w.spade,
            &w.conversation,
            "c3",
            json!({ "allowed": true, "always": true }),
        )
        .await?;
        let events = w
            .spade
            .wait_for_count(&w.conversation, "reply_finished", 3)
            .await?;
        assert!(output(&events, "c3").contains("TAX-SECRET"));
        let (_, view) = w
            .spade
            .get(&format!("/v1/agents/{}/security", w.bot))
            .await?;
        assert_eq!(view["commands"], "outside", "{view}");
        assert_eq!(view["own"]["commands"], true);
        Ok(())
    }

    #[tokio::test]
    async fn a_machine_default_is_inherited_and_a_bots_own_wins() -> Result {
        let w = world(false, vec![], |_| vec![]).await?;
        let bot = format!("/v1/agents/{}/security", w.bot);
        let (status, machine) = w
            .spade
            .put("/v1/security/commands", json!({ "commands": "outside" }))
            .await?;
        assert_eq!(status, 200, "{machine}");
        assert_eq!(machine["bots"]["commands"], "outside");
        let (_, view) = w.spade.get(&bot).await?;
        assert_eq!(view["commands"], "outside");
        assert_eq!(view["own"]["commands"], false);
        let (_, view) = w
            .spade
            .put(
                &format!("{bot}/commands"),
                json!({ "commands": "sandboxed" }),
            )
            .await?;
        assert_eq!(view["commands"], "sandboxed");
        assert_eq!(view["own"]["commands"], true);
        let (_, view) = w
            .spade
            .put(&format!("{bot}/commands"), json!({ "commands": null }))
            .await?;
        assert_eq!(view["commands"], "outside", "back to the machine's");
        // The network rules too.
        let (status, machine) = w
            .spade
            .put("/v1/security/network", json!({ "mode": "off" }))
            .await?;
        assert_eq!(status, 200, "{machine}");
        let (_, view) = w.spade.get(&bot).await?;
        assert_eq!(view["network"]["mode"], "off");
        assert_eq!(view["own"]["network"], false);
        let (_, view) = w
            .spade
            .put(&format!("{bot}/network"), json!({ "mode": "open" }))
            .await?;
        assert_eq!(view["network"]["mode"], "open");
        let (status, view) = w.spade.delete(&format!("{bot}/network")).await?;
        assert_eq!(status, 200, "{view}");
        assert_eq!(view["network"]["mode"], "off");
        let (status, refused) = w
            .spade
            .put(
                "/v1/security/network",
                json!({ "mode": "allow_list", "allow": ["not a host"] }),
            )
            .await?;
        assert_eq!(status, 400, "{refused}");
        Ok(())
    }
}

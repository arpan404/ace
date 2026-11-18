//! Full access through the API (ADR 0163, amendment 2): every bot starts on the auto-review; the
//! person turns Full access on for one bot or for the machine; a Full access bot's commands
//! outside the sandbox and its app writes run with no reviewer and no request, while a send in the
//! person's name and a payment still go to the person.

mod support;

use std::sync::Arc;

use serde_json::{Value, json};
use spade_core::effect::Effect;
use spade_core::tools::Risk;
use spade_server::tools::Tool;
use spade_testkit::Script;
use support::sandbox::{asked, output, world};
use support::{FakeTool, Result};

fn security(bot: &str) -> String {
    format!("/v1/agents/{bot}/security")
}

/// How the bot list shows the bot deciding.
async fn listed(spade: &support::Spade, bot: &str) -> Result<Value> {
    let (status, list) = spade.get("/v1/agents").await?;
    assert_eq!(status, 200, "{list}");
    let found = list["agents"]
        .as_array()
        .and_then(|agents| agents.iter().find(|a| a["id"] == bot))
        .map(|agent| agent["autonomy"].clone());
    Ok(found.unwrap_or(Value::Null))
}

#[tokio::test]
async fn auto_review_stays_the_default_and_full_access_is_the_persons_choice_per_bot() -> Result {
    let w = world(false, vec![], |_| vec![]).await?;
    let (status, view) = w.spade.get(&security(&w.bot)).await?;
    assert_eq!(status, 200, "{view}");
    assert_eq!(view["autonomy"], "auto_review");
    assert_eq!(view["full_access_confirmed"], false);
    assert_eq!(listed(&w.spade, &w.bot).await?, "auto_review");

    let autonomy = format!("{}/autonomy", security(&w.bot));
    let (status, view) = w
        .spade
        .put(&autonomy, json!({ "autonomy": "full_access" }))
        .await?;
    assert_eq!(status, 200, "{view}");
    assert_eq!(view["autonomy"], "full_access");
    assert_eq!(view["own"]["autonomy"], true);
    assert_eq!(view["full_access_confirmed"], true);
    assert_eq!(listed(&w.spade, &w.bot).await?, "full_access");
    // Another bot is still on the auto-review.
    let other = w.spade.new_agent("Other", "").await?;
    let other = other["id"].as_str().unwrap_or_default().to_owned();
    let (_, view) = w.spade.get(&security(&other)).await?;
    assert_eq!(view["autonomy"], "auto_review");

    // A word Spade doesn't know changes nothing.
    let (status, _) = w
        .spade
        .put(&autonomy, json!({ "autonomy": "everything" }))
        .await?;
    assert_eq!(status, 422);
    // Back to following the machine: the auto-review, and the confirmation is remembered.
    let (status, view) = w.spade.put(&autonomy, json!({ "autonomy": null })).await?;
    assert_eq!(status, 200, "{view}");
    assert_eq!(view["autonomy"], "auto_review");
    assert_eq!(view["full_access_confirmed"], true);

    // The machine's default reaches bots without their own; a bot's own wins.
    let (status, machine) = w
        .spade
        .put(
            "/v1/security/autonomy",
            json!({ "autonomy": "full_access" }),
        )
        .await?;
    assert_eq!(status, 200, "{machine}");
    assert_eq!(machine["bots"]["autonomy"], "full_access");
    let (_, view) = w.spade.get(&security(&other)).await?;
    assert_eq!(view["autonomy"], "full_access");
    w.spade
        .put(
            &format!("{}/autonomy", security(&other)),
            json!({ "autonomy": "auto_review" }),
        )
        .await?;
    let (_, view) = w.spade.get(&security(&other)).await?;
    assert_eq!(view["autonomy"], "auto_review");
    // The retired access levels stay retired: Full access is this setting, not `access`.
    let (status, _) = w
        .spade
        .patch(
            &format!("/v1/agents/{}", w.bot),
            json!({ "access": "full_access" }),
        )
        .await?;
    assert_eq!(status, 400);
    Ok(())
}

fn finished(events: &[Value], call: &str) -> bool {
    !output(events, call).is_empty()
        || events
            .iter()
            .any(|e| e["type"] == "tool_finished" && e["call_id"] == call)
}

#[tokio::test]
async fn in_full_access_a_write_outside_the_sandbox_runs_but_a_send_and_a_payment_ask() -> Result {
    let ticket = FakeTool::new("tracker_create", Risk::Write, "Filed")
        .app("Files a ticket")
        .declares(Effect::Network);
    let charge = FakeTool::new("shop_charge", Risk::Write, "Charged")
        .app("Charges a card")
        .declares(Effect::Pay);
    let send = FakeTool::new("send_message", Risk::Write, "Sent");
    let (tickets, charges, sends) = (ticket.calls(), charge.calls(), send.calls());
    let tools: Vec<Arc<dyn Tool>> = vec![Arc::new(ticket), Arc::new(charge), Arc::new(send)];
    let w = world(false, tools, |at| {
        let note = at.home.join("Documents/note.txt");
        vec![
            // With no sandbox on this machine, a command runs outside it: the auto-review would
            // review it (and in these tests the reviewer can't be reached, so ask).
            Script::reply("")
                .call(
                    "c1",
                    "shell",
                    json!({ "command": format!("echo noted > '{}'", note.display()) }),
                )
                .call("c2", "tracker_create", json!({ "title": "Broken" })),
            Script::reply("Done."),
            Script::reply("").plain(r#"{"title":"Work"}"#),
            Script::reply("")
                .call(
                    "c3",
                    "send_message",
                    json!({ "app": "messages", "to": "+15551234567", "body": "Hi" }),
                )
                .call("c4", "shop_charge", json!({ "amount": 5 })),
        ]
    })
    .await?;
    let (status, view) = w
        .spade
        .put(
            &format!("{}/autonomy", security(&w.bot)),
            json!({ "autonomy": "full_access" }),
        )
        .await?;
    assert_eq!(status, 200, "{view}");

    w.spade.say(&w.conversation, "Note it and file it").await?;
    let events = w.spade.wait_for(&w.conversation, "reply_finished").await?;
    assert!(asked(&events).is_empty(), "{events:?}");
    assert!(
        !events.iter().any(|e| e["type"] == "call_reviewed"),
        "nothing was reviewed: {events:?}"
    );
    assert!(finished(&events, "c1") && finished(&events, "c2"));
    assert_eq!(
        std::fs::read_to_string(w.home.join("Documents/note.txt"))?.trim(),
        "noted"
    );
    assert_eq!(tickets.lock().map(|c| c.len()).unwrap_or(0), 1);

    w.spade.say(&w.conversation, "Tell Sam and pay").await?;
    let events = w
        .spade
        .wait_for_count(&w.conversation, "approval_requested", 2)
        .await?;
    let lines: Vec<&str> = events
        .iter()
        .filter(|e| e["type"] == "approval_requested")
        .filter_map(|e| e["reviewer_reason"].as_str())
        .collect();
    assert_eq!(
        lines,
        [
            "It sends something in your name to +15551234567, so you decide.",
            "It could spend money, so you decide.",
        ]
    );
    assert_eq!(sends.lock().map(|c| c.len()).unwrap_or(0), 0);
    assert_eq!(charges.lock().map(|c| c.len()).unwrap_or(0), 0);
    Ok(())
}

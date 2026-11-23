//! Task lanes (ADR 0217 §2, §4): a lane's approvals and questions are asked in main and answered
//! there, main's words reach a lane as the bot's, and every pair of writes lands together or not
//! at all.

mod support;

use std::time::{Duration, Instant};

use serde_json::{Value, json};
use spade_core::tools::Risk;
use spade_testkit::{Route, Script};
use support::lanes::*;
use support::{FakeTool, Options, Result, Spade, types};

#[tokio::test]
async fn a_lanes_approval_makes_the_bot_need_you_and_is_answered_from_main() -> Result {
    let send = FakeTool::new("send_email", Risk::Write, "sent");
    let sent = send.calls();
    let routes = vec![route(
        "Send Dana the invoice",
        vec![
            Script::reply("").call("e1", "send_email", json!({ "to": "dana@northwind.co" })),
            Script::reply("Sent it to Dana."),
        ],
    )];
    let mut main = warm_up();
    main.extend([
        starts("t1", "Send Dana the invoice"),
        Script::reply("Started a task for it."),
        Script::reply("The task needs your OK to send."),
        Script::reply("Sent to Dana."),
    ]);
    let spade = Spade::start_routed(routes, main, tools(vec![send]), Options::default()).await?;
    let (agent, conversation) = warm_bot(&spade).await?;
    spade.say(&conversation, "Send Dana the invoice.").await?;
    let events = wait_count(&spade, &conversation, "approval_requested", 1).await?;
    let asked = events
        .iter()
        .find(|e| e["type"] == "approval_requested")
        .cloned()
        .unwrap_or_default();
    assert_eq!(asked["name"], "send_email");
    assert_eq!(asked["lane"]["title"], "Send Dana the invoice");
    let lane_id = asked["lane"]["task"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let row = roster_state(&spade, &agent).await?;
        if row["state"] == "waiting" {
            assert_eq!(row["waiting_for"], "task", "{row}");
            break;
        }
        assert_ne!(
            row["state"], "idle",
            "idle while a task waits on the person"
        );
        if Instant::now() > deadline {
            return Err(format!("never needed the person: {row}").into());
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let found = tasks(&spade, &conversation).await?;
    assert_eq!(found[0]["state"], "needs_you");
    assert!(sent.lock().map(|c| c.is_empty()).unwrap_or(false));

    // Answered in main, the lane carries on and sends.
    let call = asked["call_id"].as_str().unwrap_or_default();
    let (status, body) = spade
        .post(
            &format!("/v1/conversations/{conversation}/approvals/{call}"),
            json!({ "allowed": true }),
        )
        .await?;
    assert_eq!(status, 202, "{body}");
    wait_count(&spade, &lane_id, "reply_finished", 1).await?;
    assert_eq!(sent.lock().map(|c| c.len()).unwrap_or(0), 1);
    Ok(())
}

#[tokio::test]
async fn a_lanes_question_shows_in_main_as_the_lanes_and_its_answer_goes_back_to_the_lane() -> Result
{
    let routes = vec![route(
        "Book flights to Lisbon",
        vec![
            Script::reply("").call("q1", "ask_user", json!({ "question": "Window or aisle?" })),
            Script::reply("Booked a window seat."),
        ],
    )];
    let mut main = warm_up();
    main.extend([
        starts("t1", "Book flights to Lisbon"),
        Script::reply("Started a task for the flights."),
        Script::reply("The flights are booked."),
    ]);
    let spade = Spade::start_routed(routes, main, Vec::new(), Options::default()).await?;
    let (agent, conversation) = warm_bot(&spade).await?;
    spade.say(&conversation, "Book flights to Lisbon.").await?;
    let events = wait_count(&spade, &conversation, "question_asked", 1).await?;
    let asked = events
        .iter()
        .find(|e| e["type"] == "question_asked")
        .cloned()
        .unwrap_or_default();
    assert_eq!(asked["question"], "Window or aisle?");
    assert_eq!(asked["lane"]["title"], "Book flights to Lisbon");
    assert_eq!(asked["lane"]["call_id"], "q1");
    let lane_id = asked["lane"]["task"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    assert_eq!(asked["call_id"], format!("{lane_id}.q1").as_str());
    // The bot needs the person; main's own reply has ended and doesn't wait on the card.
    wait_count(&spade, &conversation, "reply_finished", 2).await?;
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let row = roster_state(&spade, &agent).await?;
        if row["state"] == "waiting" {
            assert_eq!(row["waiting_for"], "task", "{row}");
            break;
        }
        if Instant::now() > deadline {
            return Err(format!("never needed the person: {row}").into());
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let (_, cards) = spade
        .get(&format!("/v1/conversations/{conversation}/questions"))
        .await?;
    assert!(cards.to_string().contains("Window or aisle?"), "{cards}");

    // Answered from main, the answer reaches the lane, which carries on.
    let call = asked["call_id"].as_str().unwrap_or_default();
    let (status, body) = spade
        .post(
            &format!("/v1/conversations/{conversation}/questions/{call}"),
            json!({ "answers": ["Window"] }),
        )
        .await?;
    assert_eq!(status, 202, "{body}");
    let lane_events = wait_count(&spade, &lane_id, "reply_finished", 1).await?;
    let answered = lane_events
        .iter()
        .find(|e| e["type"] == "question_answered")
        .cloned()
        .unwrap_or_default();
    assert_eq!(answered["call_id"], "q1");
    assert_eq!(answered["answers"], json!(["Window"]));
    let main_events = spade.events(&conversation).await?;
    assert!(
        main_events
            .iter()
            .any(|e| e["type"] == "question_answered" && e["call_id"] == call),
        "main's copy closed"
    );
    let lane_asked = spade
        .fake
        .seen()
        .iter()
        .filter(|s| s.body.to_string().contains(&lane("Book flights to Lisbon")))
        .count();
    assert_eq!(lane_asked, 2, "the lane's next step read the answer");
    Ok(())
}

#[tokio::test]
async fn a_lanes_request_is_never_stored_without_its_copy_in_main() -> Result {
    let send = FakeTool::new("send_email", Risk::Write, "sent");
    let routes = vec![route(
        "Send Dana the invoice",
        vec![
            Script::reply("").call("e1", "send_email", json!({ "to": "dana@northwind.co" })),
            Script::reply("Sent."),
        ],
    )];
    let mut main = warm_up();
    main.extend([
        starts("t1", "Send Dana the invoice"),
        Script::reply("Started."),
        Script::reply("The task stopped early."),
    ]);
    let spade = Spade::start_routed(routes, main, tools(vec![send]), Options::default()).await?;
    let (_, conversation) = warm_bot(&spade).await?;
    // Main's copy can't be written, as if Spade died between the two writes.
    refuse(
        &spade,
        "no_mirror",
        "json_extract(NEW.body, '$.type') = 'approval_requested' \
         AND json_extract(NEW.body, '$.lane') IS NOT NULL",
    )?;
    spade.say(&conversation, "Send Dana the invoice.").await?;
    let found = wait_tasks(&spade, &conversation, |t| {
        t.first().is_some_and(|t| t["state"] == "failed")
    })
    .await?;
    let lane_id = id_of(found.first());
    let lane_events = spade.events(&lane_id).await?;
    assert_eq!(
        count(&lane_events, "approval_requested"),
        0,
        "the lane waits on a request main can't show: {:?}",
        types(&lane_events)
    );
    allow(&spade, "no_mirror")?;
    Ok(())
}

#[tokio::test]
async fn an_answer_to_a_lanes_request_lands_in_main_and_the_lane_together_or_not_at_all() -> Result
{
    let send = FakeTool::new("send_email", Risk::Write, "sent");
    let sent = send.calls();
    let routes = vec![route(
        "Send Dana the invoice",
        vec![
            Script::reply("").call("e1", "send_email", json!({ "to": "dana@northwind.co" })),
            Script::reply("Sent."),
        ],
    )];
    let mut main = warm_up();
    main.extend([
        starts("t1", "Send Dana the invoice"),
        Script::reply("Started."),
        Script::reply("Sent."),
    ]);
    let spade = Spade::start_routed(routes, main, tools(vec![send]), Options::default()).await?;
    let (agent, conversation) = warm_bot(&spade).await?;
    spade.say(&conversation, "Send Dana the invoice.").await?;
    let events = wait_count(&spade, &conversation, "approval_requested", 1).await?;
    let asked = events
        .iter()
        .find(|e| e["type"] == "approval_requested")
        .cloned()
        .unwrap_or_default();
    let lane_id = asked["lane"]["task"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    let call = asked["call_id"].as_str().unwrap_or_default().to_owned();
    refuse(
        &spade,
        "no_lane_answer",
        &format!(
            "json_extract(NEW.body, '$.type') = 'approval_answered' \
             AND NEW.conversation_id = '{lane_id}'"
        ),
    )?;
    let path = format!("/v1/conversations/{conversation}/approvals/{call}");
    let (status, _) = spade.post(&path, json!({ "allowed": true })).await?;
    assert_eq!(status, 500, "the answer could not be stored");
    // Nothing of it landed: main still asks, and the bot still needs the person.
    assert_eq!(
        count(&spade.events(&conversation).await?, "approval_answered"),
        0
    );
    assert_eq!(roster_state(&spade, &agent).await?["state"], "waiting");
    allow(&spade, "no_lane_answer")?;
    let (status, body) = spade.post(&path, json!({ "allowed": true })).await?;
    assert_eq!(status, 202, "{body}");
    wait_count(&spade, &lane_id, "reply_finished", 1).await?;
    assert_eq!(sent.lock().map(|c| c.len()).unwrap_or(0), 1);
    Ok(())
}

#[tokio::test]
async fn a_reply_routed_to_a_lane_lands_in_main_and_the_lane_together_or_not_at_all() -> Result {
    let routes = vec![route(
        "Fix the March invoice",
        vec![
            Script::reply("Fixed it."),
            Script::reply("Attached the PDF."),
        ],
    )];
    let mut main = warm_up();
    main.extend([
        starts("t1", "Fix the March invoice"),
        Script::reply("Started."),
        Script::reply("The invoice is fixed."),
        Script::reply("The PDF went too."),
    ]);
    let spade = Spade::start_routed(routes, main, Vec::new(), Options::default()).await?;
    let (_, conversation) = warm_bot(&spade).await?;
    spade.say(&conversation, "Fix the March invoice.").await?;
    let events = wait_count(&spade, &conversation, "reply_finished", 3).await?;
    let at = events
        .iter()
        .rposition(|e| e["type"] == "reply_finished")
        .unwrap_or_default();
    let lane_id = id_of(tasks(&spade, &conversation).await?.first());
    refuse(
        &spade,
        "no_routed",
        &format!(
            "json_extract(NEW.body, '$.type') = 'user_message' \
             AND NEW.conversation_id = '{lane_id}'"
        ),
    )?;
    let body = json!({ "text": "Attach the PDF too.", "reply_to": format!("m{}", at + 1) });
    let path = format!("/v1/conversations/{conversation}/messages");
    let (status, _) = spade.post(&path, body.clone()).await?;
    assert!(
        status >= 500,
        "the lane could not take it, so nothing was sent: {status}"
    );
    let events = spade.events(&conversation).await?;
    assert_eq!(count(&events, "ask_routed"), 0, "{:?}", types(&events));
    assert!(
        !events.iter().any(|e| e["text"] == "Attach the PDF too."),
        "main never keeps a message the lane didn't get"
    );
    allow(&spade, "no_routed")?;
    let (status, reply) = spade.post(&path, body).await?;
    assert_eq!(status, 202, "{reply}");
    let lane_events = wait_count(&spade, &lane_id, "reply_finished", 2).await?;
    assert!(
        lane_events
            .iter()
            .any(|e| e["text"] == "Attach the PDF too.")
    );
    Ok(())
}

#[tokio::test]
async fn main_steering_a_lane_reaches_it_as_the_bots_words_never_as_the_persons() -> Result {
    let routes = vec![route(
        "Fix the March invoice",
        vec![
            Script::reply("Fixing it.").held(Duration::from_millis(800)),
            Script::reply("Fixed, with Sam in copy."),
        ],
    )];
    let mut main = warm_up();
    main.extend([
        starts("t1", "Fix the March invoice"),
        Script::reply("Started."),
        Script::reply("").call(
            "m1",
            "task_message",
            json!({ "task": "Fix the March invoice", "text": "Also copy Sam." }),
        ),
        Script::reply("Told the task."),
        Script::reply("Done."),
    ]);
    let spade = Spade::start_routed(routes, main, Vec::new(), Options::default()).await?;
    let (_, conversation) = warm_bot(&spade).await?;
    spade.say(&conversation, "Fix the March invoice.").await?;
    wait_count(&spade, &conversation, "reply_finished", 2).await?;
    spade.say(&conversation, "Tell it to copy Sam.").await?;
    let lane_id = id_of(tasks(&spade, &conversation).await?.first());
    let lane_events = wait_count(&spade, &lane_id, "lane_message", 1).await?;
    let steered = lane_events
        .iter()
        .find(|e| e["type"] == "lane_message")
        .cloned()
        .unwrap_or_default();
    assert_eq!(steered["text"], "Also copy Sam.");
    let persons: Vec<&Value> = lane_events
        .iter()
        .filter(|e| e["type"] == "user_message")
        .collect();
    assert_eq!(
        persons.len(),
        1,
        "only the person's own ask reads as theirs"
    );
    assert!(!persons[0]["text"].as_str().unwrap_or("").contains("Sam"));
    // It steered the running reply: the lane's next step read it.
    let lane_events = wait_count(&spade, &lane_id, "reply_finished", 1).await?;
    assert_eq!(
        count(&lane_events, "step_finished"),
        2,
        "{:?}",
        types(&lane_events)
    );
    let read = spade
        .fake
        .seen()
        .iter()
        .rev()
        .find(|s| s.body.to_string().contains(&lane("Fix the March invoice")))
        .map(|s| s.body.to_string())
        .unwrap_or_default();
    assert!(read.contains("task_message from=\\\"bot\\\""), "{read}");
    Ok(())
}

/// A lane that asks the person without waiting, and main's copy of the card.
async fn deferred_lane_card(spade: &Spade, conversation: &str) -> Result<(String, String)> {
    spade.say(conversation, "File the receipts.").await?;
    let events = wait_count(spade, conversation, "question_deferred", 1).await?;
    let asked = events
        .iter()
        .find(|e| e["type"] == "question_asked")
        .cloned()
        .unwrap_or_default();
    let lane_id = asked["lane"]["task"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    let call = asked["call_id"].as_str().unwrap_or_default().to_owned();
    Ok((lane_id, call))
}

fn receipts() -> (Vec<Route>, Vec<Script>) {
    let routes = vec![route(
        "File the receipts",
        vec![
            Script::reply("").call(
                "q1",
                "ask_user",
                json!({ "question": "Which folder?", "wait": false }),
            ),
            Script::reply("Filing them meanwhile."),
            Script::reply("Filed in Archive."),
        ],
    )];
    let mut main = warm_up();
    main.extend([
        starts("t1", "File the receipts"),
        Script::reply("Started."),
        Script::reply("Filed."),
        Script::reply("Filed in Archive."),
    ]);
    (routes, main)
}

fn closed_in_main(events: &[Value], call: &str) -> bool {
    events
        .iter()
        .any(|e| e["type"] == "question_answered" && e["call_id"] == call)
}

#[tokio::test]
async fn a_late_answer_whose_copy_in_main_never_closed_closes_when_asked_again() -> Result {
    let (routes, main) = receipts();
    let spade = Spade::start_routed(routes, main, Vec::new(), Options::default()).await?;
    let (_, conversation) = warm_bot(&spade).await?;
    let (lane_id, call) = deferred_lane_card(&spade, &conversation).await?;
    // The answer reaches the lane; main's copy can't be closed, as if Spade died in between.
    refuse(
        &spade,
        "no_main_close",
        &format!(
            "json_extract(NEW.body, '$.type') = 'question_answered' \
             AND NEW.conversation_id = '{conversation}'"
        ),
    )?;
    let path = format!("/v1/conversations/{conversation}/questions/{call}");
    let (status, _) = spade.post(&path, json!({ "answers": ["Archive"] })).await?;
    assert_eq!(status, 202);
    wait_count(&spade, &lane_id, "question_answered", 1).await?;
    assert!(!closed_in_main(&spade.events(&conversation).await?, &call));
    allow(&spade, "no_main_close")?;
    // Asked again, main's copy closes as the lane's did, instead of a stuck card.
    let (status, body) = spade.post(&path, json!({ "answers": ["Archive"] })).await?;
    assert_eq!(status, 202, "{body}");
    assert!(closed_in_main(&spade.events(&conversation).await?, &call));
    Ok(())
}

#[tokio::test]
async fn a_late_answer_whose_copy_in_main_never_closed_closes_when_spade_opens() -> Result {
    let (routes, main) = receipts();
    let spade = Spade::start_routed(routes, main, Vec::new(), Options::default()).await?;
    let (_, conversation) = warm_bot(&spade).await?;
    let (lane_id, call) = deferred_lane_card(&spade, &conversation).await?;
    refuse(
        &spade,
        "no_main_close",
        &format!(
            "json_extract(NEW.body, '$.type') = 'question_answered' \
             AND NEW.conversation_id = '{conversation}'"
        ),
    )?;
    let path = format!("/v1/conversations/{conversation}/questions/{call}");
    let (status, _) = spade.post(&path, json!({ "answers": ["Archive"] })).await?;
    assert_eq!(status, 202);
    wait_count(&spade, &lane_id, "question_answered", 1).await?;
    allow(&spade, "no_main_close")?;
    let spade = spade
        .restart_routed(
            Vec::new(),
            vec![Script::reply("ok")],
            Vec::new(),
            Options::default(),
        )
        .await?;
    let deadline = Instant::now() + Duration::from_secs(10);
    while !closed_in_main(&spade.events(&conversation).await?, &call) {
        if Instant::now() > deadline {
            return Err("main's copy never closed".into());
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    Ok(())
}

#[tokio::test]
async fn a_lanes_failure_reports_its_error_as_untrusted_never_as_spades_words() -> Result {
    let routes = vec![route(
        "Renew the domain",
        vec![Script::failing(400), Script::failing(400)],
    )];
    let mut main = warm_up();
    main.extend([
        starts("t1", "Renew the domain"),
        Script::reply("Started."),
        Script::reply("The renewal stopped early."),
    ]);
    let spade = Spade::start_routed(routes, main, Vec::new(), Options::default()).await?;
    let (_, conversation) = warm_bot(&spade).await?;
    spade.say(&conversation, "Renew the domain.").await?;
    let events = wait_count(&spade, &conversation, "worker_reported", 1).await?;
    let report = events
        .iter()
        .find(|e| e["type"] == "worker_reported")
        .cloned()
        .unwrap_or_default();
    assert_eq!(report["state"], "failed");
    let error = report["error"].as_str().unwrap_or_default().to_owned();
    assert!(!error.is_empty(), "{report}");
    assert!(
        !report["summary"]
            .as_str()
            .unwrap_or_default()
            .contains(&error),
        "{report}"
    );
    wait_count(&spade, &conversation, "reply_finished", 3).await?;
    let read = spade
        .fake
        .seen()
        .iter()
        .rev()
        .map(|s| s.body.to_string())
        .find(|b| b.contains("task_report"))
        .unwrap_or_default();
    assert!(read.contains("worker_error untrusted"), "{read}");
    Ok(())
}

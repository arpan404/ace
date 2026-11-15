//! Question cards (ADR 0154): kinds, answers checked at the endpoint, Answer later, Never mind and
//! typed answers, through the real engine and API on a scripted fake endpoint and a real SQLite
//! file that restarts reopen.

mod support;

use std::time::Duration;

use serde_json::{Value, json};
use spade_testkit::{Script, Seen};
use support::{Result, Spade, types};

const DEFERRED: &str = "The person will answer later. Go on without it where you can, or end \
your reply saying what waits on it. Their answer will arrive as a <question_answer>.";

fn title() -> Script {
    Script::reply("").plain(r#"{"title":"Trip"}"#)
}

/// The model calls (streamed), leaving out titles.
fn turns(seen: &[Seen]) -> Vec<Value> {
    seen.iter()
        .filter(|s| s.body["stream"] == true)
        .map(|s| s.body.clone())
        .collect()
}

/// Each message's content of a model call, as text.
fn contents(body: &Value) -> Vec<String> {
    body["messages"]
        .as_array()
        .map(|m| {
            m.iter()
                .map(|m| match &m["content"] {
                    Value::String(text) => text.clone(),
                    other => other.to_string(),
                })
                .collect()
        })
        .unwrap_or_default()
}

fn last_call(spade: &Spade) -> Vec<String> {
    turns(&spade.fake.seen())
        .last()
        .map(contents)
        .unwrap_or_default()
}

fn seat_and_bags() -> Value {
    json!({ "questions": [
        { "prompt": "Window or aisle?", "kind": "choice",
          "options": [{ "label": "Window" }, { "label": "Aisle" }] },
        { "prompt": "Extras?", "kind": "choices", "options": ["Bag", "Meal", "Wifi"], "max": 2 },
        { "prompt": "How many nights?", "kind": "number", "min": 1, "max": 14, "unit": "nights" },
    ] })
}

async fn answer(spade: &Spade, chat: &str, call: &str, body: Value) -> Result<(u16, Value)> {
    spade
        .post(&format!("/v1/conversations/{chat}/questions/{call}"), body)
        .await
}

async fn ids(spade: &Spade, name: &str) -> Result<(String, String)> {
    let made = spade.new_agent(name, "").await?;
    Ok((
        made["id"].as_str().unwrap_or_default().to_owned(),
        made["conversation"].as_str().unwrap_or_default().to_owned(),
    ))
}

async fn agent(spade: &Spade, id: &str) -> Result<Value> {
    let (_, body) = spade.get("/v1/agents").await?;
    Ok(body["agents"]
        .as_array()
        .and_then(|a| a.iter().find(|a| a["id"] == id))
        .cloned()
        .unwrap_or(Value::Null))
}

/// The conversation's count of questions for later, as its list row and its agent say it.
async fn for_later(spade: &Spade, agent_id: &str, chat: &str) -> Result<(Value, Value)> {
    let (_, list) = spade.get("/v1/conversations").await?;
    let row = list
        .as_array()
        .and_then(|rows| rows.iter().find(|r| r["id"] == chat))
        .map(|r| r["questions_for_later"].clone())
        .unwrap_or(Value::Null);
    Ok((
        row,
        agent(spade, agent_id).await?["questions_for_later"].clone(),
    ))
}

fn count(events: &[Value], kind: &str) -> usize {
    events.iter().filter(|e| e["type"] == kind).count()
}

#[tokio::test]
async fn answers_breaking_the_cards_rules_are_refused_and_good_ones_resume_the_turn_after_a_restart()
-> Result {
    let spade = Spade::start(
        vec![Script::reply("").call("q1", "ask_user", seat_and_bags())],
        Vec::new(),
    )
    .await?;
    let (bot, chat) = ids(&spade, "Travel").await?;
    spade.say(&chat, "Book me a trip to Lisbon").await?;
    let events = spade.wait_for(&chat, "question_asked").await?;
    let asked = events.iter().find(|e| e["type"] == "question_asked");
    assert_eq!(
        asked.map(|e| e["questions"][1]["kind"].clone()),
        Some(json!("choices"))
    );
    assert_eq!(
        asked.map(|e| e["questions"][0]["options"][1]["label"].clone()),
        Some(json!("Aisle"))
    );
    let state = agent(&spade, &bot).await?;
    assert_eq!(
        json!([state["state"], state["waiting_for"]]),
        json!(["waiting", "question"])
    );

    let spade = spade
        .restart(
            Vec::new(),
            vec![Script::reply("Booked an aisle seat for 3 nights."), title()],
        )
        .await?;
    let stored = spade.events(&chat).await?.len();
    for (answers, why) in [
        (
            json!(["Middle", ["Bag"], 3]),
            "Question 1: \"Middle\" is not one of its options.",
        ),
        (
            json!(["Aisle", ["Bag", "Meal", "Wifi"], 3]),
            "Question 2: pick 1 to 2; this picks 3.",
        ),
        (
            json!(["Aisle", ["Bag"], 30]),
            "Question 3: 30 is above the most, 14.",
        ),
        (json!(["Aisle", null, 3]), "Question 2: it has no answer."),
        (
            json!(["Aisle"]),
            "Give one answer per question: there are 3 questions and 1 answers.",
        ),
    ] {
        let (status, body) = answer(&spade, &chat, "q1", json!({ "answers": answers })).await?;
        assert_eq!((status, body["error"].clone()), (400, json!(why)));
    }
    assert_eq!(
        spade.events(&chat).await?.len(),
        stored,
        "nothing is stored"
    );
    let (status, _) = answer(&spade, &chat, "nope", json!({ "answers": [] })).await?;
    assert_eq!(status, 409, "no such question is open");
    let (status, _) = answer(
        &spade,
        &chat,
        "q1",
        json!({ "defer": true, "dismiss": true }),
    )
    .await?;
    assert_eq!(status, 400);

    let (status, _) = answer(
        &spade,
        &chat,
        "q1",
        json!({ "answers": ["aisle", ["Wifi", "Bag"], 3.0] }),
    )
    .await?;
    assert_eq!(status, 202);
    let events = spade.wait_for(&chat, "reply_finished").await?;
    assert_eq!(count(&events, "reply_started"), 1, "{:?}", types(&events));
    let answered = events.iter().find(|e| e["type"] == "question_answered");
    assert_eq!(
        answered.map(|e| e["answers"].clone()),
        Some(json!(["Aisle", ["Bag", "Wifi"], 3]))
    );
    let shown = last_call(&spade);
    assert!(
        shown.iter().any(|m| m
            == "The person answered.\n\nWindow or aisle?\nAnswer: Aisle\n\nExtras?\nAnswer: \
                Bag, Wifi\n\nHow many nights?\nAnswer: 3 nights"),
        "{shown:?}"
    );
    let (status, _) = answer(
        &spade,
        &chat,
        "q1",
        json!({ "answers": ["Window", ["Bag"], 2] }),
    )
    .await?;
    assert_eq!(status, 409, "an answered card is not open");
    let state = agent(&spade, &bot).await?;
    assert_eq!(state["state"], "idle");
    Ok(())
}

#[tokio::test]
async fn a_typed_message_answers_a_text_question_and_is_other_text_for_an_open_choice() -> Result {
    let spade = Spade::start(
        vec![
            Script::reply("").call("q1", "ask_user", json!({ "question": "Which city?" })),
            Script::reply("Lisbon it is."),
            title(),
            Script::reply("").call(
                "q2",
                "ask_user",
                json!({ "questions": [{ "prompt": "Seat?", "kind": "choice",
                                        "options": ["Window", "Aisle"], "other": true }] }),
            ),
            Script::reply("An exit row seat."),
        ],
        Vec::new(),
    )
    .await?;
    let (_, chat) = ids(&spade, "Travel").await?;
    spade.say(&chat, "Plan a trip").await?;
    spade.wait_for(&chat, "question_asked").await?;
    spade.say(&chat, "Lisbon").await?;
    spade.wait_for(&chat, "renamed").await?;
    let shown = last_call(&spade);
    let n = shown.len();
    assert_eq!(shown[n - 2], "The person answered; their reply follows.");
    assert!(shown[n - 1].contains("Lisbon"), "{shown:?}");

    spade.say(&chat, "Book the seat").await?;
    spade.wait_for_count(&chat, "question_asked", 2).await?;
    spade.say(&chat, "Exit row").await?;
    let events = spade.wait_for_count(&chat, "reply_finished", 2).await?;
    let typed: Vec<Value> = events
        .iter()
        .filter(|e| e["type"] == "question_answered")
        .map(|e| json!([e["call_id"], e["answers"], e["typed"]]))
        .collect();
    assert_eq!(
        typed,
        vec![
            json!(["q1", ["Lisbon"], true]),
            json!(["q2", ["Exit row"], true])
        ]
    );
    let (_, cards) = spade
        .get(&format!("/v1/conversations/{chat}/questions"))
        .await?;
    assert_eq!(cards["questions"][1]["standing"], "answered");
    assert_eq!(cards["questions"][1]["answers"], json!(["Exit row"]));
    Ok(())
}

#[tokio::test]
async fn answer_later_carries_the_turn_on_and_the_late_answer_opens_one_reply_across_restarts()
-> Result {
    let spade = Spade::start(
        vec![
            Script::reply("").call("q1", "ask_user", seat_and_bags()),
            Script::reply("I'll hold the booking until you choose."),
            title(),
        ],
        Vec::new(),
    )
    .await?;
    let (bot, chat) = ids(&spade, "Travel").await?;
    spade.say(&chat, "Book me a trip").await?;
    spade.wait_for(&chat, "question_asked").await?;
    let (status, _) = answer(&spade, &chat, "q1", json!({ "defer": true })).await?;
    assert_eq!(status, 202);
    let events = spade.wait_for(&chat, "renamed").await?;
    let result = events
        .iter()
        .find(|e| e["type"] == "tool_finished" && e["call_id"] == "q1");
    assert_eq!(result.map(|e| e["content"].clone()), Some(json!(DEFERRED)));
    assert_eq!(count(&events, "reply_finished"), 1, "the turn carried on");
    assert_eq!(agent(&spade, &bot).await?["state"], "idle");
    assert_eq!(for_later(&spade, &bot, &chat).await?, (json!(1), json!(1)));
    let (status, _) = answer(&spade, &chat, "q1", json!({ "defer": true })).await?;
    assert_eq!(status, 409, "already left for later");

    let spade = spade
        .restart(
            Vec::new(),
            vec![Script::reply("Booked: aisle, a bag, 2 nights.")],
        )
        .await?;
    assert_eq!(
        for_later(&spade, &bot, &chat).await?,
        (json!(1), json!(1)),
        "the count is taken from the stored events"
    );
    let (status, _) = answer(
        &spade,
        &chat,
        "q1",
        json!({ "answers": ["Aisle", ["Bag"], 2] }),
    )
    .await?;
    assert_eq!(status, 202);
    let events = spade.wait_for_count(&chat, "reply_finished", 2).await?;
    assert_eq!(count(&events, "reply_started"), 2, "{:?}", types(&events));
    let late = events.iter().find(|e| e["type"] == "question_answered");
    assert_eq!(late.map(|e| e["late"].clone()), Some(json!(true)));
    let shown = last_call(&spade);
    assert_eq!(
        shown.last().map(String::as_str),
        Some(
            "<question_answer call=\"q1\">\nWindow or aisle?\nAnswer: Aisle\n\nExtras?\nAnswer: \
             Bag\n\nHow many nights?\nAnswer: 2 nights\n</question_answer>"
        )
    );
    assert_eq!(for_later(&spade, &bot, &chat).await?, (json!(0), json!(0)));
    let (status, _) = answer(
        &spade,
        &chat,
        "q1",
        json!({ "answers": ["Aisle", ["Bag"], 2] }),
    )
    .await?;
    assert_eq!(status, 409, "delivered once");

    let stored = spade.events(&chat).await?;
    let spade = spade.restart(Vec::new(), Vec::new()).await?;
    tokio::time::sleep(Duration::from_millis(300)).await;
    let after = spade.events(&chat).await?;
    assert_eq!(
        after.len(),
        stored.len(),
        "a restart delivers nothing again"
    );
    assert_eq!(turns(&spade.fake.seen()).len(), 0);
    Ok(())
}

#[tokio::test]
async fn asking_without_waiting_never_pauses_and_a_late_answer_steers_the_open_reply() -> Result {
    let spade = Spade::start(
        vec![
            Script::reply("").call(
                "q1",
                "ask_user",
                json!({ "questions": [{ "prompt": "Any airline you avoid?", "kind": "text" }],
                        "wait": false }),
            ),
            // Still streaming when the answer comes.
            Script::reply(&"searching ".repeat(30))
                .chunks(30)
                .delay(Duration::from_millis(30)),
            Script::reply("Found flights, none on Skyways."),
            title(),
        ],
        Vec::new(),
    )
    .await?;
    let (bot, chat) = ids(&spade, "Travel").await?;
    spade.say(&chat, "Find flights").await?;
    let events = spade.wait_for(&chat, "tool_finished").await?;
    let deferred = events.iter().find(|e| e["type"] == "question_deferred");
    assert_eq!(deferred.map(|e| e["by_bot"].clone()), Some(json!(true)));
    assert_ne!(agent(&spade, &bot).await?["state"], "waiting");
    let (status, _) = answer(&spade, &chat, "q1", json!({ "answers": ["Skyways"] })).await?;
    assert_eq!(status, 202);
    let events = spade.wait_for(&chat, "renamed").await?;
    assert_eq!(count(&events, "reply_started"), 1, "{:?}", types(&events));
    let finished = events.iter().find(|e| e["type"] == "reply_finished");
    assert_eq!(
        finished.map(|e| e["text"].clone()),
        Some(json!("Found flights, none on Skyways."))
    );
    let shown = last_call(&spade);
    assert!(
        shown.iter().any(|m| m.contains(
            "<question_answer call=\"q1\">\nAny airline you avoid?\nAnswer: Skyways\n</question_answer>"
        )),
        "{shown:?}"
    );
    Ok(())
}

#[tokio::test]
async fn a_dismissed_waiting_question_and_a_dismissed_deferred_one_each_reach_the_bot_once()
-> Result {
    let later = json!({ "question": "Hotel budget?", "wait": false });
    let now = json!({ "questions": [{ "prompt": "Go ahead?", "kind": "confirm" }] });
    let spade = Spade::start(
        vec![
            Script::reply("")
                .call("q1", "ask_user", later)
                .call("q2", "ask_user", now),
            Script::reply("Leaving it, then."),
            title(),
            Script::reply("I'll pick a mid-range hotel."),
        ],
        Vec::new(),
    )
    .await?;
    let (bot, chat) = ids(&spade, "Travel").await?;
    spade.say(&chat, "Plan the hotel").await?;
    spade.wait_for_count(&chat, "question_asked", 2).await?;
    let (status, _) = answer(&spade, &chat, "q2", json!({ "dismiss": true })).await?;
    assert_eq!(status, 202);
    spade.wait_for(&chat, "renamed").await?;
    assert_eq!(for_later(&spade, &bot, &chat).await?, (json!(1), json!(1)));
    let (status, _) = answer(&spade, &chat, "q1", json!({ "dismiss": true })).await?;
    assert_eq!(status, 202);
    let events = spade.wait_for_count(&chat, "reply_finished", 2).await?;
    assert_eq!(count(&events, "question_dismissed"), 2);
    let shown = last_call(&spade).join("\n");
    assert_eq!(
        shown.matches("The person dismissed this question.").count(),
        2,
        "once as q2's result, once delivered for q1: {shown}"
    );
    assert!(shown.contains("<question_answer call=\"q1\">\nThe person dismissed this question."));
    assert_eq!(for_later(&spade, &bot, &chat).await?, (json!(0), json!(0)));
    let (status, _) = answer(&spade, &chat, "q1", json!({ "dismiss": true })).await?;
    assert_eq!(status, 409);
    Ok(())
}

#[tokio::test]
async fn a_call_that_breaks_a_rule_is_refused_saying_which_and_nothing_waits() -> Result {
    let spade = Spade::start(
        vec![
            Script::reply("").call(
                "q1",
                "ask_user",
                json!({ "questions": [{ "prompt": "Pick", "kind": "slider" }] }),
            ),
            Script::reply("Sorry, asking differently."),
            title(),
        ],
        Vec::new(),
    )
    .await?;
    let (_, chat) = ids(&spade, "Travel").await?;
    spade.say(&chat, "Plan").await?;
    let events = spade.wait_for(&chat, "reply_finished").await?;
    assert_eq!(count(&events, "question_asked"), 0);
    let refused = events
        .iter()
        .find(|e| e["type"] == "tool_finished" && e["call_id"] == "q1");
    assert_eq!(refused.map(|e| e["is_error"].clone()), Some(json!(true)));
    let why = refused
        .and_then(|e| e["content"].as_str())
        .unwrap_or_default();
    assert!(why.contains("no kind \"slider\""), "{why}");
    Ok(())
}

//! Task lanes (ADR 0217) through the real API with a scripted model: main starts each
//! independent request as a lane of its own, answers quick things itself, routes a reply to the
//! lane it answers, and hears back when a lane ends.
//!
//! A lane's model calls are told apart by the words Spade gives it about its task, so each lane
//! takes its own scripts (`Route`) whatever order the calls arrive in; main takes the rest.

mod support;

use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use spade_core::tools::Risk;
use spade_server::engine::Limits;
use spade_server::tools::Tool;
use spade_testkit::{Route, Script};
use support::{FakeTool, Options, Result, Spade, types};

fn title() -> Script {
    Script::reply("").plain(r#"{"title":"Errands"}"#)
}

/// The first turn and its title, so no title call races a lane's calls later.
fn warm_up() -> Vec<Script> {
    vec![Script::reply("Hello."), title()]
}

/// The words only a lane's own calls carry: what Spade tells it about its task.
fn lane(title: &str) -> String {
    format!("one task for the person: {title}.")
}

fn route(title: &str, scripts: Vec<Script>) -> Route {
    Route::when(&lane(title), scripts)
}

/// Main's step that starts a lane for the person's latest ask.
fn starts(id: &str, title: &str) -> Script {
    Script::reply("").call(
        id,
        "task_start",
        json!({ "title": title, "brief": "Done when it is sent." }),
    )
}

fn tools(list: Vec<FakeTool>) -> Vec<Arc<dyn Tool>> {
    list.into_iter()
        .map(|tool| Arc::new(tool) as Arc<dyn Tool>)
        .collect()
}

fn with(limits: Limits) -> Options {
    Options {
        limits,
        ..Default::default()
    }
}

/// A bot that has had its first turn: its id and conversation.
async fn warm_bot(spade: &Spade) -> Result<(String, String)> {
    let agent = spade.new_agent("Errands", "").await?;
    let id = agent["id"].as_str().unwrap_or_default().to_owned();
    let conversation = agent["conversation"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    spade.say(&conversation, "Hi").await?;
    spade.wait_for(&conversation, "renamed").await?;
    Ok((id, conversation))
}

async fn roster_state(spade: &Spade, agent: &str) -> Result<Value> {
    let (_, body) = spade.get("/v1/agents").await?;
    body["agents"]
        .as_array()
        .and_then(|list| list.iter().find(|a| a["id"] == agent).cloned())
        .ok_or_else(|| "the bot is not in the roster".into())
}

async fn tasks(spade: &Spade, conversation: &str) -> Result<Vec<Value>> {
    let (status, body) = spade
        .get(&format!("/v1/conversations/{conversation}/tasks"))
        .await?;
    assert_eq!(status, 200, "{body}");
    Ok(body["tasks"].as_array().cloned().unwrap_or_default())
}

/// Waits until the conversation's lanes satisfy `test`.
async fn wait_tasks(
    spade: &Spade,
    conversation: &str,
    test: impl Fn(&[Value]) -> bool,
) -> Result<Vec<Value>> {
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        let found = tasks(spade, conversation).await?;
        if test(&found) {
            return Ok(found);
        }
        if Instant::now() > deadline {
            return Err(format!("the tasks never got there: {found:#?}").into());
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

/// Waits until `count` events of type `kind` are stored, for up to 20 seconds.
async fn wait_count(spade: &Spade, id: &str, kind: &str, count: usize) -> Result<Vec<Value>> {
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        let events = spade.events(id).await?;
        if events.iter().filter(|e| e["type"] == kind).count() >= count {
            return Ok(events);
        }
        if Instant::now() > deadline {
            return Err(format!("no {count} {kind}: {:?}", types(&events)).into());
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

fn count(events: &[Value], kind: &str) -> usize {
    events.iter().filter(|e| e["type"] == kind).count()
}

fn titled<'a>(found: &'a [Value], title: &str) -> Option<&'a Value> {
    found.iter().find(|t| t["title"] == title)
}

fn id_of(task: Option<&Value>) -> String {
    task.and_then(|t| t["task"].as_str())
        .unwrap_or_default()
        .to_owned()
}

#[tokio::test]
async fn two_independent_requests_run_as_two_lanes_while_main_answers_a_quick_question() -> Result {
    let routes = vec![
        route(
            "Fix the March invoice",
            vec![Script::reply("The invoice is fixed and sent.").held(Duration::from_secs(3))],
        ),
        route(
            "Draft the quarterly note",
            vec![Script::reply("The note is drafted.").held(Duration::from_secs(3))],
        ),
    ];
    let mut main = warm_up();
    main.extend([
        starts("t1", "Fix the March invoice"),
        Script::reply("Started a task for the invoice."),
        starts("t2", "Draft the quarterly note"),
        Script::reply("Started a task for the note."),
        Script::reply("It's 14:05 in Lisbon."),
        Script::reply("Done: the invoice went to Dana."),
        Script::reply("Done: the note is in your folder."),
    ]);
    let spade = Spade::start_routed(routes, main, Vec::new(), Options::default()).await?;
    let (agent, conversation) = warm_bot(&spade).await?;
    spade
        .say(&conversation, "Fix the March invoice and send it to Dana.")
        .await?;
    wait_count(&spade, &conversation, "reply_finished", 2).await?;
    spade
        .say(&conversation, "Draft the quarterly note too.")
        .await?;
    wait_count(&spade, &conversation, "reply_finished", 3).await?;
    spade
        .say(&conversation, "What time is it in Lisbon?")
        .await?;
    let events = wait_count(&spade, &conversation, "reply_finished", 4).await?;
    let answered = events
        .iter()
        .rev()
        .find(|e| e["type"] == "reply_finished")
        .cloned()
        .unwrap_or_default();
    assert_eq!(answered["text"], "It's 14:05 in Lisbon.");

    // Main answered while both tasks still worked, side by side, and the bot reads working.
    let running = tasks(&spade, &conversation).await?;
    let states: Vec<(&str, &str)> = running
        .iter()
        .map(|t| {
            (
                t["title"].as_str().unwrap_or_default(),
                t["state"].as_str().unwrap_or_default(),
            )
        })
        .collect();
    assert_eq!(
        states,
        [
            ("Fix the March invoice", "working"),
            ("Draft the quarterly note", "working")
        ],
        "{running:#?}"
    );
    let row = roster_state(&spade, &agent).await?;
    assert_eq!(row["state"], "working", "{row}");
    assert_eq!(row["tasks"], 2, "{row}");
    // A lane's goal reads like a bot's; main is no lane.
    let lane_id = running[0]["conversation"].as_str().unwrap_or_default();
    let (status, body) = spade
        .get(&format!("/v1/conversations/{lane_id}/task"))
        .await?;
    assert_eq!((status, body["task"].clone()), (200, Value::Null), "{body}");
    let (status, _) = spade
        .get(&format!("/v1/conversations/{conversation}/task"))
        .await?;
    assert_eq!(status, 404);

    // Each lane hears only its own ask, never the quick question or the other task.
    for task in &running {
        let lane_events = spade
            .events(task["conversation"].as_str().unwrap_or(""))
            .await?;
        let text = Value::Array(lane_events).to_string();
        assert!(!text.contains("Lisbon"), "{text}");
        let other = if task["title"] == "Fix the March invoice" {
            "quarterly"
        } else {
            "invoice"
        };
        assert!(!text.contains(other), "{text}");
    }

    // Both report back once, each opening one short reply in main, and the bot reads idle only
    // once both have ended and main has told the person.
    let mut seen_working_late = false;
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        let now = roster_state(&spade, &agent).await?;
        let events = spade.events(&conversation).await?;
        let reports = count(&events, "worker_reported");
        if now["state"] == "idle" {
            assert_eq!(
                reports,
                2,
                "idle before both tasks reported: {:?}",
                types(&events)
            );
            assert_eq!(
                count(&events, "reply_started"),
                count(&events, "reply_finished")
            );
            break;
        }
        seen_working_late |= reports < 2;
        if Instant::now() > deadline {
            return Err(format!("never idle: {:?}", types(&events)).into());
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(seen_working_late);
    let ended = tasks(&spade, &conversation).await?;
    assert!(ended.iter().all(|t| t["state"] == "finished"), "{ended:#?}");
    Ok(())
}

#[tokio::test]
async fn a_reply_to_a_lanes_report_goes_to_that_lane_with_no_model_call_in_main() -> Result {
    let routes = vec![route(
        "Fix the March invoice",
        vec![
            Script::reply("Fixed the VAT line and sent it."),
            Script::reply("Attached the PDF and sent it again."),
        ],
    )];
    let mut main = warm_up();
    main.extend([
        starts("t1", "Fix the March invoice"),
        Script::reply("Started a task for it."),
        Script::reply("The invoice is fixed and sent to Dana."),
        Script::reply("Done again: the PDF went too."),
    ]);
    let spade = Spade::start_routed(routes, main, Vec::new(), Options::default()).await?;
    let (_, conversation) = warm_bot(&spade).await?;
    spade.say(&conversation, "Fix the March invoice.").await?;
    // The lane reports, and main tells the person in its own words.
    let events = wait_count(&spade, &conversation, "reply_finished", 3).await?;
    let (at, told) = events
        .iter()
        .enumerate()
        .rev()
        .find(|(_, e)| e["type"] == "reply_finished")
        .ok_or("no report reply")?;
    assert_eq!(told["text"], "The invoice is fixed and sent to Dana.");
    let lane_id = id_of(tasks(&spade, &conversation).await?.first());
    let asked_before = spade.fake.seen().len();
    let replies_before = count(&events, "reply_started");

    let (status, body) = spade
        .post(
            &format!("/v1/conversations/{conversation}/messages"),
            json!({ "text": "Attach the PDF too.", "reply_to": format!("m{}", at + 1) }),
        )
        .await?;
    assert_eq!(status, 202, "{body}");
    // The lane takes it as the person's message and answers in its own context.
    let lane_events = wait_count(&spade, &lane_id, "reply_finished", 2).await?;
    let heard = lane_events
        .iter()
        .rev()
        .find(|e| e["type"] == "user_message")
        .cloned()
        .unwrap_or_default();
    assert_eq!(heard["text"], "Attach the PDF too.");
    assert!(heard.get("from_agent").is_none(), "the person's own words");
    // Main kept the person's bubble with where it went, and called no model for it: the one
    // call since was the lane's.
    let events = spade.events(&conversation).await?;
    let routed = events
        .iter()
        .find(|e| e["type"] == "ask_routed")
        .cloned()
        .ok_or("main never said where the message went")?;
    assert_eq!(routed["lane"], lane_id.as_str());
    assert_eq!(routed["title"], "Fix the March invoice");
    let at = events
        .iter()
        .position(|e| e["type"] == "ask_routed")
        .unwrap_or_default();
    assert_eq!(events[at - 1]["type"], "user_message");
    assert_eq!(events[at - 1]["text"], "Attach the PDF too.");
    // The lane's model call answered it; main's next reply is the one the lane's second report
    // opens, never one for the message itself.
    assert!(
        spade.fake.seen()[asked_before]
            .body
            .to_string()
            .contains(&lane("Fix the March invoice")),
        "main made a model call for the routed message"
    );
    let events = wait_count(&spade, &conversation, "worker_reported", 2).await?;
    let opened = events[at..]
        .iter()
        .position(|e| e["type"] == "reply_started")
        .map(|n| at + n);
    let reported = events[at..]
        .iter()
        .position(|e| e["type"] == "worker_reported")
        .map(|n| at + n);
    assert!(
        opened.is_none_or(|opened| reported.is_some_and(|r| r < opened)),
        "{:?}",
        types(&events)
    );
    assert_eq!(count(&events[..at], "reply_started"), replies_before);
    // When main next answers, it reads where the message went, so it never answers it itself.
    wait_count(&spade, &conversation, "reply_finished", replies_before + 1).await?;
    let mains_next = spade
        .fake
        .seen()
        .into_iter()
        .rev()
        .find(|s| !s.body.to_string().contains(&lane("Fix the March invoice")))
        .map(|s| s.body.to_string())
        .unwrap_or_default();
    assert!(mains_next.contains("<routed task="), "{mains_next}");
    Ok(())
}

#[tokio::test]
async fn the_seventeenth_lane_queues_and_starts_when_one_ends() -> Result {
    let names: Vec<String> = (1..=17).map(|n| format!("Errand {n:02}")).collect();
    let mut routes = vec![route(
        &names[0],
        vec![Script::reply("Errand one is done.").held(Duration::from_millis(1500))],
    )];
    for name in &names[1..] {
        routes.push(route(
            name,
            vec![Script::reply("still going").held(Duration::from_secs(30))],
        ));
    }
    let mut start = Script::reply("");
    for (n, name) in names.iter().enumerate() {
        start = start.call(
            &format!("t{n}"),
            "task_start",
            json!({ "title": name, "brief": "Run the errand." }),
        );
    }
    let mut main = warm_up();
    main.extend([start, Script::reply("Started 17 errands.")]);
    let spade = Spade::start_routed(routes, main, Vec::new(), Options::default()).await?;
    let (_, conversation) = warm_bot(&spade).await?;
    spade.say(&conversation, "Run my 17 errands.").await?;

    let found = wait_tasks(&spade, &conversation, |t| t.len() == 17).await?;
    let queued: Vec<&str> = found
        .iter()
        .filter(|t| t["state"] == "queued")
        .filter_map(|t| t["title"].as_str())
        .collect();
    assert_eq!(queued, ["Errand 17"], "16 run at once: {found:#?}");
    assert_eq!(found.last().map(|t| &t["title"]), Some(&json!("Errand 17")));
    // Main said it was queued: its start was stored so.
    let events = spade.events(&conversation).await?;
    let started = events
        .iter()
        .find(|e| e["type"] == "lane_started" && e["title"] == "Errand 17")
        .cloned()
        .unwrap_or_default();
    assert_eq!(started["queued"], true);

    // Errand 01 ends; the queued one takes its slot.
    let found = wait_tasks(&spade, &conversation, |t| {
        titled(t, "Errand 17").is_some_and(|e| e["state"] == "working")
    })
    .await?;
    assert_eq!(
        titled(&found, "Errand 01").map(|t| &t["state"]),
        Some(&json!("finished"))
    );
    assert_eq!(found.iter().filter(|t| t["state"] == "queued").count(), 0);
    Ok(())
}

#[tokio::test]
async fn mains_long_work_moves_to_a_lane_and_carries_on_there_from_the_same_step() -> Result {
    let read = FakeTool::new("read_sheet", Risk::Read, "Q3 revenue: 1.2M");
    let mut main = warm_up();
    for n in 0..8 {
        main.push(Script::reply("").call(&format!("s{n}"), "read_sheet", json!({ "n": n })));
    }
    main.push(Script::reply("The note is drafted, every number checked."));
    let routes = vec![route(
        "Draft the quarterly note from Q3",
        vec![Script::reply("Drafted the note from all eight reads.").held(Duration::from_secs(2))],
    )];
    let options = with(Limits {
        move_long_work: true,
        ..Default::default()
    });
    let spade = Spade::start_routed(routes, main, tools(vec![read]), options).await?;
    let (agent, conversation) = warm_bot(&spade).await?;
    spade
        .say(&conversation, "Draft the quarterly note from Q3.xlsx")
        .await?;

    let events = wait_count(&spade, &conversation, "reply_moved", 1).await?;
    let moved = events
        .iter()
        .find(|e| e["type"] == "reply_moved")
        .cloned()
        .unwrap_or_default();
    assert_eq!(moved["title"], "Draft the quarterly note from Q3.xlsx");
    let reply = moved["reply"].as_str().unwrap_or_default().to_owned();
    // Main's reply closed with the move, in the same write, with no words of the model's.
    let at = events
        .iter()
        .position(|e| e["type"] == "reply_moved")
        .unwrap_or_default();
    assert_eq!(events[at + 1]["type"], "reply_finished");
    assert_eq!(events[at + 1]["reply"], reply.as_str());
    assert_eq!(events[at + 1]["text"], "");
    let row = roster_state(&spade, &agent).await?;
    assert_ne!(row["state"], "idle", "never idle while the moved work runs");

    // The lane carries on the same reply from the ninth step, with all eight results.
    let lane_id = moved["lane"].as_str().unwrap_or_default().to_owned();
    let lane_events = wait_count(&spade, &lane_id, "reply_finished", 1).await?;
    assert_eq!(lane_events[0]["type"], "lane_of");
    assert_eq!(lane_events[0]["moved_from"], reply.as_str());
    assert_eq!(count(&lane_events, "reply_started"), 1);
    assert_eq!(count(&lane_events, "step_finished"), 9);
    assert_eq!(count(&lane_events, "tool_finished"), 8);
    let last = lane_events
        .iter()
        .rev()
        .find(|e| e["type"] == "reply_finished")
        .cloned()
        .unwrap_or_default();
    assert_eq!(last["reply"], reply.as_str());
    assert_eq!(last["text"], "Drafted the note from all eight reads.");
    let found = tasks(&spade, &conversation).await?;
    assert_eq!(found[0]["moved"], true);

    // It reports back to main, which tells the person.
    let events = wait_count(&spade, &conversation, "worker_reported", 1).await?;
    let report = events
        .iter()
        .find(|e| e["type"] == "worker_reported")
        .cloned()
        .unwrap_or_default();
    assert_eq!(report["kind"], "lane");
    assert_eq!(report["worker"], lane_id.as_str());
    Ok(())
}

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
async fn stop_on_a_lane_stops_only_that_lane() -> Result {
    let routes = vec![
        route(
            "Book flights to Lisbon",
            vec![Script::reply("never").held(Duration::from_secs(30))],
        ),
        route(
            "Clean up the shared drive",
            vec![Script::reply("Cleaned up.").held(Duration::from_secs(2))],
        ),
    ];
    let mut main = warm_up();
    main.extend([
        Script::reply("")
            .call(
                "t1",
                "task_start",
                json!({ "title": "Book flights to Lisbon", "brief": "" }),
            )
            .call(
                "t2",
                "task_start",
                json!({ "title": "Clean up the shared drive", "brief": "" }),
            ),
        Script::reply("Started both."),
        Script::reply("The drive is clean."),
    ]);
    let spade = Spade::start_routed(routes, main, Vec::new(), Options::default()).await?;
    let (_, conversation) = warm_bot(&spade).await?;
    spade
        .say(
            &conversation,
            "Book flights to Lisbon and clean up the drive.",
        )
        .await?;
    let found = wait_tasks(&spade, &conversation, |t| {
        t.len() == 2 && t.iter().all(|t| t["state"] == "working")
    })
    .await?;
    let flights = id_of(titled(&found, "Book flights to Lisbon"));
    let replies_before = count(&spade.events(&conversation).await?, "reply_started");
    let (status, body) = spade
        .post(&format!("/v1/conversations/{flights}/stop"), json!({}))
        .await?;
    assert_eq!(status, 202, "{body}");
    let found = wait_tasks(&spade, &conversation, |t| {
        titled(t, "Book flights to Lisbon").is_some_and(|f| f["state"] == "stopped")
    })
    .await?;
    assert_eq!(
        titled(&found, "Clean up the shared drive").map(|t| &t["state"]),
        Some(&json!("working")),
        "the other task carries on"
    );
    // The stop is reported to main and opens no reply there; the other lane's report does.
    let events = wait_count(&spade, &conversation, "worker_reported", 2).await?;
    let stopped = events
        .iter()
        .find(|e| e["type"] == "worker_reported" && e["state"] == "stopped")
        .cloned()
        .unwrap_or_default();
    assert_eq!(stopped["worker"], flights.as_str());
    let events = wait_count(&spade, &conversation, "reply_finished", replies_before + 1).await?;
    assert_eq!(count(&events, "reply_started"), replies_before + 1);
    Ok(())
}

#[tokio::test]
async fn a_lane_cut_off_by_a_restart_resumes_its_step_and_reports_once() -> Result {
    let routes = vec![route(
        "Renew the domain",
        vec![Script::reply("never").held(Duration::from_secs(30))],
    )];
    let mut main = warm_up();
    main.extend([starts("t1", "Renew the domain"), Script::reply("On it.")]);
    let spade = Spade::start_routed(routes, main, Vec::new(), Options::default()).await?;
    let (agent, conversation) = warm_bot(&spade).await?;
    spade.say(&conversation, "Renew the domain.").await?;
    let found = wait_tasks(&spade, &conversation, |t| {
        t.first().is_some_and(|t| t["state"] == "working")
    })
    .await?;
    let lane_id = id_of(found.first());
    wait_count(&spade, &conversation, "reply_finished", 2).await?;
    // Its step is asked for before Spade goes away.
    let deadline = Instant::now() + Duration::from_secs(10);
    while !spade
        .fake
        .seen()
        .iter()
        .any(|s| s.body.to_string().contains(&lane("Renew the domain")))
    {
        if Instant::now() > deadline {
            return Err("the lane's step was never asked for".into());
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }

    let spade = spade
        .restart_routed(
            vec![route(
                "Renew the domain",
                vec![Script::reply("Renewed for a year.")],
            )],
            vec![Script::reply("The domain is renewed.")],
            Vec::new(),
            Options::default(),
        )
        .await?;
    let lane_events = wait_count(&spade, &lane_id, "reply_finished", 1).await?;
    assert_eq!(
        count(&lane_events, "reply_started"),
        1,
        "the same reply carried on"
    );
    assert_eq!(count(&lane_events, "reply_interrupted"), 0);
    let events = wait_count(&spade, &conversation, "worker_reported", 1).await?;
    wait_count(&spade, &conversation, "reply_finished", 3).await?;
    // Every lane is checked again as Spade opens; the report still arrives once.
    tokio::time::sleep(Duration::from_millis(500)).await;
    let events_now = spade.events(&conversation).await?;
    assert_eq!(
        count(&events_now, "worker_reported"),
        1,
        "{:?}",
        types(&events)
    );
    let row = roster_state(&spade, &agent).await?;
    assert_eq!(row["tasks"], 0);
    Ok(())
}

#[tokio::test]
async fn a_lanes_steps_run_on_the_task_roles_model_and_on_mains_when_unset() -> Result {
    let routes = vec![
        route("Tidy the notes", vec![Script::reply("Tidied.")]),
        route("Sort the inbox", vec![Script::reply("Sorted.")]),
    ];
    let mut main = warm_up();
    main.extend([
        starts("t1", "Tidy the notes"),
        Script::reply("Started."),
        Script::reply("Tidied."),
        starts("t2", "Sort the inbox"),
        Script::reply("Started."),
        Script::reply("Sorted."),
    ]);
    let spade = Spade::start_routed(routes, main, Vec::new(), Options::default()).await?;
    let (agent, conversation) = warm_bot(&spade).await?;
    let model_of = |words: &str| {
        spade
            .fake
            .seen()
            .iter()
            .find(|s| s.body.to_string().contains(words))
            .and_then(|s| s.body["model"].as_str().map(str::to_owned))
    };
    spade.say(&conversation, "Tidy the notes.").await?;
    wait_count(&spade, &conversation, "worker_reported", 1).await?;
    let main_model = spade.fake.seen()[0].body["model"].clone();
    assert_eq!(
        model_of(&lane("Tidy the notes")).map(Value::from),
        Some(main_model),
        "unset, a task runs on main's model"
    );

    let (status, body) = spade
        .post(
            "/v1/endpoints/fake/models",
            json!({ "id": "tasker", "capabilities": ["tools"] }),
        )
        .await?;
    assert!(status < 300, "{body}");
    let (status, body) = spade
        .put(
            &format!("/v1/agents/{agent}/models"),
            json!({ "roles": { "task": "fake/tasker" }, "efforts": { "task": "high" } }),
        )
        .await?;
    assert_eq!(status, 200, "{body}");
    let (_, view) = spade.get(&format!("/v1/agents/{agent}/models")).await?;
    let role = view["roles"]
        .as_array()
        .and_then(|roles| roles.iter().find(|r| r["role"] == "task").cloned())
        .unwrap_or_default();
    assert_eq!(role["model"], "fake/tasker", "{view}");
    assert_eq!(role["source"], "bot");
    assert_eq!(role["effort"], "high");
    spade.say(&conversation, "Sort the inbox.").await?;
    wait_count(&spade, &conversation, "worker_reported", 2).await?;
    assert_eq!(model_of(&lane("Sort the inbox")).as_deref(), Some("tasker"));
    Ok(())
}

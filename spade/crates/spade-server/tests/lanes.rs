//! Task lanes (ADR 0217) through the real API with a scripted model: main starts each independent
//! request as a lane of its own, answers quick things itself, routes a reply to the lane it
//! answers, and hears back when a lane ends.

mod support;

use std::time::{Duration, Instant};

use serde_json::{Value, json};
use spade_core::tools::Risk;
use spade_testkit::Script;
use support::lanes::*;
use support::{FakeTool, Options, Result, Spade, types};

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
    // Each card says in one line what its task will do.
    assert!(
        running.iter().all(|t| t["brief"]
            .as_str()
            .is_some_and(|b| !b.is_empty() && !b.contains('\n'))),
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

#[tokio::test]
async fn try_again_on_a_failed_lane_answers_its_last_reply_again() -> Result {
    let routes = vec![route(
        "Renew the domain",
        // Refused twice: once, and once more when Spade sends the step again.
        vec![
            Script::failing(400),
            Script::failing(400),
            Script::reply("Renewed for a year."),
        ],
    )];
    let mut main = warm_up();
    main.extend([
        starts("t1", "Renew the domain"),
        Script::reply("Started."),
        Script::reply("The renewal failed."),
        Script::reply("The domain is renewed."),
    ]);
    let spade = Spade::start_routed(routes, main, Vec::new(), Options::default()).await?;
    let (_, conversation) = warm_bot(&spade).await?;
    spade.say(&conversation, "Renew the domain.").await?;
    let found = wait_tasks(&spade, &conversation, |t| {
        t.first().is_some_and(|t| t["state"] == "failed")
    })
    .await?;
    let lane_id = id_of(found.first());
    let events = spade.events(&lane_id).await?;
    let failed = events
        .iter()
        .find(|e| e["type"] == "reply_failed")
        .cloned()
        .unwrap_or_default();
    let reply = failed["reply"].as_str().unwrap_or_default();
    let (status, body) = spade
        .post(
            &format!("/v1/conversations/{lane_id}/retry"),
            json!({ "reply": reply }),
        )
        .await?;
    assert_eq!(status, 202, "{body}");
    let found = wait_tasks(&spade, &conversation, |t| {
        t.first().is_some_and(|t| t["state"] == "finished")
    })
    .await?;
    assert_eq!(found[0]["report"], "Renewed for a year.");
    let reports: Vec<String> = wait_count(&spade, &conversation, "worker_reported", 2)
        .await?
        .iter()
        .filter(|e| e["type"] == "worker_reported")
        .filter_map(|e| e["state"].as_str().map(str::to_owned))
        .collect();
    assert_eq!(reports, ["failed", "finished"]);
    Ok(())
}

#[tokio::test]
async fn a_lane_writing_a_file_another_working_lane_wrote_gets_a_note_and_main_a_line() -> Result {
    // A stand-in for the folder's write tool that the gate lets run, so the test is about the
    // note and not the approval.
    let write = FakeTool::new("workspace_write", Risk::Read, "written");
    let routes = vec![
        route(
            "Compare the CRM quotes",
            vec![
                Script::reply("").call(
                    "w1",
                    "workspace_write",
                    json!({ "path": "crm.md", "content": "a" }),
                ),
                Script::reply("still comparing").held(Duration::from_secs(10)),
            ],
        ),
        route(
            "Summarise the CRM quotes",
            vec![
                Script::reply("")
                    .call(
                        "w1",
                        "workspace_write",
                        json!({ "path": "./crm.md", "content": "b" }),
                    )
                    .held(Duration::from_secs(1)),
                Script::reply("Summarised."),
            ],
        ),
    ];
    let mut main = warm_up();
    main.extend([
        Script::reply("")
            .call(
                "t1",
                "task_start",
                json!({ "title": "Compare the CRM quotes" }),
            )
            .call(
                "t2",
                "task_start",
                json!({ "title": "Summarise the CRM quotes" }),
            ),
        Script::reply("Started both."),
        Script::reply("The summary is done."),
    ]);
    let spade = Spade::start_routed(routes, main, tools(vec![write]), Options::default()).await?;
    let (_, conversation) = warm_bot(&spade).await?;
    spade
        .say(&conversation, "Compare the CRM quotes and summarise them.")
        .await?;
    let events = wait_count(&spade, &conversation, "lanes_overlapped", 1).await?;
    let noted = events
        .iter()
        .find(|e| e["type"] == "lanes_overlapped")
        .cloned()
        .unwrap_or_default();
    assert_eq!(noted["path"], "crm.md");
    assert_eq!(noted["title"], "Summarise the CRM quotes");
    assert_eq!(noted["other_title"], "Compare the CRM quotes");
    // The writing lane's next step reads the warning; nothing stopped either lane.
    let summary = noted["lane"].as_str().unwrap_or_default().to_owned();
    wait_count(&spade, &summary, "reply_finished", 1).await?;
    let warned = spade.fake.seen().iter().any(|s| {
        let body = s.body.to_string();
        body.contains(&lane("Summarise the CRM quotes")) && body.contains("<overlap task=")
    });
    assert!(warned, "the second lane never read the note");
    let found = tasks(&spade, &conversation).await?;
    assert_eq!(
        titled(&found, "Compare the CRM quotes").map(|t| &t["state"]),
        Some(&json!("working"))
    );
    assert_eq!(
        count(&spade.events(&conversation).await?, "lanes_overlapped"),
        1
    );
    Ok(())
}

#[tokio::test]
async fn ended_lanes_leave_the_live_index_come_back_when_reopened_and_page_in_the_list() -> Result {
    let routes = vec![
        route(
            "Tidy the notes",
            vec![Script::reply("Tidied."), Script::reply("Tidied again.")],
        ),
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
        Script::reply("Tidied again."),
    ]);
    let spade = Spade::start_routed(routes, main, Vec::new(), Options::default()).await?;
    let (_, conversation) = warm_bot(&spade).await?;
    spade.say(&conversation, "Tidy the notes.").await?;
    wait_count(&spade, &conversation, "worker_reported", 1).await?;
    spade.say(&conversation, "Sort the inbox.").await?;
    wait_count(&spade, &conversation, "worker_reported", 2).await?;
    // Both ended: neither is in the live index, so nothing per step reads them.
    let deadline = Instant::now() + Duration::from_secs(10);
    while !live_in_store(&spade)?.is_empty() {
        if Instant::now() > deadline {
            return Err(format!("still live: {:?}", live_in_store(&spade)?).into());
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    // The list pages ended lanes: the most recent first in, and all with the default.
    let (_, one) = spade
        .get(&format!("/v1/conversations/{conversation}/tasks?ended=1"))
        .await?;
    let titles: Vec<&str> = one["tasks"]
        .as_array()
        .map(|t| t.iter().filter_map(|t| t["title"].as_str()).collect())
        .unwrap_or_default();
    assert_eq!(titles, ["Sort the inbox"]);
    assert_eq!(tasks(&spade, &conversation).await?.len(), 2);
    // The person writes in an ended lane: it is live again and works in its own context.
    let tidy = id_of(titled(
        &tasks(&spade, &conversation).await?,
        "Tidy the notes",
    ));
    spade.say(&tidy, "Tidy them once more.").await?;
    wait_count(&spade, &tidy, "reply_finished", 2).await?;
    assert!(
        wait_count(&spade, &conversation, "worker_reported", 3)
            .await
            .is_ok(),
        "the reopened lane reports again"
    );
    Ok(())
}

#[tokio::test]
async fn a_lane_that_ends_its_reply_with_its_job_still_running_reads_working_until_it_ends()
-> Result {
    let fetch = FakeTool::new("fetch_report", Risk::Read, "Revenue is up 12%.")
        .background()
        .slow(Duration::from_millis(1500));
    let routes = vec![route(
        "Fetch the Q3 report",
        vec![
            Script::reply("").call("j1", "fetch_report", json!({})),
            Script::reply("Waiting for the report."),
            Script::reply("The report says revenue is up 12%."),
        ],
    )];
    let mut main = warm_up();
    main.extend([
        starts("t1", "Fetch the Q3 report"),
        Script::reply("Started."),
        Script::reply("Revenue is up 12%."),
    ]);
    let spade = Spade::start_routed(routes, main, tools(vec![fetch]), Options::default()).await?;
    let (agent, conversation) = warm_bot(&spade).await?;
    spade.say(&conversation, "Fetch the Q3 report.").await?;
    let lane_id = id_of(
        wait_tasks(&spade, &conversation, |t| !t.is_empty())
            .await?
            .first(),
    );
    // The lane's reply ended while its job runs: it, and the bot, still read working.
    wait_count(&spade, &lane_id, "reply_finished", 1).await?;
    let found = tasks(&spade, &conversation).await?;
    assert_eq!(found[0]["state"], "working", "{found:#?}");
    let row = roster_state(&spade, &agent).await?;
    assert_ne!(row["state"], "idle", "{row}");
    assert_eq!(
        count(&spade.events(&conversation).await?, "worker_reported"),
        0
    );
    // Once the job's result is read, it reports, once.
    let events = wait_count(&spade, &conversation, "worker_reported", 1).await?;
    let report = events
        .iter()
        .find(|e| e["type"] == "worker_reported")
        .cloned()
        .unwrap_or_default();
    assert_eq!(report["state"], "finished");
    assert_eq!(count(&spade.events(&lane_id).await?, "job_finished"), 1);
    Ok(())
}

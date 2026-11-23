//! Task lanes (ADR 0217 §5, §6): Stop on a lane, on a queued one and on the bot, `task_stop`'s
//! rule, and restarts.

mod support;

use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::json;
use spade_server::engine::Limits;
use spade_testkit::Script;
use support::lanes::*;
use support::{Options, Result, Spade, types};

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
async fn stop_on_an_idle_bot_stops_its_running_and_queued_lanes_and_admits_none() -> Result {
    let routes = vec![
        route(
            "Book flights to Lisbon",
            vec![Script::reply("never").held(Duration::from_secs(30))],
        ),
        route("Renew the domain", vec![Script::reply("Renewed.")]),
    ];
    let mut main = warm_up();
    main.extend([
        Script::reply("")
            .call(
                "t1",
                "task_start",
                json!({ "title": "Book flights to Lisbon" }),
            )
            .call("t2", "task_start", json!({ "title": "Renew the domain" })),
        Script::reply("Started both; the domain waits its turn."),
    ]);
    let options = with(Limits {
        tasks_at_once: 1,
        ..Default::default()
    });
    let spade = Spade::start_routed(routes, main, Vec::new(), options).await?;
    let (_, conversation) = warm_bot(&spade).await?;
    spade
        .say(&conversation, "Book flights and renew the domain.")
        .await?;
    let found = wait_tasks(&spade, &conversation, |t| {
        titled(t, "Book flights to Lisbon").is_some_and(|f| f["state"] == "working")
            && titled(t, "Renew the domain").is_some_and(|d| d["state"] == "queued")
    })
    .await?;
    let domain = id_of(titled(&found, "Renew the domain"));
    wait_count(&spade, &conversation, "reply_finished", 2).await?;
    // Main itself is idle; Stop on the bot still stops both, and the queued one never starts.
    let (status, body) = spade
        .post(&format!("/v1/conversations/{conversation}/stop"), json!({}))
        .await?;
    assert_eq!(status, 202, "{body}");
    let found = wait_tasks(&spade, &conversation, |t| {
        t.iter().all(|t| t["state"] == "stopped")
    })
    .await?;
    assert_eq!(found.len(), 2);
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(count(&spade.events(&domain).await?, "reply_started"), 0);
    Ok(())
}

#[tokio::test]
async fn stop_on_a_queued_lane_marks_it_so_it_never_starts() -> Result {
    let routes = vec![
        route(
            "Book flights to Lisbon",
            vec![Script::reply("Booked.").held(Duration::from_millis(800))],
        ),
        route("Renew the domain", vec![Script::reply("Renewed.")]),
    ];
    let mut main = warm_up();
    main.extend([
        Script::reply("")
            .call(
                "t1",
                "task_start",
                json!({ "title": "Book flights to Lisbon" }),
            )
            .call("t2", "task_start", json!({ "title": "Renew the domain" })),
        Script::reply("Started both."),
        Script::reply("The flights are booked."),
    ]);
    let options = with(Limits {
        tasks_at_once: 1,
        ..Default::default()
    });
    let spade = Spade::start_routed(routes, main, Vec::new(), options).await?;
    let (_, conversation) = warm_bot(&spade).await?;
    spade
        .say(&conversation, "Book flights and renew the domain.")
        .await?;
    let found = wait_tasks(&spade, &conversation, |t| {
        titled(t, "Renew the domain").is_some_and(|d| d["state"] == "queued")
    })
    .await?;
    let domain = id_of(titled(&found, "Renew the domain"));
    let (status, body) = spade
        .post(&format!("/v1/conversations/{domain}/stop"), json!({}))
        .await?;
    assert_eq!(status, 202, "{body}");
    // The flights end and free the slot; the stopped one stays stopped.
    wait_tasks(&spade, &conversation, |t| {
        titled(t, "Book flights to Lisbon").is_some_and(|f| f["state"] == "finished")
    })
    .await?;
    tokio::time::sleep(Duration::from_millis(300)).await;
    let found = tasks(&spade, &conversation).await?;
    assert_eq!(
        titled(&found, "Renew the domain").map(|t| &t["state"]),
        Some(&json!("stopped"))
    );
    assert_eq!(count(&spade.events(&domain).await?, "reply_started"), 0);
    Ok(())
}

#[tokio::test]
async fn task_stop_citing_an_old_message_is_refused_and_the_task_runs_on() -> Result {
    let routes = vec![route(
        "Book flights to Lisbon",
        vec![Script::reply("still booking").held(Duration::from_secs(10))],
    )];
    let mut main = warm_up();
    main.extend([
        starts("t1", "Book flights to Lisbon"),
        Script::reply("Started."),
        // It cites the person's greeting, from before the task began.
        Script::reply("").call(
            "x1",
            "task_stop",
            json!({ "task": "Book flights to Lisbon", "because": "m1" }),
        ),
        Script::reply("I can't stop it on my own."),
    ]);
    let spade = Spade::start_routed(routes, main, Vec::new(), Options::default()).await?;
    let (_, conversation) = warm_bot(&spade).await?;
    spade.say(&conversation, "Book flights to Lisbon.").await?;
    wait_count(&spade, &conversation, "reply_finished", 2).await?;
    spade.say(&conversation, "How is it going?").await?;
    let events = wait_count(&spade, &conversation, "reply_finished", 3).await?;
    let refused = events
        .iter()
        .find(|e| e["type"] == "tool_finished" && e["call_id"] == "x1")
        .cloned()
        .unwrap_or_default();
    assert_eq!(refused["is_error"], true, "{refused}");
    let found = tasks(&spade, &conversation).await?;
    assert_eq!(found[0]["state"], "working");
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
async fn a_lanes_task_left_working_by_a_restart_after_its_reply_closed_carries_on() -> Result {
    let routes = vec![route(
        "Renew the domain",
        vec![
            Script::reply("").call("c1", "task_status", json!({ "status": "working" })),
            Script::reply("Found the registrar."),
        ],
    )];
    let mut main = warm_up();
    main.extend([starts("t1", "Renew the domain"), Script::reply("Started.")]);
    let spade = Spade::start_routed(routes, main, Vec::new(), Options::default()).await?;
    // A lane's turn waits once its reply has closed, before it plans the next step: Spade dies
    // there.
    let reached = Arc::new(tokio::sync::Notify::new());
    let at = reached.clone();
    spade.engine.hold_turn_ends(Arc::new(move |id| {
        let (at, lane) = (at.clone(), id.starts_with("l"));
        Box::pin(async move {
            if lane {
                at.notify_one();
                std::future::pending::<()>().await;
            }
        })
    }));
    let (_, conversation) = warm_bot(&spade).await?;
    spade.say(&conversation, "Renew the domain.").await?;
    tokio::time::timeout(Duration::from_secs(10), reached.notified()).await?;
    let lane_id = id_of(tasks(&spade, &conversation).await?.first());
    let spade = spade
        .restart_routed(
            vec![route(
                "Renew the domain",
                vec![
                    Script::reply("").call("c2", "task_status", json!({ "status": "done" })),
                    Script::reply("Renewed for a year."),
                ],
            )],
            vec![Script::reply("The domain is renewed.")],
            Vec::new(),
            Options::default(),
        )
        .await?;
    // The task's next step runs in the lane, and it ends and reports.
    let lane_events = wait_count(&spade, &lane_id, "reply_finished", 2).await?;
    assert!(
        count(&lane_events, "task_continued") >= 1,
        "{:?}",
        types(&lane_events)
    );
    let events = wait_count(&spade, &conversation, "worker_reported", 1).await?;
    let report = events
        .iter()
        .find(|e| e["type"] == "worker_reported")
        .cloned()
        .unwrap_or_default();
    assert_eq!(report["state"], "finished");
    Ok(())
}

#[tokio::test]
async fn stop_on_the_bot_marks_every_queued_lane_in_one_write_or_none() -> Result {
    let routes = vec![
        route(
            "Book flights to Lisbon",
            vec![Script::reply("never").held(Duration::from_secs(30))],
        ),
        route("Renew the domain", vec![Script::reply("Renewed.")]),
        route("Sort the inbox", vec![Script::reply("Sorted.")]),
    ];
    let mut main = warm_up();
    main.extend([
        Script::reply("")
            .call(
                "t1",
                "task_start",
                json!({ "title": "Book flights to Lisbon" }),
            )
            .call("t2", "task_start", json!({ "title": "Renew the domain" }))
            .call("t3", "task_start", json!({ "title": "Sort the inbox" })),
        Script::reply("Started all three."),
    ]);
    let options = with(Limits {
        tasks_at_once: 1,
        ..Default::default()
    });
    let spade = Spade::start_routed(routes, main, Vec::new(), options).await?;
    let (_, conversation) = warm_bot(&spade).await?;
    spade.say(&conversation, "Three errands, please.").await?;
    let found = wait_tasks(&spade, &conversation, |t| {
        t.len() == 3 && t.iter().filter(|t| t["state"] == "queued").count() == 2
    })
    .await?;
    let domain = id_of(titled(&found, "Renew the domain"));
    let inbox = id_of(titled(&found, "Sort the inbox"));
    wait_count(&spade, &conversation, "reply_finished", 2).await?;
    // The second queued lane's stop can't be written, as if Spade died between the two.
    refuse(
        &spade,
        "no_inbox_stop",
        &format!(
            "json_extract(NEW.body, '$.type') = 'stop_requested' \
             AND NEW.conversation_id = '{inbox}'"
        ),
    )?;
    let path = format!("/v1/conversations/{conversation}/stop");
    let (status, _) = spade.post(&path, json!({})).await?;
    assert!(status >= 500, "{status}");
    assert_eq!(
        count(&spade.events(&domain).await?, "stop_requested"),
        0,
        "all of them or none"
    );
    allow(&spade, "no_inbox_stop")?;
    let (status, body) = spade.post(&path, json!({})).await?;
    assert_eq!(status, 202, "{body}");
    wait_tasks(&spade, &conversation, |t| {
        t.iter().all(|t| t["state"] == "stopped")
    })
    .await?;
    for queued in [&domain, &inbox] {
        assert_eq!(count(&spade.events(queued).await?, "reply_started"), 0);
    }
    Ok(())
}

#[tokio::test]
async fn a_lane_reopened_while_its_report_goes_out_stays_live_and_the_bot_never_reads_idle()
-> Result {
    let routes = vec![route(
        "Tidy the notes",
        vec![
            Script::reply("Tidied."),
            Script::reply("Tidied again.").held(Duration::from_secs(2)),
        ],
    )];
    let mut main = warm_up();
    main.extend([
        starts("t1", "Tidy the notes"),
        Script::reply("Started."),
        Script::reply("Tidied."),
        Script::reply("Tidied again."),
    ]);
    let spade = Spade::start_routed(routes, main, Vec::new(), Options::default()).await?;
    // Between reading the lane's settlement and its report going out, the person writes in it.
    let engine = spade.engine.clone();
    let done = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let once = done.clone();
    spade.engine.hold_registrations(Arc::new(move |what, id| {
        if what == "lane_settled" && !once.swap(true, std::sync::atomic::Ordering::SeqCst) {
            let message = spade_server::engine::Outgoing {
                text: "Tidy them once more.".to_owned(),
                ..Default::default()
            };
            let _ = engine.send_message(id, message);
        }
    }));
    let (agent, conversation) = warm_bot(&spade).await?;
    spade.say(&conversation, "Tidy the notes.").await?;
    let lane_id = id_of(
        wait_tasks(&spade, &conversation, |t| !t.is_empty())
            .await?
            .first(),
    );
    wait_count(&spade, &lane_id, "reply_started", 2).await?;
    // Its second reply runs: it is live, and the bot reads working.
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(
        live_in_store(&spade)?.contains(&lane_id),
        "dropped while it works"
    );
    assert_ne!(roster_state(&spade, &agent).await?["state"], "idle");
    wait_count(&spade, &lane_id, "reply_finished", 2).await?;
    Ok(())
}

#[tokio::test]
async fn a_lane_goes_live_before_a_reply_of_it_is_stored_or_nothing_is() -> Result {
    let routes = vec![route(
        "Tidy the notes",
        vec![
            Script::reply("Tidied."),
            Script::reply("Tidied again.").held(Duration::from_secs(2)),
        ],
    )];
    let mut main = warm_up();
    main.extend([
        starts("t1", "Tidy the notes"),
        Script::reply("Started."),
        Script::reply("Tidied."),
        Script::reply("Tidied again."),
    ]);
    let spade = Spade::start_routed(routes, main, Vec::new(), Options::default()).await?;
    let (agent, conversation) = warm_bot(&spade).await?;
    spade.say(&conversation, "Tidy the notes.").await?;
    let lane_id = id_of(
        wait_tasks(&spade, &conversation, |t| {
            t.first().is_some_and(|t| t["state"] == "finished")
        })
        .await?
        .first(),
    );
    let deadline = Instant::now() + Duration::from_secs(10);
    while live_in_store(&spade)?.contains(&lane_id) {
        if Instant::now() > deadline {
            return Err("never left the live list".into());
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    // Putting it back on the list fails, as a crash there would: no reply of it is stored.
    {
        let connection = spade_store::Store::connect(spade.database())?;
        connection.execute_batch(
            "CREATE TRIGGER no_live BEFORE INSERT ON lanes_live \
             BEGIN SELECT RAISE(ABORT, 'refused for a test'); END;",
        )?;
    }
    let path = format!("/v1/conversations/{lane_id}/messages");
    let (status, _) = spade.post(&path, json!({ "text": "Once more." })).await?;
    assert!(status >= 500, "{status}");
    assert_eq!(count(&spade.events(&lane_id).await?, "reply_started"), 1);
    {
        let connection = spade_store::Store::connect(spade.database())?;
        connection.execute_batch("DROP TRIGGER no_live;")?;
    }
    let (status, body) = spade.post(&path, json!({ "text": "Once more." })).await?;
    assert_eq!(status, 202, "{body}");
    wait_count(&spade, &lane_id, "reply_started", 2).await?;
    assert!(live_in_store(&spade)?.contains(&lane_id));
    assert_ne!(roster_state(&spade, &agent).await?["state"], "idle");
    Ok(())
}

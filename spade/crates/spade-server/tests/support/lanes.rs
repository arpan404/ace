//! Task lanes (ADR 0217) in tests: a bot whose lanes take their own scripts (`Route`) whatever
//! order their calls arrive in, and the reads the lane tests share.

use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use spade_core::tools::Risk;
use spade_server::engine::Limits;
use spade_server::tools::Tool;
use spade_testkit::{Route, Script};

use super::{FakeTool, Options, Result, Spade, types};

pub fn title() -> Script {
    Script::reply("").plain(r#"{"title":"Errands"}"#)
}

/// The first turn and its title, so no title call races a lane's calls later.
pub fn warm_up() -> Vec<Script> {
    vec![Script::reply("Hello."), title()]
}

/// The words only a lane's own calls carry: what Spade tells it about its task.
pub fn lane(title: &str) -> String {
    format!("one task for the person: {title}.")
}

pub fn route(title: &str, scripts: Vec<Script>) -> Route {
    Route::when(&lane(title), scripts)
}

/// Main's step that starts a lane for the person's latest ask.
pub fn starts(id: &str, title: &str) -> Script {
    Script::reply("").call(
        id,
        "task_start",
        json!({ "title": title, "brief": "Done when it is sent." }),
    )
}

pub fn tools(list: Vec<FakeTool>) -> Vec<Arc<dyn Tool>> {
    list.into_iter()
        .map(|tool| Arc::new(tool) as Arc<dyn Tool>)
        .collect()
}

pub fn with(limits: Limits) -> Options {
    Options {
        limits,
        ..Default::default()
    }
}

/// A bot that has had its first turn: its id and conversation.
pub async fn warm_bot(spade: &Spade) -> Result<(String, String)> {
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

pub async fn roster_state(spade: &Spade, agent: &str) -> Result<Value> {
    let (_, body) = spade.get("/v1/agents").await?;
    body["agents"]
        .as_array()
        .and_then(|list| list.iter().find(|a| a["id"] == agent).cloned())
        .ok_or_else(|| "the bot is not in the roster".into())
}

pub async fn tasks(spade: &Spade, conversation: &str) -> Result<Vec<Value>> {
    let (status, body) = spade
        .get(&format!("/v1/conversations/{conversation}/tasks"))
        .await?;
    assert_eq!(status, 200, "{body}");
    Ok(body["tasks"].as_array().cloned().unwrap_or_default())
}

/// Waits until the conversation's lanes satisfy `test`.
pub async fn wait_tasks(
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
pub async fn wait_count(spade: &Spade, id: &str, kind: &str, count: usize) -> Result<Vec<Value>> {
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

pub fn count(events: &[Value], kind: &str) -> usize {
    events.iter().filter(|e| e["type"] == kind).count()
}

pub fn titled<'a>(found: &'a [Value], title: &str) -> Option<&'a Value> {
    found.iter().find(|t| t["title"] == title)
}

pub fn id_of(task: Option<&Value>) -> String {
    task.and_then(|t| t["task"].as_str())
        .unwrap_or_default()
        .to_owned()
}

/// Main's reply that reads a sheet eight times, moved to a lane whose title call takes `named`.
pub async fn moved_lane(named: Script) -> Result<(Spade, String, String)> {
    let read = FakeTool::new("read_sheet", Risk::Read, "Q3 revenue: 1.2M");
    let mut main = warm_up();
    for n in 0..8 {
        main.push(Script::reply("").call(&format!("s{n}"), "read_sheet", json!({ "n": n })));
    }
    main.push(Script::reply("The note is drafted."));
    let routes = vec![
        Route::when("for a task the person asked for", vec![named]),
        route(
            "Draft the quarterly note from Q3",
            vec![Script::reply("Drafted.").held(Duration::from_secs(1))],
        ),
    ];
    let options = with(Limits {
        move_long_work: true,
        ..Default::default()
    });
    let spade = Spade::start_routed(routes, main, tools(vec![read]), options).await?;
    let (_, conversation) = warm_bot(&spade).await?;
    spade
        .say(&conversation, "Draft the quarterly note from Q3.xlsx")
        .await?;
    let events = wait_count(&spade, &conversation, "reply_moved", 1).await?;
    let lane_id = events
        .iter()
        .find(|e| e["type"] == "reply_moved")
        .and_then(|e| e["lane"].as_str())
        .unwrap_or_default()
        .to_owned();
    Ok((spade, conversation, lane_id))
}

/// Main's reply that starts `first` (a job, a wait), then reads a sheet seven times: eight steps,
/// so it moves to a lane at the next boundary. The lane takes `lane_scripts`.
pub async fn moves_with(
    first: Script,
    lane_scripts: Vec<Script>,
    extra: Vec<FakeTool>,
    options: Options,
) -> Result<(Spade, String, Value)> {
    let read = FakeTool::new("read_sheet", Risk::Read, "Q3 revenue: 1.2M");
    let mut main = warm_up();
    main.push(first);
    for n in 1..8 {
        main.push(Script::reply("").call(&format!("s{n}"), "read_sheet", json!({ "n": n })));
    }
    main.push(Script::reply("Noted."));
    let routes = vec![
        Route::when(
            "for a task the person asked for",
            vec![Script::failing(500)],
        ),
        route("Draft the quarterly note from Q3", lane_scripts),
    ];
    let mut list = vec![read];
    list.extend(extra);
    let spade = Spade::start_routed(routes, main, tools(list), options).await?;
    let (_, conversation) = warm_bot(&spade).await?;
    spade
        .say(&conversation, "Draft the quarterly note from Q3.xlsx")
        .await?;
    let events = wait_count(&spade, &conversation, "reply_moved", 1).await?;
    let moved = events
        .iter()
        .find(|e| e["type"] == "reply_moved")
        .cloned()
        .unwrap_or_default();
    Ok((spade, conversation, moved))
}

pub fn moving() -> Limits {
    Limits {
        move_long_work: true,
        ..Default::default()
    }
}

/// Makes the database refuse events matching `when` (SQL over `NEW`) until [`allow`], as a crash
/// between two writes would leave them: the trigger's name is `name`.
pub fn refuse(spade: &Spade, name: &str, when: &str) -> Result {
    let connection = spade_store::Store::connect(spade.database())?;
    connection.execute_batch(&format!(
        "CREATE TRIGGER {name} BEFORE INSERT ON events WHEN {when} \
         BEGIN SELECT RAISE(ABORT, 'refused for a test'); END;"
    ))?;
    Ok(())
}

pub fn allow(spade: &Spade, name: &str) -> Result {
    let connection = spade_store::Store::connect(spade.database())?;
    connection.execute_batch(&format!("DROP TRIGGER {name};"))?;
    Ok(())
}

/// The lanes the database lists as not ended.
pub fn live_in_store(spade: &Spade) -> Result<Vec<String>> {
    let connection = spade_store::Store::connect(spade.database())?;
    let mut statement =
        connection.prepare("SELECT conversation_id FROM lanes_live ORDER BY conversation_id")?;
    let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
    Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
}

//! Deep research (ADR 0135): the real `research` tool over a local site and the real `web_fetch`,
//! with a scripted fake model. A run fans out to read-only `explore` helpers, starts the first one
//! before the rest, and comes back with a compact report that names the page and saved path behind
//! every finding.

mod support;

use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::Router;
use axum::http::header::CONTENT_TYPE;
use axum::routing::get;
use serde_json::{Value, json};
use spade_core::research::Budget;
use spade_core::tools::Risk;
use spade_docs::Extractor;
use spade_fetch::{Fetcher, Policy};
use spade_server::research::ResearchTool;
use spade_server::tools::{EngineHandle, Tool, WebFetch};
use spade_server::workspace::{TRUST_DIR, Workspaces};
use spade_testkit::{Gate, Route, Script};
use support::{FakeTool, Options, Result, Spade};
use tokio::net::TcpListener;

const QUESTION: &str = "Which Rust async runtimes are maintained?";
const MESSAGE: &str = "Please look into which Rust async runtimes people still keep up.";
const RUNTIMES: &str = "Which runtimes have releases this year";
const USED: &str = "Which runtime is used most";
const SMALL: &str = "Which runtime has the smallest footprint";

const PLAN: &str = r#"{"title":"Rust async runtimes","questions":[
    {"question":"Which runtimes have releases this year","queries":["tokio release 2026"]},
    {"question":"Which runtime is used most","queries":["rust runtime usage"]},
    {"question":"Which runtime has the smallest footprint","queries":["smol runtime size"]}]}"#;
const SUMMARY: &str = r#"{"answer":"Tokio is maintained and the most used runtime; smol is the smallest.","disagreements":[],"gaps":["No 2026 numbers for smol"]}"#;

/// The local pages the helpers read, by address.
struct Pages {
    runtime: String,
    used: String,
    small: String,
}

/// A local site the helpers read through the real `web_fetch`.
async fn site() -> Result<Pages> {
    let runtime = "<html><body><h1>Tokio</h1><p>Tokio is maintained and shipped 1.40 this \
                   year.</p><h2>Support</h2><p>The project is funded and active.</p></body></html>";
    let used = "<html><body><h1>Usage</h1><p>A survey found Tokio is the most used async \
                runtime for Rust.</p></body></html>";
    let small = "<html><body><h1>Smol</h1><p>Smol is the smallest of the maintained \
                 runtimes.</p></body></html>";
    let app = Router::new()
        .route(
            "/runtime",
            get(move || async move { ([(CONTENT_TYPE, "text/html")], runtime) }),
        )
        .route(
            "/used",
            get(move || async move { ([(CONTENT_TYPE, "text/html")], used) }),
        )
        .route(
            "/small",
            get(move || async move { ([(CONTENT_TYPE, "text/html")], small) }),
        );
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let address = listener.local_addr()?;
    tokio::spawn(async move { axum::serve(listener, app).await });
    Ok(Pages {
        runtime: format!("http://{address}/runtime"),
        used: format!("http://{address}/used"),
        small: format!("http://{address}/small"),
    })
}

struct Setup {
    spade: Spade,
    workspaces: Workspaces,
    agent: String,
    conversation: String,
    /// The tool itself, for a test that runs it twice without the bot's own turn.
    research: Arc<dyn Tool>,
    search: Arc<FakeTool>,
    write: Arc<FakeTool>,
    /// The first helper's answer waits behind it, so a test can see what happened before it
    /// streamed.
    gate: Gate,
}

/// A bot whose model reads the local site: `research` runs as its background job, its helpers
/// read through the real `web_fetch` and a fake `web_search`, and `workspace_write` is offered so
/// a helper can be seen trying to use it. `hold` keeps the second and third helpers' answers back
/// (a run cut short by its budget); the first helper's answer waits behind `gate`.
async fn setup(pages: &Pages, budget: Budget, hold: Option<Duration>, gate: Gate) -> Result<Setup> {
    let dir = tempfile::tempdir()?;
    let workspaces = Workspaces::new(dir.path().join("workspace"));
    let bots = EngineHandle::default();
    let fetcher = Arc::new(
        Fetcher::new(Policy::allowing_loopback(), Duration::from_secs(10))
            .with_documents(Extractor::in_process()),
    );
    let search = Arc::new(FakeTool::new(
        "web_search",
        Risk::Read,
        "1. Tokio release notes\n2. Rust runtime survey",
    ));
    let write = Arc::new(FakeTool::new("workspace_write", Risk::Write, "written"));
    let research: Arc<dyn Tool> =
        Arc::new(ResearchTool::new(workspaces.clone(), bots.clone()).with_budget(budget));
    let tools: Vec<Arc<dyn Tool>> = vec![
        Arc::new(WebFetch::new(fetcher).with_workspaces(workspaces.clone(), bots.clone())),
        research.clone(),
        search.clone(),
        write.clone(),
    ];
    let routes = research_routes(pages, hold, &gate);
    let spade = Spade::start_routed(
        routes,
        Vec::new(),
        tools,
        Options {
            workspaces: Some(workspaces.clone()),
            ..Options::default()
        },
    )
    .await?;
    bots.set(&spade.engine);
    let agent = spade.new_agent("Scout", "Finds things out").await?;
    let id = agent["id"].as_str().unwrap_or_default().to_owned();
    let conversation = agent["conversation"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    Ok(Setup {
        spade,
        workspaces,
        agent: id,
        conversation,
        research,
        search,
        write,
        gate,
    })
}

/// The bot's own turn starts the research; each helper takes its own scripts whatever order its
/// calls arrive in. The first helper's answer waits behind `gate`; the last two are held when
/// `hold` is set.
fn research_routes(pages: &Pages, hold: Option<Duration>, gate: &Gate) -> Vec<Route> {
    vec![
        Route::when("You plan web research", vec![Script::reply("").plain(PLAN)]),
        Route::when(
            "You summarise research",
            vec![Script::reply("").plain(SUMMARY)],
        ),
        Route::when(
            MESSAGE,
            vec![
                Script::reply("Looking into it.").call(
                    "r1",
                    "research",
                    json!({ "question": QUESTION, "depth": "quick" }),
                ),
                Script::reply("The report is in your workspace."),
            ],
        ),
        // The first helper's answer waits behind a gate, so a test knows exactly when its stream
        // has begun. Its scripts repeat, for a run made twice.
        Route::when(
            RUNTIMES,
            vec![
                gated(
                    Script::reply("Reading the runtime page.")
                        .call("s1", "web_search", json!({ "query": "tokio release 2026" }))
                        .call(
                            "f1",
                            "web_fetch",
                            json!({ "url": pages.runtime, "query": "maintained" }),
                        ),
                    gate,
                ),
                Script::reply(&format!(
                    "Tokio is maintained.\n\nFindings:\n- Tokio is maintained and shipped \
                 1.40 — {}\nGaps: none\nDisagreements: none",
                    pages.runtime
                )),
                gated(
                    Script::reply("Reading the runtime page.")
                        .call("s4", "web_search", json!({ "query": "tokio release 2026" }))
                        .call(
                            "f4",
                            "web_fetch",
                            json!({ "url": pages.runtime, "query": "maintained" }),
                        ),
                    gate,
                ),
                Script::reply(&format!(
                    "Tokio is maintained.\n\nFindings:\n- Tokio is maintained and shipped \
                 1.40 — {}\nGaps: none\nDisagreements: none",
                    pages.runtime
                )),
            ],
        ),
        Route::when(
            USED,
            vec![
                held(
                    Script::reply("Reading the survey.")
                        .call("s2", "web_search", json!({ "query": "rust runtime usage" }))
                        .call("f2", "web_fetch", json!({ "url": pages.used })),
                    hold,
                ),
                Script::reply(&format!(
                    "Tokio is the most used.\n\nFindings:\n- A survey found Tokio is the most \
                 used — {}\nGaps: none\nDisagreements: none",
                    pages.used
                )),
                held(
                    Script::reply("Reading the survey.")
                        .call("s5", "web_search", json!({ "query": "rust runtime usage" }))
                        .call("f5", "web_fetch", json!({ "url": pages.used })),
                    hold,
                ),
                Script::reply(&format!(
                    "Tokio is the most used.\n\nFindings:\n- A survey found Tokio is the most \
                 used — {}\nGaps: none\nDisagreements: none",
                    pages.used
                )),
            ],
        ),
        // A helper cannot write: its attempt is refused and it answers from what it could read.
        Route::when(
            SMALL,
            vec![
                held(
                    Script::reply("")
                        .call("s3", "web_search", json!({ "query": "smol runtime size" }))
                        .call(
                            "w1",
                            "workspace_write",
                            json!({ "path": "x.md", "text": "planted" }),
                        )
                        .call("f3", "web_fetch", json!({ "url": pages.small })),
                    hold,
                ),
                Script::reply(&format!(
                    "Smol is the smallest.\n\nFindings:\n- Smol is the smallest maintained \
                 runtime — {}\nGaps: none\nDisagreements: none",
                    pages.small
                )),
                held(
                    Script::reply("")
                        .call("s6", "web_search", json!({ "query": "smol runtime size" }))
                        .call(
                            "w2",
                            "workspace_write",
                            json!({ "path": "x.md", "text": "planted" }),
                        )
                        .call("f6", "web_fetch", json!({ "url": pages.small })),
                    hold,
                ),
                Script::reply(&format!(
                    "Smol is the smallest.\n\nFindings:\n- Smol is the smallest maintained \
                 runtime — {}\nGaps: none\nDisagreements: none",
                    pages.small
                )),
            ],
        ),
    ]
}

/// `script`, gated before its first frame.
fn gated(script: Script, gate: &Gate) -> Script {
    script.gated(gate.clone())
}

/// A gate nothing waits behind.
fn open_gate() -> Gate {
    let gate = Gate::new();
    gate.open();
    gate
}

/// `script`, held before it answers when `hold` is set: a helper still working at the budget.
fn held(script: Script, hold: Option<Duration>) -> Script {
    match hold {
        Some(hold) => script.held(hold),
        None => script,
    }
}

/// Three helpers, two pages each, at most `time_ms` of work.
fn budget(time_ms: u64) -> Budget {
    Budget {
        helpers: 3,
        pages: 2,
        time_ms,
    }
}

async fn helpers(spade: &Spade, conversation: &str) -> Result<Vec<Value>> {
    let (status, body) = spade
        .get(&format!("/v1/conversations/{conversation}/helpers"))
        .await?;
    assert_eq!(status, 200, "{body}");
    Ok(body["helpers"].as_array().cloned().unwrap_or_default())
}

/// Waits until a call `call` has a result in `conversation`, and answers it.
async fn finished(spade: &Spade, conversation: &str, call: &str) -> Result<Value> {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let events = spade.events(conversation).await?;
        if let Some(done) = events
            .iter()
            .find(|e| e["type"] == "tool_finished" && e["call_id"] == call)
        {
            return Ok(done.clone());
        }
        if Instant::now() > deadline {
            return Err(format!("no result for {call}").into());
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

async fn run_research(setup: &Setup, job: &str) -> Result<Value> {
    let output = setup
        .research
        .run(
            &format!("{}.{job}", setup.conversation),
            json!({ "question": QUESTION, "depth": "quick" }),
        )
        .await;
    Ok(json!({
        "content": output.content,
        "is_error": output.is_error,
        "files": output.files.to_vec(),
    }))
}

#[tokio::test]
async fn research_runs_explore_helpers_side_by_side_and_reports_what_they_cited() -> Result {
    let pages = site().await?;
    let setup = setup(&pages, budget(60_000), None, Gate::new()).await?;
    setup.spade.say(&setup.conversation, MESSAGE).await?;
    // The first helper's request is in and its answer is held: no other helper has started.
    setup.gate.holding().await;
    let before = setup.spade.fake.seen();
    assert!(
        before
            .iter()
            .all(|seen| !seen.body.to_string().contains(USED)
                && !seen.body.to_string().contains(SMALL)),
        "a helper started before the first one answered"
    );
    // Let it answer; the others may start only after it has.
    let released = Instant::now();
    setup.gate.open();
    let events = setup
        .spade
        .wait_for(&setup.conversation, "job_finished")
        .await?;
    let report = events
        .iter()
        .find(|e| e["type"] == "job_finished" && e["name"] == "research")
        .cloned()
        .unwrap_or_default();
    let content = report["content"].as_str().unwrap_or_default();
    assert_eq!(report["is_error"], false, "{content}");
    assert_eq!(
        report["untrusted"], true,
        "a report of web pages is untrusted"
    );
    assert!(
        content.starts_with("# Rust async runtimes\n\n## Answer"),
        "{content}"
    );
    // Every finding names its page and the workspace path that page was saved at.
    assert!(
        content.contains(&format!(
            "Tokio is maintained and shipped 1.40 — <{}>",
            pages.runtime
        )),
        "{content}"
    );
    assert!(content.contains("_(saved: web/"), "{content}");
    assert!(content.contains("## Disagreements and gaps"), "{content}");
    assert!(
        content.contains("High: every part of the question came back with a page cited"),
        "{content}"
    );
    let path = report["files"][0].as_str().unwrap_or_default().to_owned();
    assert!(
        path.starts_with("research/") && path.ends_with("-rust-async-runtimes.md"),
        "{path}"
    );
    assert!(
        content.contains(&format!("Full report: {path}")),
        "{content}"
    );

    // The saved report is the same, and the pages it cites are in the workspace.
    let workspace = setup.workspaces.of(&setup.agent)?;
    let saved = workspace.text(&path)?;
    // Never trusted: reading it later taints the turn too.
    assert!(!workspace.file_trusted(&path, saved.as_bytes()));
    assert!(saved.contains(&format!("<{}>", pages.used)), "{saved}");
    assert!(saved.contains(&format!("<{}>", pages.small)), "{saved}");
    for line in saved.lines().filter(|line| line.contains("_(saved: ")) {
        let saved_path = line
            .split("_(saved: ")
            .nth(1)
            .and_then(|rest| rest.split(')').next())
            .unwrap_or_default();
        assert!(
            workspace.text(saved_path).is_ok(),
            "{saved_path} is missing"
        );
    }

    // Three helpers ran, each read-only, each on the helper role, each given the bot's words as
    // the bot's: the plan is model-written and never reads as the person's.
    let helpers = helpers(&setup.spade, &setup.conversation).await?;
    assert_eq!(helpers.len(), 3, "{helpers:?}");
    assert!(
        helpers.iter().all(|h| h["profile"] == "explore"),
        "{helpers:?}"
    );
    assert!(
        helpers.iter().all(|h| h["model"] == "fake/m"),
        "{helpers:?}"
    );
    assert!(helpers.iter().all(|h| h["state"] == "ended"), "{helpers:?}");
    for helper in &helpers {
        let conversation = helper["conversation"].as_str().unwrap_or_default();
        let events = setup.spade.events(conversation).await?;
        let given = events
            .iter()
            .find(|e| e["type"] == "user_message")
            .cloned()
            .unwrap_or_default();
        assert_eq!(
            given["from_agent"]["name"], "Scout",
            "the task reads as the bot's, not the person's: {given}"
        );
    }
    assert_eq!(
        setup
            .search
            .calls()
            .lock()
            .map(|calls| calls.len())
            .unwrap_or(0),
        3,
        "every helper searched"
    );

    // The others asked only after the first had begun answering.
    let seen = setup.spade.fake.seen();
    let first = |words: &str| seen.iter().find(|s| s.body.to_string().contains(words));
    let one = first(RUNTIMES).ok_or("the first helper never asked")?;
    let two = first(USED).ok_or("the second helper never asked")?;
    let three = first(SMALL).ok_or("the third helper never asked")?;
    assert!(
        two.at >= released && three.at >= released,
        "a helper started before the first streamed"
    );
    // Its parts are offered the bot's stored list, byte for byte, like any helper.
    let bot = seen
        .iter()
        .find(|s| s.body.to_string().contains(MESSAGE) && s.body["stream"] == true)
        .ok_or("the bot made no request")?;
    for part in [one, two, three] {
        assert_eq!(
            part.body["tools"], bot.body["tools"],
            "the same tools, in order"
        );
    }

    // The helper that tried to write was refused, and nothing was written.
    let writable = helpers
        .iter()
        .find(|h| h["task"].as_str().unwrap_or_default().contains(SMALL))
        .cloned()
        .unwrap_or_default();
    let conversation = writable["conversation"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    let refused = finished(&setup.spade, &conversation, "w1").await?;
    assert_eq!(refused["is_error"], true, "{refused}");
    assert!(
        refused["content"]
            .as_str()
            .unwrap_or_default()
            .contains("cannot use workspace_write"),
        "{refused}"
    );
    assert_eq!(
        setup.write.calls().lock().map(|c| c.len()).unwrap_or(0),
        0,
        "a helper's write never runs"
    );

    Ok(())
}

#[tokio::test]
async fn research_stops_helpers_still_working_at_its_time_budget_and_says_what_is_missing() -> Result
{
    let pages = site().await?;
    // The first helper answers once its gate opens; the other two are held past a short budget.
    let setup = setup(
        &pages,
        budget(2_000),
        Some(Duration::from_secs(10)),
        open_gate(),
    )
    .await?;
    setup.spade.say(&setup.conversation, MESSAGE).await?;
    let events = setup
        .spade
        .wait_for(&setup.conversation, "job_finished")
        .await?;
    let report = events
        .iter()
        .find(|e| e["type"] == "job_finished" && e["name"] == "research")
        .cloned()
        .unwrap_or_default();
    let content = report["content"].as_str().unwrap_or_default();
    // What came back is reported, and the run says it was cut short.
    assert!(
        content.contains(&format!("<{}>", pages.runtime)),
        "{content}"
    );
    assert!(
        content.contains("Research stopped early: it reached the time budget"),
        "{content}"
    );
    assert!(
        content.contains("No answer for \"Which runtime is used most\""),
        "{content}"
    );
    assert!(
        content.contains("Low: 1 of 3 parts came back with a page cited"),
        "{content}"
    );
    assert!(content.contains("2 helpers did not answer."), "{content}");
    // The held helpers were stopped and ended before the report was published.
    let helpers = helpers(&setup.spade, &setup.conversation).await?;
    assert_eq!(helpers.len(), 3, "{helpers:?}");
    assert!(helpers.iter().all(|h| h["state"] == "ended"), "{helpers:?}");
    Ok(())
}

#[tokio::test]
async fn stop_on_the_bot_stops_the_helpers_and_publishes_the_research_result_last() -> Result {
    let pages = site().await?;
    // The first helper answers; the other two are still working when the person stops.
    let setup = setup(
        &pages,
        budget(60_000),
        Some(Duration::from_secs(10)),
        open_gate(),
    )
    .await?;
    setup.spade.say(&setup.conversation, MESSAGE).await?;
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let found = helpers(&setup.spade, &setup.conversation).await?;
        if found.len() == 3 && found.iter().any(|h| h["state"] == "working") {
            break;
        }
        if Instant::now() > deadline {
            return Err(format!("the helpers never ran: {found:?}").into());
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let (status, _) = setup
        .spade
        .post(
            &format!("/v1/conversations/{}/stop", setup.conversation),
            json!({}),
        )
        .await?;
    assert_eq!(status, 202);
    // The research job's result comes only once every part it started has ended.
    let events = setup
        .spade
        .wait_for_count(&setup.conversation, "job_finished", 1)
        .await?;
    let stopped = events
        .iter()
        .find(|e| e["type"] == "job_finished")
        .cloned()
        .unwrap_or_default();
    assert_eq!(stopped["name"], "research");
    assert!(
        stopped["content"]
            .as_str()
            .unwrap_or_default()
            .starts_with("Stopped by the person"),
        "{stopped}"
    );
    let found = helpers(&setup.spade, &setup.conversation).await?;
    assert!(
        found.iter().all(|h| h["state"] == "ended"),
        "the result was published while a part still worked: {found:?}"
    );
    // The result opened no reply.
    let asked = setup.spade.fake.seen().len();
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(
        setup
            .spade
            .events(&setup.conversation)
            .await?
            .iter()
            .filter(|e| e["type"] == "reply_started")
            .count(),
        1,
        "no reply opened after the stop"
    );
    assert_eq!(setup.spade.fake.seen().len(), asked);
    Ok(())
}

#[tokio::test]
async fn a_report_never_inherits_the_trust_of_the_file_its_path_once_held() -> Result {
    let pages = site().await?;
    let setup = setup(&pages, budget(60_000), None, open_gate()).await?;
    let first = run_research(&setup, "job1").await?;
    assert_eq!(first["is_error"], false, "{first}");
    let path = first["files"][0].as_str().unwrap_or_default().to_owned();
    let workspace = setup.workspaces.of(&setup.agent)?;
    let report = workspace.text(&path)?;
    // As if the person had written that exact file, and then removed it: its trust record stays.
    workspace.trust().record_person(&path, report.as_bytes());
    workspace.delete(&path)?;
    assert!(
        workspace.trust().has(&path),
        "the old record is what a reused path would inherit"
    );

    // The plan, the answer and the helpers are helper work: no `main` spend at all, since the
    // bot answered nothing itself here.
    let (_, activity) = setup
        .spade
        .get(&format!("/v1/agents/{}/activity", setup.agent))
        .await?;
    let today = &activity["spend_by_role"]["today"];
    assert!(today["helper"].as_u64().unwrap_or(0) > 0, "{activity}");
    assert_eq!(
        today["main"].as_u64().unwrap_or(0),
        0,
        "research's calls are not main's: {activity}"
    );

    let second = run_research(&setup, "job2").await?;
    assert_eq!(second["is_error"], false, "{second}");
    assert_eq!(
        second["files"][0].as_str().unwrap_or_default(),
        path,
        "the second run takes the freed path"
    );
    let again = workspace.text(&path)?;
    assert_eq!(again, report);
    assert!(
        !workspace.file_trusted(&path, again.as_bytes()),
        "a recreated report inherited the trust of the file it replaced"
    );
    Ok(())
}

#[tokio::test]
async fn a_report_is_not_saved_when_its_path_trust_cannot_be_cleared() -> Result {
    let pages = site().await?;
    let setup = setup(&pages, budget(60_000), None, open_gate()).await?;
    // The trust record cannot be written: a folder sits where its file goes.
    let trust = setup.workspaces.root().join(TRUST_DIR);
    tokio::fs::create_dir_all(&trust).await?;
    tokio::fs::create_dir(trust.join(format!("{}.json", setup.agent))).await?;
    let run = run_research(&setup, "job1").await?;
    assert_eq!(run["is_error"], true, "{run}");
    let content = run["content"].as_str().unwrap_or_default();
    assert!(content.contains("trust could not be cleared"), "{content}");
    assert!(
        run["files"].as_array().is_none_or(Vec::is_empty),
        "no chip for a report that was not saved: {run}"
    );
    // Nothing of it was left in the bot's folder.
    let research = setup.workspaces.of(&setup.agent)?.path()?.join("research");
    let left: Vec<String> = std::fs::read_dir(&research)
        .map(|entries| {
            entries
                .filter_map(|entry| entry.ok())
                .map(|entry| entry.file_name().to_string_lossy().into_owned())
                .collect()
        })
        .unwrap_or_default();
    assert!(left.is_empty(), "left behind: {left:?}");
    Ok(())
}

#[tokio::test]
async fn a_research_result_makes_the_rest_of_the_turn_untrusted() -> Result {
    let tool = ResearchTool::new(
        Workspaces::new(std::env::temp_dir()),
        EngineHandle::default(),
    );
    assert!(tool.def().background, "it runs as a job");
    let registry = spade_core::tools::Registry::new([tool.def()]);
    let mut events = vec![
        spade_core::Event::user_message(QUESTION),
        spade_core::Event::reply_started("r1", "fake/m"),
    ];
    events.push(spade_core::Event::Known(
        spade_core::event::Known::ReplyFinished {
            reply: "r1".into(),
            text: "I'll look into it.".into(),
            input_tokens: None,
            output_tokens: None,
            cost_micros: 0,
        },
    ));
    events.push(spade_core::Event::Known(
        spade_core::event::Known::JobFinished {
            job: "c1".into(),
            name: "research".into(),
            content: "Tokio is maintained.".into(),
            is_error: false,
            uncertain: false,
            files: vec!["research/r.md".into()],
            untrusted: false,
            cost_micros: None,
        },
    ));
    events.push(spade_core::Event::reply_started("r2", "fake/m"));
    // The job's result opened the next reply: every write in it asks.
    assert_eq!(
        spade_core::context::untrusted_sources(&events, &registry),
        vec!["the result of research".to_owned()]
    );
    Ok(())
}

#[tokio::test]
async fn a_restart_reports_the_research_lost_and_closes_its_parts_before_they_resume() -> Result {
    let pages = site().await?;
    // The first helper's answer is held, so the research is mid-part when the crash comes.
    let gate = Gate::new();
    let dir = tempfile::tempdir()?;
    let workspaces = Workspaces::new(dir.path().join("workspace"));
    let bots = EngineHandle::default();
    let fetcher = Arc::new(
        Fetcher::new(Policy::allowing_loopback(), Duration::from_secs(10))
            .with_documents(Extractor::in_process()),
    );
    let search = Arc::new(FakeTool::new("web_search", Risk::Read, "1. Tokio"));
    let write = Arc::new(FakeTool::new("workspace_write", Risk::Write, "written"));
    let research: Arc<dyn Tool> =
        Arc::new(ResearchTool::new(workspaces.clone(), bots.clone()).with_budget(budget(60_000)));
    let tools: Vec<Arc<dyn Tool>> = vec![
        Arc::new(WebFetch::new(fetcher.clone()).with_workspaces(workspaces.clone(), bots.clone())),
        research.clone(),
        search.clone(),
        write.clone(),
    ];
    let spade = Spade::start_routed(
        research_routes(&pages, None, &gate),
        Vec::new(),
        tools,
        Options {
            workspaces: Some(workspaces.clone()),
            ..Options::default()
        },
    )
    .await?;
    bots.set(&spade.engine);
    let agent = spade.new_agent("Scout", "").await?;
    let conversation = agent["conversation"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    spade.say(&conversation, MESSAGE).await?;
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let found = helpers(&spade, &conversation).await?;
        if found.iter().any(|h| h["state"] == "working") {
            break;
        }
        if Instant::now() > deadline {
            return Err(format!("no part ever ran: {found:?}").into());
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let parts: Vec<String> = helpers(&spade, &conversation)
        .await?
        .iter()
        .map(|h| h["conversation"].as_str().unwrap_or_default().to_owned())
        .collect();

    // The crash: a new server on the same data folder. Its fake is scripted with nothing: a part
    // that resumed would be seen by it.
    let bots = EngineHandle::default();
    let search = Arc::new(FakeTool::new("web_search", Risk::Read, "1. Tokio"));
    let tools: Vec<Arc<dyn Tool>> = vec![
        Arc::new(WebFetch::new(fetcher).with_workspaces(workspaces.clone(), bots.clone())),
        Arc::new(ResearchTool::new(workspaces.clone(), bots.clone())) as Arc<dyn Tool>,
        search,
        Arc::new(FakeTool::new("workspace_write", Risk::Write, "written")),
    ];
    let spade = spade.restart_after_crash("", tools, Vec::new()).await?;
    bots.set(&spade.engine);

    // The job is reported lost, and every part it had left is ended rather than resumed.
    let events = spade.events(&conversation).await?;
    let lost = events
        .iter()
        .find(|e| e["type"] == "job_finished" && e["name"] == "research")
        .cloned()
        .unwrap_or_default();
    assert!(
        lost["content"]
            .as_str()
            .unwrap_or_default()
            .contains("Unknown outcome"),
        "{lost}"
    );
    let found = helpers(&spade, &conversation).await?;
    assert!(!found.is_empty(), "the parts were stored");
    assert!(found.iter().all(|h| h["state"] == "ended"), "{found:?}");
    for part in &parts {
        let part_events = spade.events(part).await?;
        assert!(
            part_events.iter().any(|e| e["type"] == "stop_requested"),
            "{part} was not closed: {part_events:?}"
        );
    }
    let resumed = spade.fake.seen().into_iter().any(|seen| {
        seen.body
            .to_string()
            .contains("You are a helper Spade started")
    });
    assert!(!resumed, "a part resumed after the restart");
    Ok(())
}

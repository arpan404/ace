//! `spade --bot-test <package>` (ADR 0200 §9): runs a package's scenario tests on Spade's real
//! engine, offline. Each scenario gets a throwaway Spade in a temporary folder: its one endpoint
//! is `spade-testkit`'s fake model on this machine, scripted by the scenario; the tools that
//! would reach outside are fakes answering the scenario's results; there is no keychain, no ace,
//! no app and no plugin. The package installs through the same path an install from the market
//! takes, as a linked bot with its switches on (the developer is the person), and the person's
//! part of each approval is answered yes. What happened is read from the conversation's events
//! and checked by [`spade_core::package::scenario::check`].

mod fakes;
mod observe;

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{Value, json};
use spade_core::package::scenario::{self, Observed, Scenario};
use spade_core::package::{Manifest, read};
use spade_keys::Keys;
use spade_models::{Catalog, Models};
use spade_store::Store;
use spade_testkit::{FakeProvider, Script};
use tokio::net::TcpListener;
use tokio::sync::oneshot;

use crate::api::AppState;
use crate::clock::{CountingIds, SystemClock};
use crate::engine::{Engine, GlobalChange, Limits, Setup};
use crate::tools::{
    CardShow, DecisionLog, EngineHandle, TaskGoal, TaskPlan, TaskStatus, Todo, Tool, Toolbox,
};

/// How long one scenario may take before it fails as stuck.
const SCENARIO_TIME: Duration = Duration::from_secs(60);
const TOKEN: &str = "bot-test";
/// The fake endpoint's model, as a bot names it.
const MODEL: &str = "fake/m";
/// The reviewer: an address nothing listens on, so every held call is the person's to answer.
const REVIEWER: &str = "unreached/r";

/// One scenario's result.
#[derive(Debug, Clone, Serialize)]
pub struct ScenarioReport {
    pub file: String,
    pub name: String,
    pub passed: bool,
    pub failures: Vec<String>,
    /// The calls the run made, as the gate read them.
    pub calls: Vec<scenario::Seen>,
}

/// What `spade --bot-test` prints.
#[derive(Debug, Clone, Serialize)]
pub struct Report {
    /// The package's name, once its manifest read.
    pub name: Option<String>,
    /// Why the package or a scenario file couldn't be read, each with its place.
    pub problems: Vec<String>,
    pub scenarios: Vec<ScenarioReport>,
}

impl Report {
    pub fn passed(&self) -> bool {
        self.problems.is_empty() && self.scenarios.iter().all(|s| s.passed)
    }
}

type Failure = Box<dyn std::error::Error + Send + Sync>;

/// Reads the package at `folder` and runs every scenario its manifest names.
pub async fn run(folder: &Path) -> Report {
    let mut report = Report {
        name: None,
        problems: Vec::new(),
        scenarios: Vec::new(),
    };
    let text = match std::fs::read_to_string(folder.join("bot.json")) {
        Ok(text) => text,
        Err(error) => {
            report.problems.push(format!("bot.json: {error}"));
            return report;
        }
    };
    let recipe: Value = match serde_json::from_str(&text) {
        Ok(value) => value,
        Err(error) => {
            report.problems.push(format!("bot.json: {error}"));
            return report;
        }
    };
    let manifest = match read(&recipe, crate::packages::build()) {
        Ok(manifest) => manifest,
        Err(problems) => {
            report
                .problems
                .extend(problems.into_iter().map(|p| format!("bot.json: {p}")));
            return report;
        }
    };
    report.name = Some(manifest.name.clone());
    if manifest.tests.is_empty() {
        report
            .problems
            .push("bot.json: tests names no scenario; add one under tests/".to_owned());
    }
    // Its panels' pages install with it, as the daemon sends them (ADR 0200 §5.2).
    let pages: serde_json::Map<String, Value> =
        spade_core::package::surfaces::panels(&manifest.surfaces)
            .filter_map(|panel| {
                let page = std::fs::read_to_string(folder.join(&panel.file)).ok()?;
                Some((panel.file.clone(), Value::String(page)))
            })
            .collect();
    let pages = Value::Object(pages);
    let triggers: Vec<&str> = manifest.routines().map(|(name, _, _)| name).collect();
    for file in &manifest.tests {
        let scenario = std::fs::read_to_string(folder.join(file))
            .map_err(|error| vec![error.to_string()])
            .and_then(|text| scenario::read_scenario(&text, &triggers))
            .and_then(|scenario| {
                let problems = scenario::call_problems(&scenario, &manifest.contracts);
                if problems.is_empty() {
                    Ok(scenario)
                } else {
                    Err(problems)
                }
            })
            .and_then(|scenario| fakes_problems(&scenario).map(|()| scenario));
        match scenario {
            Ok(scenario) => {
                let ran =
                    tokio::time::timeout(SCENARIO_TIME, one(&recipe, &manifest, &pages, &scenario))
                        .await
                        .unwrap_or_else(|_| {
                            Err(
                                format!("it didn't finish within {}s", SCENARIO_TIME.as_secs())
                                    .into(),
                            )
                        });
                let (failures, calls) = match ran {
                    Ok(observed) => (scenario::check(&scenario, &observed), observed.calls),
                    Err(error) => (vec![format!("It couldn't run: {error}")], Vec::new()),
                };
                report.scenarios.push(ScenarioReport {
                    file: file.clone(),
                    name: scenario.name.clone(),
                    passed: failures.is_empty(),
                    failures,
                    calls,
                });
            }
            Err(problems) => report
                .problems
                .extend(problems.into_iter().map(|p| format!("{file}: {p}"))),
        }
    }
    report
}

/// A fake result named for a tool Spade runs itself in a scenario: it would never be used.
fn fakes_problems(scenario: &Scenario) -> Result<(), Vec<String>> {
    let problems: Vec<String> = scenario
        .tools
        .keys()
        .filter(|name| !faked(name))
        .map(|name| {
            format!(
                "tools.{name}: Spade runs {name} itself in a scenario; only tools that reach outside take a fake result"
            )
        })
        .collect();
    if problems.is_empty() {
        Ok(())
    } else {
        Err(problems)
    }
}

/// Whether a run gives the bot a fake for `name`: every tool that reaches outside, and any name
/// that isn't one of Spade's own (an app's tool, say).
fn faked(name: &str) -> bool {
    fakes::OUTSIDE.contains(&name)
        || (spade_core::effect::runtime::tool(name).is_none()
            && !spade_core::effect::runtime::INTERNAL.contains(&name))
}

/// The tools of a run: Spade's own that stay in the bot's folder and notes, cards, and a fake
/// for every tool that would reach outside.
fn toolbox(scenario: &Scenario, workspace: &Path, bots: &EngineHandle) -> Toolbox {
    let workspaces = crate::workspace::Workspaces::new(workspace.to_path_buf());
    let mut tools: Vec<Arc<dyn Tool>> = vec![
        Arc::new(Todo),
        Arc::new(TaskStatus),
        Arc::new(TaskGoal),
        Arc::new(TaskPlan),
        Arc::new(DecisionLog),
        Arc::new(CardShow::new(bots.clone(), Some(workspaces.clone()))),
    ];
    // The folder's tools are real; its commands are not run.
    tools.extend(
        crate::workspace::workspace_tools(
            workspaces,
            bots.clone(),
            crate::workspace::Commands::OneShot(crate::workspace::shell::Shell::system()),
        )
        .into_iter()
        .filter(|tool| tool.def().spec.name != "shell"),
    );
    let mut names: Vec<String> = fakes::OUTSIDE.iter().map(|n| (*n).to_owned()).collect();
    names.extend(scenario.called_tools().into_iter().filter(|n| faked(n)));
    names.sort();
    names.dedup();
    for name in names {
        let answers = scenario
            .tools
            .get(&name)
            .map(scenario::Answers::list)
            .unwrap_or_default();
        tools.push(fakes::Fake::new(&name, answers));
    }
    Toolbox::new(tools)
}

/// The model's steps as the fake answers them; titles and other plain calls get a title.
fn scripts(scenario: &Scenario) -> Vec<Script> {
    scenario
        .model
        .iter()
        .enumerate()
        .map(|(at, step)| {
            step.calls
                .iter()
                .enumerate()
                .fold(Script::reply(&step.say), |script, (index, call)| {
                    script.call(
                        &format!("s{at}c{index}"),
                        &call.tool,
                        call.arguments.clone(),
                    )
                })
        })
        .collect()
}

fn catalog(root: &str) -> Result<Catalog, Failure> {
    let json = json!({
        "roles": { "main": MODEL, "fast": MODEL, "deep": MODEL },
        "endpoints": [
            { "id": "fake", "name": "Scripted model", "format": "openai-chat", "base_url": root,
              "key": { "env": "SPADE_BOT_TEST_KEY" },
              "models": [{ "id": "m", "name": "Scripted", "capabilities": ["tools", "images"],
                           "price": { "input": 0, "output": 0 } }] },
            { "id": "unreached", "name": "Unreached", "format": "openai-chat",
              "base_url": "http://127.0.0.1:9/v1/", "key": { "env": "SPADE_BOT_TEST_KEY" },
              "models": [{ "id": "r", "name": "R", "capabilities": ["tools"],
                           "price": { "input": 0, "output": 0 } }] }
        ]
    });
    Ok(Catalog::from_json(&json.to_string())?)
}

/// A throwaway Spade, serving on this machine until dropped.
struct Throwaway {
    base: String,
    engine: Arc<Engine>,
    http: reqwest::Client,
    _folder: tempfile::TempDir,
    stop: Option<oneshot::Sender<()>>,
}

impl Drop for Throwaway {
    fn drop(&mut self) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
    }
}

impl Throwaway {
    async fn start(scenario: &Scenario, fake: &FakeProvider) -> Result<Self, Failure> {
        let folder = tempfile::tempdir()?;
        let dir = folder.path().to_path_buf();
        let models = Models::new(
            catalog(&fake.root)?,
            Keys::keychain_then_env(
                |_| None,
                |var| (var == "SPADE_BOT_TEST_KEY").then(|| "scripted".to_owned()),
            ),
            crate::home::VERSION,
        )?;
        let bots = EngineHandle::default();
        let engine = Engine::open(Setup {
            store: Store::open(&dir.join("spade.sqlite"))?,
            models,
            tools: toolbox(scenario, &dir.join("workspace"), &bots),
            clock: Arc::new(SystemClock),
            ids: Arc::new(CountingIds::default()),
            utc_offset_seconds: 0,
            limits: Limits::default(),
            skills: None,
            images: crate::images::ImageStore::open(&dir.join("images"))?,
            adopt: None,
            keychain: None,
        })?;
        bots.set(&engine);
        engine.set_security(secure(&dir, &bots).await?);
        crate::startup::finish(engine.clone(), None, None, crate::startup::SETTLE_DEADLINE).await?;
        engine.set_oversight(GlobalChange {
            classifier: Some(false),
            review_model: Some(Some(REVIEWER.to_owned())),
            ..Default::default()
        })?;
        let state = AppState {
            engine: engine.clone(),
            token: TOKEN.into(),
            keys: None,
            ace: None,
            workspaces: None,
            learning: None,
            skill_store: None,
            connectors: None,
            search: None,
        };
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let base = format!("http://{}", listener.local_addr()?);
        let (stop, stopped) = oneshot::channel::<()>();
        tokio::spawn(crate::serve(listener, state, async {
            let _ = stopped.await;
        }));
        Ok(Self {
            base,
            engine,
            http: reqwest::Client::builder().no_proxy().build()?,
            _folder: folder,
            stop: Some(stop),
        })
    }

    async fn call(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Option<Value>,
    ) -> Result<(u16, Value), Failure> {
        let mut request = self
            .http
            .request(method, format!("{}{path}", self.base))
            .bearer_auth(TOKEN);
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request.send().await?;
        let status = response.status().as_u16();
        let text = response.text().await?;
        Ok((status, serde_json::from_str(&text).unwrap_or(Value::Null)))
    }

    async fn post(&self, path: &str, body: Value) -> Result<(u16, Value), Failure> {
        self.call(reqwest::Method::POST, path, Some(body)).await
    }

    async fn get(&self, path: &str) -> Result<(u16, Value), Failure> {
        self.call(reqwest::Method::GET, path, None).await
    }
}

/// The run's security service: the gate's ceiling and switches, with no sandbox to launch.
async fn secure(
    dir: &Path,
    bots: &EngineHandle,
) -> Result<Arc<crate::security::Security>, Failure> {
    Ok(crate::security::Security::start(crate::security::Setup {
        runner: spade_sandbox::Runner::unavailable("A scenario runs no commands."),
        store: Store::open(&dir.join("spade.sqlite"))?,
        home: dir.join("home"),
        spade_data: dir.to_path_buf(),
        ace_data: None,
        person_key: None,
        workspaces: dir.join("workspace"),
        log_dir: dir.join("egress"),
        clock: Arc::new(SystemClock),
        ids: Arc::new(CountingIds::default()),
        bots: bots.clone(),
    })
    .await)
}

/// The install body: every declared effect switched on. With no market signature the package
/// installs as a local package, linked to `local/<name>` (ADR 0200 §3.2).
fn install(recipe: &Value, manifest: &Manifest, pages: &Value) -> Value {
    let switches: serde_json::Map<String, Value> = manifest
        .effect_keys()
        .into_iter()
        .map(|key| (key, Value::Bool(true)))
        .collect();
    json!({
        "recipe": recipe,
        "from_recipe": { "source": "local", "name": manifest.name, "version": "test" },
        "grants": { "connectors": [], "plugins": [], "skills": [] },
        "switches": switches,
        "start_routines": false,
        "pages": pages,
    })
}

/// One scenario on its own throwaway Spade.
async fn one(
    recipe: &Value,
    manifest: &Manifest,
    pages: &Value,
    scenario: &Scenario,
) -> Result<Observed, Failure> {
    let fake = FakeProvider::start_turns(
        scripts(scenario),
        Script::reply("").plain(r#"{"title":"Scenario"}"#),
    )
    .await?;
    let spade = Throwaway::start(scenario, &fake).await?;
    let (status, made) = spade
        .post("/v1/agents", install(recipe, manifest, pages))
        .await?;
    if status != 201 {
        return Err(format!("the package didn't install: {}", error_of(&made)).into());
    }
    let agent = made["agent"]["id"].as_str().unwrap_or_default().to_owned();
    let conversation = made["agent"]["conversation"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    // The bot runs on the scripted model whatever its manifest asks for.
    let (status, changed) = spade
        .call(
            reqwest::Method::PATCH,
            &format!("/v1/agents/{agent}"),
            Some(json!({ "model": MODEL })),
        )
        .await?;
    if status != 200 {
        return Err(format!("its model couldn't be set: {}", error_of(&changed)).into());
    }
    start(&spade, scenario, &agent, &conversation).await?;
    let events = settle(&spade, &conversation).await?;
    Ok(observe::observed(&events))
}

/// Gives the bot its message, or fires the trigger the scenario names.
async fn start(
    spade: &Throwaway,
    scenario: &Scenario,
    agent: &str,
    conversation: &str,
) -> Result<(), Failure> {
    if let Some(message) = &scenario.given.message {
        let (status, answer) = spade
            .post(
                &format!("/v1/conversations/{conversation}/messages"),
                json!({ "text": message }),
            )
            .await?;
        if status != 202 {
            return Err(format!("the message was refused: {}", error_of(&answer)).into());
        }
        return Ok(());
    }
    if let Some(call) = &scenario.given.call {
        return give_call(spade, call, agent).await;
    }
    let wanted = scenario.given.trigger.as_deref().unwrap_or_default();
    let (_, listed) = spade.get(&format!("/v1/agents/{agent}/routines")).await?;
    let routine = listed["routines"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|r| r["name"] == wanted)
        .and_then(|r| r["id"].as_str())
        .ok_or_else(|| format!("its trigger {wanted:?} made no routine"))?
        .to_owned();
    let (status, answer) = spade
        .post(&format!("/v1/routines/{routine}/run"), json!({}))
        .await?;
    if status != 202 {
        return Err(format!("its trigger didn't fire: {}", error_of(&answer)).into());
    }
    Ok(())
}

/// The id a scenario's given call has, which its scripted `contract_return` names.
pub const CALL: &str = "cc.scenario";

/// Another bot of the person's calls the bot's contract, as `contract_call` would deliver it.
async fn give_call(
    spade: &Throwaway,
    call: &scenario::GivenCall,
    agent: &str,
) -> Result<(), Failure> {
    let name = call
        .from
        .clone()
        .unwrap_or_else(|| "Another bot".to_owned());
    let (status, made) = spade.post("/v1/agents", json!({ "name": name })).await?;
    if status != 201 {
        return Err(format!("its caller couldn't be made: {}", error_of(&made)).into());
    }
    let caller = made["agent"]["id"].as_str().unwrap_or_default();
    let store = spade.engine.store();
    let (Ok(Some(me)), Ok(Some(target))) = (store.agent(caller), store.agent(agent)) else {
        return Err("the bots couldn't be read".into());
    };
    let contract = spade
        .engine
        .callable(&target, &call.contract, &call.input)
        .map_err(|why| format!("the call couldn't start: {why}"))?;
    spade
        .engine
        .deliver_call(&me, &target, CALL, &contract, call.input.clone(), 1)
        .map_err(|error| format!("the call wasn't delivered: {error}"))?;
    Ok(())
}

/// Waits for the turn to end, answering yes to each call put to the person.
async fn settle(spade: &Throwaway, conversation: &str) -> Result<Vec<Value>, Failure> {
    let deadline = Instant::now() + SCENARIO_TIME;
    let mut answered: Vec<String> = Vec::new();
    loop {
        let (_, body) = spade
            .get(&format!("/v1/conversations/{conversation}/events"))
            .await?;
        let events: Vec<Value> = body
            .as_array()
            .map(|rows| rows.iter().map(|r| r["event"].clone()).collect())
            .unwrap_or_default();
        for asked in events.iter().filter(|e| e["type"] == "approval_requested") {
            let call = asked["call_id"].as_str().unwrap_or_default().to_owned();
            if answered.contains(&call) {
                continue;
            }
            spade
                .post(
                    &format!("/v1/conversations/{conversation}/approvals/{call}"),
                    json!({ "allowed": true, "always": false }),
                )
                .await?;
            answered.push(call);
        }
        if observe::ended(&events) {
            return Ok(events);
        }
        if Instant::now() > deadline {
            return Ok(events);
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

fn error_of(body: &Value) -> String {
    body["error"]
        .as_str()
        .map_or_else(|| body.to_string(), str::to_owned)
}

/// `spade --bot-test <folder>`: the report as JSON on stdout; exit 0 when every scenario passes,
/// 1 when one fails or the package can't be read, 2 for a wrong command line.
pub fn main(args: &[std::ffi::OsString]) -> std::process::ExitCode {
    let Some(folder) = args.first().map(PathBuf::from) else {
        eprintln!("usage: spade --bot-test <package folder>");
        return std::process::ExitCode::from(2);
    };
    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("spade could not start its runtime: {error}");
            return std::process::ExitCode::FAILURE;
        }
    };
    let report = runtime.block_on(run(&folder));
    match serde_json::to_string(&report) {
        Ok(json) => println!("{json}"),
        Err(error) => {
            eprintln!("the report couldn't be written: {error}");
            return std::process::ExitCode::FAILURE;
        }
    }
    if report.passed() {
        std::process::ExitCode::SUCCESS
    } else {
        std::process::ExitCode::FAILURE
    }
}

#[cfg(test)]
mod tests;

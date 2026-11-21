//! A throwaway Spade for one run of a package (ADR 0200 §9, ADR 0204 §2): a temporary folder,
//! the real engine and install path, no keychain, ace, app or plugin, serving on this machine
//! until dropped. A scenario test and a replay each run on one, with the model and the outside
//! tools they bring.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use spade_core::package::Manifest;
use spade_core::package::scenario::{self, Scenario};
use spade_models::{Catalog, Models};
use spade_store::Store;
use spade_testkit::Script;
use tokio::net::TcpListener;
use tokio::sync::oneshot;

use super::{Failure, MODEL, REVIEWER, SCENARIO_TIME, TOKEN, observe};
use crate::api::AppState;
use crate::clock::{CountingIds, SystemClock};
use crate::engine::{Engine, GlobalChange, Limits, Setup};
use crate::tools::{
    CardShow, DecisionLog, EngineHandle, TaskGoal, TaskPlan, TaskStatus, Todo, Tool, Toolbox,
};

/// Whether a run gives the bot a fake for `name`: every tool that reaches outside, and any name
/// that isn't one of Spade's own (an app's tool, say).
pub(crate) fn faked(name: &str) -> bool {
    super::fakes::OUTSIDE.contains(&name)
        || (spade_core::effect::runtime::tool(name).is_none()
            && !spade_core::effect::runtime::INTERNAL.contains(&name))
}

/// Spade's own tools a run gives the bot: those that stay in its folder and notes, and cards.
/// Its folder's tools are real; its commands are not run.
pub(crate) fn own_tools(workspace: &Path, bots: &EngineHandle) -> Vec<Arc<dyn Tool>> {
    let workspaces = crate::workspace::Workspaces::new(workspace.to_path_buf());
    let mut tools: Vec<Arc<dyn Tool>> = vec![
        Arc::new(Todo),
        Arc::new(TaskStatus),
        Arc::new(TaskGoal),
        Arc::new(TaskPlan),
        Arc::new(DecisionLog),
        Arc::new(CardShow::new(bots.clone(), Some(workspaces.clone()))),
    ];
    tools.extend(
        crate::workspace::workspace_tools(
            workspaces,
            bots.clone(),
            crate::workspace::Commands::OneShot(crate::workspace::shell::Shell::system()),
        )
        .into_iter()
        .filter(|tool| tool.def().spec.name != "shell"),
    );
    tools
}

/// The names a run fakes: every tool that reaches outside, and each of `called` that isn't
/// Spade's own.
pub(crate) fn outside_names(called: Vec<String>) -> Vec<String> {
    let mut names: Vec<String> = super::fakes::OUTSIDE
        .iter()
        .map(|n| (*n).to_owned())
        .collect();
    names.extend(called.into_iter().filter(|n| faked(n)));
    names.sort();
    names.dedup();
    names
}

/// The model's steps as the fake answers them; titles and other plain calls get a title.
pub(crate) fn scripts(scenario: &Scenario) -> Vec<Script> {
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

pub(crate) fn catalog(root: &str) -> Result<Catalog, Failure> {
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
pub(crate) struct Throwaway {
    base: String,
    pub(crate) engine: Arc<Engine>,
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
    /// Its workspace folder, where its bots' own files are.
    pub(crate) fn workspace(&self) -> PathBuf {
        self._folder.path().join("workspace")
    }

    /// Starts one on `models`, with the tools `tools` gives for its workspace folder.
    pub(crate) async fn start(
        models: Models,
        tools: impl FnOnce(&Path, &EngineHandle) -> Toolbox,
    ) -> Result<Self, Failure> {
        let folder = tempfile::tempdir()?;
        let dir = folder.path().to_path_buf();
        let bots = EngineHandle::default();
        let engine = Engine::open(Setup {
            store: Store::open(&dir.join("spade.sqlite"))?,
            models,
            tools: tools(&dir.join("workspace"), &bots),
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

    pub(crate) async fn call(
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

    pub(crate) async fn post(&self, path: &str, body: Value) -> Result<(u16, Value), Failure> {
        self.call(reqwest::Method::POST, path, Some(body)).await
    }

    pub(crate) async fn get(&self, path: &str) -> Result<(u16, Value), Failure> {
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
pub(crate) fn install(recipe: &Value, manifest: &Manifest, pages: &Value) -> Value {
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

/// Fills a bot's workspace folder before its run starts.
pub(crate) type Seed<'a> = &'a (dyn Fn(&Path) -> std::io::Result<()> + Sync);

/// Installs the package on `spade`, sets its bot on `model`, fills its workspace with `seed`,
/// gives it the scenario's start and waits for the turn to end: the conversation's events.
pub(crate) async fn run_on(
    spade: &Throwaway,
    package: (&Value, &Manifest, &Value),
    scenario: &Scenario,
    model: &str,
    seed: Option<Seed<'_>>,
) -> Result<(String, Vec<Value>), Failure> {
    let (recipe, manifest, pages) = package;
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
    // The bot runs on the run's model whatever its manifest asks for.
    let (status, changed) = spade
        .call(
            reqwest::Method::PATCH,
            &format!("/v1/agents/{agent}"),
            Some(json!({ "model": model })),
        )
        .await?;
    if status != 200 {
        return Err(format!("its model couldn't be set: {}", error_of(&changed)).into());
    }
    if let Some(seed) = seed {
        let folder = crate::workspace::Workspaces::new(spade.workspace())
            .of(&agent)
            .and_then(|workspace| workspace.path())
            .map_err(|error| format!("its workspace couldn't be made: {error}"))?;
        seed(&folder)?;
    }
    start(spade, scenario, &agent, &conversation).await?;
    Ok((agent, settle(spade, &conversation).await?))
}

/// Gives the bot its message, or fires the trigger the scenario names.
pub(crate) async fn start(
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
        .deliver_call(
            &me,
            &target,
            scenario::CALL,
            &contract,
            call.input.clone(),
            1,
        )
        .map_err(|error| format!("the call wasn't delivered: {error}"))?;
    Ok(())
}

/// Waits for the turn to end, answering yes to each call put to the person.
pub(crate) async fn settle(spade: &Throwaway, conversation: &str) -> Result<Vec<Value>, Failure> {
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

pub(crate) fn error_of(body: &Value) -> String {
    body["error"]
        .as_str()
        .map_or_else(|| body.to_string(), str::to_owned)
}

//! The Runtime level: what a runtime MUST do with a package it installs, driven through its HTTP
//! API (`runtime/packages.json`) and its scenario door (`runtime/scenarios.json`).
//!
//! The scenario door is a command answering `<cmd> <folder>` with the report `spade --bot-test`
//! prints: `{problems, scenarios: [{calls: [{tool, effect, outcome}], cards}]}`, each call's
//! `outcome` `"ran"`, `{"refused": why}` or `{"failed": why}`. The runner judges the calls
//! itself: a runtime's own verdict on its scenario counts for nothing here.

use std::ffi::OsString;
use std::path::Path;

use serde_json::{Value, json};

use crate::folder;
use crate::http::{Answer, Http};
use crate::report::{Level, Outcome};
use crate::suite::{self, File};

/// A runtime's scenario door.
pub trait ScenarioDoor {
    /// The report for the package folder at `folder`, with its scenarios run.
    fn run(&self, folder: &Path) -> impl Future<Output = Result<Value, String>>;
}

/// A scenario door that is a command: `program args… <folder>`.
pub struct Command {
    pub program: OsString,
    pub args: Vec<OsString>,
}

impl ScenarioDoor for Command {
    async fn run(&self, folder: &Path) -> Result<Value, String> {
        let ran = tokio::process::Command::new(&self.program)
            .args(&self.args)
            .arg(folder)
            .kill_on_drop(true)
            .output()
            .await
            .map_err(|e| format!("the scenario door didn't start: {e}"))?;
        serde_json::from_slice(&ran.stdout).map_err(|e| {
            format!(
                "the scenario report isn't JSON ({e}); it said: {}",
                String::from_utf8_lossy(&ran.stderr).trim()
            )
        })
    }
}

/// The doors a run has: either may be missing, and its cases then fail as not run.
pub struct Doors<'a, S> {
    pub http: Option<&'a Http>,
    pub scenarios: Option<&'a S>,
    /// Unique to this run, so its install transactions never meet an earlier run's.
    pub run: &'a str,
}

/// Every Runtime case.
pub async fn run<S: ScenarioDoor>(doors: &Doors<'_, S>) -> Level {
    let mut cases = Vec::new();
    let packages = suite::RUNTIME_PACKAGES.json();
    for (n, case) in suite::RUNTIME_PACKAGES.cases().iter().enumerate() {
        let result = match doors.http {
            Some(http) => steps(http, &packages, case, &format!("{}-{n}", doors.run)).await,
            None => Err("not run: no HTTP door (--runtime)".to_owned()),
        };
        cases.push(Outcome::of(suite::id(case), result));
    }
    cases.extend(scenarios(doors.scenarios, &suite::RUNTIME_SCENARIOS).await);
    Level {
        level: "Runtime",
        cases,
    }
}

/// Each scenario case of `file`, through `door`.
pub async fn scenarios<S: ScenarioDoor>(door: Option<&S>, file: &File) -> Vec<Outcome> {
    let all = file.json();
    let mut out = Vec::new();
    for case in file.cases() {
        let result = match door {
            Some(door) => scenario(door, &all, &case).await,
            None => Err("not run: no scenario door (--scenarios)".to_owned()),
        };
        out.push(Outcome::of(suite::id(&case), result));
    }
    out
}

const TEST: &str = "tests/conformance.json";

async fn scenario(door: &impl ScenarioDoor, all: &Value, case: &Value) -> Result<(), String> {
    let mut bot = suite::merged(&all["base"], &case["with"]);
    bot["tests"] = json!([TEST]);
    let files = vec![(TEST.to_owned(), case["scenario"].to_string())];
    let package = folder::package(&bot, &files)?;
    let report = door.run(package.path()).await?;
    let problems = report["problems"].as_array().cloned().unwrap_or_default();
    if !problems.is_empty() {
        return Err(format!("the runtime couldn't run it: {problems:?}"));
    }
    let run = &report["scenarios"][0];
    if run.is_null() {
        return Err("the report has no scenario run".to_owned());
    }
    judge_calls(&case["expect"], run)
}

/// Whether a scenario run's calls and cards show what `expect` says.
pub fn judge_calls(expect: &Value, run: &Value) -> Result<(), String> {
    let calls = run["calls"].as_array().cloned().unwrap_or_default();
    let of = |tool: &str| -> Vec<&Value> { calls.iter().filter(|c| c["tool"] == tool).collect() };
    let ran = |call: &Value| call["outcome"] == "ran";
    let refused = |call: &Value| call["outcome"].get("refused").is_some();
    for tool in words(&expect["refused"]) {
        if of(&tool).into_iter().any(ran) {
            return Err(format!("{tool} ran; the runtime MUST refuse it"));
        }
        if !of(&tool).into_iter().any(refused) {
            return Err(format!("{tool} wasn't refused: {calls:?}"));
        }
    }
    for tool in words(&expect["ran"]) {
        if !of(&tool).into_iter().any(ran) {
            return Err(format!("{tool} didn't run: {calls:?}"));
        }
    }
    for (tool, effect) in expect["effects"].as_object().into_iter().flatten() {
        if !of(tool).into_iter().any(|c| c["effect"] == *effect) {
            return Err(format!("{tool} wasn't read as {effect}: {calls:?}"));
        }
    }
    let cards = words(&run["cards"]);
    for title in words(&expect["cards"]) {
        let shown = cards
            .iter()
            .any(|c| c.to_lowercase().contains(&title.to_lowercase()));
        if !shown {
            return Err(format!("no card {title:?} was shown; it showed {cards:?}"));
        }
    }
    Ok(())
}

fn words(value: &Value) -> Vec<String> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|w| w.as_str().map(str::to_owned))
        .collect()
}

/// A bot the runner installed, deleted when its case ends.
pub struct Bot {
    pub id: String,
    pub conversation: String,
}

/// `POST /v1/agents` with `recipe`, as a person's Install makes it.
pub async fn install(
    http: &Http,
    recipe: &Value,
    switches: &Value,
    pages: &Value,
    run: &str,
) -> Result<Result<Bot, Answer>, String> {
    let body = json!({
        "recipe": recipe,
        "from_recipe": { "source": "spade-conform", "name": "conformance", "version": "1", "transaction": format!("install-{run}") },
        "grants": { "connectors": [], "plugins": [], "skills": [] },
        "switches": if switches.is_object() { switches.clone() } else { json!({}) },
        "pages": if pages.is_object() { pages.clone() } else { json!({}) },
    });
    let answer = http.post("/v1/agents", &body).await?;
    if !answer.ok() {
        return Ok(Err(answer));
    }
    let text = |v: &Value| v.as_str().map(str::to_owned);
    match (
        text(&answer.json["agent"]["id"]),
        text(&answer.json["agent"]["conversation"]),
    ) {
        (Some(id), Some(conversation)) => Ok(Ok(Bot { id, conversation })),
        _ => Err(format!(
            "the install answered no agent id: {}",
            answer.says()
        )),
    }
}

async fn bots(http: &Http) -> Result<usize, String> {
    let answer = http.get("/v1/agents").await?;
    Ok(answer.json["agents"].as_array().map_or(0, Vec::len))
}

/// The versions a case's bot has run, by its package's hash.
#[derive(Default)]
struct Versions {
    installed: Option<String>,
    updated: Option<String>,
}

async fn package(http: &Http, bot: &Bot) -> Result<Value, String> {
    let answer = http.get(&format!("/v1/agents/{}/package", bot.id)).await?;
    if !answer.ok() {
        return Err(format!("its package didn't read: {}", answer.says()));
    }
    Ok(answer.json["package"].clone())
}

async fn steps(http: &Http, all: &Value, case: &Value, run: &str) -> Result<(), String> {
    let mut bot: Option<Bot> = None;
    let result = take_steps(http, all, case, run, &mut bot).await;
    if let Some(bot) = bot {
        // Best effort: a bot left behind changes nothing another case checks.
        let _ = http.delete(&format!("/v1/agents/{}", bot.id)).await;
    }
    result
}

async fn take_steps(
    http: &Http,
    all: &Value,
    case: &Value,
    run: &str,
    bot: &mut Option<Bot>,
) -> Result<(), String> {
    let mut versions = Versions::default();
    let mut installed = Value::Null;
    for (n, step) in case["steps"].as_array().into_iter().flatten().enumerate() {
        let expect = &step["expect"];
        let at = format!("step {}", n + 1);
        let refused =
            |answer: &Answer, what: &str| verdict(expect, answer, &format!("{at}: {what}"));
        if let Some(install) = step.get("install") {
            installed = suite::merged(&all["base"], &install["with"]);
            let before = bots(http).await?;
            match self::install(http, &installed, &install["switches"], &Value::Null, run).await? {
                Ok(made) => {
                    *bot = Some(made);
                    if expect["refused"] == true {
                        return Err(format!(
                            "{at}: the install was taken; the runtime MUST refuse it"
                        ));
                    }
                }
                Err(answer) => {
                    refused(&answer, "the install")?;
                    if bots(http).await? != before {
                        return Err(format!("{at}: a refused install left a bot behind"));
                    }
                    continue;
                }
            }
        }
        let Some(made) = bot.as_ref() else {
            return Err(format!("{at}: there is no bot to take it on"));
        };
        if versions.installed.is_none() {
            versions.installed = package(http, made).await?["hash"]
                .as_str()
                .map(str::to_owned);
        }
        if let Some(switch) = step.get("switch") {
            let body = json!({ "key": switch["key"], "on": switch["on"] });
            let answer = http
                .put(&format!("/v1/agents/{}/package/effects", made.id), &body)
                .await?;
            refused(&answer, "the switch")?;
        }
        if let Some(calls) = step.get("calls") {
            let body = json!({ "incoming": calls["incoming"] });
            let answer = http
                .put(&format!("/v1/agents/{}/contracts", made.id), &body)
                .await?;
            refused(&answer, "the calls switch")?;
        }
        let moving = match (step.get("update"), step.get("rollback")) {
            (Some(update), _) => Some(suite::merged(&installed, &update["with"])),
            (None, Some(_)) => Some(installed.clone()),
            (None, None) => None,
        };
        if let Some(recipe) = moving {
            let body = json!({ "recipe": recipe, "transaction": format!("move-{run}-{n}") });
            let answer = http
                .post(&format!("/v1/agents/{}/package", made.id), &body)
                .await?;
            refused(&answer, "the move")?;
            if step.get("update").is_some() {
                versions.updated = package(http, made).await?["hash"]
                    .as_str()
                    .map(str::to_owned);
            }
        }
        expected(http, made, expect, &versions)
            .await
            .map_err(|why| format!("{at}: {why}"))?;
    }
    Ok(())
}

/// Whether `answer` is what `expect` says of a step: taken, or refused (naming `refused_says`).
pub fn verdict(expect: &Value, answer: &Answer, what: &str) -> Result<(), String> {
    if expect["refused"] == true && !answer.refused() {
        return Err(format!("{what} was taken; the runtime MUST refuse it"));
    }
    if expect["refused"] != true && !answer.ok() {
        return Err(format!("{what} was refused: {}", answer.says()));
    }
    if let Some(words) = expect["refused_says"].as_str()
        && !answer.says().contains(words)
    {
        return Err(format!(
            "{what}: its refusal doesn't name {words:?}: {}",
            answer.says()
        ));
    }
    Ok(())
}

async fn expected(
    http: &Http,
    bot: &Bot,
    expect: &Value,
    versions: &Versions,
) -> Result<(), String> {
    if let Some(switches) = expect["switches"].as_object() {
        let package = package(http, bot).await?;
        let rows = package["effects"].as_array().cloned().unwrap_or_default();
        for (key, on) in switches {
            match rows.iter().find(|row| row["key"] == key.as_str()) {
                Some(row) if row["on"] == *on => {}
                Some(row) => return Err(format!("{key} is {}, not {on}", row["on"])),
                None => return Err(format!("its package has no switch {key}: {rows:?}")),
            }
        }
    }
    if expect["routines_paused"] == true {
        let answer = http.get(&format!("/v1/agents/{}/routines", bot.id)).await?;
        let routines = answer.json["routines"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        if routines.is_empty() {
            return Err(format!("its triggers made no routine: {}", answer.says()));
        }
        if let Some(on) = routines.iter().find(|r| r["paused"] != true) {
            return Err(format!("a routine started on at install: {on}"));
        }
    }
    if let Some(which) = expect["package"].as_str() {
        let hash = package(http, bot).await?["hash"]
            .as_str()
            .map(str::to_owned);
        let ok = match which {
            "installed" => hash == versions.installed,
            _ => hash.is_some() && hash != versions.installed && hash == versions.updated,
        };
        if !ok {
            return Err(format!("it doesn't run the {which} version"));
        }
    }
    if let Some(names) = expect["contracts"].as_array() {
        let answer = http
            .get(&format!("/v1/agents/{}/contracts", bot.id))
            .await?;
        let listed: Vec<&Value> = answer.json["contracts"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|c| &c["name"])
            .collect();
        if let Some(missing) = names.iter().find(|n| !listed.contains(n)) {
            return Err(format!("it doesn't publish {missing}: {}", answer.says()));
        }
        if expect.get("incoming").is_some() && answer.json["incoming"] != expect["incoming"] {
            return Err(format!(
                "calls to it are {}, not {}",
                answer.json["incoming"], expect["incoming"]
            ));
        }
    }
    Ok(())
}

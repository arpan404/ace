//! The Surfaces level: panels over a runtime's HTTP API (`surfaces/panels.json`) and cards
//! through its scenario door (`surfaces/cards.json`). A panel's page reaches a client as text it
//! isolates, never as a page of its own; an action reaches the bot only as the panel declares it,
//! and a `confirm` action only when the person confirmed it outside the page.

use serde_json::{Value, json};

use crate::http::Http;
use crate::report::{Level, Outcome};
use crate::runtime::{self, Bot, ScenarioDoor, verdict};
use crate::suite;

/// Every Surfaces case.
pub async fn run<S: ScenarioDoor>(doors: &runtime::Doors<'_, S>) -> Level {
    let mut cases = Vec::new();
    let panels = suite::SURFACES_PANELS.json();
    for (n, case) in suite::SURFACES_PANELS.cases().iter().enumerate() {
        let result = match doors.http {
            Some(http) => panel_case(http, &panels, case, &format!("{}-p{n}", doors.run)).await,
            None => Err("not run: no HTTP door (--runtime)".to_owned()),
        };
        cases.push(Outcome::of(suite::id(case), result));
    }
    cases.extend(runtime::scenarios(doors.scenarios, &suite::SURFACES_CARDS).await);
    Level {
        level: "Surfaces",
        cases,
    }
}

async fn panel_case(http: &Http, all: &Value, case: &Value, run: &str) -> Result<(), String> {
    let recipe = suite::merged(&all["base"], &case["with"]);
    let bot = match runtime::install(http, &recipe, &json!({}), &all["pages"], run).await? {
        Ok(bot) => bot,
        Err(answer) => return Err(format!("the install was refused: {}", answer.says())),
    };
    let result = steps(http, all, case, &bot, run).await;
    let _ = http.delete(&format!("/v1/agents/{}", bot.id)).await;
    result
}

async fn steps(http: &Http, all: &Value, case: &Value, bot: &Bot, run: &str) -> Result<(), String> {
    let panel = all["base"]["surfaces"][0]["id"]
        .as_str()
        .unwrap_or_default();
    for (n, step) in case["steps"].as_array().into_iter().flatten().enumerate() {
        let expect = &step["expect"];
        let at = format!("step {}", n + 1);
        if step.get("page").is_some() {
            page(http, all, bot, panel)
                .await
                .map_err(|why| format!("{at}: {why}"))?;
        }
        if let Some(act) = step.get("act") {
            let mut body = json!({ "key": format!("act-{run}-{n}"), "action": act["action"] });
            if let Some(value) = act.get("value") {
                body["value"] = value.clone();
            }
            if act["confirmed"] == true {
                body["confirmed"] = json!(true);
            }
            let path = format!(
                "/v1/conversations/{}/panels/{panel}/actions",
                bot.conversation
            );
            let answer = http.post(&path, &body).await?;
            verdict(expect, &answer, &format!("{at}: the action"))?;
            if expect["taken"] == true && !answer.ok() {
                return Err(format!("{at}: the action wasn't taken: {}", answer.says()));
            }
        }
    }
    Ok(())
}

/// The panel's page, fetched as a client would: text that can't be taken for a page of its own.
async fn page(http: &Http, all: &Value, bot: &Bot, panel: &str) -> Result<(), String> {
    let listed = http
        .get(&format!("/v1/conversations/{}/panels", bot.conversation))
        .await?;
    let found = listed.json["panels"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|p| p["id"] == panel)
        .cloned()
        .ok_or_else(|| format!("its panels don't list {panel}: {}", listed.says()))?;
    let hash = found["page"]
        .as_str()
        .ok_or_else(|| format!("{panel} lists no page: {found}"))?;
    let served = http.get(&format!("/v1/panels/pages/{hash}")).await?;
    let file = all["base"]["surfaces"][0]["file"]
        .as_str()
        .unwrap_or_default();
    let written = all["pages"][file].as_str().unwrap_or_default();
    if !served.ok() || served.text != written {
        return Err(format!(
            "the page isn't the one the package shipped ({})",
            served.status
        ));
    }
    if !served.content_type.starts_with("text/plain") || !served.nosniff {
        return Err(format!(
            "the page is served as {:?}{}, which a browser could open as a page of its own",
            served.content_type,
            if served.nosniff {
                ""
            } else {
                " without nosniff"
            }
        ));
    }
    Ok(())
}

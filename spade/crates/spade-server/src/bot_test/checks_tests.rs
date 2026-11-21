//! A package's `schema` checks (ADR 0204 §3) through `spade --bot-test`: a contract's output and a
//! package card's data are held to them before the caller gets the output or the card is shown.
//! A miss goes back to the bot with the reasons, at most twice; then the call fails, or the card
//! isn't shown. A result that passes its checks goes through.

use serde_json::{Value, json};

fn package(dir: &std::path::Path, scenario: &Value) -> std::io::Result<()> {
    let manifest = json!({
        "format": "spade-bot",
        "version": 3,
        "requires": { "runtime": "1" },
        "name": "Flight watcher",
        "blurb": "Watches fares.",
        "task": "You watch flight fares for the person.",
        "contracts": [{
            "name": "cheapest_fare",
            "summary": "The cheapest fare seen for a route this week.",
            "input": { "type": "object", "properties": { "from": { "type": "string", "maxLength": 3 } }, "required": ["from"] },
            "output": { "type": "object", "properties": {
                "fare": { "type": "number" },
                "link": { "type": "string", "maxLength": 200 } }, "required": ["fare"] }
        }],
        "surfaces": [{ "id": "fare-drop", "kind": "card", "file": "cards/fare-drop.json" }],
        "checks": [
            { "name": "fare-has-link", "on": ["contract:cheapest_fare"], "kind": "schema",
              "rule": { "required": ["link"], "properties": { "link": { "pattern": "^https://" } } } },
            { "name": "short-title", "on": ["card:fare-drop"], "kind": "schema",
              "rule": { "properties": { "title": { "maxLength": 20 } } } }
        ],
        "tests": ["tests/one.json"],
        "pricing": { "kind": "free" }
    });
    std::fs::create_dir_all(dir.join("tests"))?;
    std::fs::write(dir.join("bot.json"), manifest.to_string())?;
    std::fs::write(dir.join("tests/one.json"), scenario.to_string())
}

fn returning(outputs: &[Value]) -> Value {
    let mut model: Vec<Value> = outputs
        .iter()
        .map(|output| {
            json!({ "calls": [{ "tool": "contract_return",
                                "arguments": { "call": super::CALL, "output": output } }] })
        })
        .collect();
    model.push(json!({ "say": "Sent." }));
    json!({
        "name": "Answers a fare question",
        "given": { "call": { "contract": "cheapest_fare", "input": { "from": "KTM" } } },
        "model": model,
        "expect": { "output": { "fare": 182 } }
    })
}

async fn failures(scenario: &Value) -> std::io::Result<Vec<String>> {
    let dir = tempfile::tempdir()?;
    package(dir.path(), scenario)?;
    let report = super::run(dir.path()).await;
    assert!(report.problems.is_empty(), "{:?}", report.problems);
    Ok(report
        .scenarios
        .first()
        .map(|s| s.failures.clone())
        .unwrap_or_default())
}

#[tokio::test]
async fn an_output_that_misses_a_check_goes_back_twice_and_then_the_call_fails()
-> std::io::Result<()> {
    let plain = json!({ "fare": 182, "link": "http://fares.example/ktm" });
    let failed = failures(&returning(&[plain.clone(), plain.clone(), plain])).await?;
    assert_eq!(
        failures_about_the_call(&failed),
        vec!["The call failed: fare-has-link: output.link: doesn't match ^https://".to_owned()],
        "{failed:?}"
    );
    Ok(())
}

fn failures_about_the_call(failures: &[String]) -> Vec<String> {
    failures
        .iter()
        .filter(|f| f.starts_with("The call"))
        .cloned()
        .collect()
}

#[tokio::test]
async fn an_output_that_passes_its_checks_on_a_retry_returns() -> std::io::Result<()> {
    let failed = failures(&returning(&[
        json!({ "fare": 182 }),
        json!({ "fare": 182, "link": "https://fares.example/ktm" }),
    ]))
    .await?;
    assert_eq!(failed, Vec::<String>::new());
    Ok(())
}

fn showing(titles: &[&str]) -> Value {
    let mut model: Vec<Value> = titles
        .iter()
        .map(|title| {
            json!({ "calls": [{ "tool": "card_show",
                                "arguments": { "surface": "fare-drop", "data": { "title": title } } }] })
        })
        .collect();
    model.push(json!({ "say": "Shown." }));
    json!({
        "name": "Shows a fare drop",
        "given": { "message": "Show me the drop." },
        "model": model,
        "expect": { "cards": ["Fare"] }
    })
}

#[tokio::test]
async fn a_package_card_that_misses_its_checks_three_times_is_not_shown() -> std::io::Result<()> {
    let long = "Fare dropped to 182 USD on KTM to DEL";
    let failed = failures(&showing(&[long, long, long, long])).await?;
    assert!(
        failed.contains(&"No card titled with \"Fare\" was shown".to_owned()),
        "{failed:?}"
    );
    assert!(
        failed
            .iter()
            .any(|f| f.contains("won't be shown in this reply")),
        "{failed:?}"
    );
    Ok(())
}

#[tokio::test]
async fn a_package_card_that_passes_its_checks_is_shown() -> std::io::Result<()> {
    let failed = failures(&showing(&["Fare now 182"])).await?;
    assert_eq!(failed, Vec::<String>::new());
    Ok(())
}

//! `spade --bot-test` on a package that publishes a contract (ADR 0200 §7, §9): a scenario gives
//! the bot a call from another of the person's bots, its scripted model returns, and the output
//! is checked against the contract's schema and what the scenario expects.

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
            "output": { "type": "object", "properties": { "fare": { "type": "number" } }, "required": ["fare"] }
        }],
        "tests": ["tests/answers-a-call.json"],
        "pricing": { "kind": "free" }
    });
    std::fs::create_dir_all(dir.join("tests"))?;
    std::fs::write(dir.join("bot.json"), manifest.to_string())?;
    std::fs::write(dir.join("tests/answers-a-call.json"), scenario.to_string())
}

fn answering(output: Value, expected: Value) -> Value {
    json!({
        "name": "Answers a fare question",
        "given": { "call": { "contract": "cheapest_fare", "input": { "from": "KTM" }, "from": "Trip planner" } },
        "model": [
            { "calls": [{ "tool": "contract_return", "arguments": { "call": super::CALL, "output": output } }] },
            { "say": "Sent." }
        ],
        "expect": { "calls": ["contract_return"], "output": expected }
    })
}

#[tokio::test]
async fn a_scenario_can_give_the_bot_a_contract_call_and_check_what_it_returns()
-> std::io::Result<()> {
    let dir = tempfile::tempdir()?;
    package(
        dir.path(),
        &answering(json!({ "fare": 182 }), json!({ "fare": 182 })),
    )?;
    let report = super::run(dir.path()).await;
    assert!(
        report.passed(),
        "{:?} {:?}",
        report.problems,
        report.scenarios
    );
    Ok(())
}

#[tokio::test]
async fn a_scenario_fails_when_the_bot_returns_other_output_or_output_that_doesnt_fit()
-> std::io::Result<()> {
    let dir = tempfile::tempdir()?;
    package(
        dir.path(),
        &answering(json!({ "fare": 99 }), json!({ "fare": 182 })),
    )?;
    let report = super::run(dir.path()).await;
    let failures = report
        .scenarios
        .first()
        .map(|s| s.failures.clone())
        .unwrap_or_default();
    assert_eq!(
        failures,
        vec!["The output's fare is 99, not 182".to_owned()]
    );

    package(
        dir.path(),
        &answering(json!({ "fare": "cheap" }), json!({ "fare": 182 })),
    )?;
    let report = super::run(dir.path()).await;
    let failures = report
        .scenarios
        .first()
        .map(|s| s.failures.clone())
        .unwrap_or_default();
    assert!(
        failures
            .iter()
            .any(|f| f.contains("contract_return ran and answered an error")),
        "{failures:?}"
    );
    Ok(())
}

#[tokio::test]
async fn a_scenario_that_calls_a_contract_the_package_doesnt_publish_is_a_problem()
-> std::io::Result<()> {
    let dir = tempfile::tempdir()?;
    let mut scenario = answering(json!({ "fare": 182 }), json!({ "fare": 182 }));
    scenario["given"]["call"]["contract"] = json!("dearest_fare");
    package(dir.path(), &scenario)?;
    let report = super::run(dir.path()).await;
    assert!(
        report
            .problems
            .iter()
            .any(|p| p.contains("no contract \"dearest_fare\"")),
        "{:?}",
        report.problems
    );
    Ok(())
}

#[tokio::test]
async fn a_contracts_schemas_in_a_file_of_the_package_check_the_output_as_in_bot_json()
-> std::io::Result<()> {
    let dir = tempfile::tempdir()?;
    package(
        dir.path(),
        &answering(json!({ "fare": "cheap" }), json!({ "fare": 182 })),
    )?;
    // The same contract with its schemas moved to contracts/cheapest-fare.json.
    let mut manifest: Value =
        serde_json::from_str(&std::fs::read_to_string(dir.path().join("bot.json"))?)?;
    let contract = &mut manifest["contracts"][0];
    let schemas = json!({ "input": contract["input"].take(), "output": contract["output"].take() });
    if let Some(fields) = contract.as_object_mut() {
        fields.remove("input");
        fields.remove("output");
        fields.insert("file".into(), json!("contracts/cheapest-fare.json"));
    }
    std::fs::write(dir.path().join("bot.json"), manifest.to_string())?;
    let report = super::run(dir.path()).await;
    assert!(
        report
            .problems
            .iter()
            .any(|p| p.contains("contracts/cheapest-fare.json isn't in the package")),
        "{:?}",
        report.problems
    );

    std::fs::create_dir_all(dir.path().join("contracts"))?;
    std::fs::write(
        dir.path().join("contracts/cheapest-fare.json"),
        schemas.to_string(),
    )?;
    let report = super::run(dir.path()).await;
    assert!(report.problems.is_empty(), "{:?}", report.problems);
    let failures = report
        .scenarios
        .first()
        .map(|s| s.failures.clone())
        .unwrap_or_default();
    assert!(
        failures
            .iter()
            .any(|f| f.contains("contract_return ran and answered an error")),
        "the file's output schema refuses a fare that isn't a number: {failures:?}"
    );
    Ok(())
}

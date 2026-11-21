//! `spade --bot-test` on a package with its own code (ADR 0203 §6): the component runs for real,
//! offline, its `http` answered by the scenario's `http:<host>` fakes, and a scenario fails when
//! the code's answer is wrong. A process test: the edge is Spade's own binary, as a developer and
//! the market's signer run it.
#![cfg(any(target_os = "macos", all(target_os = "linux", feature = "landlock")))]

mod support;

use serde_json::{Value, json};
use support::Result;
use support::code::{PROGRAM, component, entry, recipe};

fn scenario(name: &str, fare: u64) -> Value {
    json!({
        "name": name,
        "given": { "message": "Cheapest fare?" },
        "model": [
            { "calls": [{ "tool": "code_fares_http_get", "arguments": { "u": "https://api.example-fares.com/cheapest" } }] },
            { "say": "The cheapest is 120." }
        ],
        "tools": { "http:api.example-fares.com": "{\"fare\":120,\"airline\":\"Yeti\"}" },
        "expect": {
            "calls": ["code_fares_http_get"],
            "results": { "code_fares_http_get": { "fare": fare } }
        }
    })
}

#[test]
fn a_scenario_runs_the_packages_code_offline_and_fails_when_its_answer_is_wrong() -> Result {
    let folder = tempfile::tempdir()?;
    let mut manifest = recipe(
        json!([{ "effect": "network", "hosts": ["api.example-fares.com"], "why": "Reads fares." }]),
        json!([entry(
            "fares",
            &["spade:package/tools", "spade:package/http"]
        )]),
    );
    manifest["tests"] = json!(["tests/right.json", "tests/wrong.json"]);
    std::fs::create_dir_all(folder.path().join("code"))?;
    std::fs::create_dir_all(folder.path().join("tests"))?;
    std::fs::write(folder.path().join("bot.json"), manifest.to_string())?;
    std::fs::write(folder.path().join("code/fares.wasm"), component(true))?;
    std::fs::write(
        folder.path().join("tests/right.json"),
        scenario("Reads the fare", 120).to_string(),
    )?;
    std::fs::write(
        folder.path().join("tests/wrong.json"),
        scenario("Expects another fare", 340).to_string(),
    )?;
    let ran = std::process::Command::new(PROGRAM)
        .arg("--bot-test")
        .arg(folder.path())
        .output()?;
    let report: Value = serde_json::from_slice(&ran.stdout)
        .unwrap_or_else(|e| panic!("{e}: {}", String::from_utf8_lossy(&ran.stderr)));
    assert_eq!(report["problems"], json!([]), "{report}");
    let scenarios = report["scenarios"].as_array().cloned().unwrap_or_default();
    assert_eq!(scenarios.len(), 2, "{report}");
    assert_eq!(scenarios[0]["passed"], true, "{report}");
    assert_eq!(scenarios[1]["passed"], false, "{report}");
    assert_eq!(
        scenarios[1]["failures"],
        json!(["code_fares_http_get's answer has fare 120, not 340"]),
        "{report}"
    );
    // The run fails as a whole.
    assert!(!ran.status.success());
    Ok(())
}

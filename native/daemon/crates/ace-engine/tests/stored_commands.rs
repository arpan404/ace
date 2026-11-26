// SPDX-License-Identifier: Apache-2.0

use ace_engine::intents::command;
use serde::Deserialize;

#[derive(Deserialize)]
struct Fixture {
    commands: Vec<Case>,
}

#[derive(Deserialize)]
struct Case {
    name: String,
    input: String,
    output: Option<String>,
}

#[test]
fn stored_commands_match_zod_verdicts_and_json_bytes() {
    let fixture: Fixture =
        serde_json::from_str(include_str!("fixtures/stored-command-cases.json")).unwrap();
    let mut mismatches = Vec::new();
    for case in fixture.commands {
        let actual = command::parse(&case.input)
            .ok()
            .map(|command| ace_json::to_string(&command));
        if actual != case.output {
            mismatches.push(format!(
                "{}: expected {:?}, got {:?}",
                case.name, case.output, actual
            ));
        }
    }
    assert!(
        mismatches.is_empty(),
        "{} mismatches, first 12:\n{}",
        mismatches.len(),
        mismatches
            .iter()
            .take(12)
            .cloned()
            .collect::<Vec<_>>()
            .join("\n")
    );
}

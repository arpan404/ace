use serde_json::json;

use super::*;

fn scenario(value: serde_json::Value) -> Scenario {
    match read_scenario(&value.to_string(), &["Morning check"]) {
        Ok(scenario) => scenario,
        Err(problems) => panic!("{problems:?}"),
    }
}

fn problems(value: serde_json::Value) -> Vec<String> {
    read_scenario(&value.to_string(), &["Morning check"])
        .err()
        .unwrap_or_default()
}

fn watch() -> Scenario {
    scenario(json!({
        "name": "Watches a trip",
        "given": { "message": "Watch KTM to DEL" },
        "model": [
            { "calls": [{ "tool": "web_fetch", "arguments": { "url": "https://api.example-fares.com/" } }] },
            { "calls": [{ "tool": "memory_save" }] },
            { "say": "I'll watch it." }
        ],
        "expect": {
            "calls": ["web_fetch", "memory_save"],
            "effects": ["network"],
            "reply_contains": ["WATCH"]
        }
    }))
}

fn ran(tool: &str, effect: Effect) -> Seen {
    Seen {
        tool: tool.to_owned(),
        effect: Some(effect),
        outcome: Outcome::Ran,
    }
}

fn run(calls: Vec<Seen>, reply: &str) -> Observed {
    Observed {
        calls,
        reply: reply.to_owned(),
        ..Observed::default()
    }
}

#[test]
fn a_run_that_does_what_the_scenario_expects_passes() {
    let seen = run(
        vec![
            ran("web_fetch", Effect::Network),
            ran("memory_save", Effect::WriteLocal),
        ],
        "I'll watch it.",
    );
    assert_eq!(check(&watch(), &seen), Vec::<String>::new());
}

#[test]
fn each_expectation_a_run_misses_is_its_own_failure() {
    let seen = run(vec![ran("memory_save", Effect::WriteLocal)], "Done.");
    let failures = check(&watch(), &seen);
    assert_eq!(
        failures,
        vec![
            "web_fetch was expected to run and didn't",
            "No call asked for network",
            "The reply doesn't say \"WATCH\"",
        ]
    );
}

#[test]
fn calls_in_another_order_fail_by_order() {
    let seen = run(
        vec![
            ran("memory_save", Effect::WriteLocal),
            ran("web_fetch", Effect::Network),
        ],
        "I'll watch it.",
    );
    assert_eq!(
        check(&watch(), &seen),
        vec!["memory_save ran, but not in the order expect.calls gives"]
    );
}

#[test]
fn a_refused_call_fails_unless_the_scenario_expects_the_refusal() {
    let refused = Seen {
        tool: "send_message".to_owned(),
        effect: Some(Effect::SendAsPerson),
        outcome: Outcome::Refused(
            "Not run: Flight watcher doesn't declare sending in your name.".to_owned(),
        ),
    };
    let mut seen = run(
        vec![
            ran("web_fetch", Effect::Network),
            ran("memory_save", Effect::WriteLocal),
            refused,
        ],
        "I'll watch it.",
    );
    let failures = check(&watch(), &seen);
    assert_eq!(failures.len(), 1, "{failures:?}");
    assert!(
        failures[0].starts_with("send_message was refused: Not run:"),
        "{failures:?}"
    );

    let mut expecting = watch();
    expecting.expect.refused = vec!["send_message".to_owned()];
    assert_eq!(check(&expecting, &seen), Vec::<String>::new());
    // A refused call didn't run, so it can't stand in for a call the scenario expects to run.
    expecting.expect.calls.push("send_message".to_owned());
    seen.calls.truncate(3);
    assert_eq!(
        check(&expecting, &seen),
        vec!["send_message was expected to run and didn't"]
    );
}

#[test]
fn a_card_that_did_not_fit_or_a_turn_that_did_not_finish_fails() {
    let seen = Observed {
        calls: vec![
            ran("web_fetch", Effect::Network),
            ran("memory_save", Effect::WriteLocal),
        ],
        card_problems: vec!["data.blocks[0].kind: html is not a block".to_owned()],
        ended: Some("the model's endpoint failed".to_owned()),
        reply: "I'll watch it.".to_owned(),
        ..Observed::default()
    };
    assert_eq!(
        check(&watch(), &seen),
        vec![
            "The turn didn't finish with a reply: the model's endpoint failed",
            "A card didn't fit and wasn't shown: data.blocks[0].kind: html is not a block",
        ]
    );
}

#[test]
fn cards_are_found_by_words_in_their_title() {
    let mut wants = watch();
    wants.expect.cards = vec!["fare dropped".to_owned()];
    let mut seen = run(
        vec![
            ran("web_fetch", Effect::Network),
            ran("memory_save", Effect::WriteLocal),
        ],
        "I'll watch it.",
    );
    assert_eq!(
        check(&wants, &seen),
        vec!["No card titled with \"fare dropped\" was shown"]
    );
    seen.cards.push("Fare dropped: KTM to DEL".to_owned());
    assert_eq!(check(&wants, &seen), Vec::<String>::new());
}

#[test]
fn a_scenario_names_its_problems_by_place() {
    assert_eq!(
        problems(json!({
            "name": " ",
            "given": { "trigger": "Evening check" },
            "model": [
                { "calls": [{ "tool": "Web Fetch", "arguments": [] }] }
            ],
            "expect": { "effects": ["teleport"] }
        })),
        vec![
            "name says in a few words what the scenario shows",
            "given.trigger: \"Evening check\" isn't one of the package's schedule, event or webhook triggers",
            "model[0].calls[0].tool: \"Web Fetch\" isn't a tool name",
            "model[0].calls[0].arguments is an object",
            "model's last step only says something: the engine asks again after each call",
            "expect.effects: \"teleport\" isn't an effect",
        ]
    );
}

#[test]
fn a_misspelt_field_is_a_problem_not_a_silent_pass() {
    let found = problems(json!({
        "name": "Watches",
        "given": { "message": "Hi" },
        "model": [{ "say": "Hi" }],
        "expects": { "calls": ["web_fetch"] }
    }));
    assert_eq!(found.len(), 1);
    assert!(found[0].contains("unknown field `expects`"), "{found:?}");
}

#[test]
fn a_scenario_starts_from_a_message_or_a_trigger_never_both() {
    let both = problems(json!({
        "name": "Both",
        "given": { "message": "Hi", "trigger": "Morning check" },
        "model": [{ "say": "Hi" }]
    }));
    assert_eq!(both, vec!["given is a message or a trigger, one of them"]);
    let trigger = scenario(json!({
        "name": "Morning",
        "given": { "trigger": "Morning check" },
        "model": [{ "say": "Nothing dropped." }]
    }));
    assert_eq!(trigger.given.trigger.as_deref(), Some("Morning check"));
}

#[test]
fn an_expected_call_that_answered_an_error_fails() {
    let failed = Seen {
        tool: "memory_save".to_owned(),
        effect: Some(Effect::WriteLocal),
        outcome: Outcome::Failed("text is required".to_owned()),
    };
    let seen = run(
        vec![ran("web_fetch", Effect::Network), failed],
        "I'll watch it.",
    );
    assert_eq!(
        check(&watch(), &seen),
        vec!["memory_save ran and answered an error: text is required"]
    );
}

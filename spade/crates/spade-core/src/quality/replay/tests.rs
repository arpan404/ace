use serde_json::{Value, json};

use super::*;
use crate::effect::Effect;
use crate::package::scenario::Seen;
use crate::quality::case::{
    Given as CaseGiven, Outcome as CaseOutcome, Step as CaseStep, StepCall, Trigger,
};

fn result(call: &str, tool: &str, arguments: Value, content: &str) -> ToolResult {
    ToolResult {
        call: call.into(),
        tool: tool.into(),
        arguments,
        content: content.into(),
        is_error: false,
    }
}

/// A kept run: it fetched a fare page twice, saved a note, and showed a card.
fn kept() -> Case {
    let fetch = json!({ "url": "https://fares.example/ktm" });
    Case {
        id: "case_1".into(),
        bot: "bot_1".into(),
        reply: "r_2".into(),
        package: None,
        trigger: Trigger {
            kind: TriggerKind::Message,
            name: None,
        },
        given: CaseGiven {
            messages: vec!["Watch KTM to DEL".into()],
            input: None,
        },
        steps: vec![
            CaseStep {
                text: "Looking.".into(),
                calls: vec![
                    StepCall {
                        id: "c1".into(),
                        tool: "web_fetch".into(),
                        arguments: fetch.clone(),
                    },
                    StepCall {
                        id: "c2".into(),
                        tool: "web_fetch".into(),
                        arguments: fetch.clone(),
                    },
                ],
            },
            CaseStep {
                text: String::new(),
                calls: vec![StepCall {
                    id: "c3".into(),
                    tool: "memory_save".into(),
                    arguments: json!({ "text": "KTM-DEL" }),
                }],
            },
            CaseStep {
                text: "Watching it.".into(),
                calls: Vec::new(),
            },
        ],
        tool_results: vec![
            result("c1", "web_fetch", fetch.clone(), "182 USD"),
            result("c2", "web_fetch", fetch, "179 USD"),
            result("c3", "memory_save", json!({ "text": "KTM-DEL" }), "Saved."),
        ],
        outcome: CaseOutcome {
            text: "Watching it.".into(),
            cards: vec![json!({ "title": "Fare drop", "blocks": [] })],
            contract: None,
            effects: vec!["network".into()],
            verdict: None,
        },
        mark: None,
        why: None,
        made_at: 0,
    }
}

fn seen(tool: &str, effect: Effect, outcome: Outcome) -> Seen {
    Seen {
        tool: tool.into(),
        effect: Some(effect),
        outcome,
    }
}

/// What a replay of [`kept`] that did the same shows.
fn same() -> Observed {
    Observed {
        calls: vec![
            seen("web_fetch", Effect::Network, Outcome::Ran),
            seen("web_fetch", Effect::Network, Outcome::Ran),
            seen("memory_save", Effect::WriteLocal, Outcome::Ran),
        ],
        cards: vec!["Fare drop".into()],
        card_problems: Vec::new(),
        reply: "Watching it.".into(),
        ended: None,
        returned: None,
    }
}

#[test]
fn a_case_becomes_a_scenario_of_its_message_and_its_recorded_steps() {
    let scenario = scenario(&kept(), "cc.scenario");
    assert_eq!(scenario.given.message.as_deref(), Some("Watch KTM to DEL"));
    let tools: Vec<Vec<&str>> = scenario
        .model
        .iter()
        .map(|s| s.calls.iter().map(|c| c.tool.as_str()).collect())
        .collect();
    assert_eq!(
        tools,
        vec![vec!["web_fetch", "web_fetch"], vec!["memory_save"], vec![]]
    );
    assert_eq!(
        scenario.model.last().map(|s| s.say.as_str()),
        Some("Watching it.")
    );
}

#[test]
fn a_contract_case_replays_its_call_and_returns_to_the_runs_own_call_id() {
    let mut case = kept();
    case.trigger = Trigger {
        kind: TriggerKind::Contract,
        name: Some("cheapest_fare".into()),
    };
    case.given.input = Some(json!({ "from": "KTM" }));
    case.steps = vec![CaseStep {
        text: String::new(),
        calls: vec![StepCall {
            id: "c1".into(),
            tool: "contract_return".into(),
            arguments: json!({ "call": "cc.c_4.p1", "output": { "fare": 182 } }),
        }],
    }];
    let scenario = scenario(&case, "cc.scenario");
    let call = scenario
        .given
        .call
        .clone()
        .unwrap_or_else(|| panic!("a call"));
    assert_eq!(
        (call.contract.as_str(), call.input),
        ("cheapest_fare", json!({ "from": "KTM" }))
    );
    assert_eq!(scenario.model[0].calls[0].arguments["call"], "cc.scenario");
    // The run's reply ends with the kept run's words.
    assert_eq!(scenario.model[1].say, "Watching it.");
}

#[test]
fn the_recording_answers_a_call_by_tool_and_arguments_in_order_and_counts_any_other() {
    let mut case = kept();
    case.tool_results.push(ToolResult {
        is_error: true,
        ..result("c4", "send_message", json!({}), "Not run: no send.")
    });
    let mut recording = Recording::new(&case);
    let fetch = json!({ "url": "https://fares.example/ktm" });
    let answer = |r: &mut Recording, tool: &str, args: &Value| r.answer(tool, args).map(|a| a.0);
    assert_eq!(
        answer(&mut recording, "web_fetch", &fetch).as_deref(),
        Some("182 USD")
    );
    assert_eq!(
        answer(&mut recording, "web_fetch", &fetch).as_deref(),
        Some("179 USD")
    );
    // Asked again more often than the kept run did: the last answer again.
    assert_eq!(
        answer(&mut recording, "web_fetch", &fetch).as_deref(),
        Some("179 USD")
    );
    assert_eq!(recording.outside(), 0);
    let other = json!({ "url": "https://fares.example/lis" });
    assert_eq!(answer(&mut recording, "web_fetch", &other), None);
    // A call the gate refused in the kept run never ran, so it has no answer.
    assert_eq!(answer(&mut recording, "send_message", &json!({})), None);
    assert_eq!(recording.outside(), 2);
}

#[test]
fn a_wiring_replay_that_does_the_same_passes() {
    let judged = judge(&kept(), &same(), 0, Mode::Wiring);
    assert_eq!(judged.lines, Vec::<String>::new());
    assert!(judged.passed);
}

#[test]
fn a_wiring_replay_fails_on_a_refused_call_a_missing_card_or_a_failed_contract_call() {
    let mut refused = same();
    refused.calls[0].outcome = Outcome::Refused("Flight watcher doesn't declare network.".into());
    refused.calls[1].outcome = Outcome::Refused("Flight watcher doesn't declare network.".into());
    refused.cards.clear();
    let judged = judge(&kept(), &refused, 0, Mode::Wiring);
    assert!(!judged.passed);
    assert_eq!(
        judged.lines,
        vec![
            "web_fetch was refused: Flight watcher doesn't declare network.".to_owned(),
            "web_fetch was refused: Flight watcher doesn't declare network.".to_owned(),
            "The card \"Fare drop\" wasn't shown".to_owned(),
        ]
    );
    let mut case = kept();
    case.trigger = Trigger {
        kind: TriggerKind::Contract,
        name: Some("cheapest_fare".into()),
    };
    case.outcome.contract = Some(json!({ "status": "returned", "output": { "fare": 182 } }));
    let mut failed = same();
    failed.returned = Some(Returned::Failed(vec!["output.link: is missing".into()]));
    assert_eq!(
        judge(&case, &failed, 0, Mode::Wiring).lines,
        vec!["The call failed: output.link: is missing".to_owned()]
    );
}

#[test]
fn a_model_replay_counts_calls_outside_the_recording_and_fails_only_on_what_the_gate_refused() {
    let mut other = same();
    other
        .calls
        .push(seen("web_search", Effect::Network, Outcome::Ran));
    other.cards.clear();
    let judged = judge(&kept(), &other, 1, Mode::Model);
    assert!(judged.passed, "{:?}", judged.lines);
    assert_eq!(judged.outside, 1);
    other.calls.push(seen(
        "send_message",
        Effect::SendAsPerson,
        Outcome::Refused("Flight watcher doesn't declare sending.".into()),
    ));
    let judged = judge(&kept(), &other, 1, Mode::Model);
    assert_eq!(
        judged.lines,
        vec!["send_message was refused: Flight watcher doesn't declare sending.".to_owned()]
    );
}

#[test]
fn the_summary_says_how_many_replayed_the_same_in_words() {
    let pass = Judged {
        passed: true,
        lines: Vec::new(),
        outside: 0,
    };
    let fail = Judged {
        passed: false,
        lines: vec!["x".into()],
        outside: 2,
    };
    assert_eq!(
        summary(&[&pass, &pass], Mode::Wiring),
        "All 2 kept runs replay the same."
    );
    assert_eq!(
        summary(&[&pass, &fail, &pass], Mode::Wiring),
        "2 of 3 kept runs replay the same. 1 doesn't: see why."
    );
    assert_eq!(
        summary(&[&pass, &fail], Mode::Model),
        "1 of 2 kept runs the same or better. 1 worse: see why. 2 calls were outside the recording."
    );
    assert_eq!(summary(&[], Mode::Wiring), "No kept runs to replay.");
}

#[test]
fn a_marked_case_is_compared_by_one_call_quoting_both_outcomes_and_an_unmarked_one_is_not() {
    let mut case = kept();
    assert!(comparison(&case, "Watching it.").is_none());
    case.mark = Some(crate::quality::case::Mark::Wrong);
    case.why = Some("It watched the wrong <route>".into());
    let prompt = comparison(&case, "Watching KTM to BOM.").unwrap_or_default();
    let text = format!("{prompt:?}");
    assert!(text.contains("doesn't repeat that mistake"), "{text}");
    assert!(text.contains("Watching KTM to BOM."));
    assert!(text.contains("wrong ‹route›"), "data is quoted: {text}");
}

#[test]
fn a_replays_estimate_grows_with_what_each_step_reads_and_is_nothing_on_a_free_model() {
    let case = kept();
    assert_eq!(estimate_micros(&case, 0.0, 0.0), 0);
    let cheap = estimate_micros(&case, 1.0, 2.0);
    let dear = estimate_micros(&case, 10.0, 20.0);
    assert!(cheap > 0 && dear >= cheap * 9, "{cheap} {dear}");
}

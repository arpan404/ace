use serde_json::json;

use super::*;
use crate::autonomy::Sensitive;

/// A held write of `effect` from the host, nothing else about it.
fn call(tool: &str, effect: Option<Effect>) -> Call<'_> {
    Call {
        tool,
        rule: Decision::Ask,
        risk: Risk::Write,
        always: false,
        effect,
        remembered: None,
        place: Place::Host,
        tainted: false,
        credentials: false,
        standing: false,
        fits: true,
        granted: Granted::No,
        checkpointed: false,
    }
}

fn asks(line: &str) -> Route {
    Route::Ask {
        line: line.to_owned(),
        ask: None,
    }
}

fn reviewed(concern: Option<&str>) -> Route {
    Route::Review(concern.map(str::to_owned))
}

#[test]
fn each_effect_goes_where_its_rule_sends_it() {
    use Effect::*;
    let cases = [
        (Read, Route::Run),
        (WriteLocal, Route::Run),
        (Network, reviewed(None)),
        (Publish, reviewed(Some(PUBLISHES))),
        (SendAsPerson, asks(SENDS_AS_YOU)),
        (Pay, asks(SPENDS)),
        (ChangeAccess, asks(CHANGES_ACCESS)),
        (
            Credential,
            Route::Refuse(autonomy::CREDENTIALS_REFUSED.to_owned()),
        ),
    ];
    for (effect, expected) in cases {
        assert_eq!(
            route(call("app_tool", Some(effect))),
            expected,
            "{effect:?}"
        );
    }
}

#[test]
fn a_sandboxed_call_runs_whatever_it_is_unless_it_pays_sends_or_reads_secrets() {
    use Effect::*;
    for effect in [
        Some(Read),
        Some(WriteLocal),
        Some(Network),
        Some(Publish),
        None,
    ] {
        let sandboxed = Call {
            place: Place::Sandbox,
            tainted: true,
            ..call("shell", effect)
        };
        assert_eq!(route(sandboxed), Route::Run, "{effect:?}");
    }
    for (effect, line) in [(SendAsPerson, SENDS_AS_YOU), (Pay, SPENDS)] {
        let sandboxed = Call {
            place: Place::Sandbox,
            ..call("plugin__tool", Some(effect))
        };
        assert_eq!(route(sandboxed), asks(line), "{effect:?}");
    }
}

#[test]
fn a_sandboxed_command_never_reaches_the_reviewer_under_any_fact() {
    for tainted in [false, true] {
        for fits in [false, true] {
            for rule in [Decision::Run, Decision::Ask] {
                let sandboxed = Call {
                    place: Place::Sandbox,
                    tainted,
                    fits,
                    rule,
                    ..call("shell", Some(Effect::WriteLocal))
                };
                assert_eq!(route(sandboxed), Route::Run);
            }
        }
    }
}

#[test]
fn sends_and_payments_run_only_on_always_allow_and_never_on_a_tool_grant() {
    for effect in [Effect::SendAsPerson, Effect::Pay] {
        let always = Call {
            always: true,
            rule: Decision::Run,
            ..call("gmail__send", Some(effect))
        };
        assert_eq!(route(always), Route::Run);
        // Always allow under untrusted content: the rule gate holds it, so the person decides.
        let tainted = Call {
            always: true,
            tainted: true,
            ..call("gmail__send", Some(effect))
        };
        assert!(matches!(route(tainted), Route::Ask { .. }));
        let tool_grant = Call {
            granted: Granted::Tool,
            ..call("gmail__send", Some(effect))
        };
        assert!(matches!(route(tool_grant), Route::Ask { .. }));
        // A read-only claim doesn't run it: the effect decides.
        let read_risk = Call {
            risk: Risk::Read,
            rule: Decision::Run,
            ..call("gmail__send", Some(effect))
        };
        assert!(matches!(route(read_risk), Route::Ask { .. }));
    }
}

#[test]
fn a_push_runs_within_its_grant_and_otherwise_goes_to_the_person() {
    let push = call(GIT_PUSH, Some(Effect::SendAsPerson));
    let cases = [
        (Granted::Typed, false, Route::Run),
        (Granted::Typed, true, reviewed(Some(GRANTED_TAINTED))),
        (Granted::No, false, asks(PUSHES)),
        (Granted::No, true, asks(PUSHES)),
        (Granted::Tool, false, asks(PUSHES)),
    ];
    for (granted, tainted, expected) in cases {
        let call = Call {
            granted,
            tainted,
            ..push
        };
        assert_eq!(route(call), expected, "{granted:?} tainted={tainted}");
    }
}

#[test]
fn an_undeclared_tool_asks_once_then_keeps_the_answer() {
    let tool = call("app__mystery", None);
    assert_eq!(
        route(tool),
        Route::Ask {
            line: UNDECLARED.to_owned(),
            ask: Some(Ask::Undeclared),
        }
    );
    let allowed = Call {
        remembered: Some(true),
        ..tool
    };
    assert_eq!(route(allowed), Route::Run);
    let declined = Call {
        remembered: Some(false),
        ..tool
    };
    assert_eq!(route(declined), Route::Refuse(DECLINED_TOOL.to_owned()));
    let steered = Call {
        remembered: Some(true),
        tainted: true,
        ..tool
    };
    assert_eq!(route(steered), asks(UNDECLARED_TAINTED));
}

#[test]
fn a_command_asking_to_run_outside_goes_to_the_person_with_its_own_card() {
    let outside = Call {
        place: Place::AsksOutside,
        ..call("shell", Some(Effect::WriteLocal))
    };
    assert_eq!(
        route(outside),
        Route::Ask {
            line: OUTSIDE.to_owned(),
            ask: Some(Ask::OutsideSandbox),
        }
    );
}

#[test]
fn a_command_outside_the_sandbox_takes_the_review_path_with_the_classifier() {
    let cases = [
        (Class::Inside, reviewed(None)),
        (
            Class::Sensitive(Sensitive::Network),
            reviewed(Some(Sensitive::Network.reason())),
        ),
        (
            Class::Sensitive(Sensitive::MessageAsPerson),
            asks("It sends something in your name, so you decide."),
        ),
    ];
    for (class, expected) in cases {
        let outside = Call {
            place: Place::Unsandboxed(class),
            ..call("shell", Some(Effect::WriteLocal))
        };
        assert_eq!(route(outside), expected, "{class:?}");
    }
}

#[test]
fn credentials_are_refused_before_anything_else() {
    for place in [
        Place::Host,
        Place::AsksOutside,
        Place::Unsandboxed(Class::Inside),
    ] {
        let reaching = Call {
            credentials: true,
            always: true,
            rule: Decision::Run,
            place,
            ..call("shell", Some(Effect::Read))
        };
        assert_eq!(
            route(reaching),
            Route::Refuse(autonomy::CREDENTIALS_REFUSED.to_owned())
        );
    }
}

#[test]
fn local_writes_run_but_unprotected_file_writes_and_tainted_notes_keep_their_review() {
    let cases = [
        ("todo", Risk::Write, false, false, Route::Run),
        ("workspace_write", Risk::Write, false, false, reviewed(None)),
        ("workspace_write", Risk::Write, true, false, Route::Run),
        ("workspace_write", Risk::Write, true, true, Route::Run),
        ("memory_save", Risk::Memory, false, true, reviewed(None)),
    ];
    for (tool, risk, checkpointed, tainted, expected) in cases {
        let write = Call {
            risk,
            checkpointed,
            tainted,
            ..call(tool, Some(Effect::WriteLocal))
        };
        assert_eq!(route(write), expected, "{tool}");
    }
}

#[test]
fn writes_outside_the_box_run_on_a_grant_and_are_reviewed_without_one() {
    let write = call("jira__create_issue", Some(Effect::Network));
    let cases = [
        (Granted::Tool, false, Risk::Write, Route::Run),
        (
            Granted::Tool,
            true,
            Risk::Write,
            reviewed(Some(GRANTED_TAINTED)),
        ),
        (
            Granted::No,
            true,
            Risk::Write,
            reviewed(Some(TAINTED_OUTWARD)),
        ),
        (
            Granted::No,
            false,
            Risk::Destructive,
            reviewed(Some(DELETES)),
        ),
    ];
    for (granted, tainted, risk, expected) in cases {
        let call = Call {
            granted,
            tainted,
            risk,
            ..write
        };
        assert_eq!(route(call), expected, "{granted:?} {tainted} {risk:?}");
    }
    let too_long = Call {
        fits: false,
        ..write
    };
    assert_eq!(route(too_long), asks(TOO_LONG));
}

#[test]
fn a_routine_set_up_under_untrusted_content_is_reviewed_even_when_allowed_always() {
    let routine = Call {
        standing: true,
        tainted: true,
        always: true,
        ..call("routine_save", Some(Effect::WriteLocal))
    };
    assert_eq!(
        route(routine),
        reviewed(Some(Sensitive::TaintedRoutine.reason()))
    );
}

#[test]
fn names_never_change_an_effect() {
    // Harmless names the word lists used to flag, and alarming ones they used to trust.
    for name in [
        "update_sort_order",
        "invite_member",
        "send_email",
        "pay_invoice",
    ] {
        assert_eq!(builtin(name, Risk::Read), Some(Effect::Read), "{name}");
        assert_eq!(builtin(name, Risk::Write), None, "{name}");
        let annotated = Mcp {
            annotated: true,
            ..Mcp::default()
        };
        assert_eq!(mcp(annotated), Some(Effect::Network), "{name}");
    }
}

#[test]
fn mcp_tools_read_their_declaration_then_their_annotations() {
    use Effect::*;
    let cases = [
        (Mcp::default(), None),
        (
            Mcp {
                annotated: true,
                ..Mcp::default()
            },
            Some(Network),
        ),
        (
            Mcp {
                annotated: true,
                read_only: true,
                ..Mcp::default()
            },
            Some(Read),
        ),
        (
            Mcp {
                read_only: true,
                annotated: true,
                declared: Some(SendAsPerson),
                ..Mcp::default()
            },
            Some(SendAsPerson),
        ),
        (
            Mcp {
                writes: Some(Pay),
                ..Mcp::default()
            },
            Some(Pay),
        ),
        (
            Mcp {
                read_only: true,
                annotated: true,
                writes: Some(Pay),
                ..Mcp::default()
            },
            Some(Read),
        ),
    ];
    for (tool, expected) in cases {
        assert_eq!(mcp(tool), expected, "{tool:?}");
    }
}

#[test]
fn a_declaration_keeps_its_most_serious_known_word() {
    let cases = [
        (json!("send_as_person"), Some(Effect::SendAsPerson)),
        (json!(["read", "pay", "nonsense"]), Some(Effect::Pay)),
        (json!("sends_mail"), None),
        (json!(3), None),
    ];
    for (value, expected) in cases {
        assert_eq!(Effect::declared(&value), expected, "{value}");
    }
}

#[test]
fn spades_typed_outward_tools_send_as_the_person() {
    for tool in [GIT_PUSH, PR_COMMENT, ISSUE_COMMENT, SEND_MESSAGE] {
        assert_eq!(
            builtin(tool, Risk::Write),
            Some(Effect::SendAsPerson),
            "{tool}"
        );
    }
    assert_eq!(builtin("bot_message", Risk::Write), Some(Effect::Network));
    assert_eq!(
        builtin("memory_save", Risk::Memory),
        Some(Effect::WriteLocal)
    );
}

#[test]
fn ace_tools_pay_only_when_told_to_press_a_purchase_button() {
    let cases = [
        ("browser_act", json!({"click": "Place order"}), Effect::Pay),
        ("screen_act", json!({"type": "Buy now"}), Effect::Pay),
        ("browser_act", json!({"click": "e42"}), Effect::Network),
        (
            "browser_act",
            json!({"click": "Checkout tips"}),
            Effect::Pay,
        ),
        ("agent_message", json!({"text": "Buy now"}), Effect::Network),
        ("transfer", json!({}), Effect::Network),
    ];
    for (name, arguments, expected) in cases {
        assert_eq!(ace(name, Risk::Write, &arguments), expected, "{name}");
    }
    assert_eq!(ace("threads_find", Risk::Read, &json!({})), Effect::Read);
}

#[test]
fn grants_are_refused_by_what_the_tool_declares() {
    for effect in [
        Effect::Pay,
        Effect::SendAsPerson,
        Effect::ChangeAccess,
        Effect::Credential,
    ] {
        assert!(never_granted(Some(effect)).is_some(), "{effect:?}");
    }
    for effect in [None, Some(Effect::Network), Some(Effect::Publish)] {
        assert!(never_granted(effect).is_none(), "{effect:?}");
    }
}

#[test]
fn what_the_sandbox_stopped_is_read_from_the_output() {
    let cases = [
        (
            "cat: /Users/x/a: Operation not permitted",
            Some(Blocked::Files),
        ),
        (
            "curl: (56) CONNECT tunnel failed, response 403",
            Some(Blocked::Network),
        ),
        (
            "curl: (6) Could not resolve host: example.com",
            Some(Blocked::Network),
        ),
        (
            "execution error: Not authorized to send Apple events to Mail. (-1743)",
            Some(Blocked::App),
        ),
        ("error: test failed, to rerun pass `--lib`", None),
    ];
    for (output, expected) in cases {
        assert_eq!(blocked(output), expected, "{output}");
    }
}

#[test]
fn stored_requests_fold_with_or_without_an_ask_this_build_knows() {
    use crate::event::{Event, Known};
    let cases = [
        (json!("outside_sandbox"), Some(Ask::OutsideSandbox)),
        (json!("undeclared"), Some(Ask::Undeclared)),
        (json!("something_later"), None),
        (serde_json::Value::Null, None),
    ];
    for (ask, expected) in cases {
        let mut stored = json!({
            "type": "approval_requested", "reply": "r", "call_id": "c", "name": "shell",
            "arguments": {"command": "ls"}
        });
        if !ask.is_null() {
            stored["ask"] = ask.clone();
        }
        let event = Event::from_json(stored);
        let Event::Known(Known::ApprovalRequested { ask: read, .. }) = event else {
            panic!("{ask} did not fold as a request");
        };
        assert_eq!(read, expected, "{ask}");
    }
}

#[test]
fn the_answer_kept_for_an_undeclared_tool_is_the_persons_latest() {
    use crate::event::{Event, Known};
    let asked = |call: &str, name: &str, ask: Option<Ask>| {
        Event::Known(Known::ApprovalRequested {
            reply: "r".into(),
            call_id: call.into(),
            name: name.into(),
            arguments: json!({}),
            scope: None,
            reviewer_reason: None,
            ask,
            helper: None,
        })
    };
    let answered = |call: &str, allowed: bool| {
        Event::Known(Known::ApprovalAnswered {
            reply: "r".into(),
            call_id: call.into(),
            allowed,
            always: false,
        })
    };
    let tool = "app__mystery";
    assert_eq!(
        remembered(&[asked("a", tool, Some(Ask::Undeclared))], tool),
        None
    );
    let allowed = [asked("a", tool, Some(Ask::Undeclared)), answered("a", true)];
    assert_eq!(remembered(&allowed, tool), Some(true));
    let changed = [
        asked("a", tool, Some(Ask::Undeclared)),
        answered("a", true),
        asked("b", tool, Some(Ask::Undeclared)),
        answered("b", false),
    ];
    assert_eq!(remembered(&changed, tool), Some(false));
    // A usual request about the same tool, or an undeclared one about another, says nothing.
    let other = [
        asked("a", tool, None),
        answered("a", false),
        asked("b", "app__other", Some(Ask::Undeclared)),
        answered("b", true),
    ];
    assert_eq!(remembered(&other, tool), None);
}

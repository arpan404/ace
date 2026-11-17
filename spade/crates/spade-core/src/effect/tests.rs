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
        target: None,
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
        assert_eq!(mcp(annotated), None, "{name}");
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
fn grants_are_refused_by_what_the_tool_declares() {
    for effect in [
        Effect::Pay,
        Effect::SendAsPerson,
        Effect::ChangeAccess,
        Effect::Credential,
    ] {
        assert!(never_granted(Some(effect)).is_some(), "{effect:?}");
    }
    assert!(
        never_granted(None).is_some(),
        "a tool that declares nothing"
    );
    for effect in [Effect::Network, Effect::Publish] {
        assert!(never_granted(Some(effect)).is_none(), "{effect:?}");
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
fn the_answer_kept_for_an_undeclared_tool_is_the_persons_latest_for_that_exact_tool() {
    use crate::event::{Event, Known};
    // (call, offered name, the tool's key: bot, server, original name and schema)
    let asked = |call: &str, name: &str, key: &str| {
        Event::Known(Known::ApprovalRequested {
            reply: "r".into(),
            call_id: call.into(),
            name: name.into(),
            arguments: json!({}),
            scope: None,
            reviewer_reason: None,
            ask: Some(Ask::Undeclared),
            tool_key: Some(key.into()),
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
    let key = "a_1|plugin:files@h1/fs:delete#s1";
    assert_eq!(remembered(&[asked("a", "files__delete", key)], key), None);
    let allowed = [asked("a", "files__delete", key), answered("a", true)];
    assert_eq!(remembered(&allowed, key), Some(true));
    let changed = [
        asked("a", "files__delete", key),
        answered("a", true),
        asked("b", "files__delete", key),
        answered("b", false),
    ];
    assert_eq!(remembered(&changed, key), Some(false));
    // The same offered name from another server, another version or schema, or another bot,
    // says nothing about this tool.
    for other in [
        "a_1|plugin:files@h2/fs:delete#s1",
        "a_1|plugin:files@h1/fs:delete#s2",
        "a_2|plugin:files@h1/fs:delete#s1",
        "a_1|connector:files@https://x/mcp:delete#s1",
    ] {
        let elsewhere = [asked("a", "files__delete", other), answered("a", true)];
        assert_eq!(remembered(&elsewhere, key), None, "{other}");
    }
}

#[test]
fn person_only_effects_hold_wherever_the_call_runs() {
    // A call that fell back to the classifier (no checkpoint, no sandbox) still goes to the
    // person for a payment or a send, and a secret is still refused, before any classifying.
    for place in [Place::Unsandboxed(Class::Inside), Place::Host] {
        let pay = Call {
            place,
            ..call("billing__charge", Some(Effect::Pay))
        };
        assert_eq!(route(pay), asks(SPENDS), "{place:?}");
        let secret = Call {
            place,
            ..call("vault__get", Some(Effect::Credential))
        };
        assert_eq!(
            route(secret),
            Route::Refuse(autonomy::CREDENTIALS_REFUSED.to_owned()),
            "{place:?}"
        );
    }
}

#[test]
fn hints_raise_a_trusted_declaration_but_never_lower_it() {
    use Effect::*;
    let cases = [
        // A payments app's read-only-marked tool still pays.
        (true, Some(Pay), Some(Pay)),
        // A tool declared to read that says it may write is a write outside the box.
        (false, Some(Read), Some(Network)),
        (true, Some(Read), Some(Read)),
        (false, Some(Publish), Some(Publish)),
        // Hints alone declare nothing: the person decides once.
        (true, None, None),
        (false, None, None),
    ];
    for (read_only, declared, expected) in cases {
        let tool = Mcp {
            read_only,
            annotated: true,
            declared,
        };
        assert_eq!(mcp(tool), expected, "{tool:?}");
    }
}

#[test]
fn an_ace_tool_declared_as_publishing_is_reviewed_and_a_declared_read_stays_a_read() {
    let publish = ace(
        "market_publish",
        Risk::Write,
        Some(Effect::Publish),
        &json!({}),
    );
    assert_eq!(publish, Effect::Publish);
    assert_eq!(
        route(call("market_publish", Some(publish))),
        reviewed(Some(PUBLISHES))
    );
    assert_eq!(
        ace("market_read", Risk::Read, Some(Effect::Read), &json!({})),
        Effect::Read
    );
    // A declaration is the least a tool does: it never lowers what the risk says.
    assert_eq!(
        ace("thread_start", Risk::Write, Some(Effect::Read), &json!({})),
        Effect::Network
    );
}

#[test]
fn a_driving_call_that_can_act_goes_to_the_person_and_no_grant_covers_it() {
    for (name, arguments) in [
        ("browser_act", json!({"click": "e42"})),
        ("browser_act", json!({"click": "Place order"})),
        ("screen_act", json!({"type": "hello"})),
        ("sim_act", json!({"key": "return"})),
    ] {
        assert_eq!(
            ace(name, Risk::Write, None, &arguments),
            Effect::Drive,
            "{name}"
        );
    }
    assert_eq!(
        ace("browser_snapshot", Risk::Read, None, &json!({})),
        Effect::Read
    );
    let drive = call("browser_act", Some(Effect::Drive));
    for granted in [Granted::No, Granted::Tool, Granted::Typed] {
        let call = Call { granted, ..drive };
        assert_eq!(route(call), asks(DRIVES), "{granted:?}");
    }
    let always = Call {
        always: true,
        rule: Decision::Run,
        ..drive
    };
    assert_eq!(route(always), Route::Run);
    assert!(never_granted(Some(Effect::Drive)).is_some());
}

#[test]
fn a_word_spade_doesnt_know_leaves_every_call_to_the_person() {
    assert_eq!(
        Effect::declared(&json!(["read", "transfer_funds"])),
        Some(Effect::Unknown)
    );
    assert_eq!(Effect::declared(&json!("teleport")), Some(Effect::Unknown));
    assert_eq!(Effect::declared(&json!(3)), Some(Effect::Unknown));
    assert_eq!(Effect::declared(&json!([])), None);
    assert_eq!(
        Effect::declared(&json!(["read", "send_as_person"])),
        Some(Effect::SendAsPerson)
    );
    let unknown = call("app__move_money", Some(Effect::Unknown));
    assert_eq!(route(unknown), asks(UNKNOWN));
    // Remembered or granted, it is still asked: only Always allow runs it.
    let granted = Call {
        granted: Granted::Tool,
        remembered: Some(true),
        ..unknown
    };
    assert_eq!(route(granted), asks(UNKNOWN));
    assert!(never_granted(Some(Effect::Unknown)).is_some());
}

#[test]
fn a_sandboxed_call_with_no_checkpoint_is_reviewed_after_the_person_only_rules() {
    let unprotected = |effect| Call {
        place: Place::Unprotected,
        ..call("shell", Some(effect))
    };
    assert_eq!(
        route(unprotected(Effect::WriteLocal)),
        reviewed(Some(NO_CHECKPOINT))
    );
    assert_eq!(route(unprotected(Effect::Pay)), asks(SPENDS));
}

#[test]
fn a_push_or_send_request_names_where_it_goes() {
    let push = Call {
        target: Some("attacker.example/acme/app, branch main"),
        ..call(GIT_PUSH, Some(Effect::SendAsPerson))
    };
    assert_eq!(
        route(push),
        asks(
            "It pushes to attacker.example/acme/app, branch main with your sign-in, so you decide."
        )
    );
    let comment = Call {
        target: Some("github.com/acme/app#7"),
        ..call(PR_COMMENT, Some(Effect::SendAsPerson))
    };
    assert_eq!(
        route(comment),
        asks("It sends something in your name to github.com/acme/app#7, so you decide.")
    );
}

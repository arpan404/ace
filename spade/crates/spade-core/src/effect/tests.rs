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
        drive: Drive::default(),
        mode: crate::autonomy::Mode::AutoReview,
        remote: false,
        classifier: true,
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
            "sh: 1: cannot create /home/x/a: Permission denied",
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
        (json!("drive"), Some(Ask::Drive)),
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
            app: None,
            acts_in: None,
            helper: None,
            launch: None,
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

/// A driving step in `target`, sensitive or granted as given.
fn step<'a>(
    target: Result<&'a str, &'static str>,
    sensitive: Option<&'static str>,
    granted: bool,
) -> Call<'a> {
    Call {
        drive: Drive {
            target,
            sensitive,
            granted,
            bound: true,
        },
        ..call("screen_act", Some(Effect::Drive))
    }
}

fn reviewed_with(route: Route, words: &[&str]) {
    let Route::Review(Some(concern)) = &route else {
        panic!("not reviewed with a concern: {route:?}");
    };
    for word in words {
        assert!(concern.contains(word), "{word:?} not in {concern:?}");
    }
}

fn asked_about_driving(route: &Route) -> &str {
    match route {
        Route::Ask {
            line,
            ask: Some(Ask::Drive),
        } => line,
        other => panic!("not asked as a driving step: {other:?}"),
    }
}

#[test]
fn ace_tools_that_can_act_in_a_page_or_app_drive_and_reads_stay_reads() {
    for (name, arguments) in [
        ("browser_act", json!({"click": "e42"})),
        ("screen_act", json!({"app": "TextEdit", "actions": []})),
        ("sim_act", json!({"key": "return"})),
    ] {
        assert_eq!(
            ace(name, Risk::Write, None, &arguments),
            Effect::Drive,
            "{name}"
        );
    }
    for name in [
        "browser_snapshot",
        "screen_apps",
        "screen_display",
        "sim_ui",
    ] {
        assert_eq!(
            ace(name, Risk::Read, None, &json!({})),
            Effect::Read,
            "{name}"
        );
    }
}

#[test]
fn a_click_in_textedit_goes_to_the_reviewer_not_the_person() {
    let route = route(step(Ok("TextEdit"), None, false));
    reviewed_with(route, &["TextEdit", "as the person", "sends, pays"]);
}

#[test]
fn typing_in_mail_asks_the_person() {
    let mail = drive::Place::App {
        id: "com.apple.mail".into(),
        name: "Mail".into(),
    };
    let why = drive::sensitive(&mail);
    assert!(why.is_some());
    let route = route(step(Ok("Mail"), why, false));
    let line = asked_about_driving(&route);
    assert!(
        line.starts_with("It acts in Mail, mail or messages"),
        "{line}"
    );
    // A name that may be Mail asks even when Spade can't tell which app ace would open.
    let unplaced = route_of(step(Err(drive::NO_APP), why, false));
    assert!(
        unplaced.starts_with("It acts in a place, mail"),
        "{unplaced}"
    );
}

fn route_of(call: Call<'_>) -> String {
    asked_about_driving(&route(call)).to_owned()
}

#[test]
fn a_granted_app_runs_reviewed_without_asking() {
    reviewed_with(
        route(step(Ok("TextEdit"), None, true)),
        &["allowed driving TextEdit", "escalate only"],
    );
    // Under untrusted content the review is the strict one, grant or not.
    let tainted = Call {
        tainted: true,
        ..step(Ok("TextEdit"), None, true)
    };
    reviewed_with(
        route(tainted),
        &["untrusted content", "serves the person's request"],
    );
    let tainted = Call {
        tainted: true,
        ..step(Ok("TextEdit"), None, false)
    };
    reviewed_with(
        route(tainted),
        &["untrusted content", "serves the person's request"],
    );
}

#[test]
fn a_sensitive_place_asks_even_when_granted_or_allowed_always() {
    let always = Call {
        always: true,
        rule: Decision::Run,
        ..step(Ok("paypal.com"), Some("a bank"), true)
    };
    asked_about_driving(&route(always));
}

#[test]
fn a_step_spade_cant_place_asks_the_person_even_in_a_granted_app() {
    for why in [
        drive::UNPLACED,
        drive::NO_TAB,
        drive::LOADING,
        drive::DEVICE_INPUT,
        drive::table::CLOSES_BROWSER,
    ] {
        assert_eq!(route_of(step(Err(why), None, false)), why);
        assert_eq!(route_of(step(Err(why), None, true)), why);
        let always = Call {
            always: true,
            rule: Decision::Run,
            ..step(Err(why), None, false)
        };
        assert_eq!(route_of(always), why, "Always allow doesn't place it");
    }
}

#[test]
fn a_drive_step_runs_on_always_allow_and_no_tool_grant_covers_it() {
    let always = Call {
        always: true,
        rule: Decision::Run,
        ..step(Ok("TextEdit"), None, false)
    };
    assert_eq!(route(always), Route::Run);
    // A tool grant for browser_act would cover every site: refused, and ignored at the gate.
    assert!(never_granted(Some(Effect::Drive)).is_some());
    let tool_grant = Call {
        granted: Granted::Tool,
        ..step(Ok("TextEdit"), None, false)
    };
    assert!(matches!(route(tool_grant), Route::Review(Some(_))));
    let too_long = Call {
        fits: false,
        ..step(Ok("TextEdit"), None, true)
    };
    assert_eq!(asked_about_driving(&route(too_long)), TOO_LONG);
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

#[test]
fn a_step_ace_cant_hold_to_its_place_asks_the_person_instead_of_the_reviewer() {
    for granted in [false, true] {
        let unbound = Call {
            drive: Drive {
                bound: false,
                ..step(Ok("docs.rs"), None, granted).drive
            },
            ..step(Ok("docs.rs"), None, granted)
        };
        let line = route_of(unbound);
        assert!(
            line.starts_with("It acts in docs.rs, and this version of ace"),
            "{line}"
        );
        assert!(line.contains("Updating ace"), "{line}");
    }
    // Not even the person's own Always allow for the tool lets it run unheld.
    let always = Call {
        always: true,
        rule: Decision::Run,
        drive: Drive {
            bound: false,
            ..step(Ok("docs.rs"), None, false).drive
        },
        ..step(Ok("docs.rs"), None, false)
    };
    assert!(route_of(always).contains("this version of ace"));
}

/// The route of a `sim_*` call, with the facts the engine would find for it (no lookup: a device
/// step names its own place), granted and allowed always as given.
fn device_route(tool: &str, arguments: serde_json::Value, always: bool) -> Route {
    let step = drive::read(tool, &arguments, None);
    let call = Call {
        always,
        rule: if always { Decision::Run } else { Decision::Ask },
        drive: Drive {
            target: step
                .place
                .as_ref()
                .map(drive::Place::shown)
                .map_err(|why| *why),
            sensitive: step.sensitive,
            granted: true,
            bound: true,
        },
        ..call(tool, Some(Effect::Drive))
    };
    route(call)
}

#[test]
fn every_simulator_and_device_operation_asks_the_person() {
    for row in drive::table::TABLE
        .iter()
        .filter(|row| row.tool.starts_with("sim_"))
    {
        let mut arguments = json!({"simId": "s1", "appId": "com.apple.calculator",
                                   "url": "https://docs.rs/", "text": "hi"});
        if let Some(op) = row.op {
            arguments["action"] = json!(op);
        }
        for always in [false, true] {
            let route = device_route(row.tool, arguments.clone(), always);
            asked_about_driving(&route);
        }
    }
    // And a simulator tool or operation the table doesn't know yet asks too.
    asked_about_driving(&device_route("sim_new", json!({"simId": "s1"}), true));
    asked_about_driving(&device_route(
        "sim_act",
        json!({"simId": "s1", "action": "shake"}),
        true,
    ));
}

#[test]
fn an_always_allow_for_sim_act_never_skips_the_person() {
    let open = json!({"simId": "s1", "action": "open_app", "appId": "com.apple.calculator"});
    let route = device_route("sim_act", open, true);
    let line = asked_about_driving(&route).to_owned();
    assert!(line.contains(drive::ON_DEVICE), "{line}");
}

#[test]
fn every_kind_of_device_place_is_the_persons_alone() {
    let Some(page) = drive::address::parse("https://docs.rs/") else {
        panic!("a web address");
    };
    for place in [
        drive::Place::Device {
            device: "s1".into(),
        },
        drive::Place::DeviceApp {
            device: "s1".into(),
            app: "com.apple.calculator".into(),
        },
        drive::Place::DeviceSite {
            device: "s1".into(),
            page,
        },
    ] {
        assert_eq!(place.persons_alone(), Some(drive::ON_DEVICE), "{place:?}");
        assert!(drive::sensitive(&place).is_some(), "{place:?}");
        assert_eq!(place.grant(), None, "{place:?}");
    }
}

/// The route of a screen step on `app` (by name or id), as the engine would find it: ace lists
/// the app for the name, the person allowed the tool always and allowed the app for the bot.
fn screen_route(tool: &str, arguments: serde_json::Value, listed: &str) -> Route {
    let step = drive::read(tool, &arguments, Some(listed));
    let call = Call {
        always: true,
        rule: Decision::Run,
        drive: Drive {
            target: step
                .place
                .as_ref()
                .map(drive::Place::shown)
                .map_err(|why| *why),
            sensitive: step.sensitive,
            granted: true,
            bound: true,
        },
        ..call(tool, Some(Effect::Drive))
    };
    route(call)
}

#[test]
fn an_app_that_shows_another_device_asks_on_every_screen_path_despite_always_allow_and_a_grant() {
    let viewers = [
        ("Simulator", "com.apple.iphonesimulator"),
        ("Xcode", "com.apple.dt.Xcode"),
        ("Android Studio", "com.google.android.studio"),
        ("studio64", "studio64.exe"),
        ("studio.sh", "android-studio"),
        ("studio", "studio"),
        ("qemu-system-aarch64", "qemu-system-aarch64"),
        ("Android Emulator", "com.google.android.emulator"),
        ("scrcpy", "scrcpy"),
        ("iPhone Mirroring", "com.apple.ScreenContinuity"),
        ("QuickTime Player", "com.apple.QuickTimePlayerX"),
        ("Vysor", "com.koushikdutta.vysor"),
        ("Genymotion", "com.genymobile.genymotion"),
        ("Duet", "com.kairos.duet"),
        ("Screen Sharing", "com.apple.ScreenSharing"),
        ("VNC Viewer", "com.realvnc.vncviewer"),
        ("Windows App", "com.microsoft.rdc.macos"),
        ("UTM", "com.utmapp.UTM"),
        ("Parallels Desktop", "com.parallels.desktop.console"),
        ("VMware Fusion", "com.vmware.fusion"),
        ("VirtualBox", "org.virtualbox.app.VirtualBox"),
        ("Remmina", "org.remmina.Remmina"),
        ("AnyDesk", "com.philandro.anydesk"),
        ("TeamViewer", "com.teamviewer.TeamViewer"),
    ];
    for (name, id) in viewers {
        let listed = format!("Running:\n{name} ({id}), frontmost");
        let paths = [
            (
                "screen_act",
                json!({"app": id, "actions": [{"type": "click", "id": 3}]}),
            ),
            (
                "screen_act",
                json!({"app": name, "actions": [{"type": "type", "text": "hi"}]}),
            ),
            ("screen_state", json!({"app": name})),
            // Another machine's screen tools, routed there.
            (
                "screen_act",
                json!({"app": name, "machine": "mini", "actions": []}),
            ),
            // The older screen toolkit opens it by its id.
            ("screen_open_app", json!({"bundleId": id})),
        ];
        for (tool, arguments) in paths {
            let route = screen_route(tool, arguments.clone(), &listed);
            asked_about_driving(&route);
        }
        // It can't be allowed for a bot, and a grant stored for it covers nothing.
        assert!(drive::grantable_app(id).is_err(), "{name}");
        let grant = crate::grant::Scope::DriveApp { app: id.to_owned() };
        assert!(
            !crate::grant::covers(&grant, &crate::grant::Action::DriveApp { app: id }),
            "{name}"
        );
    }
}

#[test]
fn an_answer_given_before_the_bot_arrived_from_another_machine_is_not_remembered_here() {
    use crate::event::{Event, Known, since_arrival};
    let key = "a_1|plugin:files@h1/fs:delete#s1";
    let asked = |call: &str| {
        Event::Known(Known::ApprovalRequested {
            reply: "r".into(),
            call_id: call.into(),
            name: "files__delete".into(),
            arguments: json!({}),
            scope: None,
            reviewer_reason: None,
            ask: Some(Ask::Undeclared),
            tool_key: Some(key.into()),
            app: None,
            acts_in: None,
            helper: None,
        })
    };
    let answered = |call: &str, always: bool| {
        Event::Known(Known::ApprovalAnswered {
            reply: "r".into(),
            call_id: call.into(),
            allowed: true,
            always,
        })
    };
    let arrived = Event::Known(Known::Arrived {
        from: "Laptop".into(),
    });
    let there = vec![asked("a"), answered("a", true), arrived.clone()];
    assert_eq!(
        remembered(&there, key),
        Some(true),
        "the whole history remembers it"
    );
    assert_eq!(
        remembered(since_arrival(&there), key),
        None,
        "here it asks again"
    );
    let folded = crate::Transcript::fold(since_arrival(&there));
    assert!(folded.always_allowed.is_empty(), "no Always allow crossed");
    // An answer given here, after it arrived, counts.
    let mut here = there;
    here.extend([asked("b"), answered("b", false)]);
    assert_eq!(remembered(since_arrival(&here), key), Some(true));
}

/// A connector's or plugin's tool, run in the sandbox, that can reach the network.
fn contained_app_tool(effect: Option<Effect>) -> Call<'static> {
    Call {
        place: Place::Sandbox,
        remote: true,
        ..call("mailer__send_email", effect)
    }
}

#[test]
fn on_the_auto_review_a_sandboxed_app_tool_that_can_reach_the_network_never_runs_unreviewed() {
    // It declares nothing: the person decides once, as on the host.
    assert_eq!(
        route(contained_app_tool(None)),
        Route::Ask {
            line: UNDECLARED.to_owned(),
            ask: Some(Ask::Undeclared)
        }
    );
    // Declared to write: the reviewer, with or without untrusted content in view.
    assert_eq!(
        route(contained_app_tool(Some(Effect::Network))),
        reviewed(None)
    );
    let tainted = Call {
        tainted: true,
        ..contained_app_tool(Some(Effect::Network))
    };
    assert_eq!(route(tainted), reviewed(Some(TAINTED_OUTWARD)));
    // A checkpoint that couldn't be taken changes nothing about that.
    let unprotected = Call {
        place: Place::Unprotected,
        ..contained_app_tool(Some(Effect::Network))
    };
    assert_eq!(route(unprotected), reviewed(None));
    // Declared read-only: it runs.
    assert_eq!(route(contained_app_tool(Some(Effect::Read))), Route::Run);
    // The person's say still counts: their Always allow, or a remembered "yes".
    let always = Call {
        always: true,
        rule: Decision::Run,
        ..contained_app_tool(Some(Effect::Network))
    };
    assert_eq!(route(always), Route::Run);
    let remembered = Call {
        remembered: Some(true),
        ..contained_app_tool(None)
    };
    assert_eq!(route(remembered), Route::Run);
    // Sends and payments stay the person's, as everywhere.
    assert_eq!(route(contained_app_tool(Some(Effect::Pay))), asks(SPENDS));
}

#[test]
fn on_the_auto_review_a_sealed_plugin_servers_tools_keep_the_sandboxs_decision() {
    for effect in [None, Some(Effect::Network), Some(Effect::Publish)] {
        let sealed = Call {
            remote: false,
            tainted: true,
            ..contained_app_tool(effect)
        };
        assert_eq!(route(sealed), Route::Run, "{effect:?}");
    }
}

#[test]
fn a_tool_the_person_declined_stays_declined_once_its_server_is_sealed() {
    use crate::autonomy::Mode;
    for mode in [Mode::AutoReview, Mode::FullAccess] {
        // Declined while its server could reach the network...
        let asked = Call {
            mode,
            ..contained_app_tool(None)
        };
        assert!(matches!(route(asked), Route::Ask { .. }), "{mode:?}");
        // ...and still declined once the server runs sealed (offline, no token), where a tool
        // that declares nothing would otherwise run as the sandbox decides.
        let sealed = Call {
            remote: false,
            ..asked
        };
        assert_eq!(route(sealed), Route::Run, "{mode:?}: never asked about");
        let declined = Call {
            remembered: Some(false),
            ..sealed
        };
        assert_eq!(
            route(declined),
            Route::Refuse(DECLINED_TOOL.to_owned()),
            "{mode:?}"
        );
    }
}

#[test]
fn on_the_auto_review_an_app_tool_that_calls_its_write_local_is_still_reviewed() {
    // Declared `write_local` with a read-only hint: the rule gate would let a local write run.
    let local = Call {
        risk: Risk::Read,
        rule: Decision::Run,
        ..contained_app_tool(Some(Effect::WriteLocal))
    };
    for place in [Place::Sandbox, Place::Host, Place::Unprotected] {
        let call = Call { place, ..local };
        assert_eq!(route(call), reviewed(None), "{place:?}");
    }
    // The person's Always allow for it still runs it.
    let always = Call {
        always: true,
        ..local
    };
    assert_eq!(route(always), Route::Run);
    // A sealed plugin server's local write is the sandbox's.
    let sealed = Call {
        remote: false,
        ..local
    };
    assert_eq!(route(sealed), Route::Run);
}

#[test]
fn an_approvals_stored_launch_reads_leniently_as_the_narrowest() {
    use crate::event::{Authorized, Event, Known};
    let read = |launch: serde_json::Value| {
        let event = Event::from_json(json!({
            "type": "approval_requested", "reply": "r", "call_id": "c", "name": "shell",
            "arguments": {}, "launch": launch,
        }));
        match event {
            Event::Known(Known::ApprovalRequested { launch, .. }) => launch,
            _ => None,
        }
    };
    assert_eq!(read(json!("outside")), Some(Authorized::Outside));
    assert_eq!(read(json!("as_found")), Some(Authorized::AsFound));
    // A word this build doesn't know never lets it run wider.
    assert_eq!(read(json!("anywhere")), Some(Authorized::Contained));
    assert_eq!(read(serde_json::Value::Null), None);
    assert!(Authorized::Contained < Authorized::AsFound);
    assert!(Authorized::AsFound < Authorized::Outside);
}

use serde_json::json;

use super::NO_CLASSIFIER;
use crate::autonomy::{CREDENTIALS_REFUSED, Class, Mode, Sensitive};
use crate::effect::{
    Ask, CHANGES_ACCESS, Call, DECLINED_TOOL, Drive, Effect, GIT_PUSH, Granted, OUTSIDE, PUSHES,
    Place, Route, SENDS_AS_YOU, SPENDS, TAINTED_OUTWARD, UNDECLARED, UNDECLARED_TAINTED, UNKNOWN,
    drive, route,
};
use crate::gate::Decision;
use crate::tools::Risk;

/// A held write of `effect` from the host by a bot in Full access, nothing else about it.
fn full(tool: &str, effect: Option<Effect>) -> Call<'_> {
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
        mode: Mode::FullAccess,
        remote: false,
        classifier: true,
        ceiling: None,
        command: None,
        destructive: false,
    }
}

/// A connector's or plugin's tool, run on its server outside the sandbox.
fn app_tool(tool: &str, effect: Option<Effect>) -> Call<'_> {
    Call {
        remote: true,
        ..full(tool, effect)
    }
}

/// The same call by a bot on the auto-review.
fn reviewed(call: Call<'_>) -> Call<'_> {
    Call {
        mode: Mode::AutoReview,
        ..call
    }
}

/// A driving step of a Full access bot, placed by what ace would answer for it.
fn driving<'a>(tool: &'a str, step: &'a drive::Step) -> Call<'a> {
    Call {
        drive: Drive {
            target: step
                .place
                .as_ref()
                .map(drive::Place::shown)
                .map_err(|why| *why),
            sensitive: step.sensitive,
            granted: false,
            bound: true,
        },
        ..full(tool, Some(Effect::Drive))
    }
}

fn asks(line: &str) -> Route {
    Route::Ask {
        line: line.to_owned(),
        ask: None,
    }
}

fn is_review(route: &Route) -> bool {
    matches!(route, Route::Review(_))
}

/// Every fact that would add a review or an ask under the auto-review, together.
fn under_everything(call: Call<'_>) -> [Call<'_>; 4] {
    [
        call,
        Call {
            tainted: true,
            ..call
        },
        Call {
            tainted: true,
            standing: true,
            ..call
        },
        Call {
            fits: false,
            risk: Risk::Destructive,
            ..call
        },
    ]
}

#[test]
fn in_full_access_a_write_outside_the_sandbox_runs_without_review() {
    let cases = [
        // An app's data, another bot, an ace thread.
        full("app_tool", Some(Effect::Network)),
        // A command the bot runs outside the sandbox (its setting), however the classifier
        // reads it short of a hard stop.
        Call {
            place: Place::Unsandboxed(Class::Sensitive(Sensitive::WriteOutside)),
            ..full("shell", Some(Effect::WriteLocal))
        },
        Call {
            place: Place::Unsandboxed(Class::Outward),
            ..full("shell", Some(Effect::WriteLocal))
        },
        Call {
            place: Place::Unsandboxed(Class::Sensitive(Sensitive::RemoteChange)),
            ..full("shell", Some(Effect::WriteLocal))
        },
        Call {
            place: Place::Unsandboxed(Class::Sensitive(Sensitive::UnseenScript)),
            ..full("shell", Some(Effect::WriteLocal))
        },
        // A file write no checkpoint can undo.
        Call {
            place: Place::Unprotected,
            ..full("workspace_write", Some(Effect::WriteLocal))
        },
        full("workspace_write", Some(Effect::WriteLocal)),
        full("market_publish", Some(Effect::Publish)),
    ];
    for case in cases {
        // The auto-review would have held each one.
        assert_ne!(route(reviewed(case)), Route::Run, "{case:?}");
        for call in under_everything(case) {
            assert_eq!(route(call), Route::Run, "{call:?}");
        }
    }
}

#[test]
fn in_full_access_a_payment_still_asks_the_person() {
    let cases = [
        full("stripe__create_charge", Some(Effect::Pay)),
        Call {
            place: Place::Sandbox,
            ..full("plugin__pay", Some(Effect::Pay))
        },
        Call {
            place: Place::Unsandboxed(Class::Sensitive(Sensitive::Payment)),
            ..full("shell", Some(Effect::WriteLocal))
        },
    ];
    for case in cases {
        for call in under_everything(case) {
            assert_eq!(route(call), asks(SPENDS), "{call:?}");
        }
    }
}

#[test]
fn in_full_access_a_send_as_the_person_still_asks() {
    let cases = [
        (
            full("send_message", Some(Effect::SendAsPerson)),
            SENDS_AS_YOU,
        ),
        (full("pr_comment", Some(Effect::SendAsPerson)), SENDS_AS_YOU),
        (full(GIT_PUSH, Some(Effect::SendAsPerson)), PUSHES),
        (
            Call {
                place: Place::Unsandboxed(Class::Sensitive(Sensitive::MessageAsPerson)),
                ..full("shell", Some(Effect::WriteLocal))
            },
            SENDS_AS_YOU,
        ),
    ];
    for (case, line) in cases {
        for call in under_everything(case) {
            assert_eq!(route(call), asks(line), "{call:?}");
        }
    }
}

#[test]
fn in_full_access_untrusted_content_never_turns_a_granted_push_into_a_run() {
    let granted = Call {
        granted: Granted::Typed,
        ..full(GIT_PUSH, Some(Effect::SendAsPerson))
    };
    // The person's grant runs it with nothing untrusted in view, as on the auto-review.
    assert_eq!(route(granted), Route::Run);
    let tainted = Call {
        tainted: true,
        ..granted
    };
    // The auto-review has the reviewer look; with no reviewer, the person does.
    assert!(is_review(&route(reviewed(tainted))));
    assert_eq!(route(tainted), asks(PUSHES));
}

#[test]
fn in_full_access_an_access_change_or_an_unknown_effect_still_asks() {
    for (case, line) in [
        (
            full("okta__add_member", Some(Effect::ChangeAccess)),
            CHANGES_ACCESS,
        ),
        (full("app__new_thing", Some(Effect::Unknown)), UNKNOWN),
        (
            Call {
                place: Place::Unsandboxed(Class::Sensitive(Sensitive::Credentials)),
                ..full("shell", Some(Effect::WriteLocal))
            },
            CHANGES_ACCESS,
        ),
    ] {
        for call in under_everything(case) {
            assert_eq!(route(call), asks(line), "{call:?}");
        }
    }
}

#[test]
fn in_full_access_a_secret_is_still_refused() {
    let refused = Route::Refuse(CREDENTIALS_REFUSED.to_owned());
    for case in [
        full("vault__read", Some(Effect::Credential)),
        Call {
            credentials: true,
            ..full("workspace_read", Some(Effect::Read))
        },
        Call {
            credentials: true,
            place: Place::Unsandboxed(Class::Inside),
            ..full("shell", Some(Effect::WriteLocal))
        },
    ] {
        for call in under_everything(case) {
            assert_eq!(route(call), refused, "{call:?}");
        }
        // The person's Always allow doesn't hand one back either.
        let always = Call {
            always: true,
            rule: Decision::Run,
            ..case
        };
        assert_eq!(route(always), refused);
    }
}

#[test]
fn in_full_access_a_step_on_a_simulator_still_asks() {
    let steps = [
        ("sim_act", json!({"simId": "s1", "action": "tap"})),
        ("sim_act", json!({"simId": "s1", "action": "type"})),
        (
            "sim_act",
            json!({"simId": "s1", "action": "open_app", "appId": "com.apple.calculator"}),
        ),
        ("sim_start", json!({"simId": "s1"})),
    ];
    for (tool, arguments) in steps {
        let step = drive::read(tool, &arguments, None);
        for call in under_everything(driving(tool, &step)) {
            let route = route(call);
            assert!(
                matches!(
                    route,
                    Route::Ask {
                        ask: Some(Ask::Drive),
                        ..
                    }
                ),
                "{arguments}: {route:?}"
            );
        }
    }
}

#[test]
fn in_full_access_driving_runs_except_where_sends_payments_and_sign_ins_happen() {
    let app = |id: &str, name: &str| drive::Place::App {
        id: id.into(),
        name: name.into(),
    };
    let ordinary = app("com.apple.TextEdit", "TextEdit");
    let step = drive::Step {
        sensitive: drive::sensitive(&ordinary),
        place: Ok(ordinary),
    };
    let textedit = driving("screen_act", &step);
    assert!(is_review(&route(reviewed(textedit))));
    for call in under_everything(textedit) {
        assert_eq!(route(call), Route::Run, "{call:?}");
    }
    for place in [
        app("com.apple.mail", "Mail"),
        app("com.apple.MobileSMS", "Messages"),
        app("com.bitwarden.desktop", "Bitwarden"),
        app("com.apple.iphonesimulator", "Simulator"),
        app("com.apple.ScreenContinuity", "iPhone Mirroring"),
    ] {
        let why = drive::sensitive(&place);
        assert!(why.is_some(), "{place:?}");
        let step = drive::Step {
            sensitive: why,
            place: Ok(place),
        };
        let always = Call {
            always: true,
            rule: Decision::Run,
            ..driving("screen_act", &step)
        };
        assert!(
            matches!(route(always), Route::Ask { .. }),
            "{:?}",
            step.place
        );
    }
    for address in [
        "https://www.paypal.com/checkout",
        "https://accounts.google.com/signin",
        "https://mail.google.com/mail/u/0/",
    ] {
        let step = drive::site(address);
        assert!(step.sensitive.is_some(), "{address}");
        assert!(
            matches!(route(driving("browser_act", &step)), Route::Ask { .. }),
            "{address}"
        );
    }
}

#[test]
fn in_full_access_a_step_spade_cant_place_or_hold_still_asks() {
    for why in [drive::UNPLACED, drive::NO_TAB, drive::DEVICE_INPUT] {
        let step = drive::Step {
            place: Err(why),
            sensitive: None,
        };
        assert_eq!(
            route(driving("browser_act", &step)),
            Route::Ask {
                line: why.to_owned(),
                ask: Some(Ask::Drive)
            }
        );
    }
    let step = drive::site("https://example.com/");
    let unheld = Call {
        drive: Drive {
            bound: false,
            ..driving("browser_act", &step).drive
        },
        ..driving("browser_act", &step)
    };
    assert!(matches!(route(unheld), Route::Ask { .. }));
}

#[test]
fn in_full_access_the_sandbox_is_never_widened() {
    let asks_outside = Call {
        place: Place::AsksOutside,
        ..full("shell", Some(Effect::WriteLocal))
    };
    assert_eq!(
        route(asks_outside),
        Route::Ask {
            line: OUTSIDE.to_owned(),
            ask: Some(Ask::OutsideSandbox)
        }
    );
}

#[test]
fn in_full_access_an_app_tool_that_declares_nothing_asks_on_its_first_call_even_with_the_classifier_off()
 {
    // An app's sending tool with no trusted declaration: Spade can't know it sends.
    let send = app_tool("mail__send_email", None);
    for call in [
        send,
        Call {
            classifier: false,
            ..send
        },
        Call {
            tainted: true,
            classifier: false,
            ..send
        },
    ] {
        assert_eq!(
            route(call),
            Route::Ask {
                line: UNDECLARED.to_owned(),
                ask: Some(Ask::Undeclared)
            },
            "{call:?}"
        );
    }
    // The person's "yes" for the bot lets it run, still past the classifier and never under
    // untrusted content.
    let allowed = Call {
        remembered: Some(true),
        ..send
    };
    assert_eq!(route(allowed), Route::Run);
    let blind = Call {
        classifier: false,
        ..allowed
    };
    assert!(is_review(&route(blind)), "{:?}", route(blind));
    let steered = Call {
        tainted: true,
        ..allowed
    };
    assert_eq!(route(steered), asks(UNDECLARED_TAINTED));
}

#[test]
fn in_full_access_an_app_write_goes_to_the_reviewer_when_the_classifier_is_off_or_content_is_untrusted()
 {
    // Declared only `network`, though it sends: the classifier is what would catch that.
    let send = app_tool("mail__send_email", Some(Effect::Network));
    assert_eq!(route(send), Route::Run, "the classifier screens it next");
    let off = Call {
        classifier: false,
        ..send
    };
    assert_eq!(route(off), Route::Review(Some(NO_CLASSIFIER.to_owned())));
    let tainted = Call {
        tainted: true,
        ..send
    };
    assert_eq!(
        route(tainted),
        Route::Review(Some(TAINTED_OUTWARD.to_owned()))
    );
    let both = Call {
        tainted: true,
        classifier: false,
        ..send
    };
    assert!(is_review(&route(both)));
    // Too long to review whole: the person.
    let long = Call { fits: false, ..off };
    assert!(matches!(route(long), Route::Ask { .. }));
    // An app's read runs as before.
    let read = Call {
        tainted: true,
        classifier: false,
        ..app_tool("mail__list", Some(Effect::Read))
    };
    assert_eq!(route(read), Route::Run);
    // Spade's and ace's own writes aren't an app's: they keep running.
    let own = Call {
        tainted: true,
        classifier: false,
        ..full("bot_message", Some(Effect::Network))
    };
    assert_eq!(route(own), Route::Run);
}

#[test]
fn in_full_access_a_sandbox_that_holds_an_app_tools_files_doesnt_hold_its_sends() {
    // A plugin's server in the sandbox, with an API token and its network on: still remote.
    let contained = |effect| Call {
        place: Place::Sandbox,
        ..app_tool("mailer__send_email", effect)
    };
    assert_eq!(
        route(contained(None)),
        Route::Ask {
            line: UNDECLARED.to_owned(),
            ask: Some(Ask::Undeclared)
        }
    );
    let off = Call {
        classifier: false,
        ..contained(Some(Effect::Network))
    };
    assert_eq!(route(off), Route::Review(Some(NO_CLASSIFIER.to_owned())));
    let tainted = Call {
        tainted: true,
        ..contained(Some(Effect::Network))
    };
    assert_eq!(
        route(tainted),
        Route::Review(Some(TAINTED_OUTWARD.to_owned()))
    );
    // Only a server sealed offline with no credentials of its own runs its tools as the sandbox
    // decides.
    for effect in [None, Some(Effect::Network)] {
        let sealed = Call {
            remote: false,
            tainted: true,
            classifier: false,
            ..contained(effect)
        };
        assert_eq!(route(sealed), Route::Run, "{effect:?}");
    }
}

#[test]
fn in_full_access_a_tool_the_person_declined_stays_declined() {
    let declined = Call {
        remembered: Some(false),
        ..full("plugin__tool", None)
    };
    assert_eq!(route(declined), Route::Refuse(DECLINED_TOOL.to_owned()));
}

use crate::autonomy::{CREDENTIALS_REFUSED, Class, Mode, Sensitive};
use crate::effect::{
    CHANGES_ACCESS, Call, Drive, Effect, GIT_PUSH, Granted, PUSHES, Place, Route, SENDS_AS_YOU,
    SPENDS, route,
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
        org: None,
        permits: crate::permission::Held::default(),
        connected: false,
        guessed: false,
        overwrites: false,
        app_plain: false,
    }
}

fn asks(line: &str) -> Route {
    Route::Ask {
        line: line.to_owned(),
        ask: None,
    }
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
fn full_access_runs_ordinary_calls_even_under_taint_with_permissions_and_classifier_off() {
    for (tool, effect, place) in [
        ("app__exec", None, Place::Host),
        ("app__delete", Some(Effect::Network), Place::Host),
        ("app__unknown", Some(Effect::Unknown), Place::Host),
        ("browser_open", Some(Effect::Drive), Place::Host),
        ("screen_act", Some(Effect::Drive), Place::Host),
        ("sim_act", Some(Effect::Drive), Place::Host),
        ("shell", Some(Effect::WriteLocal), Place::AsksOutside),
        ("shell", Some(Effect::WriteLocal), Place::Unprotected),
        (
            "shell",
            Some(Effect::WriteLocal),
            Place::Unsandboxed(Class::Outward),
        ),
    ] {
        let call = Call {
            classifier: false,
            place,
            remote: tool.starts_with("app__"),
            destructive: tool == "app__delete",
            overwrites: tool == "app__delete",
            ..full(tool, effect)
        };
        for call in under_everything(call) {
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
fn a_grant_cannot_bypass_a_full_access_hard_stop() {
    let granted = Call {
        granted: Granted::Typed,
        always: true,
        rule: Decision::Run,
        ..full(GIT_PUSH, Some(Effect::SendAsPerson))
    };
    for call in under_everything(granted) {
        assert_eq!(route(call), asks(PUSHES));
    }
}

#[test]
fn in_full_access_a_change_of_access_still_asks() {
    for (case, line) in [
        (
            full("okta__add_member", Some(Effect::ChangeAccess)),
            CHANGES_ACCESS,
        ),
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

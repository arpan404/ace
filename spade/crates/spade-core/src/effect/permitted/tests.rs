//! A bot's Permissions at the gate (ADR 0171, amendment 7), as tables of steps and routes: a
//! driving step runs under its family's switch with no review and no request, in both modes,
//! and is refused without it; the never-use list, a place Spade can't hold the step to, the
//! package's ceiling and the organization still stop it.

use serde_json::{Value, json};

use crate::autonomy::Mode;
use crate::effect::ceiling::Ceiling;
use crate::effect::{
    Call, Drive, Effect, GIT_PUSH, Granted, Place, Route, SENDS_AS_YOU, SPENDS, drive, route,
};
use crate::gate::Decision;
use crate::permission::{Held, Switch, never};
use crate::tools::Risk;

/// Every switch on.
const ALL_ON: Held = Held {
    computer_use: true,
    browser: true,
    devices: true,
    apps: true,
    send: true,
    pay: true,
};

/// A held write of `effect` from the host, under `permits`.
fn call(tool: &str, effect: Option<Effect>, permits: Held) -> Call<'_> {
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
        mode: Mode::AutoReview,
        remote: false,
        classifier: true,
        ceiling: None,
        command: None,
        destructive: false,
        org: None,
        permits,
        connected: false,
    }
}

/// What the engine finds for a driving step: where ace says it acts (`listed`, ace's answer to
/// the lookup), held there by an ace whose tools take `expect`, read against `list`.
struct Found {
    tool: &'static str,
    arguments: Value,
    step: drive::Step,
    list: Vec<String>,
}

fn found(tool: &'static str, arguments: Value, listed: Option<&str>, list: &[&str]) -> Found {
    let step = drive::read(tool, &arguments, listed);
    Found {
        tool,
        arguments,
        step,
        list: list.iter().map(|entry| (*entry).to_owned()).collect(),
    }
}

impl Found {
    fn call(&self, permits: Held) -> Call<'_> {
        Call {
            drive: Drive {
                target: self
                    .step
                    .place
                    .as_ref()
                    .map(drive::Place::shown)
                    .map_err(|why| *why),
                never: (Switch::driving(self.tool) == Some(Switch::ComputerUse))
                    .then(|| never::listed(&self.list, &self.step.names))
                    .flatten(),
                bound: self.step.place.is_ok(),
                placeless: drive::placeless(self.tool, &self.arguments),
            },
            ..call(self.tool, Some(Effect::Drive), permits)
        }
    }
}

/// `call` in both modes, with untrusted content in view or not, too long for a reviewer or not,
/// and with or without the person's Always allow for the tool.
fn every_way(call: Call<'_>) -> Vec<Call<'_>> {
    let mut all = Vec::new();
    for mode in [Mode::AutoReview, Mode::FullAccess] {
        for tainted in [false, true] {
            for fits in [true, false] {
                for always in [false, true] {
                    all.push(Call {
                        mode,
                        tainted,
                        fits,
                        always,
                        rule: if always { Decision::Run } else { Decision::Ask },
                        ..call
                    });
                }
            }
        }
    }
    all
}

const MAIL_LISTED: &str = "Running:\nMail (com.apple.mail), frontmost\nTextEdit (com.apple.TextEdit)";

fn screen_steps() -> Vec<Found> {
    vec![
        // Reads and input alike.
        found(
            "screen_state",
            json!({"app": "TextEdit"}),
            Some(MAIL_LISTED),
            never::DEFAULT,
        ),
        found(
            "screen_act",
            json!({"app": "TextEdit", "actions": [{"type": "click", "id": 3}]}),
            Some(MAIL_LISTED),
            never::DEFAULT,
        ),
        // Mail is no longer the person's alone: it isn't on the list unless they put it there.
        found(
            "screen_act",
            json!({"app": "Mail", "actions": [{"type": "type", "text": "hi"}]}),
            Some(MAIL_LISTED),
            never::DEFAULT,
        ),
        found("screen_state", json!({"app": "Mail"}), Some(MAIL_LISTED), never::DEFAULT),
        found(
            "screen_open_app",
            json!({"bundleId": "com.apple.TextEdit"}),
            None,
            never::DEFAULT,
        ),
    ]
}

#[test]
fn with_computer_use_on_every_screen_step_runs_with_no_review_or_request() {
    for step in screen_steps() {
        for call in every_way(step.call(Held {
            computer_use: true,
            ..Held::default()
        })) {
            assert_eq!(route(call), Route::Run, "{} {}", step.tool, step.arguments);
        }
    }
}

#[test]
fn with_computer_use_off_every_screen_step_is_refused_saying_where_to_turn_it_on() {
    let off = Route::Refuse(Switch::ComputerUse.off());
    let Route::Refuse(line) = &off else {
        unreachable!()
    };
    assert!(line.contains("Computer use is off"), "{line}");
    assert!(line.contains("under Permissions"), "{line}");
    for step in screen_steps() {
        // Off by default, and the other families' switches don't turn it on.
        for permits in [
            Held::default(),
            Held {
                computer_use: false,
                ..ALL_ON
            },
        ] {
            for call in every_way(step.call(permits)) {
                assert_eq!(route(call), off, "{} {}", step.tool, step.arguments);
            }
        }
    }
}

#[test]
fn an_app_on_the_never_use_list_is_refused_even_with_computer_use_on() {
    let on = Held {
        computer_use: true,
        ..Held::default()
    };
    let cases = [
        // On the default list.
        (
            json!({"app": "1Password", "actions": []}),
            "Running:\n1Password (com.1password.1password)",
            never::DEFAULT,
            "1Password",
        ),
        // A part of a listed app's name, as ace would open it.
        (
            json!({"app": "pass", "actions": []}),
            "Running:\n1Password (com.1password.1password)\nPassbook (x.passbook)",
            never::DEFAULT,
            "1Password",
        ),
        // A word of the list inside the app's name.
        (
            json!({"app": "Bank of America", "actions": []}),
            "Running:\nBank of America (com.bofa.app)",
            never::DEFAULT,
            "Bank",
        ),
        // The person put Mail on it.
        (
            json!({"app": "Mail", "actions": [{"type": "type", "text": "hi"}]}),
            MAIL_LISTED,
            &["Mail"][..],
            "Mail",
        ),
        // By its id, and when ace lists no app for the name at all.
        (
            json!({"app": "com.apple.mail", "actions": []}),
            MAIL_LISTED,
            &["Mail"][..],
            "Mail",
        ),
        (json!({"app": "Mail", "actions": []}), "", &["Mail"][..], "Mail"),
    ];
    for (arguments, listed, list, entry) in cases {
        let step = found("screen_act", arguments.clone(), Some(listed), list);
        for call in every_way(step.call(on)) {
            assert_eq!(
                route(call),
                Route::Refuse(never::refusal(entry)),
                "{arguments}"
            );
        }
    }
    // Taking Mail off the list lets the same step run.
    let step = found(
        "screen_act",
        json!({"app": "Mail", "actions": []}),
        Some(MAIL_LISTED),
        &[],
    );
    assert_eq!(route(step.call(on)), Route::Run);
}

#[test]
fn browser_and_simulator_steps_run_under_their_own_switch_and_are_refused_without_it() {
    let tabs = r#"{"tabs":[{"tabId":"t1","url":"https://mail.google.com/mail/u/0/","current":true}]}"#;
    let browser = [
        found("browser_act", json!({"action": "click", "ref": "e1"}), Some(tabs), &[]),
        found("browser_act", json!({"action": "type", "text": "hi"}), Some(tabs), &[]),
        found("browser_open", json!({"url": "https://www.paypal.com/checkout"}), None, &[]),
        // Placeless: nothing to hold it to.
        found("browser_settings", json!({"action": "close"}), None, &[]),
        found("browser_evaluate", json!({"script": "1"}), Some(tabs), &[]),
    ];
    let devices = [
        found("sim_act", json!({"simId": "s1", "action": "tap"}), None, &[]),
        found("sim_act", json!({"simId": "s1", "action": "type", "text": "hi"}), None, &[]),
        found(
            "sim_act",
            json!({"simId": "s1", "action": "open_app", "appId": "com.apple.MobileSMS"}),
            None,
            &[],
        ),
        found("sim_start", json!({"simId": "s1"}), None, &[]),
    ];
    for (steps, switch) in [(&browser[..], Switch::Browser), (&devices[..], Switch::Devices)] {
        let only = match switch {
            Switch::Browser => Held {
                browser: true,
                ..Held::default()
            },
            _ => Held {
                devices: true,
                ..Held::default()
            },
        };
        for step in steps {
            for call in every_way(step.call(only)) {
                assert_eq!(route(call), Route::Run, "{} {}", step.tool, step.arguments);
            }
            for call in every_way(step.call(Held {
                computer_use: true,
                ..Held::default()
            })) {
                assert_eq!(
                    route(call),
                    Route::Refuse(switch.off()),
                    "{} {}",
                    step.tool,
                    step.arguments
                );
            }
        }
    }
}

#[test]
fn a_step_that_must_be_held_where_spade_cant_place_or_hold_it_is_refused_not_asked() {
    let loading = r#"{"tabs":[{"tabId":"t1","url":"https://docs.rs/","current":true,"loading":true}]}"#;
    let cases = [
        // A tab still loading, or none current.
        found("browser_act", json!({"action": "click"}), Some(loading), &[]),
        found("browser_act", json!({"action": "click"}), Some(r#"{"tabs":[]}"#), &[]),
        // Two apps for the name and neither exactly it.
        found(
            "screen_act",
            json!({"app": "Text", "actions": []}),
            Some("Running:\nTextEdit (com.apple.TextEdit)\nTextMate (com.macromates.TextMate)"),
            &[],
        ),
        // No app named: the never-use list needs one.
        found("screen_act", json!({"actions": []}), None, &[]),
        found("screen_input", json!({"text": "hi"}), None, &[]),
    ];
    for step in cases {
        for call in every_way(step.call(ALL_ON)) {
            let route = route(call);
            let Route::Refuse(line) = &route else {
                panic!("{} {}: {route:?}", step.tool, step.arguments);
            };
            assert!(line.starts_with("Not run: "), "{line}");
            assert!(line.ends_with("Look again, then act."), "{line}");
            assert!(!line.contains("you decide"), "{line}");
        }
    }
    // Placed, but this ace's tool can't be told where to hold it.
    let step = found(
        "screen_act",
        json!({"app": "TextEdit", "actions": []}),
        Some(MAIL_LISTED),
        &[],
    );
    let unheld = Call {
        drive: Drive {
            bound: false,
            ..step.call(ALL_ON).drive
        },
        ..step.call(ALL_ON)
    };
    for call in every_way(unheld) {
        assert_eq!(route(call), Route::Refuse(drive::UNHELD.to_owned()));
    }
}

#[test]
fn a_packaged_bot_cant_drive_past_its_package_whatever_its_switches_say() {
    let step = found(
        "screen_act",
        json!({"app": "TextEdit", "actions": []}),
        Some(MAIL_LISTED),
        &[],
    );
    let packaged = |allows: &[Effect]| Call {
        ceiling: Some(Ceiling {
            bot: "Flight watcher",
            allows: allows.iter().copied().collect(),
        }),
        ..step.call(ALL_ON)
    };
    for call in every_way(packaged(&[Effect::Read])) {
        assert_eq!(
            route(call),
            Route::Refuse(
                "Flight watcher doesn't declare reaching outside its own folder.".to_owned()
            )
        );
    }
    // A package that declares it runs under the switch, and is still refused without it.
    assert_eq!(route(packaged(&[Effect::Network])), Route::Run);
    let off = Call {
        permits: Held::default(),
        ..packaged(&[Effect::Network])
    };
    assert_eq!(route(off), Route::Refuse(Switch::ComputerUse.off()));
}

#[test]
fn on_an_organizations_shared_bot_a_step_under_a_switch_still_goes_to_its_approvers() {
    let policy: &'static crate::org::Policy = Box::leak(Box::new(
        crate::org::Policy::parse("{}").unwrap_or_else(|| panic!("a policy")),
    ));
    let step = found(
        "screen_act",
        json!({"app": "TextEdit", "actions": []}),
        Some(MAIL_LISTED),
        &[],
    );
    let shared = Call {
        org: Some(crate::org::Gate {
            org: "Acme",
            policy,
        }),
        ..step.call(ALL_ON)
    };
    assert_eq!(
        route(shared),
        Route::Ask {
            line: crate::org::gate::APPROVERS.to_owned(),
            ask: None
        }
    );
}

#[test]
fn sends_payments_and_connected_apps_are_refused_while_their_switch_is_off() {
    let cases = [
        (call("send_message", Some(Effect::SendAsPerson), ALL_ON), Switch::Send),
        (call(GIT_PUSH, Some(Effect::SendAsPerson), ALL_ON), Switch::Send),
        (call("shop__buy", Some(Effect::Pay), ALL_ON), Switch::Pay),
        (
            Call {
                remote: true,
                connected: true,
                ..call("crm__update", Some(Effect::Network), ALL_ON)
            },
            Switch::Apps,
        ),
    ];
    for (on, switch) in cases {
        // On, each goes the usual way: a send and a payment ask, an app's write is reviewed.
        assert!(!matches!(route(on), Route::Refuse(_)), "{}", on.tool);
        let mut permits = ALL_ON;
        match switch {
            Switch::Send => permits.send = false,
            Switch::Pay => permits.pay = false,
            _ => permits.apps = false,
        }
        // Off, refused in every mode, over an Always allow and a grant.
        for off in every_way(Call {
            permits,
            granted: Granted::Typed,
            ..on
        }) {
            assert_eq!(route(off), Route::Refuse(switch.off()), "{}", on.tool);
        }
    }
    let ask = |line: &str| Route::Ask {
        line: line.to_owned(),
        ask: None,
    };
    assert_eq!(
        route(call("send_message", Some(Effect::SendAsPerson), ALL_ON)),
        ask(SENDS_AS_YOU)
    );
    assert_eq!(route(call("shop__buy", Some(Effect::Pay), ALL_ON)), ask(SPENDS));
}

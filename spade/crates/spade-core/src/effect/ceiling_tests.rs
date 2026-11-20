//! The effects ceiling in the gate (ADR 0200 §3.4), as tables of calls and routes.

use super::ceiling::{Ceiling, Effects};
use super::*;
use crate::autonomy::Mode;
use Effect::{
    ChangeAccess, Drive as Drives, Network, Pay, Publish, Read, SendAsPerson, WriteLocal,
};

fn call(
    tool: &'static str,
    effect: Option<Effect>,
    ceiling: Option<Ceiling<'static>>,
) -> Call<'static> {
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
        ceiling,
        command: None,
    }
}

fn watcher(allows: &[Effect]) -> Option<Ceiling<'static>> {
    Some(Ceiling {
        bot: "Flight watcher",
        allows: allows.iter().copied().collect(),
    })
}

fn refused(why: &str) -> Route {
    Route::Refuse(why.to_owned())
}

#[test]
fn an_undeclared_effect_is_refused_before_review_whatever_the_tool_is_called() {
    let publishing = "Flight watcher doesn't declare publishing.";
    let reaching = "Flight watcher doesn't declare reaching outside its own folder.";
    let cases = [
        (
            "release_create",
            Some(Publish),
            &[Network][..],
            refused(publishing),
        ),
        // A harmless name changes nothing: the effect is the gate's reading.
        (
            "read_notes",
            Some(Publish),
            &[Network][..],
            refused(publishing),
        ),
        (
            "crm__update_contact",
            Some(Network),
            &[][..],
            refused(reaching),
        ),
        // A driving step acts outside the bot: it needs `network`.
        (
            "browser_act",
            Some(Drives),
            &[Publish][..],
            refused(reaching),
        ),
    ];
    for (tool, effect, allows, route) in cases {
        let packaged = call(tool, effect, watcher(allows));
        assert_eq!(super::route(packaged), route, "{tool}");
        // The same call from a bot with no package reaches the review or the person.
        let plain = super::route(call(tool, effect, None));
        assert!(!matches!(plain, Route::Refuse(_)), "{tool}: {plain:?}");
    }
}

#[test]
fn the_ceiling_holds_in_full_access_and_over_an_always_allow() {
    let ceiling = watcher(&[Network]);
    let full = Call {
        mode: Mode::FullAccess,
        ..call("release_create", Some(Publish), ceiling)
    };
    let always = Call {
        always: true,
        rule: Decision::Run,
        ..call("release_create", Some(Publish), ceiling)
    };
    for each in [full, always] {
        assert_eq!(
            route(each),
            refused("Flight watcher doesn't declare publishing.")
        );
    }
}

#[test]
fn a_remote_apps_local_write_needs_network_declared() {
    let remote = Call {
        remote: true,
        place: Place::Sandbox,
        ..call("notes__save", Some(WriteLocal), watcher(&[]))
    };
    assert_eq!(
        route(remote),
        refused("Flight watcher doesn't declare reaching outside its own folder.")
    );
}

#[test]
fn a_declared_person_only_effect_still_goes_to_the_person_every_time() {
    for (effect, line) in [
        (SendAsPerson, SENDS_AS_YOU),
        (Pay, SPENDS),
        (ChangeAccess, CHANGES_ACCESS),
    ] {
        let packaged = call("mail__send", Some(effect), watcher(&DECLARABLE_ALL));
        assert_eq!(
            route(packaged),
            Route::Ask {
                line: line.to_owned(),
                ask: None
            },
            "{effect:?}"
        );
        let full = Call {
            mode: Mode::FullAccess,
            ..packaged
        };
        assert!(matches!(route(full), Route::Ask { .. }), "{effect:?}");
    }
}

const DECLARABLE_ALL: [Effect; 5] = ceiling::DECLARABLE;

#[test]
fn reads_local_writes_and_undeclared_tools_are_not_the_ceilings() {
    let none = watcher(&[]);
    assert_eq!(route(call("workspace_read", Some(Read), none)), Route::Run);
    let note = Call {
        rule: Decision::Run,
        risk: Risk::Memory,
        ..call("memory_save", Some(WriteLocal), none)
    };
    assert_eq!(route(note), Route::Run);
}

#[test]
fn a_tool_spade_cant_name_is_refused_unless_the_sandbox_holds_it() {
    let none = watcher(&DECLARABLE_ALL);
    let cant_tell = "Spade can't tell what this does, and Flight watcher may only do what its \
                     package declares.";
    // An app's tool with no trusted declaration, or one declaring a word Spade doesn't know.
    for effect in [None, Some(Effect::Unknown)] {
        assert_eq!(
            route(call("crm__sync", effect, none)),
            refused(cant_tell),
            "{effect:?}"
        );
        // Full access changes nothing.
        let full = Call {
            mode: Mode::FullAccess,
            ..call("crm__sync", effect, none)
        };
        assert_eq!(route(full), refused(cant_tell), "{effect:?}");
        // A server in the sandbox that still reaches the network isn't held by it.
        let remote = Call {
            place: Place::Sandbox,
            remote: true,
            ..call("crm__sync", effect, none)
        };
        assert_eq!(route(remote), refused(cant_tell), "{effect:?}");
    }
    // Sealed in the sandbox with no network of its own: the sandbox decides.
    let sealed = Call {
        place: Place::Sandbox,
        ..call("lint__check", None, none)
    };
    assert_eq!(route(sealed), Route::Run);
    // The same tool for a bot with no package still asks the person once.
    assert_eq!(
        route(call("crm__sync", None, None)),
        Route::Ask {
            line: UNDECLARED.to_owned(),
            ask: Some(Ask::Undeclared)
        }
    );
}

#[test]
fn an_earlier_answer_never_carries_to_a_packaged_bots_unnamed_tool() {
    let none = watcher(&[]);
    // In the sandbox but with no checkpoint: held, so not refused, and the person's earlier
    // "yes" for the tool isn't kept for a packaged bot.
    let remembered = Call {
        place: Place::Unprotected,
        remembered: Some(true),
        ..call("lint__fix", None, none)
    };
    assert_eq!(
        route(remembered),
        Route::Ask {
            line: UNDECLARED_EACH_TIME.to_owned(),
            ask: None
        }
    );
    let confined_unknown = Call {
        place: Place::Unprotected,
        always: true,
        rule: Decision::Run,
        ..call("lint__fix", Some(Effect::Unknown), none)
    };
    assert!(matches!(route(confined_unknown), Route::Ask { .. }));
}

#[test]
fn a_command_outside_the_sandbox_is_held_to_what_the_classifier_read_in_it() {
    use crate::autonomy::{Class, Sensitive};
    let publishing = "Flight watcher doesn't declare publishing.";
    let reaching = "Flight watcher doesn't declare reaching outside its own folder.";
    let cant_tell = "Spade can't tell what this does, and Flight watcher may only do what its \
                     package declares.";
    let cases = [
        (
            Class::Sensitive(Sensitive::Publish),
            &[Network][..],
            refused(publishing),
        ),
        (
            Class::Sensitive(Sensitive::RemoteChange),
            &[Network][..],
            refused(publishing),
        ),
        (
            Class::Sensitive(Sensitive::Network),
            &[][..],
            refused(reaching),
        ),
        (Class::Outward, &[][..], refused(reaching)),
        (
            Class::Sensitive(Sensitive::Unclear),
            &[Network][..],
            refused(cant_tell),
        ),
        (
            Class::Sensitive(Sensitive::MessageAsPerson),
            &[Network][..],
            refused("Flight watcher doesn't declare sending in your name."),
        ),
    ];
    for (class, allows, expected) in cases {
        for place in [Place::Unsandboxed(class), Place::AsksOutside] {
            let command = Call {
                place,
                command: Some(class),
                ..call("shell", Some(WriteLocal), watcher(allows))
            };
            assert_eq!(route(command), expected, "{class:?} {place:?}");
            let full = Call {
                mode: Mode::FullAccess,
                ..command
            };
            assert_eq!(route(full), expected, "{class:?} in Full access");
        }
    }
    // A plain command outside, or one the package's switches cover, is decided as before.
    let plain = Call {
        place: Place::Unsandboxed(Class::Inside),
        command: Some(Class::Inside),
        ..call("shell", Some(WriteLocal), watcher(&[]))
    };
    assert!(!matches!(route(plain), Route::Refuse(_)));
    let declared = Call {
        place: Place::Unsandboxed(Class::Sensitive(Sensitive::Publish)),
        command: Some(Class::Sensitive(Sensitive::Publish)),
        ..call("service_start", Some(WriteLocal), watcher(&[Publish]))
    };
    assert!(!matches!(route(declared), Route::Refuse(_)));
}

#[test]
fn a_packaged_bots_send_payment_or_access_change_asks_even_with_a_grant_or_always_allow() {
    for (tool, effect) in [
        (GIT_PUSH, SendAsPerson),
        (PR_COMMENT, SendAsPerson),
        ("shop__buy", Pay),
        ("keys__rotate", ChangeAccess),
    ] {
        let granted = Call {
            granted: Granted::Typed,
            ..call(tool, Some(effect), watcher(&DECLARABLE_ALL))
        };
        let always = Call {
            always: true,
            rule: Decision::Run,
            ..call(tool, Some(effect), watcher(&DECLARABLE_ALL))
        };
        for each in [granted, always] {
            assert!(
                matches!(route(each), Route::Ask { ask: None, .. }),
                "{tool}: {:?}",
                route(each)
            );
        }
        // A bot with no package keeps what the person granted or always allowed.
        let plain = Call {
            always: true,
            rule: Decision::Run,
            ..call(tool, Some(effect), None)
        };
        assert_eq!(route(plain), Route::Run, "{tool}");
    }
    let plain_grant = Call {
        granted: Granted::Typed,
        ..call(GIT_PUSH, Some(SendAsPerson), None)
    };
    assert_eq!(route(plain_grant), Route::Run);
}

#[test]
fn a_secret_is_refused_as_a_secret_first() {
    let secret = Call {
        credentials: true,
        ..call("crm__export", Some(Network), watcher(&[]))
    };
    assert_eq!(
        route(secret),
        Route::Refuse(autonomy::CREDENTIALS_REFUSED.to_owned())
    );
}

#[test]
fn a_worker_gets_no_more_than_its_maker_declared() {
    let maker: Effects = [Network, SendAsPerson].into_iter().collect();
    let asked: Effects = [Network, Publish].into_iter().collect();
    let worker = maker.and(asked);
    assert!(worker.has(Network));
    assert!(!worker.has(Publish));
    assert!(!worker.has(SendAsPerson));
    let routed = route(call(
        "release_create",
        Some(Publish),
        Some(Ceiling {
            bot: "Flight watcher",
            allows: worker,
        }),
    ));
    assert_eq!(
        routed,
        refused("Flight watcher doesn't declare publishing.")
    );
}

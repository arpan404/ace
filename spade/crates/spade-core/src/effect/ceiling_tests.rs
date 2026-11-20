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
    // A tool that says nothing about itself still asks the person once.
    assert_eq!(
        route(call("mystery", None, none)),
        Route::Ask {
            line: UNDECLARED.to_owned(),
            ask: Some(Ask::Undeclared)
        }
    );
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

//! An MCP tool's annotations and its server's trust, to effects and routes (ADR 0202 §2): outside
//! declarations can make Spade ask, never make it skip asking.

use super::ceiling::Ceiling;
use super::*;
use crate::autonomy::Mode;
use Effect::{Network, Pay, Publish, Read, SendAsPerson};

/// A tool's hints as its server sent them, and what Spade knows of the server.
fn hints(read_only: bool, destructive: bool, trusted: bool, declared: Option<Effect>) -> Mcp {
    Mcp {
        read_only,
        destructive,
        annotated: true,
        declared,
        trusted,
    }
}

/// A connector's call as the gate sees it, its effect and destructive mark read from `tool`.
fn app_call(tool: Mcp) -> Call<'static> {
    Call {
        tool: "app__tool",
        rule: Decision::Ask,
        risk: if tool.destructive {
            Risk::Destructive
        } else if tool.read_only {
            Risk::Read
        } else {
            Risk::Write
        },
        always: false,
        effect: mcp(tool),
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
        remote: true,
        classifier: true,
        ceiling: None,
        command: None,
        destructive: asks_each_call(tool),
        org: None,
        permits: crate::permission::Held::default(),
        connected: false,
    }
}

fn undeclared_once() -> Route {
    Route::Ask {
        line: UNDECLARED.to_owned(),
        ask: Some(Ask::Undeclared),
    }
}

fn asks(line: &str) -> Route {
    Route::Ask {
        line: line.to_owned(),
        ask: None,
    }
}

fn package(allows: &[Effect]) -> Option<Ceiling<'static>> {
    Some(Ceiling {
        bot: "Watcher",
        allows: allows.iter().copied().collect(),
    })
}

#[test]
fn annotations_lower_an_effect_only_from_a_server_spade_trusts() {
    // (readOnlyHint, destructiveHint, trusted server, trusted declaration) → (effect, asks every
    // call). `idempotentHint` and `openWorldHint` never change an effect, so they aren't here.
    let cases = [
        // An untrusted server: its hints declare nothing, whatever they say.
        (true, false, false, None, None, false),
        (false, false, false, None, None, false),
        // Its destructive hint can only make Spade ask more.
        (false, true, false, None, None, true),
        (true, true, false, None, None, true),
        // A trusted server: read-only reads, anything else reaches outside the bot.
        (true, false, true, None, Some(Read), false),
        (false, false, true, None, Some(Network), false),
        (false, true, true, None, Some(Network), true),
        // Destructive wins over read-only: never a read.
        (true, true, true, None, Some(Network), true),
        // A trusted declaration is the least it does, raised by the hints, never lowered.
        (true, false, false, Some(Pay), Some(Pay), false),
        (true, false, true, Some(Pay), Some(Pay), false),
        (false, false, true, Some(Read), Some(Network), false),
        (true, true, true, Some(Read), Some(Network), false),
        (true, false, false, Some(Read), Some(Read), false),
        (false, true, false, Some(Publish), Some(Publish), false),
        (
            true,
            true,
            true,
            Some(SendAsPerson),
            Some(SendAsPerson),
            false,
        ),
    ];
    for (read_only, destructive, trusted, declared, effect, each_call) in cases {
        let tool = hints(read_only, destructive, trusted, declared);
        assert_eq!(mcp(tool), effect, "{tool:?}");
        assert_eq!(asks_each_call(tool), each_call, "{tool:?}");
    }
    // A trusted server's tool that says nothing about itself declares nothing either.
    let silent = Mcp {
        trusted: true,
        ..Mcp::default()
    };
    assert_eq!(mcp(silent), None);
}

#[test]
fn an_untrusted_servers_read_only_tool_still_asks_and_a_trusted_ones_reads_without_asking() {
    let untrusted = app_call(hints(true, false, false, None));
    assert_eq!(route(untrusted), undeclared_once());
    // In Full access too: nothing says it doesn't send or pay.
    let full = Call {
        mode: Mode::FullAccess,
        ..untrusted
    };
    assert_eq!(route(full), undeclared_once());

    let trusted = app_call(hints(true, false, true, None));
    assert_eq!(route(trusted), Route::Run);
    // Untrusted content in view doesn't make a read ask.
    let tainted = Call {
        tainted: true,
        ..trusted
    };
    assert_eq!(route(tainted), Route::Run);
}

#[test]
fn under_a_package_an_untrusted_servers_tool_needs_network_and_then_asks_each_call() {
    let untrusted = |allows: &[Effect]| Call {
        ceiling: package(allows),
        ..app_call(hints(true, false, false, None))
    };
    assert_eq!(
        route(untrusted(&[])),
        Route::Refuse("Watcher doesn't declare reaching outside its own folder.".to_owned())
    );
    // Declared: still the person's each time, an answer kept for the tool notwithstanding.
    let declared = Call {
        remembered: Some(true),
        ..untrusted(&[Network])
    };
    assert_eq!(route(declared), asks(UNDECLARED_EACH_TIME));
    // A trusted server's read needs nothing declared.
    let trusted = Call {
        ceiling: package(&[]),
        ..app_call(hints(true, false, true, None))
    };
    assert_eq!(route(trusted), Route::Run);
}

#[test]
fn a_destructive_hint_asks_every_call_and_nothing_the_person_allowed_before_skips_it() {
    for trusted in [false, true] {
        let destructive = app_call(hints(false, true, trusted, None));
        assert_eq!(route(destructive), asks(DESTRUCTIVE), "trusted={trusted}");
        let allowed_before = [
            Call {
                always: true,
                rule: Decision::Run,
                ..destructive
            },
            Call {
                remembered: Some(true),
                ..destructive
            },
            Call {
                granted: Granted::Tool,
                ..destructive
            },
            Call {
                mode: Mode::FullAccess,
                ..destructive
            },
        ];
        for call in allowed_before {
            assert_eq!(route(call), asks(DESTRUCTIVE), "{call:?}");
        }
    }
    // The person's "no" for an undeclared tool still refuses it.
    let declined = Call {
        remembered: Some(false),
        ..app_call(hints(false, true, false, None))
    };
    assert_eq!(route(declined), Route::Refuse(DECLINED_TOOL.to_owned()));
    // A payment that also says it is destructive is still the person's payment.
    let pays = app_call(hints(true, true, false, Some(Pay)));
    assert_eq!(route(pays), asks(SPENDS));
}

#[test]
fn a_trusted_declaration_wins_over_a_destructive_hint_and_is_reviewed_as_before() {
    let declared = app_call(hints(false, true, true, Some(Network)));
    assert!(!declared.destructive);
    assert_eq!(
        route(declared),
        Route::Review(Some(DELETES.to_owned())),
        "a catalogue-declared write that deletes is reviewed with that said"
    );
}

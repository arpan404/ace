//! A connected app's tools as the gate decides them (ADR 0202, amendment 2): what its name and
//! hints say, then where the call goes. Notion's server annotates nothing, so its tools are read
//! from their names.

use super::*;
use crate::autonomy::Mode;
use crate::permission::Held;

/// A tool of a connected app as the connector offers it: its server's hints (`annotated` false
/// for a server that sends none, like Notion's), read with its own name and description.
fn notion(name: &'static str, description: &str, hints: Mcp) -> Call<'static> {
    let (effect, destructive) = app_tool(hints, named(name, description));
    Call {
        tool: name,
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
        remote: true,
        classifier: true,
        ceiling: None,
        command: None,
        destructive,
        org: None,
        permits: Held::default(),
        connected: true,
    }
}

fn silent() -> Mcp {
    Mcp::default()
}

fn person_decides(route: &Route) -> bool {
    matches!(route, Route::Ask { .. })
}

#[test]
fn a_connected_apps_undeclared_list_and_search_run_with_no_card() {
    for name in [
        "list_shared_pages",
        "list_favorite_pages",
        "list_recent_pages",
        "notion-search",
        "notion-fetch",
    ] {
        for mode in [Mode::AutoReview, Mode::FullAccess] {
            let call = Call {
                mode,
                ..notion(name, "", silent())
            };
            assert_eq!(route(call), Route::Run, "{name} {mode:?}");
        }
        // A clear read still runs with untrusted content in view.
        let tainted = Call {
            tainted: true,
            ..notion(name, "", silent())
        };
        assert_eq!(route(tainted), Route::Run, "{name} tainted");
    }
}

#[test]
fn a_connected_apps_reads_are_refused_while_its_apps_switch_is_off() {
    let off = Call {
        permits: Held {
            apps: false,
            ..Held::default()
        },
        ..notion("list_shared_pages", "", silent())
    };
    assert!(matches!(route(off), Route::Refuse(_)));
}

#[test]
fn an_undeclared_create_page_is_judged_by_the_reviewer_not_asked() {
    let create = notion("create_page", "Creates a page in a database.", silent());
    assert_eq!(
        route(create),
        Route::Review(Some(UNDECLARED_REVIEW.to_owned()))
    );
}

#[test]
fn sends_and_payments_of_an_app_still_reach_the_person() {
    for name in [
        "send_email",
        "transfer_funds",
        "share_page",
        "reset_password",
    ] {
        for mode in [Mode::AutoReview, Mode::FullAccess] {
            let call = Call {
                mode,
                ..notion(name, "", silent())
            };
            assert!(person_decides(&route(call)), "{name} {mode:?}");
        }
        // An Always allow for the app's writes never covers them.
        let granted = Call {
            granted: Granted::Tool,
            ..notion(name, "", silent())
        };
        assert!(person_decides(&route(granted)), "{name} granted");
    }
}

#[test]
fn a_delete_that_claims_read_only_still_reaches_the_person() {
    for trusted in [false, true] {
        let lying = Mcp {
            read_only: true,
            annotated: true,
            trusted,
            ..Mcp::default()
        };
        let call = notion("delete_page", "Read-only.", lying);
        assert_eq!(route(call), Route::ask(DESTRUCTIVE), "trusted={trusted}");
        let granted = Call {
            granted: Granted::Tool,
            ..call
        };
        assert_eq!(route(granted), Route::ask(DESTRUCTIVE));
    }
}

#[test]
fn an_untrusted_servers_read_only_hint_never_makes_a_write_a_read() {
    let claims = Mcp {
        read_only: true,
        annotated: true,
        ..Mcp::default()
    };
    for name in [
        "get_or_create_page",
        "fetch_and_update",
        "sync",
        "run",
        "execute",
    ] {
        let call = notion(name, "", claims);
        assert_ne!(call.effect, Some(Effect::Read), "{name}");
        assert!(
            matches!(route(call), Route::Review(_)),
            "{name}: {:?}",
            route(call)
        );
    }
}

#[test]
fn an_app_that_says_a_tool_may_write_narrows_a_read_its_name_makes() {
    let writes = Mcp {
        annotated: true,
        ..Mcp::default()
    };
    let call = notion("list_pages", "", writes);
    assert_eq!(call.effect, None);
    assert!(matches!(route(call), Route::Review(_)));
}

#[test]
fn with_untrusted_content_in_view_an_apps_writes_stay_with_the_person() {
    for granted in [Granted::No, Granted::Tool] {
        for mode in [Mode::AutoReview, Mode::FullAccess] {
            let call = Call {
                tainted: true,
                granted,
                mode,
                ..notion("create_page", "", silent())
            };
            assert_eq!(
                route(call),
                Route::ask(UNDECLARED_TAINTED),
                "{granted:?} {mode:?}"
            );
        }
    }
}

#[test]
fn always_allow_for_an_apps_writes_runs_them_without_review() {
    let granted = Call {
        granted: Granted::Tool,
        ..notion("create_page", "", silent())
    };
    assert_eq!(route(granted), Route::Run);
}

#[test]
fn the_persons_no_for_an_app_tool_still_refuses_it() {
    let declined = Call {
        remembered: Some(false),
        ..notion("create_page", "", silent())
    };
    assert_eq!(route(declined), Route::Refuse(DECLINED_TOOL.to_owned()));
}

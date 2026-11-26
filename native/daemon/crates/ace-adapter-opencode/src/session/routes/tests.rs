// SPDX-License-Identifier: Apache-2.0
//! `routes.select`'s two caches and its recheck (`routes.ts:6`-`:31`).

use ace_json::json;
use indexmap::IndexMap;
use std::sync::Arc;

use super::Routes;
use crate::session::server::{Tenant, TenantError, TenantId};
use crate::session::testing::{Fake, is};
use crate::translate::boundaries::parse_native_event;

/// `select`, with the envelope check the server does first.
fn select(
    routes: &mut Routes,
    value: &ace_json::Value,
    watermark: u64,
    all: &IndexMap<TenantId, Arc<dyn Tenant>>,
) -> Result<Vec<Arc<dyn Tenant>>, TenantError> {
    let event = parse_native_event(value).expect("a valid envelope");
    routes.select(&event, value, watermark, all)
}

fn tenants(entries: &[(TenantId, Arc<Fake>)]) -> IndexMap<TenantId, Arc<dyn Tenant>> {
    entries
        .iter()
        .map(|(id, fake)| (*id, Arc::clone(fake) as Arc<dyn Tenant>))
        .collect()
}

fn names(selected: &[Arc<dyn Tenant>], known: &[(&'static str, Arc<Fake>)]) -> Vec<&'static str> {
    selected
        .iter()
        .map(|tenant| {
            known
                .iter()
                .find(|(_, fake)| is(fake, tenant))
                .expect("a tenant this table built")
                .0
        })
        .collect()
}

#[test]
fn a_sessions_owners_are_cached_and_still_rechecked() {
    let session = json!({
        "id": "e1",
        "type": "session.text.delta",
        "data": { "sessionID": "s" },
    });
    // a and b accept the session before watermark 5; c only from 5 on.
    let a = Arc::new(Fake::new(|_, watermark| Ok(watermark < 5)));
    let b = Arc::new(Fake::new(|_, watermark| Ok(watermark < 5)));
    let c = Arc::new(Fake::new(|_, watermark| Ok(watermark >= 5)));
    let known = [("a", a.clone()), ("b", b.clone()), ("c", c.clone())];
    let all = tenants(&[(0, a), (1, b), (2, c)]);
    let mut routes = Routes::new();

    assert_eq!(
        names(
            &select(&mut routes, &session, 1, &all).expect("select"),
            &known
        ),
        ["a", "b"]
    );
    // The cached owners are rechecked: a and b still pass at 2.
    assert_eq!(
        names(
            &select(&mut routes, &session, 2, &all).expect("select"),
            &known
        ),
        ["a", "b"]
    );
    // Every cached owner refuses, so the select runs over every tenant again.
    assert_eq!(
        names(
            &select(&mut routes, &session, 5, &all).expect("select"),
            &known
        ),
        ["c"]
    );
    assert_eq!(
        names(
            &select(&mut routes, &session, 6, &all).expect("select"),
            &known
        ),
        ["c"]
    );
}

#[test]
fn a_shell_created_event_caches_its_owner_for_later_shell_events() {
    let created = json!({
        "id": "e1",
        "type": "shell.created",
        "data": { "info": { "id": "sh1" } },
    });
    let output = json!({
        "id": "e2",
        "type": "shell.output",
        "data": { "id": "sh1" },
    });
    let a = Arc::new(Fake::new(|_, _| Ok(true)));
    // c accepts only the output event; it is never asked, because the cache
    // names a as the shell's owner.
    let c = Arc::new(Fake::new(|value, _| {
        Ok(value.get("type") == Some(&json!("shell.output")))
    }));
    let known = [("a", a.clone()), ("c", c.clone())];
    let all = tenants(&[(0, a), (1, c)]);
    let mut routes = Routes::new();

    assert_eq!(
        names(
            &select(&mut routes, &created, 1, &all).expect("select"),
            &known
        ),
        ["a"]
    );
    assert_eq!(
        names(
            &select(&mut routes, &output, 2, &all).expect("select"),
            &known
        ),
        ["a"]
    );
}

#[test]
fn a_tool_event_caches_the_shell_it_reports() {
    let tool = json!({
        "id": "e1",
        "type": "session.tool.progress",
        "data": { "metadata": { "shellID": "sh1" } },
    });
    let output = json!({
        "id": "e2",
        "type": "shell.output",
        "data": { "id": "sh1" },
    });
    let a = Arc::new(Fake::new(|_, _| Ok(true)));
    let c = Arc::new(Fake::new(|value, _| {
        Ok(value.get("type") == Some(&json!("shell.output")))
    }));
    let known = [("a", a.clone()), ("c", c.clone())];
    let all = tenants(&[(0, a), (1, c)]);
    let mut routes = Routes::new();

    // No session and no `shell.` type: the key is empty, so every tenant is
    // asked, and the tool's shell is then cached with its accepted owners.
    assert_eq!(
        names(
            &select(&mut routes, &tool, 1, &all).expect("select"),
            &known
        ),
        ["a"]
    );
    assert_eq!(
        names(
            &select(&mut routes, &output, 2, &all).expect("select"),
            &known
        ),
        ["a"]
    );
}

#[test]
fn a_stale_cache_entry_is_selected_over_every_tenant() {
    let session = json!({
        "id": "e1",
        "type": "session.text.delta",
        "data": { "sessionID": "s" },
    });
    let a = Arc::new(Fake::new(|_, watermark| Ok(watermark < 2)));
    let b = Arc::new(Fake::new(|_, watermark| Ok(watermark < 2)));
    let known = [("a", a.clone()), ("b", b.clone())];
    let all = tenants(&[(0, a.clone()), (1, b.clone())]);
    let mut routes = Routes::new();

    // A miss asks every tenant once and caches the answer.
    assert_eq!(
        names(
            &select(&mut routes, &session, 1, &all).expect("select"),
            &known
        ),
        ["a", "b"]
    );
    assert_eq!((a.accepts_calls(), b.accepts_calls()), (1, 1));
    // At 2 both refuse the cached entry, so the TypeScript deletes it and
    // selects over every tenant again: each is asked one more time.
    assert!(
        select(&mut routes, &session, 2, &all)
            .expect("select")
            .is_empty()
    );
    assert_eq!((a.accepts_calls(), b.accepts_calls()), (3, 3));
    // The entry is gone, so this is a miss: one ask each, not two.
    assert!(
        select(&mut routes, &session, 3, &all)
            .expect("select")
            .is_empty()
    );
    assert_eq!((a.accepts_calls(), b.accepts_calls()), (4, 4));
}

#[test]
fn clear_forgets_every_cached_answer() {
    let session = json!({
        "id": "e1",
        "type": "session.text.delta",
        "data": { "sessionID": "s" },
    });
    let a = Arc::new(Fake::new(|_, watermark| Ok(watermark < 2)));
    let known = [("a", a.clone())];
    let all = tenants(&[(0, a)]);
    let mut routes = Routes::new();
    assert_eq!(
        names(
            &select(&mut routes, &session, 1, &all).expect("select"),
            &known
        ),
        ["a"]
    );
    routes.clear();
    assert!(
        select(&mut routes, &session, 2, &all)
            .expect("select")
            .is_empty()
    );
}

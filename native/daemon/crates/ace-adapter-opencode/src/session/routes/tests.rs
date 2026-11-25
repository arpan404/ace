// SPDX-License-Identifier: Apache-2.0
//! `routes.select`'s two caches and its recheck (`routes.ts:6`-`:31`).

use ace_json::json;
use indexmap::IndexMap;
use std::sync::Arc;

use super::Routes;
use crate::session::server::{Tenant, TenantId};
use crate::session::testing::{Fake, is};

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
    let a = Arc::new(Fake::new(|_, watermark| watermark < 5));
    let b = Arc::new(Fake::new(|_, watermark| watermark < 5));
    let c = Arc::new(Fake::new(|_, watermark| watermark >= 5));
    let known = [("a", a.clone()), ("b", b.clone()), ("c", c.clone())];
    let all = tenants(&[(0, a), (1, b), (2, c)]);
    let mut routes = Routes::new();

    assert_eq!(names(&routes.select(&session, 1, &all), &known), ["a", "b"]);
    // The cached owners are rechecked: a and b still pass at 2.
    assert_eq!(names(&routes.select(&session, 2, &all), &known), ["a", "b"]);
    // Every cached owner refuses, so the select runs over every tenant again.
    assert_eq!(names(&routes.select(&session, 5, &all), &known), ["c"]);
    assert_eq!(names(&routes.select(&session, 6, &all), &known), ["c"]);
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
    let a = Arc::new(Fake::new(|_, _| true));
    // c accepts only the output event; it is never asked, because the cache
    // names a as the shell's owner.
    let c = Arc::new(Fake::new(|value, _| {
        value.get("type") == Some(&json!("shell.output"))
    }));
    let known = [("a", a.clone()), ("c", c.clone())];
    let all = tenants(&[(0, a), (1, c)]);
    let mut routes = Routes::new();

    assert_eq!(names(&routes.select(&created, 1, &all), &known), ["a"]);
    assert_eq!(names(&routes.select(&output, 2, &all), &known), ["a"]);
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
    let a = Arc::new(Fake::new(|_, _| true));
    let c = Arc::new(Fake::new(|value, _| {
        value.get("type") == Some(&json!("shell.output"))
    }));
    let known = [("a", a.clone()), ("c", c.clone())];
    let all = tenants(&[(0, a), (1, c)]);
    let mut routes = Routes::new();

    // No session and no `shell.` type: the key is empty, so every tenant is
    // asked, and the tool's shell is then cached with its accepted owners.
    assert_eq!(names(&routes.select(&tool, 1, &all), &known), ["a"]);
    assert_eq!(names(&routes.select(&output, 2, &all), &known), ["a"]);
}

#[test]
fn clear_forgets_every_cached_answer() {
    let session = json!({
        "id": "e1",
        "type": "session.text.delta",
        "data": { "sessionID": "s" },
    });
    let a = Arc::new(Fake::new(|_, watermark| watermark < 2));
    let known = [("a", a.clone())];
    let all = tenants(&[(0, a)]);
    let mut routes = Routes::new();
    assert_eq!(names(&routes.select(&session, 1, &all), &known), ["a"]);
    routes.clear();
    assert!(routes.select(&session, 2, &all).is_empty());
}

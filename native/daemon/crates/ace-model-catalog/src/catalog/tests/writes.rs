// SPDX-License-Identifier: Apache-2.0
//! Session writes: one queue per instance, its place taken at acceptance, and the row
//! and login re-checked after the wait.

use super::*;

fn acp_metadata(model: &str) -> Value {
    json!({
        "availableModels": [{ "modelId": model, "name": model }],
        "currentModelId": model,
        "configOptions": [{
            "id": "model",
            "name": "Model",
            "category": "model",
            "type": "select",
            "currentValue": model,
            "options": [{ "value": model, "name": model }]
        }]
    })
}

#[test]
fn a_queued_write_for_the_old_login_never_lands_on_the_new_one() {
    let codex = instance(ProviderKind::Codex, "account");
    let storage = SharedStorage::new(MemoryStorage::new());
    let discover = always(vec![row(&codex, "gpt-6-sol")]);
    let fixture = fixture(vec![codex.clone()], storage.clone(), discover);
    let catalog = fixture.catalog.clone();
    let _ = futures::executor::block_on(catalog.refresh(ModelFilter::default()));
    // Accepted, then a new login registers and loads its own row before the queued task runs.
    catalog.update_permission_modes(
        "account",
        vec![serde_json::json!({
            "id": "plan", "label": "Plan", "description": "", "risk": "low"
        })],
    );
    catalog
        .register_instance(
            ModelInstance {
                login_revision: "2".to_owned(),
                ..codex
            },
            None,
        )
        .unwrap_or_else(|error| panic!("{error}"));
    let _ = settle(
        catalog.refresh(ModelFilter::default()),
        &fixture.spawn,
        "the new login's refresh",
    )
    .unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(listed(&catalog).models.len(), 1, "the new login loaded");
    fixture.spawn.drain();
    let mut storage = storage.clone();
    let stored = storage.load().unwrap_or_default();
    assert!(
        stored.iter().all(|entry| entry
            .permission_modes
            .as_ref()
            .is_none_or(|modes| modes.is_empty())),
        "login A's modes never land on login B"
    );
}

#[test]
fn a_session_write_queued_across_a_login_change_never_lands_on_the_new_login() {
    let agent = instance(ProviderKind::Acp, "account");
    let storage = SharedStorage::new(MemoryStorage::new());
    let fixture = fixture(vec![agent.clone()], storage.clone(), always(Vec::new()));
    let catalog = fixture.catalog.clone();
    // A write already holding the queue, and the session's write queued behind it.
    let hold = futures::executor::block_on(catalog.hold_turn("account"));
    let metadata = acp_metadata("session-model");
    let mut queued = Box::pin(catalog.update_from_session(
        ModelInstance {
            login_revision: "1".to_owned(),
            ..agent.clone()
        },
        &metadata,
    ));
    assert!(
        poll_once(queued.as_mut()).is_pending(),
        "the write is queued"
    );
    // The person signs in to another login while the write waits.
    catalog
        .register_instance(
            ModelInstance {
                login_revision: "2".to_owned(),
                ..agent.clone()
            },
            None,
        )
        .unwrap_or_else(|error| panic!("{error}"));
    assert!(catalog.has_instance("account"));
    drop(hold);
    let written = futures::executor::block_on(queued);
    assert_eq!(
        written,
        Err(CatalogError::SessionGenerationChanged),
        "the queued write refuses a login it no longer belongs to"
    );
    let mut storage = storage.clone();
    let stored = storage.load().unwrap_or_default();
    assert!(
        stored
            .iter()
            .all(|entry| entry.login_revision.as_deref() != Some("1")),
        "login A's session write never lands on login B"
    );
}

#[test]
fn a_permission_write_accepted_first_keeps_its_place_in_the_queue() {
    let agent = instance(ProviderKind::Acp, "account");
    let storage = SharedStorage::new(MemoryStorage::new());
    let fixture = fixture(vec![agent.clone()], storage.clone(), always(Vec::new()));
    let catalog = fixture.catalog.clone();
    let metadata = acp_metadata("session-model");
    let _ = futures::executor::block_on(catalog.update_from_session(agent.clone(), &metadata));
    // Accepted but not started: its place in the queue is already taken.
    catalog.update_permission_modes(
        "account",
        vec![
            serde_json::json!({ "id": "plan", "label": "Plan", "description": "", "risk": "low" }),
        ],
    );
    // A session write accepted afterwards waits for it, then replaces its entry.
    let mut session = Box::pin(catalog.update_from_session(agent.clone(), &metadata));
    assert!(
        poll_once(session.as_mut()).is_pending(),
        "the later write waits for the earlier permission write"
    );
    fixture.spawn.drain();
    futures::executor::block_on(session).unwrap_or_else(|error| panic!("{error}"));
    let mut storage = storage.clone();
    let stored = storage.load().unwrap_or_default();
    assert!(
        stored.iter().all(|entry| entry
            .permission_modes
            .as_ref()
            .is_none_or(|modes| modes.is_empty())),
        "the later session write leaves its own modes, not the queued ones"
    );
}

#[test]
fn a_dropped_writer_never_lets_later_work_pass_the_one_before_it() {
    let codex = instance(ProviderKind::Codex, "account");
    let fixture = fixture(
        vec![codex],
        SharedStorage::new(MemoryStorage::new()),
        always(Vec::new()),
    );
    let catalog = fixture.catalog.clone();
    // A holds the queue; B and C take their places after it.
    let held = futures::executor::block_on(catalog.hold_turn("account"));
    let dropped = catalog.reserve_turn("account");
    let mut later = Box::pin(catalog.hold_turn("account"));
    assert!(
        poll_once(later.as_mut()).is_pending(),
        "C waits for the places before it"
    );
    // B's caller goes away before its body runs: C still waits for A's write to finish.
    drop(dropped);
    assert!(
        poll_once(later.as_mut()).is_pending(),
        "a dropped place releases nothing before the place before it finished"
    );
    drop(held);
    futures::executor::block_on(later);
}

#[test]
fn a_dropped_session_write_releases_its_capacity_slot() {
    let agent = instance(ProviderKind::Acp, "account");
    let fixture = fixture(
        vec![agent.clone()],
        SharedStorage::new(MemoryStorage::new()),
        always(Vec::new()),
    );
    let catalog = fixture.catalog.clone();
    let held = futures::executor::block_on(catalog.hold_turn("account"));
    let metadata = acp_metadata("session-model");
    // Every slot is taken by a write whose caller goes away before its turn comes.
    for index in 0..64 {
        let mut queued = Box::pin(catalog.update_from_session(agent.clone(), &metadata));
        assert!(
            poll_once(queued.as_mut()).is_pending(),
            "write {index} is queued"
        );
        drop(queued);
    }
    drop(held);
    // The slots are free again, so a later session write is accepted.
    futures::executor::block_on(catalog.update_from_session(agent.clone(), &metadata))
        .unwrap_or_else(|error| panic!("{error}"));
}

#[test]
fn a_session_reports_levels_for_the_model_it_runs_without_erasing_others() {
    // A provider-level ACP account (no agent id) keeps the options a session reports.
    let agent = instance(ProviderKind::Acp, "one");
    let setup = |model: &str| -> Value {
        let levels = if model == "fast" {
            vec!["low", "high"]
        } else {
            vec!["low", "high", "max"]
        };
        json!({
            "availableModels": [
                { "modelId": "fast", "name": "Fast" },
                { "modelId": "deep", "name": "Deep" }
            ],
            "currentModelId": model,
            "configOptions": [
                {
                    "id": "model",
                    "name": "Model",
                    "category": "model",
                    "type": "select",
                    "currentValue": model,
                    "options": [
                        { "value": "fast", "name": "Fast" },
                        { "value": "deep", "name": "Deep" }
                    ]
                },
                {
                    "id": "thinking",
                    "name": "Thinking",
                    "category": "thought_level",
                    "type": "select",
                    "currentValue": "low",
                    "options": levels.iter().map(|value| json!({ "value": value, "name": value })).collect::<Vec<_>>()
                }
            ]
        })
    };
    let fixture = fixture(
        vec![agent.clone()],
        SharedStorage::new(MemoryStorage::new()),
        always(Vec::new()),
    );
    let catalog = &fixture.catalog;
    futures::executor::block_on(async {
        catalog
            .update_from_session(agent.clone(), &setup("fast"))
            .await
            .unwrap_or_else(|error| panic!("{error}"));
        catalog
            .update_from_session(agent.clone(), &setup("deep"))
            .await
            .unwrap_or_else(|error| panic!("{error}"));
    });
    let listed = catalog
        .list(ModelFilter::instance("one"), 0, 100)
        .unwrap_or_else(|error| panic!("{error}"));
    let levels = |id: &str| -> Vec<String> {
        listed
            .models
            .iter()
            .find(|model| model.id.0 == id)
            .map(|model| {
                model
                    .efforts
                    .iter()
                    .map(|effort| effort.id.0.clone())
                    .collect()
            })
            .unwrap_or_default()
    };
    assert_eq!(levels("fast"), ["low", "high"]);
    assert_eq!(levels("deep"), ["low", "high", "max"]);
    // Neither session started discovery.
    assert_eq!(fixture.discover.calls(), 0);
}

#[test]
fn a_permission_write_dropped_before_it_runs_does_not_hold_close() {
    within(15, "a dropped permission write and close", || {
        let codex = instance(ProviderKind::Codex, "account");
        let storage = SharedStorage::new(MemoryStorage::new());
        let discover = always(vec![row(&codex, "gpt-6-sol")]);
        let fixture = fixture(vec![codex], storage, discover);
        let catalog = fixture.catalog.clone();
        let _ = settle(
            catalog.refresh(ModelFilter::default()),
            &fixture.spawn,
            "the login's refresh",
        )
        .unwrap_or_else(|error| panic!("{error}"));
        // Accepted, then its task is dropped before it first runs.
        catalog.update_permission_modes(
            "account",
            vec![serde_json::json!({
                "id": "plan",
                "label": "Plan",
                "description": "",
                "risk": "low"
            })],
        );
        assert_eq!(fixture.spawn.discard(), 1, "the write had not started");
        let closed = settle(
            catalog.close(),
            &fixture.spawn,
            "close after a dropped write",
        );
        closed.unwrap_or_else(|error| panic!("{error}"));
    })
}

#[test]
fn close_drains_a_write_accepted_before_it_started() {
    let codex = instance(ProviderKind::Codex, "account");
    let storage = SharedStorage::new(MemoryStorage::new());
    let discover = always(vec![row(&codex, "gpt-6-sol")]);
    let fixture = fixture(vec![codex], storage.clone(), discover);
    let catalog = fixture.catalog.clone();
    let _ = futures::executor::block_on(catalog.refresh(ModelFilter::default()));
    // Accepted, but its task has not run yet: close must wait for it.
    catalog.update_permission_modes(
        "account",
        vec![serde_json::json!({
            "id": "plan",
            "label": "Plan",
            "description": "",
            "risk": "low"
        })],
    );
    let mut close = Box::pin(catalog.close());
    let closed = loop {
        match poll_once(close.as_mut()) {
            std::task::Poll::Ready(result) => break result,
            std::task::Poll::Pending => {
                fixture.spawn.drain();
            }
        }
    };
    closed.unwrap_or_else(|error| panic!("{error}"));
    let mut storage = storage.clone();
    let stored = storage.load().unwrap_or_default();
    assert_eq!(
        stored[0]
            .permission_modes
            .as_ref()
            .and_then(|modes| modes.first())
            .and_then(|mode| mode.get("id"))
            .and_then(|id| id.as_str()),
        Some("plan")
    );
}

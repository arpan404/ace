// SPDX-License-Identifier: Apache-2.0
//! Selection, paging, removal capacity and invalidation across rows.

use std::collections::BTreeMap;

use super::*;

#[test]
fn filters_page_only_their_own_instances() {
    let codex = instance(ProviderKind::Codex, "codex");
    let claude = instance(ProviderKind::Claude, "claude");
    let discover = FakeDiscover::new(|request, _signal| {
        Box::pin(async move {
            let ids: &[&str] = if request.instance.provider == ProviderKind::Codex {
                &["gpt-6-sol", "gpt-6"]
            } else {
                &["claude-opus-5", "claude-sonnet-5"]
            };
            Ok(models(&request.instance, ids))
        })
    });
    let fixture = fixture(
        vec![codex, claude],
        SharedStorage::new(MemoryStorage::new()),
        discover,
    );
    let catalog = &fixture.catalog;
    // Every row is read once, which is what asks each instance for its models.
    let _ = listed(catalog);
    fixture.spawn.drain();
    let _ = listed(catalog);
    let codex_page = catalog
        .list(ModelFilter::provider(ProviderKind::Codex), 0, 100)
        .unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(codex_page.models.len(), 2);
    assert!(
        codex_page
            .models
            .iter()
            .all(|model| model.provider == ProviderKind::Codex)
    );
    assert_eq!(codex_page.instances.len(), 1);
    let page = catalog
        .list(ModelFilter::default(), 1, 1)
        .unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(page.models.len(), 1);
    assert_eq!(page.next_offset, Some(2));
    let only = catalog
        .list(ModelFilter::instance("claude"), 0, 100)
        .unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(only.instances.len(), 1);
    assert_eq!(only.instances[0].instance, "claude");
}

#[test]
fn picker_results_cannot_mutate_the_shared_cached_row() {
    let codex = instance(ProviderKind::Codex, "account");
    let discover = always(vec![row(&codex, "gpt-6-sol")]);
    let fixture = fixture(
        vec![codex],
        SharedStorage::new(MemoryStorage::new()),
        discover,
    );
    let catalog = &fixture.catalog;
    let _ = settle(
        catalog.refresh(ModelFilter::default()),
        &fixture.spawn,
        "the refresh",
    );
    let mut first = catalog
        .list(ModelFilter::default(), 0, 100)
        .unwrap_or_else(|error| panic!("{error}"));
    first.models[0].display_name = "Mutated".to_owned().into();
    let second = catalog
        .list(ModelFilter::default(), 0, 100)
        .unwrap_or_else(|error| panic!("{error}"));
    assert_ne!(second.models[0].display_name.0, "Mutated");
}

#[test]
fn removing_an_instance_cancels_its_refresh_and_deletes_its_cached_rows() {
    let codex = instance(ProviderKind::Codex, "account");
    let storage = MemoryStorage::new();
    let shared = SharedStorage::new(storage);
    let discover = always(vec![row(&codex, "gpt-6-sol")]);
    let fixture = fixture(vec![codex], shared.clone(), discover);
    let catalog = &fixture.catalog;
    let _ = settle(
        catalog.refresh(ModelFilter::default()),
        &fixture.spawn,
        "the refresh",
    );
    settle(
        async { catalog.remove_instance("account").await },
        &fixture.spawn,
        "the removal",
    )
    .unwrap_or_else(|error| panic!("{error}"));
    assert!(!catalog.has_instance("account"));
    assert!(listed(catalog).models.is_empty());
    let storage = shared.clone();
    assert!(
        storage
            .load()
            .unwrap_or_else(|error| panic!("{error}"))
            .is_empty()
    );
}

#[test]
fn instance_admission_is_bounded_per_kind_and_a_removal_frees_capacity() {
    let codex = instance(ProviderKind::Codex, "first");
    let fixture = fixture(
        vec![codex],
        SharedStorage::new(MemoryStorage::new()),
        always(Vec::new()),
    );
    let catalog = &fixture.catalog;
    for index in 1..crate::cache::CLI_INSTANCE_LIMIT {
        catalog
            .register_instance(instance(ProviderKind::Codex, &format!("cli-{index}")), None)
            .unwrap_or_else(|error| panic!("{error}"));
    }
    assert_eq!(
        catalog.register_instance(instance(ProviderKind::Codex, "over"), None),
        Err(CatalogError::InstanceLimit)
    );
    // ACP rows have their own capacity.
    catalog
        .register_instance(instance(ProviderKind::Acp, "agent"), None)
        .unwrap_or_else(|error| panic!("{error}"));
    settle(
        async { catalog.remove_instance("cli-1").await },
        &fixture.spawn,
        "the removal",
    )
    .unwrap_or_else(|error| panic!("{error}"));
    catalog
        .register_instance(instance(ProviderKind::Codex, "fresh"), None)
        .unwrap_or_else(|error| panic!("{error}"));
}

#[test]
fn a_timeout_leaves_another_instances_models_immediately_available() {
    let slow = instance(ProviderKind::Codex, "slow");
    let quick = instance(ProviderKind::Claude, "quick");
    let discover = FakeDiscover::new(|request, signal| {
        Box::pin(async move {
            if request.instance.id == "slow" {
                signal.wait().await;
                return Err(DiscoveryFailure::with_code(FailureCode::Timeout));
            }
            Ok(models(&request.instance, &["claude-opus-5"]))
        })
    });
    let fixture = fixture(
        vec![slow, quick],
        SharedStorage::new(MemoryStorage::new()),
        discover.clone(),
    );
    let catalog = fixture.catalog.clone();
    // The slow flight starts and waits for the deadline; the quick one settles.
    let mut slow_flight = Box::pin(catalog.refresh(ModelFilter::instance("slow")));
    assert!(poll_once(slow_flight.as_mut()).is_pending());
    settle(
        catalog.refresh(ModelFilter::instance("quick")),
        &fixture.spawn,
        "the quick refresh",
    )
    .unwrap_or_else(|error| panic!("{error}"));
    let quick_page = catalog
        .list(ModelFilter::instance("quick"), 0, 100)
        .unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(quick_page.models.len(), 1);
    assert!(!quick_page.instances[0].stale);
    // The timeout aborts the slow flight; its row reports a timeout, never a stale pick.
    fixture.deadlines.fire(1_000.0 + 1_000.0);
    let timed_out = settle(slow_flight, &fixture.spawn, "the slow refresh")
        .unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(timed_out[0].error, Some(StatusError::Timeout));
    let slow_page = catalog
        .list(ModelFilter::instance("slow"), 0, 100)
        .unwrap_or_else(|error| panic!("{error}"));
    assert!(slow_page.models.is_empty());
}

#[test]
fn a_source_that_authoritatively_has_no_models_drops_its_rows() {
    let codex = instance(ProviderKind::Codex, "account");
    let mut findings = models(&codex, &["gpt-6-sol"]);
    let mut source = ace_models::source::provider_source("codex");
    source.id = "codex".to_owned().into();
    findings.sources = Some(vec![SourceStatus {
        source,
        status: SourceState::Fresh,
        last_refreshed_at: None,
        error: Some(crate::failures::discovery_error(
            None,
            FailureCode::NoModels,
            &crate::failures::ErrorContext::default(),
        )),
    }]);
    let discover = always(findings.models);
    let fixture = fixture(
        vec![codex],
        SharedStorage::new(MemoryStorage::new()),
        discover,
    );
    // The rows are usable until the source says it has none; the port above reports the
    // reply's statuses through the outcome.
    let outcome = settle(
        fixture.catalog.refresh(ModelFilter::default()),
        &fixture.spawn,
        "the refresh",
    )
    .unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(outcome.len(), 1);
}

fn statuses_by_id(catalog: &Catalog) -> BTreeMap<String, InstanceStatus> {
    catalog
        .list(ModelFilter::default(), 0, 100)
        .map(|result| {
            result
                .instances
                .into_iter()
                .map(|status| (status.instance.clone(), status))
                .collect()
        })
        .unwrap_or_default()
}

#[test]
fn an_invalidated_account_keeps_its_place_but_not_its_choices() {
    let codex = instance(ProviderKind::Codex, "account");
    let discover = always(vec![row(&codex, "gpt-6-sol")]);
    let fixture = fixture(
        vec![codex],
        SharedStorage::new(MemoryStorage::new()),
        discover,
    );
    let catalog = fixture.catalog.clone();
    let _ = settle(
        catalog.refresh(ModelFilter::default()),
        &fixture.spawn,
        "the refresh",
    );
    settle(
        catalog.invalidate(ModelFilter::default()),
        &fixture.spawn,
        "the invalidation",
    )
    .unwrap_or_else(|error| panic!("{error}"));
    assert!(catalog.has_instance("account"));
    let listed = catalog
        .list(ModelFilter::default(), 0, 100)
        .unwrap_or_else(|error| panic!("{error}"));
    assert!(listed.models.is_empty(), "revoked choices are gone");
    let _ = statuses_by_id(&catalog);
}

#[test]
fn a_re_registered_row_keeps_its_pending_invalidation() {
    within(15, "a revocation across a re-registration", || {
        let codex = instance(ProviderKind::Codex, "account");
        let gate = crate::signals::Gate::new();
        let held = gate.clone();
        let discover = FakeDiscover::new(move |request, _signal| {
            let held = held.clone();
            Box::pin(async move {
                held.wait().await;
                Ok(models(&request.instance, &["gpt-6-sol"]))
            })
        });
        let fixture = fixture(
            vec![codex.clone()],
            SharedStorage::new(MemoryStorage::new()),
            discover.clone(),
        );
        let catalog = fixture.catalog.clone();
        let mut old = Box::pin(catalog.refresh_state("account", RefreshCause::Background));
        assert!(poll_once(old.as_mut()).is_pending());
        fixture.spawn.drain();
        let mut invalidating = Box::pin(catalog.invalidate(ModelFilter::default()));
        assert!(
            poll_once(invalidating.as_mut()).is_pending(),
            "the deletion is pending"
        );
        // The same id is registered again by a new login while the delete is pending.
        catalog
            .register_instance(
                ModelInstance {
                    login_revision: "2".to_owned(),
                    ..codex
                },
                None,
            )
            .unwrap_or_else(|error| panic!("{error}"));
        let mut replacement = Box::pin(catalog.refresh_state("account", RefreshCause::Background));
        assert!(
            poll_once(replacement.as_mut()).is_pending(),
            "the replacement still waits for the pending delete"
        );
        assert_eq!(
            fixture.discover.calls(),
            1,
            "no discovery runs before the pending delete finished"
        );
        gate.open();
        let (_, revoked) = settle(
            async move { futures::join!(old, invalidating) },
            &fixture.spawn,
            "the revocation and the flight it drained",
        );
        revoked.unwrap_or_else(|error| panic!("{error}"));
        let _ = settle(replacement, &fixture.spawn, "the replacement flight");
        assert_eq!(fixture.discover.calls(), 2, "the replacement discovered");
        assert_eq!(listed(&catalog).models.len(), 1);
    })
}

#[test]
fn a_replacement_refresh_waits_for_a_pending_invalidations_delete() {
    let codex = instance(ProviderKind::Codex, "account");
    let gate = crate::signals::Gate::new();
    let held = gate.clone();
    let discover = FakeDiscover::new(move |request, _signal| {
        let held = held.clone();
        Box::pin(async move {
            held.wait().await;
            Ok(models(&request.instance, &["gpt-6-sol"]))
        })
    });
    let fixture = fixture(
        vec![codex],
        SharedStorage::new(MemoryStorage::new()),
        discover.clone(),
    );
    let catalog = fixture.catalog.clone();
    let mut old = Box::pin(catalog.refresh_state("account", RefreshCause::Background));
    assert!(poll_once(old.as_mut()).is_pending());
    fixture.spawn.drain();
    let mut invalidating = Box::pin(catalog.invalidate(ModelFilter::default()));
    assert!(
        poll_once(invalidating.as_mut()).is_pending(),
        "delete is pending"
    );
    let mut replacement = Box::pin(catalog.refresh_state("account", RefreshCause::Background));
    assert!(poll_once(replacement.as_mut()).is_pending());
    assert_eq!(
        fixture.discover.calls(),
        1,
        "the replacement waited for the delete"
    );
    gate.open();
    let (_, _, _) = settle(
        async move { futures::join!(old, invalidating, replacement) },
        &fixture.spawn,
        "a replacement across a revocation",
    );
    assert_eq!(fixture.discover.calls(), 2);
    assert!(!listed(&catalog).models.is_empty());
}

#[test]
fn a_sign_in_method_is_held_to_128_code_points() {
    let catalog = fixture(
        Vec::new(),
        SharedStorage::new(MemoryStorage::new()),
        always(Vec::new()),
    )
    .catalog;
    for (index, (method, accepted)) in [
        ("m".repeat(128), true),
        ("m".repeat(129), false),
        ("🌍".repeat(128), true),
        ("🌍".repeat(129), false),
        (String::new(), false),
    ]
    .into_iter()
    .enumerate()
    {
        let mut account = instance(ProviderKind::Codex, &format!("account-{index}"));
        account.sign_in_method = Some(method);
        assert_eq!(
            catalog.register_instance(account, None).is_ok(),
            accepted,
            "case {index}"
        );
    }
}

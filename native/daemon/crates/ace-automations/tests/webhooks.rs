// SPDX-License-Identifier: Apache-2.0
#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]
//! Ports the cases of `packages/automations/src/webhooks.test.ts`: rotate/revoke, the order of
//! refusal checks, receipts, the rate limit, access, the outside-text note and secret hygiene.

use std::cell::Cell;

use ace_automations::scheduler::{Admission, Clock, CounterIds};
use ace_automations::service::{Ports, Service};
use ace_automations::webhook_secret_box::SecretBox;
use ace_automations::webhook_signature::sign_webhook;
use ace_automations::webhooks::{WebhookDeps, WebhookRequest, Webhooks};
use ace_automations::{AutomationStore, Definition, Trigger};

const START: i64 = 1_704_099_600_000;

struct TestClock(Cell<i64>);

impl Clock for TestClock {
    fn now_ms(&self) -> i64 {
        self.0.get()
    }
}

struct TestAdmission(Cell<bool>);

impl Admission for TestAdmission {
    fn open(&self) -> bool {
        self.0.get()
    }
}

struct Harness {
    dir: tempfile::TempDir,
    store: AutomationStore,
    clock: TestClock,
    admission: TestAdmission,
    ids: CounterIds,
}

impl Harness {
    fn new() -> Harness {
        let dir = tempfile::tempdir().expect("temp");
        let store = AutomationStore::open(dir.path().join("auto.sqlite").to_str().expect("utf8"))
            .expect("store");
        Harness {
            dir,
            store,
            clock: TestClock(Cell::new(START)),
            admission: TestAdmission(Cell::new(true)),
            ids: CounterIds::new("run"),
        }
    }

    fn path(&self) -> std::path::PathBuf {
        self.dir.path().join("auto.sqlite")
    }

    fn service(&self) -> Service<'_> {
        Service::new(
            &self.store,
            Ports {
                clock: &self.clock,
                random: &ZeroRandom,
                admission: &self.admission,
                timer: &ace_automations::service::NoopTimer,
                ids: &self.ids,
                workspace: None,
                model_loading: None,
            },
        )
    }

    fn started(&self) -> Service<'_> {
        let mut service = self.service();
        service.start().expect("start");
        service
    }
}

struct ZeroRandom;

impl ace_automations::scheduler::Random for ZeroRandom {
    fn draw(&self) -> f64 {
        0.0
    }
}

struct CountingRandom(Cell<u8>);

impl CountingRandom {
    fn bytes(&self, size: usize) -> Vec<u8> {
        (0..size)
            .map(|_| {
                self.0.set(self.0.get().wrapping_add(1));
                self.0.get()
            })
            .collect()
    }
}

fn definition() -> Definition {
    Definition {
        id: "deploy".to_owned(),
        title: "Deploy".to_owned(),
        enabled: true,
        workspace: "/project".to_owned(),
        provider: "codex".to_owned(),
        access: None,
        model: None,
        effort: None,
        instance: None,
        prompt: "Check the {{body.env}} deploy of {{body.commit}}".to_owned(),
        worktree: false,
        trigger: Trigger::Webhook,
        missed_run: "skip".to_owned(),
        concurrency: 1,
        jitter_ms: 0,
        extra: Default::default(),
    }
}

fn body() -> Vec<u8> {
    br#"{"env":"prod","commit":"abc123"}"#.to_vec()
}

fn request<'a>(
    method: &'a str,
    content_type: Option<&'a str>,
    id: Option<&'a str>,
    timestamp: Option<&'a str>,
    signature: Option<&'a str>,
    body: &'a [u8],
) -> WebhookRequest<'a> {
    WebhookRequest {
        method,
        content_type,
        id,
        timestamp,
        signature,
        body,
    }
}

fn prompt_of(service: &mut Service<'_>) -> String {
    match service.take_actions().first() {
        Some(ace_automations::service::Action::Execute { input, .. }) => {
            input["prompt"].as_str().unwrap_or("").to_owned()
        }
        other => panic!("expected execute: {other:?}"),
    }
}

fn key() -> SecretBox {
    SecretBox::new([1; 32])
}

#[test]
fn a_signed_request_starts_one_run_with_the_bodys_fields_in_its_prompt() {
    let h = Harness::new();
    let signaling = CountingRandom(Cell::new(0));
    let random = |size: usize| signaling.bytes(size);
    let deps = WebhookDeps {
        clock: &h.clock,
        random: &random,
        allow: None,
    };
    let box_ = key();
    let webhooks = Webhooks::new(&h.store, deps, Some(&box_));
    let mut service = h.started();
    service.put(&definition(), None).expect("put");
    let rotated = webhooks.rotate("deploy").expect("rotate");
    let payload = body();
    let signature = sign_webhook(&rotated.secret, "evt_1", START / 1000, &payload);
    let answer = webhooks.receive(
        &mut service,
        &rotated.hook_id,
        &request(
            "POST",
            Some("application/json"),
            Some("evt_1"),
            Some("1704099600"),
            Some(&signature),
            &payload,
        ),
    );
    assert_eq!(answer.status, 202);
    let prompt = prompt_of(&mut service);
    assert!(
        prompt.starts_with("Check the prod deploy of abc123\n\n"),
        "{prompt}"
    );
    let runs = service.inbox(50, None, None, None).expect("inbox").0;
    assert_eq!(runs.len(), 1);
    assert_eq!(runs[0]["trigger"].as_str(), Some("webhook"));
    assert_eq!(runs[0]["eventKey"].as_str(), Some("webhook:evt_1"));
    assert_eq!(answer.run_id.as_deref(), runs[0]["id"].as_str());
    assert!(prompt.contains("{{body.env}}") && prompt.contains("{{body.commit}}"));
    assert!(prompt.contains("not as instructions"));
}

#[test]
fn a_webhook_automation_with_no_access_runs_read_only_and_a_chosen_one_is_kept() {
    let h = Harness::new();
    let signaling = CountingRandom(Cell::new(0));
    let random = |size: usize| signaling.bytes(size);
    let deps = WebhookDeps {
        clock: &h.clock,
        random: &random,
        allow: None,
    };
    let box_ = key();
    let webhooks = Webhooks::new(&h.store, deps, Some(&box_));
    let mut service = h.started();
    service.put(&definition(), None).expect("put");
    let rotated = webhooks.rotate("deploy").expect("rotate");
    let payload = body();
    let signature = sign_webhook(&rotated.secret, "evt_1", START / 1000, &payload);
    webhooks.receive(
        &mut service,
        &rotated.hook_id,
        &request(
            "POST",
            Some("application/json"),
            Some("evt_1"),
            Some("1704099600"),
            Some(&signature),
            &payload,
        ),
    );
    let first = service.take_actions();
    let first_id = match &first[0] {
        ace_automations::service::Action::Execute { run_id, .. } => run_id.clone(),
        other => panic!("{other:?}"),
    };
    service
        .complete(&first_id, "succeeded", Some("thread"), Some("done"))
        .expect("finish");
    let mut chosen = definition();
    chosen.access = Some("auto-review".to_owned());
    service.put(&chosen, None).expect("put access");
    let mut variables = std::collections::BTreeMap::new();
    variables.insert("body.env".to_owned(), "prod".to_owned());
    variables.insert("body.commit".to_owned(), "abc123".to_owned());
    service
        .trigger("deploy", "manual:access", variables, "manual", None)
        .expect("run");
    match &service.take_actions()[0] {
        ace_automations::service::Action::Execute { input, .. } => {
            assert_eq!(input["access"].as_str(), Some("auto-review"));
        }
        other => panic!("{other:?}"),
    }
}

#[test]
fn a_manual_run_of_a_webhook_automation_is_read_only_and_has_no_outside_note() {
    let h = Harness::new();
    let mut service = h.started();
    service.put(&definition(), None).expect("put");
    let mut variables = std::collections::BTreeMap::new();
    variables.insert("body.env".to_owned(), "x".to_owned());
    variables.insert("body.commit".to_owned(), "y".to_owned());
    service
        .trigger("deploy", "manual:1", variables, "manual", None)
        .expect("run");
    let input = match &service.take_actions()[0] {
        ace_automations::service::Action::Execute { input, .. } => input.clone(),
        other => panic!("{other:?}"),
    };
    assert_eq!(input["access"].as_str(), Some("read-only"));
    assert_eq!(input["prompt"].as_str(), Some("Check the x deploy of y"));
}

#[test]
fn a_retried_delivery_returns_its_run_instead_of_starting_another_also_after_restart() {
    let h = Harness::new();
    let signaling = CountingRandom(Cell::new(0));
    let random = |size: usize| signaling.bytes(size);
    let box_ = key();
    let (hook_id, secret, first) = {
        let deps = WebhookDeps {
            clock: &h.clock,
            random: &random,
            allow: None,
        };
        let webhooks = Webhooks::new(&h.store, deps, Some(&box_));
        let mut service = h.started();
        service.put(&definition(), None).expect("put");
        let rotated = webhooks.rotate("deploy").expect("rotate");
        let payload = body();
        let signature = sign_webhook(&rotated.secret, "evt_1", START / 1000, &payload);
        let first = webhooks
            .receive(
                &mut service,
                &rotated.hook_id,
                &request(
                    "POST",
                    Some("application/json"),
                    Some("evt_1"),
                    Some("1704099600"),
                    Some(&signature),
                    &payload,
                ),
            )
            .run_id
            .expect("run");
        let retry = webhooks
            .receive(
                &mut service,
                &rotated.hook_id,
                &request(
                    "POST",
                    Some("application/json"),
                    Some("evt_1"),
                    Some("1704099600"),
                    Some(&signature),
                    &payload,
                ),
            )
            .run_id;
        assert_eq!(retry.as_deref(), Some(first.as_str()));
        (rotated.hook_id, rotated.secret, first)
    };
    let store = AutomationStore::open(h.path().to_str().expect("utf8")).expect("reopen");
    let ids = CounterIds::new("run");
    let mut service = Service::new(
        &store,
        Ports {
            clock: &h.clock,
            random: &ZeroRandom,
            admission: &h.admission,
            timer: &ace_automations::service::NoopTimer,
            ids: &ids,
            workspace: None,
            model_loading: None,
        },
    );
    service.start().expect("restart");
    let deps = WebhookDeps {
        clock: &h.clock,
        random: &random,
        allow: None,
    };
    let webhooks = Webhooks::new(&store, deps, Some(&box_));
    let payload = body();
    let signature = sign_webhook(&secret, "evt_1", START / 1000, &payload);
    let answer = webhooks.receive(
        &mut service,
        &hook_id,
        &request(
            "POST",
            Some("application/json"),
            Some("evt_1"),
            Some("1704099600"),
            Some(&signature),
            &payload,
        ),
    );
    assert_eq!(answer.run_id.as_deref(), Some(first.as_str()));
    assert_eq!(
        service.inbox(50, None, None, None).expect("inbox").0.len(),
        1
    );
}

#[test]
fn a_known_delivery_to_an_automation_turned_off_since_is_refused_not_answered_with_its_run() {
    let h = Harness::new();
    let signaling = CountingRandom(Cell::new(0));
    let random = |size: usize| signaling.bytes(size);
    let deps = WebhookDeps {
        clock: &h.clock,
        random: &random,
        allow: None,
    };
    let box_ = key();
    let webhooks = Webhooks::new(&h.store, deps, Some(&box_));
    let mut service = h.started();
    service.put(&definition(), None).expect("put");
    let rotated = webhooks.rotate("deploy").expect("rotate");
    let payload = body();
    let signature = sign_webhook(&rotated.secret, "evt_1", START / 1000, &payload);
    assert_eq!(
        webhooks
            .receive(
                &mut service,
                &rotated.hook_id,
                &request(
                    "POST",
                    Some("application/json"),
                    Some("evt_1"),
                    Some("1704099600"),
                    Some(&signature),
                    &payload,
                ),
            )
            .status,
        202
    );
    service.set_enabled("deploy", false, None).expect("disable");
    assert_eq!(
        webhooks
            .receive(
                &mut service,
                &rotated.hook_id,
                &request(
                    "POST",
                    Some("application/json"),
                    Some("evt_1"),
                    Some("1704099600"),
                    Some(&signature),
                    &payload,
                ),
            )
            .status,
        409
    );
}

#[test]
fn over_its_limit_a_webhook_refuses_new_deliveries_but_still_answers_known_ones() {
    let h = Harness::new();
    let signaling = CountingRandom(Cell::new(0));
    let random = |size: usize| signaling.bytes(size);
    let room: Cell<u32> = Cell::new(1);
    let allow = |_id: &str| {
        let left = room.get();
        room.set(left.saturating_sub(1));
        left > 0
    };
    let deps = WebhookDeps {
        clock: &h.clock,
        random: &random,
        allow: Some(&allow),
    };
    let box_ = key();
    let webhooks = Webhooks::new(&h.store, deps, Some(&box_));
    let mut service = h.started();
    service.put(&definition(), None).expect("put");
    let rotated = webhooks.rotate("deploy").expect("rotate");
    let payload = body();
    let first = webhooks.receive(
        &mut service,
        &rotated.hook_id,
        &request(
            "POST",
            Some("application/json"),
            Some("evt_1"),
            Some("1704099600"),
            Some(&sign_webhook(
                &rotated.secret,
                "evt_1",
                START / 1000,
                &payload,
            )),
            &payload,
        ),
    );
    assert_eq!(first.status, 202);
    let limited = webhooks.receive(
        &mut service,
        &rotated.hook_id,
        &request(
            "POST",
            Some("application/json"),
            Some("evt_2"),
            Some("1704099600"),
            Some(&sign_webhook(
                &rotated.secret,
                "evt_2",
                START / 1000,
                &payload,
            )),
            &payload,
        ),
    );
    assert_eq!(limited.status, 429);
    assert_eq!(limited.error, Some("rate_limited"));
    assert_eq!(
        webhooks
            .receive(
                &mut service,
                &rotated.hook_id,
                &request(
                    "POST",
                    Some("application/json"),
                    Some("evt_1"),
                    Some("1704099600"),
                    Some(&sign_webhook(
                        &rotated.secret,
                        "evt_1",
                        START / 1000,
                        &payload
                    )),
                    &payload,
                ),
            )
            .run_id,
        first.run_id
    );
    assert_eq!(
        service.inbox(50, None, None, None).expect("inbox").0.len(),
        1
    );
}

#[test]
fn refuses_each_kind_of_bad_request_with_its_own_status_and_starts_no_run() {
    let h = Harness::new();
    let signaling = CountingRandom(Cell::new(0));
    let random = |size: usize| signaling.bytes(size);
    let deps = WebhookDeps {
        clock: &h.clock,
        random: &random,
        allow: None,
    };
    let box_ = key();
    let webhooks = Webhooks::new(&h.store, deps, Some(&box_));
    let mut service = h.started();
    service.put(&definition(), None).expect("put");
    let rotated = webhooks.rotate("deploy").expect("rotate");
    let other = webhooks.rotate("deploy").expect("rotate").secret;
    let payload = body();
    let good = sign_webhook(&other, "evt_1", START / 1000, &payload);
    let wrong = sign_webhook(&rotated.secret, "evt_1", START / 1000, &payload);
    let bad_body = b"[1]".to_vec();
    let bad_body_signature = sign_webhook(&other, "evt_1", START / 1000, &bad_body);
    let cases: [(WebhookRequest<'_>, u16, &str); 7] = [
        (
            request(
                "GET",
                Some("application/json"),
                Some("evt_1"),
                Some("1704099600"),
                Some(&good),
                &payload,
            ),
            405,
            "method_not_allowed",
        ),
        (
            request(
                "POST",
                Some("application/json"),
                Some("evt_1"),
                Some("1704099600"),
                Some(&wrong),
                &payload,
            ),
            401,
            "bad_signature",
        ),
        (
            request(
                "POST",
                Some("application/json"),
                Some("evt_1"),
                Some("1704099299"),
                Some(&good),
                &payload,
            ),
            400,
            "stale_timestamp",
        ),
        (
            request(
                "POST",
                Some("application/json"),
                Some("evt_1"),
                Some("1704099600"),
                None,
                &payload,
            ),
            400,
            "bad_headers",
        ),
        (
            request(
                "POST",
                Some("text/plain"),
                Some("evt_1"),
                Some("1704099600"),
                Some(&good),
                &payload,
            ),
            415,
            "unsupported_media_type",
        ),
        (
            request(
                "POST",
                Some("application/json"),
                Some("evt_1"),
                Some("1704099600"),
                Some(&good),
                &[b'['; 70_000],
            ),
            413,
            "too_large",
        ),
        (
            request(
                "POST",
                Some("application/json"),
                Some("evt_1"),
                Some("1704099600"),
                Some(&bad_body_signature),
                &bad_body,
            ),
            422,
            "bad_body",
        ),
    ];
    for (request, status, error) in cases {
        let answer = webhooks.receive(&mut service, &rotated.hook_id, &request);
        assert_eq!((answer.status, answer.error), (status, Some(error)));
    }
    assert_eq!(
        webhooks
            .receive(
                &mut service,
                &"0".repeat(32),
                &request(
                    "POST",
                    Some("application/json"),
                    Some("evt_1"),
                    Some("1704099600"),
                    Some(&good),
                    &payload
                )
            )
            .status,
        404
    );
    assert_eq!(
        webhooks
            .receive(
                &mut service,
                "not-a-hook",
                &request(
                    "POST",
                    Some("application/json"),
                    Some("evt_1"),
                    Some("1704099600"),
                    Some(&good),
                    &payload
                )
            )
            .status,
        404
    );
    assert!(
        service
            .inbox(50, None, None, None)
            .expect("inbox")
            .0
            .is_empty()
    );
}

#[test]
fn rotating_keeps_the_url_and_makes_the_old_secret_fail() {
    let h = Harness::new();
    let signaling = CountingRandom(Cell::new(0));
    let random = |size: usize| signaling.bytes(size);
    let deps = WebhookDeps {
        clock: &h.clock,
        random: &random,
        allow: None,
    };
    let box_ = key();
    let webhooks = Webhooks::new(&h.store, deps, Some(&box_));
    let mut service = h.started();
    service.put(&definition(), None).expect("put");
    let first = webhooks.rotate("deploy").expect("first");
    let second = webhooks.rotate("deploy").expect("second");
    assert_eq!(second.hook_id, first.hook_id);
    assert_ne!(second.secret, first.secret);
    let payload = body();
    assert_eq!(
        webhooks
            .receive(
                &mut service,
                &first.hook_id,
                &request(
                    "POST",
                    Some("application/json"),
                    Some("evt_1"),
                    Some("1704099600"),
                    Some(&sign_webhook(
                        &first.secret,
                        "evt_1",
                        START / 1000,
                        &payload
                    )),
                    &payload
                )
            )
            .status,
        401
    );
    assert_eq!(
        webhooks
            .receive(
                &mut service,
                &first.hook_id,
                &request(
                    "POST",
                    Some("application/json"),
                    Some("evt_2"),
                    Some("1704099600"),
                    Some(&sign_webhook(
                        &second.secret,
                        "evt_2",
                        START / 1000,
                        &payload
                    )),
                    &payload
                )
            )
            .status,
        202
    );
}

#[test]
fn revoking_changing_the_trigger_or_deleting_retires_the_url() {
    for retire in ["revoke", "retrigger", "remove"] {
        let h = Harness::new();
        let signaling = CountingRandom(Cell::new(0));
        let random = |size: usize| signaling.bytes(size);
        let deps = WebhookDeps {
            clock: &h.clock,
            random: &random,
            allow: None,
        };
        let box_ = key();
        let webhooks = Webhooks::new(&h.store, deps, Some(&box_));
        let mut service = h.started();
        service.put(&definition(), None).expect("put");
        let rotated = webhooks.rotate("deploy").expect("rotate");
        match retire {
            "revoke" => {
                webhooks.revoke("deploy").expect("revoke");
            }
            "retrigger" => {
                let mut manual = definition();
                manual.trigger = Trigger::Manual;
                service.put(&manual, None).expect("retrigger");
            }
            _ => {
                service.remove("deploy", None).expect("remove");
            }
        }
        let payload = body();
        assert_eq!(
            webhooks
                .receive(
                    &mut service,
                    &rotated.hook_id,
                    &request(
                        "POST",
                        Some("application/json"),
                        Some("evt_1"),
                        Some("1704099600"),
                        Some(&sign_webhook(
                            &rotated.secret,
                            "evt_1",
                            START / 1000,
                            &payload
                        )),
                        &payload
                    )
                )
                .status,
            404,
            "{retire}"
        );
        assert_eq!(webhooks.hook_of("deploy").expect("hook"), None, "{retire}");
    }
}

#[test]
fn only_a_webhook_automation_can_have_a_secret() {
    let h = Harness::new();
    let signaling = CountingRandom(Cell::new(0));
    let random = |size: usize| signaling.bytes(size);
    let deps = WebhookDeps {
        clock: &h.clock,
        random: &random,
        allow: None,
    };
    let box_ = key();
    let webhooks = Webhooks::new(&h.store, deps, Some(&box_));
    let mut service = h.started();
    let mut manual = definition();
    manual.id = "manual".to_owned();
    manual.trigger = Trigger::Manual;
    service.put(&manual, None).expect("put");
    assert!(webhooks.rotate("manual").is_err());
    assert!(webhooks.rotate("missing").is_err());
}

#[test]
fn the_secret_never_appears_in_lists_run_history_or_inputs() {
    let h = Harness::new();
    let signaling = CountingRandom(Cell::new(0));
    let random = |size: usize| signaling.bytes(size);
    let deps = WebhookDeps {
        clock: &h.clock,
        random: &random,
        allow: None,
    };
    let box_ = key();
    let webhooks = Webhooks::new(&h.store, deps, Some(&box_));
    let mut service = h.started();
    service.put(&definition(), None).expect("put");
    let rotated = webhooks.rotate("deploy").expect("rotate");
    let payload = body();
    webhooks.receive(
        &mut service,
        &rotated.hook_id,
        &request(
            "POST",
            Some("application/json"),
            Some("evt_1"),
            Some("1704099600"),
            Some(&sign_webhook(
                &rotated.secret,
                "evt_1",
                START / 1000,
                &payload,
            )),
            &payload,
        ),
    );
    let actions = service.take_actions();
    let inputs = match actions.first() {
        Some(ace_automations::service::Action::Execute { input, .. }) => input.clone(),
        other => panic!("{other:?}"),
    };
    let listed = service
        .handle(&ace_json::parse(r#"{"type":"automation.list","requestId":"l"}"#).expect("json"));
    let inbox = service.handle(
        &ace_json::parse(r#"{"type":"automation.inbox","requestId":"i","limit":10}"#)
            .expect("json"),
    );
    let secret = rotated.secret.trim_start_matches("whsec_");
    for text in [
        ace_json::to_string(&listed),
        ace_json::to_string(&inbox),
        ace_json::to_string(&inputs),
    ] {
        assert!(!text.contains(secret), "secret leaked");
    }
}

#[test]
fn a_delivery_stays_deduplicated_after_its_run_leaves_the_kept_history() {
    let h = Harness::new();
    let signaling = CountingRandom(Cell::new(0));
    let random = |size: usize| signaling.bytes(size);
    let deps = WebhookDeps {
        clock: &h.clock,
        random: &random,
        allow: None,
    };
    let box_ = key();
    let webhooks = Webhooks::new(&h.store, deps, Some(&box_));
    let mut service = h.started();
    service.put(&definition(), None).expect("put");
    let rotated = webhooks.rotate("deploy").expect("rotate");
    let payload = body();
    let first = webhooks.receive(
        &mut service,
        &rotated.hook_id,
        &request(
            "POST",
            Some("application/json"),
            Some("evt_1"),
            Some("1704099600"),
            Some(&sign_webhook(
                &rotated.secret,
                "evt_1",
                START / 1000,
                &payload,
            )),
            &payload,
        ),
    );
    // Push the run out of the 1,000 kept rows; the receipt table still remembers the delivery.
    for index in 2..=1002 {
        let id = format!("evt_{index}");
        webhooks.receive(
            &mut service,
            &rotated.hook_id,
            &request(
                "POST",
                Some("application/json"),
                Some(&id),
                Some("1704099600"),
                Some(&sign_webhook(&rotated.secret, &id, START / 1000, &payload)),
                &payload,
            ),
        );
    }
    let retry = webhooks.receive(
        &mut service,
        &rotated.hook_id,
        &request(
            "POST",
            Some("application/json"),
            Some("evt_1"),
            Some("1704099600"),
            Some(&sign_webhook(
                &rotated.secret,
                "evt_1",
                START / 1000,
                &payload,
            )),
            &payload,
        ),
    );
    assert_eq!(retry.run_id, first.run_id);
}

#[test]
fn with_another_key_the_secret_cannot_be_read_so_deliveries_are_refused() {
    let h = Harness::new();
    let signaling = CountingRandom(Cell::new(0));
    let random = |size: usize| signaling.bytes(size);
    let deps = WebhookDeps {
        clock: &h.clock,
        random: &random,
        allow: None,
    };
    let box_ = key();
    let webhooks = Webhooks::new(&h.store, deps, Some(&box_));
    let mut service = h.started();
    service.put(&definition(), None).expect("put");
    let rotated = webhooks.rotate("deploy").expect("rotate");
    let payload = body();
    let other = SecretBox::new([2; 32]);
    let deps = WebhookDeps {
        clock: &h.clock,
        random: &random,
        allow: None,
    };
    let foreign = Webhooks::new(&h.store, deps, Some(&other));
    let answer = foreign.receive(
        &mut service,
        &rotated.hook_id,
        &request(
            "POST",
            Some("application/json"),
            Some("evt_1"),
            Some("1704099600"),
            Some(&sign_webhook(
                &rotated.secret,
                "evt_1",
                START / 1000,
                &payload,
            )),
            &payload,
        ),
    );
    assert_eq!((answer.status, answer.error), (503, Some("unavailable")));
    assert!(
        service
            .inbox(50, None, None, None)
            .expect("inbox")
            .0
            .is_empty()
    );
}

#[test]
fn a_store_without_a_key_cannot_make_a_secret() {
    let h = Harness::new();
    let signaling = CountingRandom(Cell::new(0));
    let random = |size: usize| signaling.bytes(size);
    let deps = WebhookDeps {
        clock: &h.clock,
        random: &random,
        allow: None,
    };
    let webhooks = Webhooks::new(&h.store, deps, None);
    let mut service = h.started();
    service.put(&definition(), None).expect("put");
    assert!(webhooks.rotate("deploy").is_err());
}

#[test]
fn a_webhook_automation_turned_off_refuses_its_webhook() {
    let h = Harness::new();
    let signaling = CountingRandom(Cell::new(0));
    let random = |size: usize| signaling.bytes(size);
    let deps = WebhookDeps {
        clock: &h.clock,
        random: &random,
        allow: None,
    };
    let box_ = key();
    let webhooks = Webhooks::new(&h.store, deps, Some(&box_));
    let mut service = h.started();
    service.put(&definition(), None).expect("put");
    let rotated = webhooks.rotate("deploy").expect("rotate");
    service.set_enabled("deploy", false, None).expect("disable");
    let payload = body();
    assert_eq!(
        webhooks
            .receive(
                &mut service,
                &rotated.hook_id,
                &request(
                    "POST",
                    Some("application/json"),
                    Some("evt_1"),
                    Some("1704099600"),
                    Some(&sign_webhook(
                        &rotated.secret,
                        "evt_1",
                        START / 1000,
                        &payload
                    )),
                    &payload
                )
            )
            .status,
        409
    );
    assert!(
        service
            .inbox(50, None, None, None)
            .expect("inbox")
            .0
            .is_empty()
    );
}

#[test]
fn a_run_admitted_for_a_delivery_holds_its_receipt_from_the_same_commit() {
    let h = Harness::new();
    let mut service = h.started();
    service.put(&definition(), None).expect("put");
    let mut variables = std::collections::BTreeMap::new();
    variables.insert("webhook.id".to_owned(), "evt_1".to_owned());
    variables.insert("body.env".to_owned(), "prod".to_owned());
    variables.insert("body.commit".to_owned(), "c".to_owned());
    let run = service
        .trigger("deploy", "webhook:evt_1", variables, "webhook", None)
        .expect("run");
    h.clock.0.set(START + 1000);
    let run_id = run["id"].as_str().expect("id").to_owned();
    assert_eq!(
        h.store
            .webhook_delivered("deploy", "webhook:evt_1")
            .expect("receipt"),
        Some(run_id)
    );
}

#[test]
fn rotate_refuses_randomness_outside_the_contract_instead_of_zero_padding() {
    let h = Harness::new();
    let short = |size: usize| vec![1u8; size.saturating_sub(1)];
    let deps = WebhookDeps {
        clock: &h.clock,
        random: &short,
        allow: None,
    };
    let box_ = key();
    let webhooks = Webhooks::new(&h.store, deps, Some(&box_));
    let mut service = h.started();
    service.put(&definition(), None).expect("put");
    let error = webhooks.rotate("deploy").expect_err("short random");
    assert!(
        error.to_string().contains("must return 32 bytes"),
        "{error}"
    );
}

#[test]
fn a_delivery_whose_receipt_write_fails_commits_no_run_and_the_retry_runs_once() {
    let h = Harness::new();
    let signaling = CountingRandom(Cell::new(0));
    let random = |size: usize| signaling.bytes(size);
    let deps = WebhookDeps {
        clock: &h.clock,
        random: &random,
        allow: None,
    };
    let box_ = key();
    let webhooks = Webhooks::new(&h.store, deps, Some(&box_));
    let mut service = h.started();
    service.put(&definition(), None).expect("put");
    let rotated = webhooks.rotate("deploy").expect("rotate");
    let payload = body();
    let signature = sign_webhook(&rotated.secret, "evt_1", START / 1000, &payload);
    let request = request(
        "POST",
        Some("application/json"),
        Some("evt_1"),
        Some("1704099600"),
        Some(&signature),
        &payload,
    );

    // The receipt table is momentarily unavailable: admission and the receipt commit together.
    let raw = ace_store::Connection::open(
        h.path().to_str().expect("utf8"),
        ace_store::OpenOptions {
            read_only: false,
            timeout_ms: 5000,
        },
    )
    .expect("raw");
    raw.exec("DROP TABLE automation_webhook_deliveries")
        .expect("drop");
    raw.close().expect("close");
    assert_eq!(
        webhooks
            .receive(&mut service, &rotated.hook_id, &request)
            .status,
        503
    );
    assert!(
        service
            .inbox(50, None, None, None)
            .expect("inbox")
            .0
            .is_empty(),
        "the failed delivery left no run"
    );
    assert!(service.take_actions().is_empty());

    let raw = ace_store::Connection::open(
        h.path().to_str().expect("utf8"),
        ace_store::OpenOptions {
            read_only: false,
            timeout_ms: 5000,
        },
    )
    .expect("raw");
    raw.exec(
        "CREATE TABLE automation_webhook_deliveries(automation_id TEXT NOT NULL, delivery_id TEXT NOT NULL, run_id TEXT NOT NULL, expires INTEGER NOT NULL, PRIMARY KEY(automation_id, delivery_id))",
    )
    .expect("recreate");
    raw.close().expect("close");

    let answer = webhooks.receive(&mut service, &rotated.hook_id, &request);
    assert_eq!(answer.status, 202);
    let run_id = answer.run_id.expect("run");
    assert_eq!(
        h.store
            .webhook_delivered("deploy", "webhook:evt_1")
            .expect("receipt"),
        Some(run_id)
    );
    assert_eq!(service.take_actions().len(), 1, "one execution");
    assert_eq!(
        service.inbox(50, None, None, None).expect("inbox").0.len(),
        1,
        "one run"
    );
}

// SPDX-License-Identifier: Apache-2.0
//! The meters' moved cases: `context-meter.process.test.ts` (7), `provider-context-meter.process`
//! (its primitive, folded below) and `silence.test.ts` (4). Each case names its TypeScript case.

use super::context::{ContextChange, ContextSample, ContextSource, Meters, fold_context};
use super::silence::{
    DEFAULT_SILENCE_MS, SilenceResolver, SilenceScope, SilenceThresholds, parse_silence_ms,
};
use crate::futures::future::LocalBoxFuture;
use crate::repository::testsupport::{Shell, header, home};
use ace_core::ThreadState;
use ace_json::Value;
use std::cell::RefCell;
use std::rc::Rc;

fn state(thread: &str) -> ThreadState {
    let json = header(thread);
    let value = ace_json::parse(&json).expect("the fixture parses");
    ace_json::from_value(&value).expect("the fixture is a thread state")
}

fn text(value: &str) -> Value {
    Value::from(value)
}

fn event(kind: &str, fields: &[(&str, Value)]) -> Value {
    let mut object = ace_json::Map::new();
    object.insert("type", text(kind));
    for (key, value) in fields {
        object.insert(*key, value.clone());
    }
    Value::Object(object)
}

fn number(value: u64) -> Value {
    Value::from(value as f64)
}

fn sample(
    agent: &str,
    used: u64,
    window: Option<u64>,
    model: Option<&str>,
    session: Option<&str>,
) -> Value {
    let mut fields = vec![("agentId", text(agent)), ("usedTokens", number(used))];
    if let Some(window) = window {
        fields.push(("windowTokens", number(window)));
    }
    if let Some(model) = model {
        fields.push(("model", text(model)));
    }
    if let Some(session) = session {
        fields.push(("sessionId", text(session)));
    }
    event("context.sampled", &fields)
}

fn usage(used: Option<u64>, window: Option<u64>, session: Option<&str>) -> Value {
    let mut fields = vec![("agentId", text("root"))];
    if let Some(used) = used {
        fields.push(("contextTokens", number(used)));
    }
    if let Some(window) = window {
        fields.push(("contextWindow", number(window)));
    }
    if let Some(session) = session {
        fields.push(("contextSessionId", text(session)));
    }
    event("usage.updated", &fields)
}

fn compaction(complete: bool) -> Value {
    let mut item = ace_json::Map::new();
    item.insert("type", text("compaction"));
    item.insert("id", text("compact"));
    item.insert("complete", Value::Bool(complete));
    item.insert("agentId", text("root"));
    event("item.updated", &[("item", Value::Object(item))])
}

fn meters(lookup: impl Fn(&str, Option<&str>, &str) -> Option<u64> + 'static) -> Meters {
    Meters::new(Some(Rc::new(lookup)))
}

fn meter_of(store: &crate::EngineStore, thread: &str, agent: &str) -> Option<super::ContextMeter> {
    // The production engine keeps one Meters per engine; a read-only mirror creates the table
    // idempotently so a case can assert exactly what `observe` wrote.
    Meters::default()
        .samples(store, thread)
        .expect("read")
        .into_iter()
        .find(|meter| meter.agent_id == agent)
}

#[test]
fn inclusive_claude_totals_for_auxiliary_models_cannot_clear_the_last_context_sample() {
    // context-meter.process.test.ts: "inclusive Claude totals for auxiliary models cannot clear
    // the last context sample".
    let conn = home("aux", &header("aux"));
    let store = Shell::store(&conn);
    let meters = Meters::default();
    let thread = state("aux");
    meters
        .observe(
            &store,
            &thread,
            &[sample(
                "root",
                12000,
                Some(200000),
                Some("main-model"),
                Some("session"),
            )],
            1.0,
            None,
        )
        .expect("sample");
    meters
        .observe(
            &store,
            &thread,
            &[
                event(
                    "usage.updated",
                    &[
                        ("agentId", text("root")),
                        ("usageScope", text("model_session")),
                        ("model", text("auxiliary-model")),
                        ("inputTokens", number(100)),
                        ("outputTokens", number(10)),
                    ],
                ),
                event(
                    "usage.updated",
                    &[
                        ("agentId", text("root")),
                        ("usageScope", text("provider_session")),
                        ("inputTokens", number(30000)),
                        ("outputTokens", number(1000)),
                    ],
                ),
            ],
            2.0,
            None,
        )
        .expect("usage");
    let meter = meter_of(&store, "aux", "root").expect("meter");
    assert_eq!(meter.model.as_deref(), Some("main-model"));
    assert_eq!(meter.used_tokens, Some(12000));
    assert_eq!(meter.window_tokens, Some(200000));
    assert_eq!(meter.source, ContextSource::Provider);
}

#[test]
fn context_occupancy_replaces_samples_survives_billing_and_becomes_unknown_through_compaction() {
    // context-meter.process.test.ts: "context occupancy replaces samples, survives billing
    // updates, and becomes unknown through compaction".
    let conn = home("occupancy", &header("occupancy"));
    let store = Shell::store(&conn);
    let meters = meters(|_, _, _| Some(100000));
    let thread = state("occupancy");
    meters
        .observe(
            &store,
            &thread,
            &[sample("root", 80000, Some(128000), None, Some("session-1"))],
            1.0,
            None,
        )
        .expect("first");
    meters
        .observe(
            &store,
            &thread,
            &[
                sample("root", 81000, None, None, Some("session-1")),
                usage(None, None, None),
            ],
            2.0,
            None,
        )
        .expect("second");
    let meter = meter_of(&store, "occupancy", "root").expect("meter");
    assert_eq!(meter.used_tokens, Some(81000));
    assert_eq!(meter.window_tokens, Some(128000));
    assert_eq!(meter.source, ContextSource::Provider);

    let epoch = meter.epoch;
    meters
        .observe(&store, &thread, &[compaction(true)], 3.0, None)
        .expect("compaction");
    let meter = meter_of(&store, "occupancy", "root").expect("meter");
    assert_eq!(meter.used_tokens, None);
    assert!(meter.epoch > epoch, "a compaction starts a new epoch");
    let after = meter.epoch;
    meters
        .observe(&store, &thread, &[compaction(true)], 4.0, None)
        .expect("repeat");
    assert_eq!(
        meter_of(&store, "occupancy", "root").expect("meter").epoch,
        after,
        "the same compaction step changes nothing"
    );
    meters
        .observe(
            &store,
            &thread,
            &[sample("root", 12000, None, None, Some("session-1"))],
            5.0,
            None,
        )
        .expect("fresh");
    assert_eq!(
        meter_of(&store, "occupancy", "root")
            .expect("meter")
            .used_tokens,
        Some(12000)
    );
}

#[test]
fn new_native_sessions_and_model_changes_cannot_display_the_previous_occupancy() {
    // context-meter.process.test.ts: "new native sessions and model changes cannot display the
    // previous context occupancy".
    let conn = home("session", &header("session"));
    let store = Shell::store(&conn);
    let meters = meters(|_, _, model| (model == "model").then_some(100000));
    let thread = state("session");
    meters
        .observe(
            &store,
            &thread,
            &[sample(
                "root",
                70000,
                Some(128000),
                Some("model"),
                Some("one"),
            )],
            1.0,
            None,
        )
        .expect("first");
    meters
        .observe(
            &store,
            &thread,
            &[usage(None, None, Some("two"))],
            2.0,
            None,
        )
        .expect("new session");
    let meter = meter_of(&store, "session", "root").expect("meter");
    assert_eq!(meter.used_tokens, None);
    assert_eq!(meter.window_tokens, Some(100000));
    assert_eq!(meter.source, ContextSource::Catalog);

    meters
        .observe(
            &store,
            &thread,
            &[sample(
                "root",
                5000,
                None,
                Some("unknown-model"),
                Some("two"),
            )],
            3.0,
            None,
        )
        .expect("unknown model");
    let meter = meter_of(&store, "session", "root").expect("meter");
    assert_eq!(meter.used_tokens, Some(5000));
    assert_eq!(meter.window_tokens, None);
    assert_eq!(meter.model.as_deref(), Some("unknown-model"));
    assert_eq!(meter.source, ContextSource::Unknown);
}

#[test]
fn subagent_context_meters_stay_independent_of_the_root_and_are_restored_in_snapshots() {
    // context-meter.process.test.ts: "subagent context meters stay independent of the root and
    // are restored in snapshots".
    let conn = home("subagent", &header("subagent"));
    let store = Shell::store(&conn);
    let meters = meters(|_, _, model| match model {
        "child-model" => Some(20000),
        _ => Some(100000),
    });
    let thread = state("subagent");
    meters
        .observe(
            &store,
            &thread,
            &[
                sample("root", 100, None, Some("root-model"), None),
                sample("child", 9000, None, Some("child-model"), None),
            ],
            1.0,
            None,
        )
        .expect("samples");
    let root = meter_of(&store, "subagent", "root").expect("root meter");
    let child = meter_of(&store, "subagent", "child").expect("child meter");
    assert_eq!(
        (root.used_tokens, root.window_tokens),
        (Some(100), Some(100000))
    );
    assert_eq!(
        (child.used_tokens, child.window_tokens),
        (Some(9000), Some(20000))
    );
}

#[test]
fn native_continuation_invalidates_a_pre_restart_occupancy_until_a_fresh_sample() {
    // context-meter.process.test.ts: "native continuation invalidates a pre-restart occupancy
    // until a fresh provider sample arrives".
    let conn = home("restart", &header("restart"));
    let store = Shell::store(&conn);
    let meters = Meters::default();
    let thread = state("restart");
    meters
        .observe(
            &store,
            &thread,
            &[sample("root", 80000, Some(128000), None, Some("one"))],
            1.0,
            None,
        )
        .expect("first");
    // The restart continues the interrupted turn natively: `process.started` clears the figure
    // (`State::observe_context_batch`'s invalidation half is this call).
    meters
        .invalidate(&store, "restart", 2.0)
        .expect("invalidate");
    assert_eq!(
        meter_of(&store, "restart", "root")
            .expect("meter")
            .used_tokens,
        None
    );
    meters
        .observe(
            &store,
            &thread,
            &[sample("root", 9000, Some(128000), None, Some("one"))],
            4.0,
            None,
        )
        .expect("fresh");
    assert_eq!(
        meter_of(&store, "restart", "root")
            .expect("meter")
            .used_tokens,
        Some(9000)
    );
}

#[test]
fn an_explicit_agent_model_change_clears_occupancy_without_another_usage_frame() {
    // context-meter.process.test.ts: "an explicit agent model change clears occupancy without
    // requiring another usage frame".
    let conn = home("model", &header("model"));
    let store = Shell::store(&conn);
    let meters = meters(|_, _, model| (model == "new").then_some(64000));
    let thread = state("model");
    meters
        .observe(
            &store,
            &thread,
            &[sample("root", 80000, Some(128000), Some("old"), None)],
            1.0,
            None,
        )
        .expect("first");
    meters
        .observe(
            &store,
            &thread,
            &[event(
                "agent.updated",
                &[("agentId", text("root")), ("model", text("new"))],
            )],
            2.0,
            None,
        )
        .expect("model change");
    let meter = meter_of(&store, "model", "root").expect("meter");
    assert_eq!(meter.used_tokens, None);
    assert_eq!(meter.window_tokens, Some(64000));
    assert_eq!(meter.model.as_deref(), Some("new"));
    assert_eq!(meter.source, ContextSource::Catalog);
}

#[test]
fn compaction_completion_invalidates_a_sample_received_during_the_compaction() {
    // context-meter.process.test.ts: "compaction completion invalidates a sample received during
    // the compaction".
    let conn = home("compaction", &header("compaction"));
    let store = Shell::store(&conn);
    let meters = Meters::default();
    let thread = state("compaction");
    meters
        .observe(
            &store,
            &thread,
            &[sample("root", 80000, Some(128000), None, None)],
            1.0,
            None,
        )
        .expect("first");
    meters
        .observe(
            &store,
            &thread,
            &[
                compaction(false),
                sample("root", 79000, None, None, None),
                compaction(true),
            ],
            2.0,
            None,
        )
        .expect("compaction");
    assert_eq!(
        meter_of(&store, "compaction", "root")
            .expect("meter")
            .used_tokens,
        None
    );
    meters
        .observe(
            &store,
            &thread,
            &[sample("root", 9000, None, None, None)],
            3.0,
            None,
        )
        .expect("fresh");
    assert_eq!(
        meter_of(&store, "compaction", "root")
            .expect("meter")
            .used_tokens,
        Some(9000)
    );
}

#[test]
fn an_inclusive_billing_snapshot_never_occupies_context_by_itself() {
    // provider-context-meter.process.test.ts: "pi/cursor context samples replace occupancy and
    // ignore cumulative run billing".
    let prior = ContextSample::empty("root");
    let folded = fold_context(
        &prior,
        ContextChange::Sample {
            used: Some(5000),
            window: Some(128000),
            model: Some("model".into()),
            session: Some("session".into()),
            catalog: None,
        },
    )
    .expect("sample");
    assert_eq!(folded.meter.used_tokens, Some(5000));
    assert_eq!(folded.meter.window_tokens, Some(128000));
    assert_eq!(folded.meter.source, ContextSource::Provider);
}

struct FakeResolver {
    global: Option<f64>,
    workspace: RefCell<std::collections::HashMap<String, f64>>,
    thread: RefCell<std::collections::HashMap<String, f64>>,
    asked: RefCell<Vec<SilenceScope>>,
}

impl SilenceResolver for FakeResolver {
    fn resolve(&self, scope: SilenceScope) -> LocalBoxFuture<'static, Result<Option<f64>, String>> {
        self.asked.borrow_mut().push(scope.clone());
        let answer = match (&scope.thread_id, &scope.workspace_id) {
            (Some(thread), _) => self.thread.borrow().get(thread).copied(),
            (None, Some(workspace)) => self.workspace.borrow().get(workspace).copied(),
            (None, None) => self.global,
        };
        Box::pin(async move { Ok(answer) })
    }
}

fn silence(resolver: Rc<FakeResolver>) -> SilenceThresholds {
    let resolver: Rc<dyn SilenceResolver> = resolver;
    SilenceThresholds::new(
        None,
        Some(resolver),
        Box::new(|id| (id != "orphan").then(|| "workspace".to_owned())),
    )
    .expect("thresholds")
}

#[test]
fn defaults_to_five_minutes_so_a_silently_thinking_agent_stays_working_past_a_minute() {
    // silence.test.ts: "defaults to 5 minutes so a silently thinking agent stays working past
    // 60 seconds".
    assert_eq!(DEFAULT_SILENCE_MS, 300_000.0);
    assert_eq!(parse_silence_ms(None, DEFAULT_SILENCE_MS), 300_000.0);
    assert_eq!(
        parse_silence_ms(Some(&text("15m")), DEFAULT_SILENCE_MS),
        900_000.0
    );
    assert_eq!(
        parse_silence_ms(Some(&text("later")), DEFAULT_SILENCE_MS),
        DEFAULT_SILENCE_MS
    );
}

#[test]
fn applies_the_setting_across_global_workspace_and_thread_layers_and_updates_live_threads() {
    // silence.test.ts: "applies threads.unresponsiveAfter across global, workspace and thread
    // layers and updates live threads".
    let fake = Rc::new(FakeResolver {
        global: Some(120_000.0),
        workspace: RefCell::new([("workspace".to_owned(), 900_000.0)].into()),
        thread: RefCell::new([("thread".to_owned(), 60_000.0)].into()),
        asked: RefCell::new(Vec::new()),
    });
    let mut thresholds = silence(Rc::clone(&fake));
    crate::futures::executor::block_on(thresholds.prepare_global()).expect("global");
    assert_eq!(thresholds.for_workspace(None), 120_000.0);
    crate::futures::executor::block_on(thresholds.prepare_workspace("workspace"))
        .expect("workspace");
    assert_eq!(thresholds.for_workspace(Some("workspace")), 900_000.0);
    assert_eq!(thresholds.for_workspace(Some("other")), 120_000.0);

    let applied = RefCell::new(Vec::new());
    crate::futures::executor::block_on(thresholds.sync_thread("thread", |id, ms| {
        applied.borrow_mut().push((id.to_owned(), ms));
    }))
    .expect("thread");
    assert_eq!(applied.into_inner(), [("thread".to_owned(), 60_000.0)]);
}

#[test]
fn upgrades_an_older_persisted_thread_when_resumed_or_sent() {
    // silence.test.ts: "upgrades an older persisted thread with 60s silenceMs to the configured
    // setting when resumed or sent".
    let fake = Rc::new(FakeResolver {
        global: Some(300_000.0),
        workspace: RefCell::new([("workspace".to_owned(), 240_000.0)].into()),
        thread: RefCell::new([("thread".to_owned(), 300_000.0)].into()),
        asked: RefCell::new(Vec::new()),
    });
    let mut thresholds = silence(Rc::clone(&fake));
    crate::futures::executor::block_on(thresholds.prepare_global()).expect("global");
    let applied = RefCell::new(Vec::new());
    let command = ace_json::json!({
        "payload": {"type": "thread.send", "threadId": "thread"}
    });
    crate::futures::executor::block_on(thresholds.prepare_command(&command, |id, ms| {
        applied.borrow_mut().push((id.to_owned(), ms));
    }))
    .expect("send");
    assert_eq!(applied.into_inner(), [("thread".to_owned(), 300_000.0)]);

    let create = ace_json::json!({
        "payload": {"type": "thread.create", "workspaceId": "workspace"}
    });
    crate::futures::executor::block_on(thresholds.prepare_command(&create, |_, _| {}))
        .expect("create");
    assert_eq!(thresholds.for_workspace(Some("workspace")), 240_000.0);
}

#[test]
fn falls_back_to_the_global_setting_when_a_workspace_directory_has_been_deleted() {
    // silence.test.ts: "falls back to global settings when a workspace directory has been
    // deleted".
    let fake = Rc::new(FakeResolver {
        global: Some(300_000.0),
        workspace: RefCell::new(std::collections::HashMap::new()),
        thread: RefCell::new(std::collections::HashMap::new()),
        asked: RefCell::new(Vec::new()),
    });
    let mut thresholds = silence(Rc::clone(&fake));
    crate::futures::executor::block_on(thresholds.prepare_global()).expect("global");
    crate::futures::executor::block_on(thresholds.prepare_workspace("gone")).expect("workspace");
    assert_eq!(thresholds.for_workspace(Some("gone")), 300_000.0);
}

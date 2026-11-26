// SPDX-License-Identifier: Apache-2.0
//! The moved cases: `model-selection.process.test.ts` (the selection, refusal and effort halves),
//! `selection-notices.ts`' lines, and `provider-command-metadata.ts`'s discovery frames.

use super::{
    EngineModels, MODEL_UNAVAILABLE, ModelCatalog, ModelFilter, ModelResolution, ModelSpec,
    ceiling_stopped_notice, execution_model_id, provider_command_metadata, refused_options_notice,
    selection_model_filter, unhonoured_access_notice,
};
use ace_adapter_api::{Frame, FrameDirection};
use ace_json::{Raw, Value};
use ace_protocol::generated::{CatalogModel, ExecutionSelection, ProviderKind};
use std::cell::RefCell;

fn model(native: &str, provider: Option<&str>) -> CatalogModel {
    let fixture = serde_json::json!({
        "deprecated": false,
        "displayName": native,
        "efforts": [],
        "hidden": false,
        "id": native,
        "inputModalities": [],
        "instance": "instance",
        "isDefault": false,
        "nativeModelId": native,
        "provider": "claude",
        "raw": {"json": "{}", "truncated": false},
        "serviceTiers": [],
        "nativeProviderId": provider,
    });
    serde_json::from_value(fixture).expect("a catalogue row")
}

fn selection(model: Option<&str>, options: serde_json::Value) -> ExecutionSelection {
    let fixture = serde_json::json!({
        "provider": "claude",
        "model": model,
        "options": options,
    });
    serde_json::from_value(fixture).expect("a selection")
}

struct FakeCatalog {
    resolution: ModelResolution,
    asked: RefCell<Vec<ModelSpec>>,
    refreshed: RefCell<Vec<ModelFilter>>,
}

impl ModelCatalog for FakeCatalog {
    fn resolve(&self, spec: &ModelSpec) -> ModelResolution {
        self.asked.borrow_mut().push(spec.clone());
        self.resolution.clone()
    }
    fn refresh(&self, filter: &ModelFilter) -> crate::futures::future::LocalBoxFuture<'static, ()> {
        self.refreshed.borrow_mut().push(filter.clone());
        Box::pin(async {})
    }
}

fn catalog(resolution: ModelResolution) -> FakeCatalog {
    FakeCatalog {
        resolution,
        asked: RefCell::new(Vec::new()),
        refreshed: RefCell::new(Vec::new()),
    }
}

#[test]
fn without_a_catalog_a_named_model_stays_and_the_default_is_none() {
    // model-selection.process.test.ts: the legacy path keeps the named choice and asks for the
    // provider's default otherwise.
    let models = EngineModels::new(None, None);
    assert_eq!(
        models.select("claude", Some("opus"), None, None),
        Ok(Some("opus".to_owned()))
    );
    assert_eq!(
        models.select("claude", Some("default"), None, None),
        Ok(None)
    );
    assert_eq!(models.select("claude", None, None, None), Ok(None));
}

#[test]
fn a_named_model_the_catalog_does_not_offer_is_model_unavailable() {
    // model-selection.process.test.ts: a named model the account does not offer refuses with
    // `model_unavailable`, and the refusal names it to the account's record.
    let fake = catalog(ModelResolution::Unavailable {
        reason: "not offered".to_owned(),
    });
    let rejected = RefCell::new(Vec::new());
    let reject = |provider: &str, model: &str, instance: Option<&str>| {
        rejected.borrow_mut().push((
            provider.to_owned(),
            model.to_owned(),
            instance.map(str::to_owned),
        ));
    };
    let models = EngineModels::new(Some(&fake), Some(&reject));
    assert_eq!(
        models.select("claude", Some("gone"), None, None),
        Err(MODEL_UNAVAILABLE)
    );
    assert_eq!(
        rejected.borrow().as_slice(),
        [("claude".to_owned(), "gone".to_owned(), None)]
    );
    // The default never reaches a refusal.
    assert_eq!(models.select("claude", None, None, None), Ok(None));
    assert_eq!(
        models.select("claude", Some("default"), None, None),
        Ok(None)
    );
    assert_eq!(
        rejected.borrow().len(),
        1,
        "only the named model was refused"
    );
}

#[test]
fn a_resolved_model_is_selected_by_its_execution_id() {
    let fake = catalog(ModelResolution::Resolved {
        model: Box::new(model("m", Some("upstream"))),
        effort: None,
    });
    let models = EngineModels::new(Some(&fake), None);
    assert_eq!(
        models.select("pi", Some("m"), None, None),
        Ok(Some("upstream/m".to_owned()))
    );
    let filter = selection_model_filter("pi", None, None).expect("a filter");
    assert_eq!(filter.instance.as_deref(), Some("pi-cli-default"));
    assert_eq!(
        fake.asked.into_inner()[0].filter,
        ModelFilter {
            provider: Some(ProviderKind::Pi),
            instance: Some("pi-cli-default".to_owned()),
            ..ModelFilter::default()
        }
    );
}

#[test]
fn the_execution_id_prefixes_an_upstream_provider_exactly_once() {
    assert_eq!(execution_model_id(&model("m", Some("up"))), "up/m");
    assert_eq!(execution_model_id(&model("up/m", Some("up"))), "up/m");
    assert_eq!(execution_model_id(&model("m", None)), "m");
    assert_eq!(execution_model_id(&model("m", Some(""))), "m");
}

#[test]
fn an_acp_selection_needs_its_identity_and_carries_it() {
    let identity: ace_protocol::generated::AcpIdentity = serde_json::from_value(
        serde_json::json!({"acpAgentId":"agent","installationId":"install","instanceId":"session"}),
    )
    .expect("identity");
    assert!(selection_model_filter("acp", None, None).is_none());
    let filter = selection_model_filter("acp", None, Some(&identity)).expect("filter");
    assert_eq!(filter.instance.as_deref(), Some("session"));
    assert_eq!(filter.acp_agent_id.as_deref(), Some("agent"));
    assert_eq!(filter.installation_id.as_deref(), Some("install"));
}

#[test]
fn prepare_fills_only_a_missing_effort_and_drops_a_portable_selection_to_its_own_options() {
    // model-selection.process.test.ts: explicit execution choices survive discovery; only a
    // missing effort is filled, and a non-Cursor selection carries no Cursor SDK parameters.
    let fake = catalog(ModelResolution::Resolved {
        model: Box::new(model("opus", None)),
        effort: Some("high".to_owned()),
    });
    let models = EngineModels::new(Some(&fake), None);
    let prepared = crate::futures::executor::block_on(models.prepare(
        selection(
            Some("opus"),
            serde_json::json!({"effort": "low", "cursorModelParams": "[{\"id\":\"fast\",\"value\":\"true\"}]"}),
        ),
        None,
    ))
    .expect("prepare");
    assert_eq!(
        prepared.options.get("effort"),
        Some(&serde_json::json!("low")),
        "an explicit effort survives discovery"
    );
    assert!(!prepared.options.contains_key("cursorModelParams"));

    let prepared = crate::futures::executor::block_on(
        models.prepare(selection(None, serde_json::json!({})), None),
    )
    .expect("prepare");
    assert_eq!(
        prepared.options.get("effort"),
        Some(&serde_json::json!("high"))
    );
    assert_eq!(prepared.model.as_deref().map(String::as_str), Some("opus"));
}

#[test]
fn a_default_selection_asks_discovery_once_before_it_resolves() {
    let fake = FakeCatalog {
        resolution: ModelResolution::Unavailable {
            reason: "not loaded".to_owned(),
        },
        asked: RefCell::new(Vec::new()),
        refreshed: RefCell::new(Vec::new()),
    };
    let models = EngineModels::new(Some(&fake), None);
    crate::futures::executor::block_on(
        models.prepare(selection(None, serde_json::json!({})), None),
    )
    .expect("prepare");
    assert_eq!(
        fake.refreshed.borrow().len(),
        1,
        "the default asked discovery"
    );
}

#[test]
fn a_refused_access_option_and_a_ceiling_stop_leave_their_own_transcript_lines() {
    // selection-notices.ts: the words the access picker uses, and the stop it explains.
    let notice = unhonoured_access_notice("root", 7.0, "full-access", Some("Ask"));
    let draft = notice.get("draft").expect("draft");
    assert_eq!(draft.get("level").and_then(Value::as_str), Some("warning"));
    assert_eq!(
        draft.get("text").and_then(Value::as_str),
        Some("This agent doesn't offer Full access, so it runs with Ask.")
    );
    assert_eq!(
        notice.get("item").and_then(Value::as_str),
        Some("access-unavailable:7")
    );
    let notice = refused_options_notice(
        "root",
        8.0,
        &[
            ("effort".to_owned(), Value::from("high")),
            ("model".to_owned(), Value::from("x")),
        ],
    );
    assert_eq!(
        notice
            .get("draft")
            .and_then(|draft| draft.get("text"))
            .and_then(Value::as_str),
        Some(
            "This agent didn't take the high thinking level or model x, so it runs at its default."
        )
    );
    let notice = ceiling_stopped_notice("child", 9.0);
    assert_eq!(
        notice
            .get("draft")
            .and_then(|draft| draft.get("code"))
            .and_then(Value::as_str),
        Some("access_ceiling_stopped")
    );
}

fn frame(channel: &str, dir: FrameDirection, data: Value) -> Frame {
    Frame {
        seq: 1,
        t: 1,
        dir,
        channel: channel.to_owned(),
        data: Raw::from_json(&ace_json::to_string(&data)).expect("json"),
        payload: None,
        usage_account: None,
    }
}

#[test]
fn command_metadata_reads_only_the_metadata_channels() {
    // provider-command-metadata.ts: Pi's command list drops ace's own control commands.
    let data = serde_json::json!({
        "type": "response",
        "command": "get_commands",
        "success": true,
        "data": {"commands": [{"name": "ace-context"}, {"name": "compact"}, {"name": "ace-rollback"}]},
    });
    let data: Value = ace_json::parse(&data.to_string()).expect("json");
    let found =
        provider_command_metadata(&frame("stdio", FrameDirection::Recv, data), |_, _, _| None)
            .expect("commands");
    let names: Vec<&str> = found
        .get("availableCommands")
        .and_then(Value::as_array)
        .expect("commands")
        .iter()
        .filter_map(|command| command.get("name").and_then(Value::as_str))
        .collect();
    assert_eq!(names, ["compact"]);

    // A delta frame never enters discovery.
    let delta: Value = ace_json::parse(r#"{"type":"item.delta"}"#).expect("json");
    assert!(
        provider_command_metadata(&frame("stdio", FrameDirection::Recv, delta), |_, _, _| None)
            .is_none()
    );
    // The ACP command-list update passes through as its own update.
    let update: Value = ace_json::parse(
        r#"{"method":"session/update","params":{"update":{"sessionUpdate":"available_commands_update","availableCommands":[]}}}"#,
    )
    .expect("json");
    let found =
        provider_command_metadata(&frame("sdk", FrameDirection::Recv, update), |_, _, _| None)
            .expect("update");
    assert_eq!(
        found.get("sessionUpdate").and_then(Value::as_str),
        Some("available_commands_update")
    );
    // A Claude commands change becomes the init shape the UI already reads.
    let changed: Value = ace_json::parse(
        r#"{"type":"system","subtype":"commands_changed","commands":["/compact"]}"#,
    )
    .expect("json");
    let found =
        provider_command_metadata(&frame("stdio", FrameDirection::Recv, changed), |_, _, _| {
            None
        })
        .expect("init");
    assert_eq!(found.get("subtype").and_then(Value::as_str), Some("init"));
}

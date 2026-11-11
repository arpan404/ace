//! Presets come from the binary, never from a copy an earlier Spade left in the data folder; an
//! edited copy is adopted into the person's endpoints once.

mod support;

use serde_json::{Value, json};
use spade_models::Catalog;
use spade_server::presets;
use spade_testkit::Script;
use support::{Options, Result, Spade};

/// `config/models.json` as Spade shipped it on 2026-11-10, before presets named session headers.
const SHIPPED_2026_11_10: &str = include_str!("../shipped/models-2026-11-10.json");

#[test]
fn a_data_folder_holding_an_older_shipped_models_json_still_gets_the_current_presets() -> Result {
    let dir = tempfile::tempdir()?;
    std::fs::write(dir.path().join("models.json"), SHIPPED_2026_11_10)?;
    let old = Catalog::from_json(SHIPPED_2026_11_10)?;
    let go = |catalog: &Catalog| {
        catalog
            .endpoints()
            .iter()
            .find(|e| e.id == "opencode-go")
            .and_then(|e| e.session_header.clone())
    };
    assert_eq!(go(&old), None, "the old copy predates session headers");

    let startup = presets::load(dir.path(), None)?;
    assert_eq!(go(&startup.presets).as_deref(), Some("x-opencode-session"));
    assert!(
        startup.adopt.is_none(),
        "an unchanged shipped copy holds nothing of the person's"
    );
    let aside = startup.set_aside.ok_or("the old copy is moved aside")?;
    presets::set_aside(&aside)?;
    assert!(!dir.path().join("models.json").exists());
    assert!(dir.path().join("models.json.old").exists());
    let again = presets::load(dir.path(), None)?;
    assert!(again.adopt.is_none() && again.set_aside.is_none());
    Ok(())
}

#[test]
fn an_edited_copy_is_offered_for_adoption() -> Result {
    let dir = tempfile::tempdir()?;
    let edited = SHIPPED_2026_11_10.replacen(
        "\"glm-5.3\", \"name\": \"GLM-5.3\"",
        "\"glm-5.3\", \"name\": \"My GLM\"",
        1,
    );
    assert_ne!(edited, SHIPPED_2026_11_10);
    std::fs::write(dir.path().join("models.json"), edited)?;
    let startup = presets::load(dir.path(), None)?;
    assert!(startup.adopt.is_some());
    assert!(startup.set_aside.is_some());
    Ok(())
}

#[tokio::test]
async fn an_edited_copys_endpoints_and_models_become_the_persons() -> Result {
    let file = Catalog::from_json(
        &json!({ "endpoints": [
            { "id": "my-local", "name": "My local", "format": "openai-chat",
              "base_url": "http://127.0.0.1:9/", "models": [{ "id": "llama", "name": "Llama", "context": 8192 }] },
            { "id": "fake", "name": "Fake", "format": "openai-chat", "base_url": "http://127.0.0.1:9/",
              "key": { "env": "FAKE_KEY" }, "models": [{ "id": "m2", "name": "M2" }] },
            { "id": "vault", "name": "Shipped, no key", "format": "anthropic",
              "base_url": "https://vault.example/", "key": {}, "models": [{ "id": "v", "name": "V" }] }
        ]})
        .to_string(),
    )?;
    let spade = Spade::start_with(
        vec![Script::reply("unused")],
        Vec::new(),
        Options {
            adopt: Some(file),
            ..Options::default()
        },
    )
    .await?;
    let (_, models) = spade.get("/v1/models").await?;
    let endpoint = |id: &str| -> Value {
        models["endpoints"]
            .as_array()
            .and_then(|e| e.iter().find(|e| e["id"] == id).cloned())
            .unwrap_or_default()
    };
    let local = endpoint("my-local");
    assert_eq!(local["needs_key"], false);
    assert_eq!(local["models"][0]["id"], "llama");
    assert_eq!(local["models"][0]["context"], 8192);
    let fake_models: Vec<Value> = endpoint("fake")["models"]
        .as_array()
        .map(|m| m.iter().map(|m| m["id"].clone()).collect())
        .unwrap_or_default();
    assert_eq!(
        fake_models,
        vec![json!("m2"), json!("m")],
        "added to the endpoint already there"
    );
    // `vault` needs a key nobody set, and is not a preset here either, so it is the person's own.
    assert_eq!(endpoint("vault")["id"], "vault");
    Ok(())
}

async fn models_of(spade: &Spade) -> Result<Value> {
    Ok(spade.get("/v1/models").await?.1)
}

fn find<'a>(models: &'a Value, id: &str) -> &'a Value {
    models["endpoints"]
        .as_array()
        .and_then(|e| e.iter().find(|e| e["id"] == id))
        .unwrap_or(&Value::Null)
}

#[tokio::test]
async fn edits_in_an_old_copy_win_over_the_presets_for_an_existing_endpoint() -> Result {
    // `spare` is a preset here; the old copy moved it, added a header and changed a model's
    // context, and left the rest as shipped.
    let file = Catalog::from_json(
        &json!({ "endpoints": [{ "id": "spare", "name": "Spare", "format": "openai-chat",
            "base_url": "https://spare-edited.example/v1/", "key": {}, "headers": { "x-team": "blue" },
            "models": [
                { "id": "m", "name": "Spare M", "context": 1000, "capabilities": ["tools"] },
                { "id": "s", "name": "S", "context": 999, "capabilities": ["tools"] }
            ] }] })
        .to_string(),
    )?;
    let spade = Spade::start_with(
        vec![Script::reply("unused")],
        Vec::new(),
        Options {
            adopt: Some(file),
            ..Options::default()
        },
    )
    .await?;
    let models = models_of(&spade).await?;
    let spare = find(&models, "spare");
    assert_eq!(spare["base_url"], "https://spare-edited.example/v1/");
    assert_eq!(spare["header_names"], json!(["x-team"]));
    let model = |id: &str| -> Value {
        spare["models"]
            .as_array()
            .and_then(|m| m.iter().find(|m| m["id"] == id).cloned())
            .unwrap_or_default()
    };
    assert_eq!(model("s")["context"], 999, "the edited fact wins");
    assert_eq!(model("m")["context"], 1000);
    assert_eq!(
        model("m")["source"],
        "preset",
        "unchanged facts stay the preset's"
    );
    Ok(())
}

#[tokio::test]
async fn preset_facts_are_inherited_not_copied_so_shipped_corrections_reach_an_install() -> Result {
    let spade = Spade::start(vec![Script::reply("unused")], Vec::new()).await?;
    let models = models_of(&spade).await?;
    assert_eq!(find(&models, "fake")["models"][0]["id"], "m");
    let store = spade_store::Store::open(&spade.database())?;
    let fake = store
        .endpoints()?
        .into_iter()
        .find(|e| e.id == "fake")
        .ok_or("fake was imported")?;
    assert_eq!(fake.preset.as_deref(), Some("fake"));
    assert!(
        fake.models.is_empty(),
        "no preset fact is stored: {:?}",
        fake.models
    );
    Ok(())
}

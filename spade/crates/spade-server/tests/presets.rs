//! Presets come from the binary, never from a copy an earlier Spade left in the data folder; an
//! edited copy is adopted into the person's endpoints once.

mod support;

use serde_json::{Value, json};
use spade_models::Catalog;
use spade_server::presets;
use spade_testkit::Script;
use support::{Options, Result, Spade};

/// `config/models.json` as Spade shipped it on 2026-11-10, before presets named session headers.
const SHIPPED_2026_11_10: &str = include_str!("fixtures/models-shipped-2026-11-10.json");

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
        vec![json!("m"), json!("m2")],
        "added to the endpoint already there"
    );
    // `vault` needs a key nobody set, and is not a preset here either, so it is the person's own.
    assert_eq!(endpoint("vault")["id"], "vault");
    Ok(())
}

//! Publishing a bot (ADR 0168 §5): `GET /v1/agents/{id}/recipe` gives the bot as a version 2
//! recipe that installs as the same bot again, with needs from its grants and never a grant,
//! secret or note; what a recipe can't carry is named; a secret in the task refuses it. And
//! `GET /v1/skills/{id}/files` gives a skill written in Spade with its files.

mod support;

use std::sync::{Arc, Mutex};

use base64::Engine as _;
use serde_json::{Value, json};
use spade_ace::plugins::{Installed, SpadePlugin};
use spade_server::clock::SystemClock;
use spade_server::plugins::{BoxFuture, Daemon};
use spade_server::skill_store::SkillStore;
use spade_server::tools::SkillLibrary;
use spade_store::Store;
use spade_testkit::FakeConnector;
use support::{Options, Result, Spade};

fn id(agent: &Value) -> String {
    agent["id"].as_str().unwrap_or_default().to_owned()
}

fn recipe() -> Value {
    json!({
        "format": "spade-bot",
        "version": 2,
        "name": "Inbox",
        "blurb": "",
        "task": "You look after the person's inbox.",
        "face": { "kind": "character", "v": 1, "body": "round", "pair": "lagoon", "ears": "none",
                  "marking": "muzzle", "eyes": "egg", "mouth": "smile", "cheeks": "blush",
                  "accessory": "glasses" },
        "model": "fast",
        "routines": [
            { "name": "Morning sort", "instruction": "Sort the mail.", "schedule": "weekdays at 8:00" }
        ],
        "notes": ["Never send a reply without the person's word."]
    })
}

/// Stands in for ace's plugins: one accepted plugin, `mail-tools`.
#[derive(Default)]
struct FakeAce {
    plugins: Mutex<Vec<SpadePlugin>>,
}

impl FakeAce {
    fn accept(&self, name: &str) {
        let value = json!({
            "install": { "name": name, "version": "1.0", "commit": "c".repeat(40),
                         "hash": "a".repeat(64), "acceptedAt": 1 },
            "enabled": true, "root": "/nowhere", "components": [], "executions": [],
            "unsupported": [],
        });
        let plugin: SpadePlugin = serde_json::from_value(value).unwrap_or_else(|e| panic!("{e}"));
        self.plugins
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .push(plugin);
    }

    fn all(&self) -> Vec<SpadePlugin> {
        self.plugins
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
    }
}

impl Daemon for FakeAce {
    fn installed(&self) -> BoxFuture<'_, std::result::Result<Vec<Installed>, String>> {
        let all = self.all();
        Box::pin(async move {
            Ok(all
                .into_iter()
                .map(|p| Installed {
                    install: p.install,
                    enabled: true,
                })
                .collect())
        })
    }

    fn plugin<'a>(
        &'a self,
        name: &'a str,
    ) -> BoxFuture<'a, std::result::Result<SpadePlugin, String>> {
        let found = self.all().into_iter().find(|p| p.install.name == name);
        Box::pin(async move { found.ok_or_else(|| "Plugin not installed".to_owned()) })
    }
}

/// A Spade with connectors (Fake Mail connected by token), the plugin `mail-tools` and a fast model.
async fn furnished_spade() -> Result<(Spade, FakeConnector)> {
    let app = FakeConnector::start(Vec::new()).await;
    app.accept_token("api-key-1");
    let ace = Arc::new(FakeAce::default());
    ace.accept("mail-tools");
    let spade = Spade::start_with(
        Vec::new(),
        Vec::new(),
        Options {
            connectors: true,
            plugins: Some(ace),
            catalogue: vec![spade_connect::Entry {
                id: "fakemail".into(),
                name: "Fake Mail".into(),
                url: app.url(),
                sign_in: vec![spade_connect::SignIn::Token],
                notes: String::new(),
                source: "https://example.com/docs".into(),
                via: None,
                local: true,
                effects: Default::default(),
                every_tool: None,
            }],
            ..Options::default()
        },
    )
    .await?;
    let (status, body) = spade
        .post(
            "/v1/connectors",
            json!({ "catalogue": "fakemail", "token": "api-key-1" }),
        )
        .await?;
    assert_eq!(status, 200, "{body}");
    let (status, body) = spade
        .post(
            "/v1/endpoints/fake/models",
            json!({ "id": "cheap", "capabilities": ["tools"] }),
        )
        .await?;
    assert!(status < 300, "{body}");
    let (status, body) = spade
        .put(
            "/v1/settings",
            json!({ "fast_model": "fake/cheap", "new_bot_model": "fake/m" }),
        )
        .await?;
    assert!(status < 300, "{body}");
    Ok((spade, app))
}

/// A bot the person made, with a face, a fast model, a routine, a catalogue connector, a custom
/// one, and a plugin. Answers its id.
async fn own_bot(spade: &Spade) -> Result<String> {
    let custom = FakeConnector::start(Vec::new()).await;
    custom.accept_token("api-key-2");
    let (status, body) = spade
        .post(
            "/v1/connectors",
            json!({ "url": custom.url(), "name": "Private CRM", "local": true, "token": "api-key-2" }),
        )
        .await?;
    assert_eq!(status, 200, "{body}");
    let custom_id = body["connector"]["id"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    let (_, listed) = spade.get("/v1/connectors").await?;
    let mail_id = listed["connectors"]
        .as_array()
        .and_then(|all| all.iter().find(|c| c["catalogue"] == "fakemail"))
        .map(id)
        .unwrap_or_default();
    let (status, made) = spade
        .post(
            "/v1/agents",
            json!({ "name": "Inbox", "task": recipe()["task"], "model": "fake/cheap",
                    "avatar": recipe()["face"] }),
        )
        .await?;
    assert_eq!(status, 201, "{made}");
    let bot = id(&made["agent"]);
    let (status, body) = spade
        .post(
            &format!("/v1/agents/{bot}/routines"),
            json!({ "name": "Morning sort", "instruction": "Sort the mail.",
                    "trigger": { "kind": "schedule", "schedule": "weekdays at 8:00" } }),
        )
        .await?;
    assert_eq!(status, 201, "{body}");
    let (status, body) = spade
        .put(
            &format!("/v1/agents/{bot}/connectors"),
            json!({ "all": false, "connectors": [mail_id, custom_id] }),
        )
        .await?;
    assert!(status < 300, "{body}");
    let (status, body) = spade
        .put(
            &format!("/v1/agents/{bot}/plugins"),
            json!({ "plugins": ["mail-tools"] }),
        )
        .await?;
    assert!(status < 300, "{body}");
    Ok(bot)
}

#[tokio::test]
async fn a_bot_exports_as_a_recipe_that_asks_for_what_it_was_granted() -> Result {
    let (spade, _app) = furnished_spade().await?;
    let bot = own_bot(&spade).await?;
    // A webhook routine has a secret, and can't be part of a recipe.
    let (status, body) = spade
        .post(
            &format!("/v1/agents/{bot}/routines"),
            json!({ "name": "Hook", "instruction": "Run on a hook.",
                    "trigger": { "kind": "webhook" } }),
        )
        .await?;
    assert_eq!(status, 201, "{body}");
    let secret = body["routine"]["secret"].as_str().map(str::to_owned);

    let (status, exported) = spade.get(&format!("/v1/agents/{bot}/recipe")).await?;
    assert_eq!(status, 200, "{exported}");
    let out = &exported["recipe"];
    assert_eq!(out["format"], "spade-bot");
    assert_eq!(out["version"], 2);
    assert_eq!(out["name"], "Inbox");
    assert_eq!(out["task"], recipe()["task"]);
    assert_eq!(out["face"], recipe()["face"]);
    assert_eq!(out["model"], "fast", "it runs on the person's fast model");
    assert_eq!(out["routines"], recipe()["routines"]);
    assert_eq!(out["plugins"], json!(["spade-plugin/mail-tools"]));
    assert_eq!(out["notes"], json!([]), "the bot's notes stay home");
    let left_out = exported["left_out"].to_string();
    assert!(left_out.contains("Hook"), "{left_out}");

    let text = out.to_string();
    for absent in [
        "grants",
        "secret",
        "api-key-1",
        "fake/cheap",
        "conversation",
    ] {
        assert!(
            !text.contains(absent),
            "the recipe holds {absent:?}: {text}"
        );
    }
    if let Some(secret) = secret {
        assert!(!text.contains(&secret), "the webhook secret stayed home");
    }

    // The recipe installs as the same bot again.
    let mut again = out.clone();
    again["name"] = json!("Inbox again");
    let (status, remade) = spade
        .post(
            "/v1/agents",
            json!({
                "recipe": again,
                "from_recipe": { "source": "market", "name": "inbox", "version": "1.0.1" },
                "grants": { "connectors": [], "plugins": [], "skills": [] },
                "start_routines": false,
            }),
        )
        .await?;
    assert_eq!(status, 201, "{remade}");
    assert_eq!(remade["agent"]["task"], recipe()["task"]);
    assert_eq!(remade["agent"]["model"], "fake/cheap");
    Ok(())
}

#[tokio::test]
async fn a_recipe_asks_for_catalogue_apps_by_id_alone_and_never_names_a_custom_one() -> Result {
    let (spade, app) = furnished_spade().await?;
    let bot = own_bot(&spade).await?;
    let (status, exported) = spade.get(&format!("/v1/agents/{bot}/recipe")).await?;
    assert_eq!(status, 200, "{exported}");
    assert_eq!(
        exported["recipe"]["needs"]["connectors"],
        json!([{ "id": "fakemail", "why": "The bot uses this app.", "required": true }])
    );
    let text = exported["recipe"].to_string();
    for absent in [
        "Private CRM",
        "Fake Mail",
        "127.0.0.1",
        "url",
        app.url().as_str(),
    ] {
        assert!(
            !text.contains(absent),
            "the recipe holds {absent:?}: {text}"
        );
    }
    let left_out = exported["left_out"].to_string();
    assert!(left_out.contains("a custom app you added"), "{left_out}");
    assert!(!left_out.contains("Private CRM"), "{left_out}");
    Ok(())
}

#[tokio::test]
async fn a_bot_installed_from_the_marketplace_is_not_the_persons_to_publish() -> Result {
    let (spade, _app) = furnished_spade().await?;
    let (status, made) = spade
        .post(
            "/v1/agents",
            json!({
                "recipe": recipe(),
                "from_recipe": { "source": "market", "name": "inbox", "version": "1.0.0" },
                "grants": { "connectors": [], "plugins": [], "skills": [] },
                "start_routines": false,
            }),
        )
        .await?;
    assert_eq!(status, 201, "{made}");
    let (status, body) = spade
        .get(&format!("/v1/agents/{}/recipe", id(&made["agent"])))
        .await?;
    assert_eq!(status, 400, "{body}");
    assert!(body.to_string().contains("marketplace"), "{body}");
    Ok(())
}

#[tokio::test]
async fn a_bot_with_every_connector_asks_for_none_and_says_so() -> Result {
    let (spade, _app) = furnished_spade().await?;
    let agent = spade.new_agent("Research", "Find sources.").await?;
    let bot = id(&agent);
    let (status, body) = spade
        .put(
            &format!("/v1/agents/{bot}/connectors"),
            json!({ "all": true }),
        )
        .await?;
    assert!(status < 300, "{body}");
    let (status, exported) = spade.get(&format!("/v1/agents/{bot}/recipe")).await?;
    assert_eq!(status, 200, "{exported}");
    assert_eq!(exported["recipe"]["needs"]["connectors"], json!([]));
    assert_eq!(exported["recipe"]["model"], "capable");
    assert!(
        exported["left_out"].to_string().contains("every connector"),
        "{exported}"
    );
    Ok(())
}

#[tokio::test]
async fn a_recipe_is_refused_while_its_task_holds_a_secret_and_spade_itself_has_none() -> Result {
    let spade = Spade::start(Vec::new(), Vec::new()).await?;
    let agent = spade
        .new_agent(
            "Deploys",
            "Deploy with token ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789 each night.",
        )
        .await?;
    let (status, body) = spade
        .get(&format!("/v1/agents/{}/recipe", id(&agent)))
        .await?;
    assert_eq!(status, 400, "{body}");
    assert!(body.to_string().contains("secret"), "{body}");
    assert!(!body.to_string().contains("ghp_"), "{body}");

    let (_, listed) = spade.get("/v1/agents").await?;
    let main = listed["agents"]
        .as_array()
        .and_then(|all| all.iter().find(|a| a["kind"] == "main"))
        .map(id)
        .unwrap_or_default();
    let (status, _) = spade.get(&format!("/v1/agents/{main}/recipe")).await?;
    assert_eq!(status, 400, "Spade itself isn't a recipe");
    let (status, _) = spade.get("/v1/agents/a_nobody/recipe").await?;
    assert_eq!(status, 404);
    Ok(())
}

#[tokio::test]
async fn a_skill_written_in_spade_gives_its_files_for_publishing() -> Result {
    let dir = tempfile::tempdir()?;
    let store = SkillStore::open(
        dir.path().join("skills"),
        Store::open(&dir.path().join("spade.db"))?,
        Arc::new(SystemClock),
        None,
    );
    let library: Arc<dyn SkillLibrary> = store.clone();
    let made = library
        .create("release-notes", "Writes release notes", "Group by area.\n")
        .await
        .map_err(|e| e.to_string())?;
    let spade = Spade::start_with(
        Vec::new(),
        Vec::new(),
        Options {
            skill_store: Some(store),
            ..Options::default()
        },
    )
    .await?;
    let (status, body) = spade.get(&format!("/v1/skills/{made}/files")).await?;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["name"], "release-notes");
    assert_eq!(body["files"][0]["path"], "SKILL.md");
    let content = base64::engine::general_purpose::STANDARD
        .decode(body["files"][0]["content"].as_str().unwrap_or_default())?;
    let text = String::from_utf8(content)?;
    assert!(text.contains("name: release-notes"), "{text}");
    assert!(text.ends_with("Group by area.\n"), "{text}");

    let (status, _) = spade
        .get("/v1/skills/sks_00000000000000000000/files")
        .await?;
    assert_eq!(status, 404);
    Ok(())
}

/// A Spade with a skill store holding one skill written in Spade; answers its folder and id.
async fn with_spade_skill() -> Result<(Spade, tempfile::TempDir, std::path::PathBuf, String)> {
    let dir = tempfile::tempdir()?;
    let root = dir.path().join("skills");
    let store = SkillStore::open(
        root.clone(),
        Store::open(&dir.path().join("spade.db"))?,
        Arc::new(SystemClock),
        None,
    );
    let library: Arc<dyn SkillLibrary> = store.clone();
    let made = library
        .create("release-notes", "Writes release notes", "Group by area.\n")
        .await
        .map_err(|e| e.to_string())?;
    let spade = Spade::start_with(
        Vec::new(),
        Vec::new(),
        Options {
            skill_store: Some(store),
            ..Options::default()
        },
    )
    .await?;
    Ok((spade, dir, root, made))
}

#[cfg(unix)]
#[tokio::test]
async fn a_skill_whose_skill_md_is_a_link_out_of_it_gives_nothing() -> Result {
    let (spade, dir, root, made) = with_spade_skill().await?;
    let outside = dir.path().join("private.txt");
    std::fs::write(&outside, "the person's private notes")?;
    let skill_md = root.join(&made).join("SKILL.md");
    std::fs::remove_file(&skill_md)?;
    std::os::unix::fs::symlink(&outside, &skill_md)?;
    let (status, body) = spade.get(&format!("/v1/skills/{made}/files")).await?;
    assert_eq!(status, 422, "{body}");
    assert!(!body.to_string().contains("private notes"), "{body}");
    assert!(!body.to_string().contains("dGhlIHBlcnNvbi"), "{body}");
    Ok(())
}

#[cfg(unix)]
#[tokio::test]
async fn a_skill_folder_that_is_a_link_gives_nothing() -> Result {
    let (spade, dir, root, made) = with_spade_skill().await?;
    let elsewhere = dir.path().join("elsewhere");
    std::fs::create_dir(&elsewhere)?;
    std::fs::write(
        elsewhere.join("SKILL.md"),
        "---\nname: release-notes\n---\nsecret plans\n",
    )?;
    let folder = root.join(&made);
    std::fs::remove_dir_all(&folder)?;
    std::os::unix::fs::symlink(&elsewhere, &folder)?;
    let (status, body) = spade.get(&format!("/v1/skills/{made}/files")).await?;
    assert_eq!(status, 422, "{body}");
    Ok(())
}

#[tokio::test]
async fn an_oversized_skill_md_is_refused_rather_than_read_whole() -> Result {
    let (spade, _dir, root, made) = with_spade_skill().await?;
    let big = format!(
        "---\nname: release-notes\n---\n{}",
        "x".repeat(2 * 1024 * 1024)
    );
    std::fs::write(root.join(&made).join("SKILL.md"), big)?;
    let (status, body) = spade.get(&format!("/v1/skills/{made}/files")).await?;
    assert_eq!(status, 422, "{body}");
    assert!(body.to_string().contains("larger"), "{body}");
    Ok(())
}

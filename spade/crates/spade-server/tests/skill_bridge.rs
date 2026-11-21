//! Skills to and from the shared `SKILL.md` standard (ADR 0202 §1), through the real server: an
//! imported folder is a skill written in Spade with every file as it came, it exports back the
//! same, the specification's rules are held again here, and a skill's `allowed-tools` changes no
//! decision of the gate.

mod support;

use std::sync::Arc;

use base64::Engine as _;
use serde_json::{Value, json};
use spade_server::clock::SystemClock;
use spade_server::skill_store::SkillStore;
use spade_server::tools::{EngineHandle, SkillLibrary, SkillLoad, Tool};
use spade_server::workspace::shell::Shell;
use spade_server::workspace::{Workspaces, workspace_tools};
use spade_store::Store;
use spade_testkit::Script;
use support::{Options, Result, Spade};

fn b64(text: &str) -> String {
    base64::engine::general_purpose::STANDARD.encode(text)
}

fn skill_md(name: &str, extra: &str) -> String {
    format!(
        "---\nname: {name}\ndescription: Sorts a mail inbox into what needs a reply today.\n{extra}---\n# Triage mail\n\nRun scripts/run.sh first.\n"
    )
}

fn import_body(name: &str, extra: &str) -> Value {
    json!({
        "name": name,
        "description": "Sorts a mail inbox into what needs a reply today.",
        "skill_md": skill_md(name, extra),
        "files": [
            { "path": "references/guide.md", "content": b64("# Guide\n") },
            { "path": "scripts/run.sh", "executable": true, "content": b64("#!/bin/sh\necho hi\n") },
        ],
        "source": "/home/me/skills/triage-mail",
    })
}

fn open_store(dir: &std::path::Path) -> Result<Arc<SkillStore>> {
    Ok(SkillStore::open(
        dir.join("skills"),
        Store::open(&dir.join("skills.sqlite"))?,
        Arc::new(SystemClock),
        None,
    ))
}

async fn serve(store: Arc<SkillStore>) -> Result<Spade> {
    Spade::start_with(
        vec![],
        vec![],
        Options {
            skill_store: Some(store),
            ..Options::default()
        },
    )
    .await
}

fn decoded(file: &Value) -> String {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(file["content"].as_str().unwrap_or_default())
        .unwrap_or_default();
    String::from_utf8(bytes).unwrap_or_default()
}

#[tokio::test]
async fn an_imported_folder_is_a_spade_skill_that_exports_back_every_file_as_it_came() -> Result {
    let dir = tempfile::tempdir()?;
    let store = open_store(dir.path())?;
    let spade = serve(store.clone()).await?;
    let extra = "license: MIT\nallowed-tools: Bash Read\nmodel: fast\n";
    let (status, body) = spade
        .post("/v1/skills/import", import_body("triage-mail", extra))
        .await?;
    assert_eq!(status, 201, "{body}");
    let id = body["id"].as_str().unwrap_or_default().to_owned();

    let (_, listed) = spade.get("/v1/skills").await?;
    let row = listed["skills"]
        .as_array()
        .and_then(|skills| skills.iter().find(|s| s["id"] == id.as_str()))
        .ok_or("the import isn't listed")?;
    assert_eq!(row["origin"], "spade");
    assert_eq!(row["files"], 2);

    let names: Vec<String> = store.list().await?.into_iter().map(|s| s.name).collect();
    assert_eq!(names, ["triage-mail"], "offered to bots like any skill");

    let (status, exported) = spade.get(&format!("/v1/skills/{id}/export")).await?;
    assert_eq!(status, 200, "{exported}");
    assert_eq!(exported["origin"], "spade");
    assert_eq!(exported["source"], "/home/me/skills/triage-mail");
    let files = exported["files"].as_array().ok_or("no files")?;
    let by_path = |path: &str| files.iter().find(|f| f["path"] == path);
    assert_eq!(
        decoded(by_path("SKILL.md").ok_or("no SKILL.md")?),
        skill_md("triage-mail", extra),
        "SKILL.md is kept byte for byte, allowed-tools and unknown fields included"
    );
    let script = by_path("scripts/run.sh").ok_or("no script")?;
    assert_eq!(decoded(script), "#!/bin/sh\necho hi\n");
    assert_eq!(script["executable"], true);
    assert_eq!(
        decoded(by_path("references/guide.md").ok_or("no guide")?),
        "# Guide\n"
    );
    Ok(())
}

#[tokio::test]
async fn an_import_breaking_the_specifications_rules_or_the_folder_is_refused() -> Result {
    let dir = tempfile::tempdir()?;
    let spade = serve(open_store(dir.path())?).await?;
    let mut long = import_body("triage-mail", "");
    long["description"] = json!("d".repeat(1025));
    let mut empty = import_body("triage-mail", "");
    empty["description"] = json!("  ");
    let mut escaping = import_body("triage-mail", "");
    escaping["files"] = json!([{ "path": "../outside.md", "content": b64("x") }]);
    let mut hidden = import_body("triage-mail", "");
    hidden["files"] = json!([{ "path": ".env", "content": b64("A=1") }]);
    let mut bare = import_body("triage-mail", "");
    bare["skill_md"] = json!("# No front matter\n");
    let cases = [
        ("a name with capitals", import_body("Triage-Mail", "")),
        (
            "a name with two hyphens together",
            import_body("triage--mail", ""),
        ),
        ("a name ending in a hyphen", import_body("triage-", "")),
        (
            "a name over 64 characters",
            import_body(&"a".repeat(65), ""),
        ),
        ("a description over 1024 characters", long),
        ("an empty description", empty),
        ("a file outside the folder", escaping),
        ("a hidden file", hidden),
        ("no front matter", bare),
    ];
    for (label, body) in cases {
        let (status, answer) = spade.post("/v1/skills/import", body).await?;
        assert_eq!(status, 422, "{label}: {answer}");
        assert!(answer["error"].as_str().is_some(), "{label} says why");
    }
    let (_, listed) = spade.get("/v1/skills").await?;
    assert_eq!(listed["skills"], json!([]), "nothing was kept");
    Ok(())
}

#[tokio::test]
async fn an_import_never_replaces_a_skill_unless_asked() -> Result {
    let dir = tempfile::tempdir()?;
    let spade = serve(open_store(dir.path())?).await?;
    let (status, _) = spade
        .post("/v1/skills/import", import_body("triage-mail", ""))
        .await?;
    assert_eq!(status, 201);
    let (status, answer) = spade
        .post("/v1/skills/import", import_body("triage-mail", ""))
        .await?;
    assert_eq!(status, 409, "{answer}");
    let mut again = import_body("triage-mail", "license: MIT\n");
    again["replace"] = json!(true);
    let (status, body) = spade.post("/v1/skills/import", again).await?;
    assert_eq!(status, 201, "{body}");
    let id = body["id"].as_str().unwrap_or_default();
    let (_, exported) = spade.get(&format!("/v1/skills/{id}/export")).await?;
    let md = exported["files"]
        .as_array()
        .and_then(|files| files.iter().find(|f| f["path"] == "SKILL.md"))
        .map(decoded)
        .unwrap_or_default();
    assert!(md.contains("license: MIT"), "{md}");
    Ok(())
}

fn finished<'a>(events: &'a [Value], call: &str) -> Option<&'a Value> {
    events
        .iter()
        .find(|e| e["type"] == "tool_finished" && e["call_id"] == call)
}

/// A bot loads the imported skill `extra` describes, then runs its script: the calls the gate
/// held for the person, by call id.
#[cfg(unix)]
async fn asked_after_loading(extra: &str) -> Result<Vec<String>> {
    let dir = tempfile::tempdir()?;
    let store = open_store(dir.path())?;
    let library: Arc<dyn SkillLibrary> = store.clone();
    let workspaces = Workspaces::new(dir.path().join("workspace"));
    let bots = EngineHandle::default();
    let mut tools: Vec<Arc<dyn Tool>> =
        workspace_tools(workspaces.clone(), bots.clone(), Shell::system());
    tools.push(Arc::new(
        SkillLoad::new(library).with_workspaces(workspaces.clone(), bots.clone()),
    ));
    let spade = Spade::start_with(
        vec![
            Script::reply("").call("load", "skill_load", json!({ "name": "triage-mail" })),
            Script::reply("").call(
                "run",
                "shell",
                json!({ "command": "sh skills/triage-mail/scripts/run.sh" }),
            ),
            Script::reply("Done."),
        ],
        tools,
        Options {
            workspaces: Some(workspaces.clone()),
            skill_store: Some(store),
            ..Options::default()
        },
    )
    .await?;
    bots.set(&spade.engine);
    let (status, body) = spade
        .post("/v1/skills/import", import_body("triage-mail", extra))
        .await?;
    assert_eq!(status, 201, "{body}");
    let agent = spade.new_agent("Mail", "").await?;
    let conversation = agent["conversation"].as_str().unwrap_or_default();
    spade.say(conversation, "Triage my mail").await?;
    let events = spade.wait_for(conversation, "approval_requested").await?;
    let loaded = finished(&events, "load").ok_or("the skill was not loaded")?;
    assert!(
        loaded["content"]
            .as_str()
            .unwrap_or_default()
            .contains("scripts/run.sh"),
        "{loaded}"
    );
    assert!(finished(&events, "run").is_none(), "the script ran unasked");
    Ok(events
        .iter()
        .filter(|e| e["type"] == "approval_requested")
        .map(|e| e["call_id"].as_str().unwrap_or_default().to_owned())
        .collect())
}

#[cfg(unix)]
#[tokio::test]
async fn a_skill_listing_bash_in_allowed_tools_still_leaves_its_shell_call_asking() -> Result {
    let without = asked_after_loading("").await?;
    let with = asked_after_loading("allowed-tools: Bash Bash(sh:*) shell\n").await?;
    assert_eq!(without, ["run"], "the script asks, as any command does");
    assert_eq!(with, without, "allowed-tools changes no decision");
    Ok(())
}

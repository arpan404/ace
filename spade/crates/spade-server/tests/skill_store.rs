//! Spade's own skill store (ADR 0151) against ace's library on a fake daemon: a skill saved with
//! ace away lands in the store and outlives a restart, one saved with ace there goes to ace and
//! is copied back; a change notice replaces a copy and its files; a removed skill goes; a Spade
//! skill is added to ace's library on request; and a loaded skill's files land in the bot's
//! workspace, trusted until a command rewrites one.

#[path = "../../spade-ace/tests/support/fake_daemon.rs"]
#[allow(dead_code)]
mod fake_daemon;
mod support;

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use fake_daemon::{FakeDaemon, GUIDE, GUIDE_EDITED, LOCAL_TOKEN, REVIEW};
use serde_json::{Value, json};
use spade_ace::{AceSkills, LoopbackUrl, Secret, SkillsConfig};
use spade_server::clock::SystemClock;
use spade_server::skill_store::{AceSwitch, SkillStore};
use spade_server::tools::{EngineHandle, SkillLibrary, SkillLoad, Tool};
use spade_server::workspace::shell::Shell;
use spade_server::workspace::{Workspaces, workspace_tools};
use spade_store::Store;
use spade_testkit::Script;
use support::{Options, Result, Spade};

struct Setup {
    daemon: FakeDaemon,
    ace: Arc<AceSkills>,
    switch: Arc<AceSwitch>,
    dir: tempfile::TempDir,
}

impl Setup {
    async fn start() -> Result<Self> {
        let daemon = FakeDaemon::start().await;
        let url = LoopbackUrl::parse(&daemon.url())?;
        let config = SkillsConfig::new(
            url,
            Secret::new(LOCAL_TOKEN),
            "spade",
            Duration::from_secs(5),
        )?;
        Ok(Self {
            daemon,
            ace: Arc::new(AceSkills::new(config)),
            switch: Arc::new(AceSwitch::new(None)),
            dir: tempfile::tempdir()?,
        })
    }

    fn root(&self) -> PathBuf {
        self.dir.path().join("skills")
    }

    /// The store as Spade opens it on start (again after a restart).
    fn open(&self) -> Result<Arc<SkillStore>> {
        Ok(SkillStore::open(
            self.root(),
            Store::open(&self.dir.path().join("spade.sqlite"))?,
            Arc::new(SystemClock),
            Some(self.switch.clone()),
        ))
    }

    fn ace_there(&self) {
        self.switch.set(Some(self.ace.clone()));
    }
}

async fn names(library: &dyn SkillLibrary) -> Result<Vec<String>> {
    Ok(library.list().await?.into_iter().map(|s| s.name).collect())
}

/// Waits until `check` holds, for up to five seconds.
async fn until(what: &str, mut check: impl AsyncFnMut() -> bool) -> Result {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !check().await {
        if Instant::now() > deadline {
            return Err(format!("never: {what}").into());
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    Ok(())
}

#[tokio::test]
async fn a_skill_saved_with_ace_away_is_kept_in_the_store_and_offered_after_a_restart() -> Result {
    let setup = Setup::start().await?;
    let store = setup.open()?;
    let id = store
        .create("release-notes", "Write release notes", "Group by area.\n")
        .await?;
    assert!(id.starts_with("sks_"), "{id}");
    assert!(setup.daemon.writes().is_empty(), "nothing went to ace");
    assert!(
        store.create("release-notes", "Again", "x").await.is_err(),
        "a name the store holds is taken"
    );
    drop(store);

    let restarted = setup.open()?;
    assert_eq!(names(&*restarted).await?, ["release-notes"]);
    let text = restarted.read(&id).await?;
    assert!(text.starts_with("---\nname: release-notes\n"), "{text}");
    assert!(text.ends_with("Group by area.\n"), "{text}");
    let views = restarted.views()?;
    assert_eq!(views[0].origin, "spade");
    Ok(())
}

#[tokio::test]
async fn a_skill_saved_with_ace_there_goes_to_its_library_and_is_copied_back() -> Result {
    let setup = Setup::start().await?;
    setup.ace_there();
    let store = setup.open()?;
    store
        .create("release-notes", "Write release notes", "Group by area.\n")
        .await?;
    let writes = setup.daemon.writes();
    assert_eq!(writes.len(), 1);
    assert_eq!(writes[0]["op"], "create");
    let views = store.views()?;
    let copied = views
        .iter()
        .find(|v| v.name == "release-notes")
        .ok_or("not copied")?;
    assert_eq!(
        copied.origin, "ace",
        "the store holds ace's copy, not its own"
    );
    assert!(
        views.iter().all(|v| v.origin == "ace"),
        "{views:?}: nothing is kept as a Spade skill"
    );
    Ok(())
}

#[tokio::test]
async fn a_change_notice_replaces_a_copy_with_its_files_and_a_removed_skill_goes() -> Result {
    let setup = Setup::start().await?;
    setup.ace_there();
    let store = setup.open()?;
    let mirror = tokio::spawn(store.clone().run_mirror());
    let folder = setup.root().join(REVIEW);
    let read = |path: &Path| std::fs::read_to_string(path).unwrap_or_default();

    until("the library is copied with its files", async || {
        read(&folder.join("references/guide.md")) == GUIDE
    })
    .await?;
    assert!(folder.join("scripts/run.sh").exists());
    assert_eq!(store.files(REVIEW).await?.len(), 2);

    setup.daemon.edit_review();
    setup.daemon.push_change();
    until("the copy follows the change", async || {
        read(&folder.join("references/guide.md")) == GUIDE_EDITED
    })
    .await?;
    assert!(
        !folder.join("scripts/run.sh").exists(),
        "a file the skill no longer has is gone with the old copy"
    );

    // With ace away the last copy stays.
    setup.switch.set(None);
    assert!(names(&*store).await?.contains(&"review-code".to_owned()));

    setup.ace_there();
    setup.daemon.remove_review();
    setup.daemon.push_change();
    until("a removed skill goes", async || !folder.exists()).await?;
    assert!(!names(&*store).await?.contains(&"review-code".to_owned()));
    mirror.abort();
    Ok(())
}

#[tokio::test]
async fn a_spade_skill_is_added_to_aces_library_only_when_the_person_asks() -> Result {
    let setup = Setup::start().await?;
    let store = setup.open()?;
    let id = store
        .create("release-notes", "Write release notes", "Group by area.\n")
        .await?;
    assert!(
        store.add_to_ace(&id).await.is_err(),
        "with ace away there is nowhere to add it"
    );

    setup.ace_there();
    store.mirror_now().await?;
    assert!(
        setup.daemon.writes().is_empty(),
        "ace coming back sends nothing on its own"
    );
    store.add_to_ace(&id).await?;
    let writes = setup.daemon.writes();
    assert_eq!(writes.len(), 1);
    assert_eq!(writes[0]["name"], "release-notes");
    assert_eq!(writes[0]["body"], "Group by area.\n");
    let views = store.views()?;
    let origins: Vec<(&str, &str)> = views
        .iter()
        .filter(|v| v.name == "release-notes")
        .map(|v| (v.name.as_str(), v.origin))
        .collect();
    assert_eq!(
        origins,
        [("release-notes", "ace")],
        "the store's own copy is dropped once ace has it"
    );
    Ok(())
}

fn finished<'a>(events: &'a [Value], call: &str) -> Option<&'a Value> {
    events
        .iter()
        .find(|e| e["type"] == "tool_finished" && e["call_id"] == call)
}

#[cfg(unix)]
#[tokio::test]
async fn a_loaded_skills_files_are_trusted_in_the_workspace_until_a_command_rewrites_one() -> Result
{
    use std::os::unix::fs::PermissionsExt;

    let setup = Setup::start().await?;
    setup.ace_there();
    let store = setup.open()?;
    store.mirror_now().await?;
    let library: Arc<dyn SkillLibrary> = store.clone();
    let workspaces = Workspaces::new(setup.dir.path().join("workspace"));
    let bots = EngineHandle::default();
    let mut tools: Vec<Arc<dyn Tool>> =
        workspace_tools(workspaces.clone(), bots.clone(), Shell::system());
    tools.push(Arc::new(
        SkillLoad::new(library).with_workspaces(workspaces.clone(), bots.clone()),
    ));
    let guide = "skills/review-code/references/guide.md";
    let script = "skills/review-code/scripts/run.sh";
    let spade = Spade::start_with(
        vec![
            Script::reply("").call("load", "skill_load", json!({ "name": "review-code" })),
            Script::reply("").call("read", "workspace_read", json!({ "path": guide })),
            Script::reply("").call(
                "run",
                "shell",
                json!({ "command": format!("sh {script} && chmod u+w {guide} && echo changed > {guide}") }),
            ),
            Script::reply("").call("again", "workspace_read", json!({ "path": guide })),
            Script::reply("Done."),
        ],
        tools,
        Options {
            workspaces: Some(workspaces.clone()),
            ..Options::default()
        },
    )
    .await?;
    bots.set(&spade.engine);
    let agent = spade.new_agent("Reviewer", "").await?;
    let (bot, conversation) = (
        agent["id"].as_str().unwrap_or_default().to_owned(),
        agent["conversation"]
            .as_str()
            .unwrap_or_default()
            .to_owned(),
    );
    spade.say(&conversation, "Review the branch").await?;
    let events = spade.wait_for(&conversation, "approval_requested").await?;
    let asked: Vec<&Value> = events
        .iter()
        .filter(|e| e["type"] == "approval_requested")
        .collect();
    assert_eq!(asked.len(), 1, "only the command asks");
    assert_eq!(asked[0]["call_id"], "run");
    let loaded = finished(&events, "load").ok_or("the skill was not loaded")?;
    let content = loaded["content"].as_str().unwrap_or_default();
    assert!(content.contains("skills/review-code/"), "{content}");
    assert!(content.contains("scripts/run.sh"), "{content}");
    let read = finished(&events, "read").ok_or("the guide was not read")?;
    assert_eq!(
        read["untrusted"],
        Value::Null,
        "a skill's file is trusted: {read}"
    );
    assert!(
        read["content"]
            .as_str()
            .unwrap_or_default()
            .contains("Guide"),
        "{read}"
    );
    let on_disk = setup.dir.path().join("workspace").join(&bot);
    let mode = |path: &str| {
        std::fs::metadata(on_disk.join(path)).map_or(0, |m| m.permissions().mode() & 0o777)
    };
    assert_eq!(mode(guide), 0o444, "written read only");
    assert_eq!(mode(script), 0o555, "a script stays runnable, read only");

    let (status, _) = spade
        .post(
            &format!("/v1/conversations/{conversation}/approvals/run"),
            json!({ "allowed": true }),
        )
        .await?;
    assert_eq!(status, 202);
    let events = spade.wait_for(&conversation, "reply_finished").await?;
    let ran = finished(&events, "run").ok_or("the script did not run")?;
    assert!(
        ran["content"].as_str().unwrap_or_default().contains("hi"),
        "{ran}"
    );
    let again = finished(&events, "again").ok_or("the guide was not read again")?;
    assert_eq!(
        again["untrusted"], true,
        "a skill file a command rewrote is untrusted: {again}"
    );
    Ok(())
}

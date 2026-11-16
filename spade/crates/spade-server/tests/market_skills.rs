//! Skills installed from ace's marketplace (ADR 0168 §8) in Spade's store, against a fake daemon:
//! a market skill arrives with its files and serves every bot, read only; a new hash replaces the
//! copy whole; a skill the daemon stops listing goes; with ace away or its marketplace not
//! answering, the last copy stays.

#[path = "../../spade-ace/tests/support/fake_daemon.rs"]
#[allow(dead_code)]
mod fake_daemon;

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use fake_daemon::{FakeDaemon, LOCAL_TOKEN};
use spade_ace::{AceSkills, LoopbackUrl, Secret, SkillsConfig};
use spade_server::clock::SystemClock;
use spade_server::skill_store::{AceSwitch, SkillStore};
use spade_server::tools::SkillLibrary;
use spade_store::Store;

type Result<T = ()> = std::result::Result<T, Box<dyn std::error::Error>>;

const TRIAGE_MD: &[u8] = b"---\nname: triage-mail\ndescription: Sort mail\n---\nSort by sender.\n";
const TRIAGE_MD_2: &[u8] =
    b"---\nname: triage-mail\ndescription: Sort mail\n---\nSort by sender, then date.\n";

struct Setup {
    daemon: FakeDaemon,
    ace: Arc<AceSkills>,
    switch: Arc<AceSwitch>,
    dir: tempfile::TempDir,
}

impl Setup {
    async fn start() -> Result<Self> {
        let daemon = FakeDaemon::start().await;
        let config = SkillsConfig::new(
            LoopbackUrl::parse(&daemon.url())?,
            Secret::new(LOCAL_TOKEN),
            "spade",
            Duration::from_secs(5),
        )?;
        let ace = Arc::new(AceSkills::new(config));
        Ok(Self {
            daemon,
            switch: Arc::new(AceSwitch::new(Some(ace.clone()))),
            ace,
            dir: tempfile::tempdir()?,
        })
    }

    fn open(&self) -> Result<Arc<SkillStore>> {
        Ok(SkillStore::open(
            self.dir.path().join("skills"),
            Store::open(&self.dir.path().join("spade.sqlite"))?,
            Arc::new(SystemClock),
            Some(self.switch.clone()),
        ))
    }

    /// The market copy's folder, by its id in the store.
    fn folder(&self, store: &SkillStore, name: &str) -> Result<PathBuf> {
        let views = store.views()?;
        let view = views
            .iter()
            .find(|v| v.name == name && v.origin == "market")
            .ok_or_else(|| format!("{name} isn't a market skill in the store: {views:?}"))?;
        Ok(self.dir.path().join("skills").join(&view.id))
    }

    fn install_triage(&self) {
        self.daemon.set_market_skill(
            "triage-mail",
            "1.0.0",
            &[
                ("SKILL.md", TRIAGE_MD, false),
                ("references/rules.md", b"Bills first.\n", false),
                ("scripts/sort.sh", b"#!/bin/sh\necho sorted\n", true),
            ],
        );
    }
}

async fn names(library: &dyn SkillLibrary, agent: Option<&str>) -> Result<Vec<String>> {
    Ok(library
        .list_for(agent)
        .await?
        .into_iter()
        .map(|s| s.name)
        .collect())
}

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
async fn a_market_skill_reaches_the_store_with_its_files_and_serves_every_bot_read_only() -> Result
{
    let setup = Setup::start().await?;
    setup.install_triage();
    let store = setup.open()?;
    let sync = tokio::spawn(store.clone().run_market());
    until("the market skill is copied on start", async || {
        store
            .views()
            .is_ok_and(|v| v.iter().any(|v| v.origin == "market"))
    })
    .await?;
    let folder = setup.folder(&store, "triage-mail")?;
    assert_eq!(std::fs::read(folder.join("SKILL.md"))?, TRIAGE_MD);
    assert_eq!(
        std::fs::read(folder.join("references/rules.md"))?,
        b"Bills first.\n"
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(folder.join("scripts/sort.sh"))?
            .permissions()
            .mode();
        assert_eq!(mode & 0o111, 0o111, "an executable stays executable");
    }

    for bot in [None, Some("bot_1"), Some("bot_2")] {
        assert_eq!(names(&*store, bot).await?, ["triage-mail"], "{bot:?}");
    }
    let entries = store.list().await?;
    let id = entries[0].id.clone();
    assert!(store.read(&id).await?.ends_with("Sort by sender.\n"));
    let mut files: Vec<String> = store
        .files(&id)
        .await?
        .into_iter()
        .map(|f| f.path)
        .collect();
    files.sort();
    assert_eq!(files, ["references/rules.md", "scripts/sort.sh"]);
    let source = store.source("triage-mail").await?.ok_or("no source")?;
    assert!(!source.editable, "a market skill is read only");
    sync.abort();
    Ok(())
}

#[tokio::test]
async fn a_new_hash_replaces_the_copy_whole_and_a_skill_no_longer_listed_goes() -> Result {
    let setup = Setup::start().await?;
    setup.install_triage();
    let store = setup.open()?;
    let sync = tokio::spawn(store.clone().run_market());
    until("the first copy", async || {
        setup.folder(&store, "triage-mail").is_ok()
    })
    .await?;
    let folder = setup.folder(&store, "triage-mail")?;

    setup.daemon.set_market_skill(
        "triage-mail",
        "1.1.0",
        &[
            ("SKILL.md", TRIAGE_MD_2, false),
            ("references/senders.md", b"Family first.\n", false),
        ],
    );
    setup.daemon.push_market_change();
    until("the copy follows the new version", async || {
        std::fs::read(folder.join("SKILL.md")).is_ok_and(|b| b == TRIAGE_MD_2)
    })
    .await?;
    assert!(folder.join("references/senders.md").exists());
    assert!(
        !folder.join("references/rules.md").exists() && !folder.join("scripts").exists(),
        "files the new version doesn't have went with the old copy"
    );
    let id = store.list().await?[0].id.clone();
    assert_eq!(store.files(&id).await?.len(), 1);

    let asked = setup.daemon.market_requests();
    setup.daemon.push_market_change();
    until("a notice with nothing new is read", async || {
        setup.daemon.market_requests() > asked
    })
    .await?;
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(
        setup.daemon.market_requests(),
        asked + 1,
        "an unchanged hash is not copied again"
    );

    setup.daemon.remove_market_skill("triage-mail");
    setup.daemon.push_market_change();
    until("the removed skill goes", async || !folder.exists()).await?;
    assert!(names(&*store, None).await?.is_empty());
    sync.abort();
    Ok(())
}

#[tokio::test]
async fn with_ace_away_or_its_marketplace_not_answering_the_last_copy_stays() -> Result {
    let setup = Setup::start().await?;
    setup.install_triage();
    let store = setup.open()?;
    let synced = store.market_now().await?.ok_or("ace was there")?;
    assert_eq!(synced.copied, ["triage-mail"]);

    setup.daemon.remove_market_skill("triage-mail");
    setup.switch.set(None);
    assert_eq!(store.market_now().await?, None, "nothing to sync from");
    assert_eq!(names(&*store, Some("bot_1")).await?, ["triage-mail"]);

    setup.switch.set(Some(setup.ace.clone()));
    setup.daemon.market_unavailable(true);
    assert!(store.market_now().await.is_err());
    assert_eq!(
        names(&*store, Some("bot_1")).await?,
        ["triage-mail"],
        "a daemon that can't answer isn't one that dropped the skill"
    );
    drop(store);

    // After a restart, still there.
    let restarted = setup.open()?;
    assert_eq!(names(&*restarted, None).await?, ["triage-mail"]);
    setup.daemon.market_unavailable(false);
    let synced = restarted.market_now().await?.ok_or("ace was there")?;
    assert_eq!(synced.dropped, ["triage-mail"]);
    assert!(names(&*restarted, None).await?.is_empty());
    Ok(())
}

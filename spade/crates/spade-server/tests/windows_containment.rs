//! On Windows a bot's commands are `contained` only when they run as a Less Privileged
//! AppContainer: with no network, on folders Spade owns (ADR 0167, Windows amendment). A networked
//! run can't be one (`WSAStartup` fails under LPAC), and as a plain AppContainer it would keep
//! ambient read access to what every app package may read, so it keeps the review path with a
//! plain line. Process test: it starts the real AppContainer probe and takes real ACL grants.
#![cfg(windows)]

mod support;

use std::sync::Arc;

use serde_json::{Value, json};
use spade_sandbox::windows::NETWORK_REVIEW;
use spade_server::clock::{CountingIds, SystemClock};
use spade_server::security::{Security, Setup};
use spade_server::tools::EngineHandle;
use spade_server::workspace::shell::{Confine, Confinement, Kind};
use spade_store::Store;
use support::{Result, Spade};

#[tokio::test]
async fn a_networked_windows_bot_keeps_the_review_path_and_a_no_network_one_is_contained() -> Result
{
    let dir = tempfile::tempdir()?;
    let home = dir.path().join("home");
    let data = dir.path().join("data");
    std::fs::create_dir_all(&home)?;
    let spade = Spade::start_with(vec![], vec![], support::Options::default()).await?;
    let bots = EngineHandle::default();
    bots.set(&spade.engine);
    let security = Security::start(Setup {
        // The probe only needs to know Spade's own program exists; it makes a real AppContainer.
        runner: spade_sandbox::Runner::probe(Some(std::env::current_exe()?)),
        store: Store::open(&spade.database())?,
        home,
        spade_data: data.clone(),
        ace_data: None,
        workspaces: data.join("workspace"),
        log_dir: data.join("egress"),
        clock: Arc::new(SystemClock),
        ids: Arc::new(CountingIds::default()),
        bots,
    })
    .await;
    spade.engine.set_security(security.clone());
    assert!(
        security.contains(),
        "this machine should have the AppContainer sandbox"
    );
    let agent = spade.new_agent("Builder", "").await?;
    let bot = agent["id"].as_str().unwrap_or_default().to_owned();
    let workspace = data.join("workspace").join(&bot);
    std::fs::create_dir_all(&workspace)?;
    let view_path = format!("/v1/agents/{bot}/security");

    // The default network (the allow list) is networked: not contained, with the plain line, and
    // a run is sent to review rather than started.
    assert_eq!(
        security.bot_containment(&bot),
        (false, Some(NETWORK_REVIEW))
    );
    assert!(!Confine::contains(security.as_ref(), &workspace));
    match Confine::confine(security.as_ref(), &workspace, &Kind::Command)? {
        Confinement::NeedsReview(line) => assert_eq!(line, NETWORK_REVIEW),
        _ => panic!("a networked run must need review, not be contained or run plainly"),
    }
    let (_, view): (u16, Value) = spade.get(&view_path).await?;
    assert_eq!(view["contained"], json!(false), "{view}");
    assert_eq!(view["reason"], json!(NETWORK_REVIEW), "{view}");

    // With its network off, the same bot's runs are an LPAC on Spade-owned folders: contained.
    let (status, set) = spade
        .put(&format!("{view_path}/network"), json!({"mode": "off"}))
        .await?;
    assert_eq!(status, 200, "{set}");
    assert_eq!(security.bot_containment(&bot), (true, None));
    assert!(Confine::contains(security.as_ref(), &workspace));
    match Confine::confine(security.as_ref(), &workspace, &Kind::Command)? {
        // Held, then dropped: the run's grants and profile are taken back.
        Confinement::Contained(confined) => drop(confined),
        _ => panic!("a no-network run on Spade's own folders must be contained"),
    }
    let (_, view): (u16, Value) = spade.get(&view_path).await?;
    assert_eq!(view["contained"], json!(true), "{view}");
    assert_eq!(view["reason"], Value::Null, "{view}");
    Ok(())
}

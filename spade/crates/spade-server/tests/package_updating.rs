//! A packaged bot reads `updating` while an update or a rollback is being applied to it (ADR 0200
//! §6.2), in the task manager and in the bot list, and it counts as working there: never at rest
//! or done until the step committed. A step a crash cut short reads the same while it is taken
//! again at the next start. Each step is held mid-way through the engine's test hook.

mod support;

use std::sync::mpsc;
use std::sync::{Arc, Mutex};

use serde_json::{Value, json};
use spade_server::engine::Engine;
use support::packaged::*;
use support::{Options, Result, Spade};

/// The bot's row in `GET /v1/running`: its state, how it reads and its words.
async fn row(spade: &Spade, bot: &str) -> Result<(Value, Value, Value)> {
    let (status, body) = spade.get("/v1/running").await?;
    assert_eq!(status, 200, "{body}");
    let row = body["bots"]
        .as_array()
        .and_then(|rows| rows.iter().find(|r| r["id"] == bot).cloned())
        .ok_or("the bot isn't in the running view")?;
    Ok((
        row["state"].clone(),
        row["reads"].clone(),
        row["doing"].clone(),
    ))
}

/// The bot in `GET /v1/agents`: its state and whether it reads as working.
async fn listed(spade: &Spade, bot: &str) -> Result<(Value, Value)> {
    let (status, body) = spade.get("/v1/agents").await?;
    assert_eq!(status, 200, "{body}");
    let agent = body["agents"]
        .as_array()
        .and_then(|all| all.iter().find(|a| a["id"] == bot).cloned())
        .ok_or("the bot isn't listed")?;
    Ok((agent["state"].clone(), agent["working"].clone()))
}

/// Holds every package step once it has marked its bot: `entered` hears it, and it goes on once
/// `go` is sent.
struct Held {
    entered: Arc<Mutex<mpsc::Receiver<()>>>,
    go: mpsc::Sender<()>,
}

fn hold_steps(engine: &Engine) -> Held {
    let (entered_tx, entered) = mpsc::channel();
    let (go, go_rx) = mpsc::channel::<()>();
    let (entered_tx, go_rx) = (Mutex::new(entered_tx), Mutex::new(go_rx));
    engine.hold_registrations(Arc::new(move |what, _| {
        if what == "package_step" {
            let _ = entered_tx.lock().map(|tx| tx.send(()));
            let _ = go_rx.lock().map(|rx| rx.recv());
        }
    }));
    Held {
        entered: Arc::new(Mutex::new(entered)),
        go,
    }
}

impl Held {
    async fn entered(&self) -> Result {
        let entered = self.entered.clone();
        tokio::task::spawn_blocking(move || {
            entered
                .lock()
                .map_err(|_| "poisoned")?
                .recv_timeout(std::time::Duration::from_secs(10))
                .map_err(|_| "the step never started")
        })
        .await??;
        Ok(())
    }
}

/// Moves `bot` to `version`, reading it while the step is held: its row and its listing then.
async fn observed_move(
    spade: &Spade,
    held: &Held,
    bot: &str,
    version: &str,
    transaction: &str,
) -> Result<((Value, Value, Value), (Value, Value))> {
    let watch = async {
        held.entered().await?;
        let during = (row(spade, bot).await?, listed(spade, bot).await?);
        held.go.send(()).map_err(|_| "the step is gone")?;
        Ok::<_, Box<dyn std::error::Error + Send + Sync>>(during)
    };
    let (moved, during) = tokio::join!(move_to(spade, bot, version, transaction), watch);
    assert_eq!(moved?["version"], version);
    Ok(during.map_err(|e| e.to_string())?)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_bot_reads_updating_while_its_update_or_rollback_is_applied_and_at_rest_after() -> Result
{
    let spade = secured(Vec::new(), Vec::new()).await?;
    let bot = text(&installed(&spade, hosts_on(), false).await?["id"]);
    assert_eq!(row(&spade, &bot).await?.1, "idle");
    let held = hold_steps(&spade.engine);

    let updating = (json!("updating"), json!("working"), json!("Updating"));
    let listed_updating = (json!("updating"), json!(true));
    let during = observed_move(&spade, &held, &bot, "2.0.0", "u2").await?;
    assert_eq!(
        during,
        (updating.clone(), listed_updating.clone()),
        "the update"
    );
    assert_eq!(
        row(&spade, &bot).await?.1,
        "idle",
        "at rest once it committed"
    );
    assert_eq!(listed(&spade, &bot).await?, (json!("idle"), json!(false)));

    let during = observed_move(&spade, &held, &bot, "1.0.0", "back").await?;
    assert_eq!(during, (updating, listed_updating), "the rollback");
    assert_eq!(row(&spade, &bot).await?.1, "idle");
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_update_a_crash_cut_short_reads_updating_while_it_is_taken_again_at_start() -> Result {
    let spade = Spade::start(Vec::new(), Vec::new()).await?;
    secure(&spade).await?;
    let bot = text(&installed(&spade, hosts_on(), false).await?["id"]);
    // As a crash leaves an update to 2.0.0: the step written down, nothing of it done yet.
    let Some(mut link) = spade.engine.bot_package(&bot) else {
        panic!("the bot is linked");
    };
    link.pending = Some(spade_core::package::link::Pending {
        transaction: "update-crashed".to_owned(),
        package: serde_json::from_value(package("2.0.0"))?,
        manifest: spade_server::packages::manifest(&watcher("2.0.0"))
            .unwrap_or_else(|e| panic!("{e}")),
        routines: Default::default(),
        notes_added: Vec::new(),
        notes_removed: Vec::new(),
        proof: Some(sealed("2.0.0")),
    });
    spade.engine.set_bot_package(&bot, &link)?;

    // At the next start the step is taken again; what the task manager says meanwhile is kept.
    let seen: Arc<Mutex<Vec<(String, String)>>> = Arc::default();
    let (seen_by, of) = (seen.clone(), bot.clone());
    let spade = spade
        .restart_with(
            Vec::new(),
            Vec::new(),
            Options {
                before_work: Some(Arc::new(move |engine: &Arc<Engine>| {
                    let (weak, seen, of) = (Arc::downgrade(engine), seen_by.clone(), of.clone());
                    engine.hold_registrations(Arc::new(move |what, _| {
                        let Some(engine) = weak.upgrade() else { return };
                        if what != "package_step" {
                            return;
                        }
                        let rows = engine.running().unwrap_or_default();
                        if let Some(row) = rows.iter().find(|r| r.id == of)
                            && let Ok(mut seen) = seen.lock()
                        {
                            seen.push((row.state.name().to_owned(), format!("{:?}", row.reads)));
                        }
                    }));
                })),
                ..Options::default()
            },
        )
        .await?;
    let seen = seen.lock().map_err(|_| "poisoned")?.clone();
    assert_eq!(seen, vec![("updating".to_owned(), "Working".to_owned())]);
    let (_, body) = spade.get(&format!("/v1/agents/{bot}/package")).await?;
    assert_eq!(body["package"]["version"], "2.0.0", "{body}");
    assert_eq!(
        row(&spade, &bot).await?.1,
        "idle",
        "at rest once it committed"
    );
    Ok(())
}

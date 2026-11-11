//! Spade listens at once, whatever the keychain does: a keychain read can block for many seconds
//! (a prompt for a re-signed binary), and nothing before bind may wait on it.

mod support;

use std::time::{Duration, Instant};

use serde_json::json;
use spade_testkit::Script;
use support::{Options, Result, Spade};

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn with_a_keychain_that_blocks_spade_still_answers_health_at_once() -> Result {
    let started = Instant::now();
    let spade = Spade::start_with(
        vec![
            Script::reply("Hello."),
            Script::reply("").plain(r#"{"title":"Hi"}"#),
        ],
        Vec::new(),
        Options {
            keychain_delay: Some(Duration::from_secs(1)),
            ..Options::default()
        },
    )
    .await?;
    let health = spade
        .http
        .get(format!("{}/health", spade.base))
        .timeout(Duration::from_secs(1))
        .send()
        .await?;
    assert_eq!(health.status().as_u16(), 200);
    assert!(
        started.elapsed() < Duration::from_millis(1_500),
        "listening took {:?}",
        started.elapsed()
    );

    // The API answers meanwhile too.
    let asked = Instant::now();
    let (status, _) = spade.get("/v1/agents").await?;
    assert_eq!(status, 200);
    assert!(
        asked.elapsed() < Duration::from_secs(1),
        "{:?}",
        asked.elapsed()
    );

    // Once the keychain answers, setup finishes: Spade exists and agents work.
    tokio::time::timeout(Duration::from_secs(30), spade.engine.settled()).await?;
    let (_, list) = spade.get("/v1/agents").await?;
    assert_eq!(
        list["agents"][0]["kind"],
        json!("main"),
        "Spade is created once settled"
    );
    let conversation = spade.ask("Hi").await?;
    let events = spade.wait_for(&conversation, "reply_finished").await?;
    assert!(
        events
            .iter()
            .any(|e| e["type"] == "reply_finished" && e["text"] == "Hello.")
    );
    Ok(())
}

//! A model step that fails before anything streamed is sent again (docs/harness.md, Model calls),
//! through the real engine and API on a scripted fake endpoint. Each answered call costs 92
//! micros (11 tokens in at $2/M, 7 out at $10/M); a refused one costs nothing.

mod support;

use std::time::{Duration, Instant};

use serde_json::{Value, json};
use spade_server::engine::Retry;
use spade_testkit::Script;
use support::{Options, Result, Spade};

fn title() -> Script {
    Script::reply("").plain(r#"{"title":"A title"}"#)
}

fn retry(first_wait: Duration) -> Options {
    Options {
        model_retry: Some(Retry {
            tries: 3,
            first_wait,
            longest: Duration::from_secs(20),
        }),
        ..Options::default()
    }
}

async fn bot(spade: &Spade, conversation: &str) -> Result<Value> {
    let (_, body) = spade.get("/v1/agents").await?;
    Ok(body["agents"]
        .as_array()
        .and_then(|list| list.iter().find(|a| a["conversation"] == conversation))
        .cloned()
        .unwrap_or_default())
}

/// Waits until the bot's status line reads `status`.
async fn status_reads(spade: &Spade, conversation: &str, status: &str) -> Result {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if bot(spade, conversation).await?["status"] == status {
            return Ok(());
        }
        if Instant::now() > deadline {
            return Err(format!("the status never read {status}").into());
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

fn streamed(spade: &Spade) -> usize {
    spade
        .fake
        .seen()
        .iter()
        .filter(|s| s.body["stream"] == true)
        .count()
}

#[tokio::test]
async fn a_reply_refused_twice_before_anything_streamed_is_sent_again_and_paid_for_once() -> Result
{
    let spade = Spade::start_with(
        vec![
            Script::failing(503),
            Script::failing(429).retry_after("0"),
            Script::reply("Here you go."),
            title(),
        ],
        Vec::new(),
        retry(Duration::from_millis(300)),
    )
    .await?;
    let id = spade.ask("Hello").await?;
    status_reads(&spade, &id, "Retrying").await?;
    let events = spade.wait_for(&id, "reply_finished").await?;
    let finished = events
        .iter()
        .find(|e| e["type"] == "reply_finished")
        .cloned()
        .unwrap_or_default();
    assert_eq!(finished["text"], "Here you go.");
    assert!(
        !events.iter().any(|e| e["type"] == "reply_failed"),
        "the person never sees the refusals"
    );
    assert_eq!(streamed(&spade), 3, "two refusals, then the answer");
    spade.wait_for(&id, "renamed").await?;
    // The reply and its title were answered; the two refusals were never billed.
    assert_eq!(bot(&spade, &id).await?["spending"]["today_micros"], 2 * 92);
    Ok(())
}

#[tokio::test]
async fn stop_ends_the_wait_before_a_retry_and_nothing_more_is_sent() -> Result {
    let spade = Spade::start_with(
        vec![Script::failing(502), Script::reply("Too late."), title()],
        Vec::new(),
        retry(Duration::from_secs(10)),
    )
    .await?;
    let id = spade.ask("Hello").await?;
    status_reads(&spade, &id, "Retrying").await?;
    let (status, _) = spade
        .post(&format!("/v1/conversations/{id}/stop"), json!({}))
        .await?;
    assert_eq!(status, 202);
    spade.wait_for(&id, "reply_stopped").await?;
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(streamed(&spade), 1, "the retry was never sent");
    Ok(())
}

#[tokio::test]
async fn a_request_the_endpoint_refuses_for_good_fails_at_once_without_a_retry() -> Result {
    let spade = Spade::start_with(
        vec![Script::failing(400), Script::reply("Never."), title()],
        Vec::new(),
        retry(Duration::from_millis(10)),
    )
    .await?;
    let id = spade.ask("Hello").await?;
    spade.wait_for(&id, "reply_failed").await?;
    assert_eq!(streamed(&spade), 1);
    Ok(())
}

#[tokio::test]
async fn an_endpoint_that_keeps_failing_is_tried_three_times_then_the_reply_fails() -> Result {
    let spade = Spade::start_with(
        vec![
            Script::failing(503),
            Script::failing(503),
            Script::failing(503),
            title(),
        ],
        Vec::new(),
        retry(Duration::from_millis(10)),
    )
    .await?;
    let id = spade.ask("Hello").await?;
    let events = spade.wait_for(&id, "reply_failed").await?;
    assert_eq!(streamed(&spade), 3);
    assert!(
        events
            .iter()
            .find(|e| e["type"] == "reply_failed")
            .and_then(|e| e["error"].as_str())
            .is_some_and(|e| e.contains("503")),
        "{events:?}"
    );
    Ok(())
}

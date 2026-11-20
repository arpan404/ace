//! Replies read aloud by the person's own endpoint through the real server (ADR 0134, amended;
//! docs/media.md): `POST /v1/speech` streams the endpoint's audio as it arrives.

mod support;

use std::time::Duration;

use serde_json::json;
use spade_testkit::{FakeMedia, SPEECH_REST, SPEECH_START, Script};
use support::{Result, Spade, TOKEN};

/// A saved endpoint served by `media`, with one model the person may pick to speak.
async fn voice_endpoint(spade: &Spade, media: &FakeMedia) -> Result {
    let (status, body) = spade
        .post(
            "/v1/endpoints",
            json!({ "name": "Voice", "format": "openai-chat", "base_url": media.root, "needs_key": false }),
        )
        .await?;
    assert_eq!(status, 201, "{body}");
    let (status, body) = spade
        .post(
            "/v1/endpoints/voice/models",
            json!({ "id": "say-1", "capabilities": ["speech"] }),
        )
        .await?;
    assert!(status < 300, "{body}");
    Ok(())
}

async fn speak(spade: &Spade, body: serde_json::Value) -> Result<reqwest::Response> {
    Ok(spade
        .http
        .post(format!("{}/v1/speech", spade.base))
        .bearer_auth(TOKEN)
        .json(&body)
        .send()
        .await?)
}

#[tokio::test]
async fn speech_streams_the_endpoints_audio_before_the_endpoint_has_finished() -> Result {
    let media = FakeMedia::start(b"", "").await?;
    let spade = Spade::start(vec![Script::reply("unused")], Vec::new()).await?;
    let words = json!({ "text": "The flight leaves at nine.", "voice": "nova" });
    assert_eq!(
        speak(&spade, words.clone()).await?.status(),
        409,
        "no model picked yet"
    );

    voice_endpoint(&spade, &media).await?;
    let (status, body) = spade
        .put("/v1/settings", json!({ "speech_model": "voice/say-1" }))
        .await?;
    assert_eq!(status, 204, "{body}");
    let (_, models) = spade.get("/v1/models").await?;
    assert_eq!(models["speech_model"], "voice/say-1");

    let mut answer = speak(&spade, words).await?;
    assert_eq!(answer.status(), 200);
    assert_eq!(
        answer
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok()),
        Some("audio/mpeg")
    );
    // The endpoint still holds the rest of its audio: what it sent already reaches the app.
    let mut heard = Vec::new();
    while heard.len() < SPEECH_START.len() {
        let chunk = tokio::time::timeout(Duration::from_secs(10), answer.chunk())
            .await??
            .ok_or("the audio ended early")?;
        heard.extend_from_slice(&chunk);
    }
    assert_eq!(heard, SPEECH_START);
    media.finish_speech();
    while let Some(chunk) = answer.chunk().await? {
        heard.extend_from_slice(&chunk);
    }
    assert_eq!(heard, [SPEECH_START, SPEECH_REST].concat());

    let asked = media.seen();
    assert_eq!(asked[0].path, "/audio/speech");
    let sent: serde_json::Value = serde_json::from_slice(&asked[0].body)?;
    assert_eq!(
        (&sent["model"], &sent["input"], &sent["voice"]),
        (
            &json!("say-1"),
            &json!("The flight leaves at nine."),
            &json!("nova")
        )
    );
    Ok(())
}

#[tokio::test]
async fn speech_refuses_empty_words_and_odd_voices_without_calling_the_endpoint() -> Result {
    let media = FakeMedia::start(b"", "").await?;
    let spade = Spade::start(vec![Script::reply("unused")], Vec::new()).await?;
    voice_endpoint(&spade, &media).await?;
    spade
        .put("/v1/settings", json!({ "speech_model": "voice/say-1" }))
        .await?;
    for body in [
        json!({ "text": "  " }),
        json!({ "text": "Hello", "voice": "../../etc" }),
        json!({ "text": "x".repeat(5_000) }),
    ] {
        assert_eq!(speak(&spade, body.clone()).await?.status(), 400, "{body}");
    }
    assert!(media.seen().is_empty());
    // A subscription model has no speech route.
    let (status, _) = spade
        .put("/v1/settings", json!({ "speech_model": "cli:codex/gpt-5" }))
        .await?;
    assert_eq!(status, 400);
    Ok(())
}

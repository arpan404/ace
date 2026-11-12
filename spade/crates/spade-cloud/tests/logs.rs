//! What the service logs. Its own test binary: tracing caches which call sites are wanted per
//! process, so a capture in a binary whose other tests log to nobody can miss lines.

mod support;

use spade_cloud_wire::OneTimeKey;
use support::{Cloud, ISSUER, Options, Result, SECRET, VERIFIER, capture_logs, fail};

#[tokio::test(flavor = "current_thread")]
async fn the_logs_name_the_account_app_and_outcome_but_never_a_credential() -> Result {
    let (logs, _guard) = capture_logs();
    let cloud = Cloud::start(Options::default()).await?;
    let (started, _key) = cloud.begin("asana", "user_logged").await?;
    cloud
        .callback(&[
            ("code", "code-1"),
            ("state", &started.state),
            ("iss", ISSUER),
        ])
        .await?;
    cloud
        .finish("asana", "user_logged", &started.sign_in, VERIFIER)
        .await?;
    let grant = cloud.grant("user_logged", "machine");
    let key = OneTimeKey::generate(&ring::rand::SystemRandom::new()).map_err(fail)?;
    cloud
        .post(
            "/v1/oauth/asana/refresh",
            Some(&grant),
            serde_json::json!({"refresh_token": "refresh-1", "public_key": key.public_key()}),
        )
        .await?;
    let text = logs.text();
    assert!(
        text.contains("user_logged") && text.contains("asana"),
        "{text}"
    );
    assert!(text.contains("\"outcome\":\"ok\""), "{text}");
    for secret in [
        "access-1",
        "access-2",
        "refresh-1",
        "code-1",
        VERIFIER,
        SECRET,
        started.state.as_str(),
        started.sign_in.as_str(),
        grant.as_str(),
    ] {
        assert!(!text.contains(secret), "the logs hold {secret}: {text}");
    }
    Ok(())
}

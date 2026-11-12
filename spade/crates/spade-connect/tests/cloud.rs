//! Apps that sign in through Spade Cloud (ADR 0140), against a fake cloud: the tokens it seals
//! end up in the keychain, renewals go through it, a connected app outlives the cloud being
//! away, and without an ace account nothing starts.

mod support;

use spade_connect::{ConnectError, ConnectRequest, Started};
use spade_testkit::{FakeCloud, FakeConnector};
use support::{FAKE_ENTRY, Result, app_tools, from_catalogue, spade_with_cloud, wait_for};

#[tokio::test]
async fn signing_in_through_spade_cloud_keeps_the_sealed_tokens_in_the_keychain() -> Result {
    let app = FakeConnector::start(app_tools()).await;
    app.accept_token("access-1");
    let cloud = FakeCloud::start(3600).await;
    let spade = spade_with_cloud(&app.url(), &cloud.url(), true)?;

    let Started::SignIn { id, url } = spade.connectors.connect(from_catalogue()).await? else {
        return Err("expected a browser sign-in".into());
    };
    assert_eq!(id, FAKE_ENTRY);
    assert!(
        url.starts_with("https://auth.maker.example/authorize"),
        "{url}"
    );
    let waiting = spade
        .connectors
        .get(&id)
        .ok_or("no view while signing in")?;
    assert_eq!((waiting.state, waiting.via), ("signing_in", Some("cloud")));

    cloud.approve();
    wait_for(|| {
        spade
            .connectors
            .get(&id)
            .is_some_and(|v| v.state == "connected" && v.tools == 3)
    })
    .await?;
    let view = spade.connectors.get(&id).ok_or("gone")?;
    assert_eq!(view.via, Some("cloud"));
    assert_eq!(view.notice, None);
    assert_eq!(
        spade.keys.connector_secret(&id, "access")?.as_deref(),
        Some("access-1")
    );
    assert_eq!(
        spade.keys.connector_secret(&id, "refresh")?.as_deref(),
        Some("refresh-1")
    );
    let database = std::fs::read(&spade.database)?;
    for token in ["access-1", "refresh-1"] {
        assert!(
            !database.windows(token.len()).any(|w| w == token.as_bytes()),
            "{token} in the database"
        );
    }
    Ok(())
}

#[tokio::test]
async fn a_token_about_to_expire_is_renewed_through_spade_cloud() -> Result {
    let app = FakeConnector::start(app_tools()).await;
    // Only the renewed token is accepted, so the app connects only after a renewal.
    app.accept_token("access-2");
    let cloud = FakeCloud::start(30).await;
    let spade = spade_with_cloud(&app.url(), &cloud.url(), true)?;
    spade.connectors.connect(from_catalogue()).await?;
    cloud.approve();
    wait_for(|| {
        spade
            .connectors
            .get(FAKE_ENTRY)
            .is_some_and(|v| v.state == "connected" && v.tools == 3)
    })
    .await?;
    assert_eq!(
        cloud.refreshes().first().map(String::as_str),
        Some("refresh-1")
    );
    assert_eq!(
        spade
            .keys
            .connector_secret(FAKE_ENTRY, "access")?
            .as_deref(),
        Some("access-2")
    );
    assert_eq!(
        spade
            .keys
            .connector_secret(FAKE_ENTRY, "refresh")?
            .as_deref(),
        Some("refresh-2"),
        "a rotated refresh token is kept"
    );
    Ok(())
}

#[tokio::test]
async fn with_spade_cloud_away_a_connected_app_keeps_working_and_says_so() -> Result {
    let app = FakeConnector::start(app_tools()).await;
    app.accept_token("access-1");
    let cloud = FakeCloud::start(30).await;
    cloud.refresh_down();
    let spade = spade_with_cloud(&app.url(), &cloud.url(), true)?;
    spade.connectors.connect(from_catalogue()).await?;
    cloud.approve();
    wait_for(|| {
        spade
            .connectors
            .get(FAKE_ENTRY)
            .is_some_and(|v| v.state == "connected" && v.tools == 3)
    })
    .await?;
    let view = spade.connectors.get(FAKE_ENTRY).ok_or("gone")?;
    assert_eq!(view.notice, Some("cloud_unreachable"));
    cloud.stop();
    spade
        .connectors
        .call(
            FAKE_ENTRY,
            "echo",
            serde_json::json!({ "say": "still here" }),
        )
        .await?;
    Ok(())
}

#[tokio::test]
async fn without_an_ace_account_signing_in_through_spade_cloud_says_to_sign_in_to_ace() -> Result {
    let app = FakeConnector::start(app_tools()).await;
    let cloud = FakeCloud::start(3600).await;
    let spade = spade_with_cloud(&app.url(), &cloud.url(), false)?;
    let refused = spade.connectors.connect(from_catalogue()).await;
    assert!(
        matches!(refused, Err(ConnectError::NeedsAceAccount)),
        "{refused:?}"
    );
    assert_eq!(cloud.starts(), 0, "the cloud was never asked");
    assert!(spade.connectors.get(FAKE_ENTRY).is_none());
    Ok(())
}

#[tokio::test]
async fn the_persons_own_client_id_signs_in_directly_not_through_spade_cloud() -> Result {
    let app = FakeConnector::start(app_tools()).await;
    let cloud = FakeCloud::start(3600).await;
    let spade = spade_with_cloud(&app.url(), &cloud.url(), true)?;
    let started = spade
        .connectors
        .connect(ConnectRequest {
            client_id: Some("my-own-client".into()),
            client_secret: Some("my-own-secret".into()),
            ..from_catalogue()
        })
        .await?;
    let Started::SignIn { url, .. } = started else {
        return Err("expected a browser sign-in".into());
    };
    assert!(url.starts_with(&app.issuer()), "{url}");
    assert_eq!(cloud.starts(), 0);
    Ok(())
}

#[tokio::test]
async fn disconnect_during_cloud_start_cannot_restore_a_pending_sign_in() -> Result {
    let app = FakeConnector::start(app_tools()).await;
    let cloud = FakeCloud::start(3600).await;
    let release = cloud.hold_starts();
    let spade = spade_with_cloud(&app.url(), &cloud.url(), true)?;
    let connectors = spade.connectors.clone();
    let starting = tokio::spawn(async move { connectors.connect(from_catalogue()).await });
    wait_for(|| cloud.starts() == 1).await?;
    spade.connectors.disconnect(FAKE_ENTRY).await?;
    release.notify_one();
    assert!(starting.await?.is_err());
    cloud.approve();
    assert!(spade.connectors.get(FAKE_ENTRY).is_none());
    assert!(spade.keys.connector_secret(FAKE_ENTRY, "access")?.is_none());
    Ok(())
}

//! Spade's own registered apps (ADR 0137): a shipped public client ID signs the person in with
//! PKCE and no secret, or through the device grant (RFC 8628), against a fake app on 127.0.0.1.

use std::collections::BTreeSet;
use std::time::Duration;

use spade_connect::{Access, App, ConnectError, ConnectRequest, Grant, Started, View};
use spade_keys::KeyStore;
use spade_testkit::FakeConnector;

mod support;
use support::*;

const PUBLIC_ID: &str = "spade-public-client";

fn app_for(fake: &FakeConnector, grant: Grant) -> App {
    App {
        connector: FAKE_ENTRY.into(),
        issuer: fake.issuer(),
        client_id: PUBLIC_ID.into(),
        grant,
        scopes: Some(vec!["read".into(), "write".into()]),
        source: "https://example.com/docs".into(),
    }
}

fn no_client_secret(keys: &KeyStore, id: &str) -> Result {
    assert_eq!(keys.connector_secret(id, "client_secret")?, None);
    Ok(())
}

fn query(url: &str) -> Result<std::collections::HashMap<String, String>> {
    Ok(url::Url::parse(url)?.query_pairs().into_owned().collect())
}

#[tokio::test]
async fn a_shipped_public_client_signs_in_with_pkce_its_exact_callback_and_no_secret() -> Result {
    let fake = FakeConnector::start(app_tools()).await;
    fake.without_registration();
    fake.register_public_client(PUBLIC_ID, "http://127.0.0.1/v1/connectors/callback/fake");
    let spade = spade_shipping(&fake.url(), vec![app_for(&fake, Grant::Browser)])?;
    let url = sign_in_url(&spade, from_catalogue()).await?;
    let asked = query(&url)?;
    assert_eq!(asked["client_id"], PUBLIC_ID);
    assert_eq!(
        asked["redirect_uri"],
        "http://127.0.0.1:4555/v1/connectors/callback/fake"
    );
    assert_eq!(asked["code_challenge_method"], "S256");
    assert_eq!(asked["scope"], "read write");
    let back = fake.approve(&url).await;
    let view = spade.connectors.finish(callback(&back)?).await?;
    wait_for(|| spade.connectors.get(&view.id).is_some_and(|v| v.tools == 3)).await?;
    // Renewing goes without a secret too: the refused call renews, and the next one runs.
    fake.expire_access_tokens();
    let echo = || {
        spade
            .connectors
            .call(&view.id, "echo", serde_json::json!({ "say": "hi" }))
    };
    if echo().await.is_err() {
        echo().await?;
    }
    assert!(fake.token_requests() >= 2, "no refresh happened");
    assert_eq!(fake.secrets_sent(), 0);
    assert_eq!(fake.registrations(), 0);
    no_client_secret(&spade.keys, &view.id)
}

#[tokio::test]
async fn a_shipped_app_takes_no_client_secret_and_nothing_is_sent_when_one_is_offered() -> Result {
    let fake = FakeConnector::start(app_tools()).await;
    fake.offer_device_flow(PUBLIC_ID, 1, 900);
    let spade = spade_shipping(&fake.url(), vec![app_for(&fake, Grant::Device)])?;
    for request in [
        ConnectRequest {
            client_secret: Some("shh".into()),
            ..from_catalogue()
        },
        ConnectRequest {
            client_id: Some(PUBLIC_ID.into()),
            client_secret: Some("shh".into()),
            ..from_catalogue()
        },
    ] {
        match spade.connectors.connect(request).await {
            Err(ConnectError::Invalid(why)) => assert!(why.contains("no client secret"), "{why}"),
            other => return Err(format!("expected a refusal, got {other:?}").into()),
        }
    }
    assert!(fake.device_asked().is_empty());
    assert_eq!(fake.token_requests() + fake.secrets_sent(), 0);
    Ok(())
}

async fn device_sign_in(spade: &Spade) -> Result<(String, String, String)> {
    match spade.connectors.connect(from_catalogue()).await? {
        Started::Device { id, code, url, .. } => Ok((id, code, url)),
        other => Err(format!("expected a device sign-in, got {other:?}").into()),
    }
}

async fn ended(spade: &Spade, id: &str) -> Result<View> {
    wait_for(|| {
        spade
            .connectors
            .get(id)
            .is_some_and(|v| v.device.as_ref().is_some_and(|d| !d.waiting()))
    })
    .await?;
    spade.connectors.get(id).ok_or_else(|| "gone".into())
}

#[tokio::test]
async fn a_device_sign_in_shows_the_code_waits_slows_down_when_told_and_connects() -> Result {
    let fake = FakeConnector::start(app_tools()).await;
    fake.offer_device_flow(PUBLIC_ID, 2, 900);
    fake.answer_device_polls(&["authorization_pending", "slow_down", "approve"]);
    let spade = spade_shipping(&fake.url(), vec![app_for(&fake, Grant::Device)])?;
    let (id, code, url) = device_sign_in(&spade).await?;
    assert_eq!(code, "WDJB-MJHT");
    assert_eq!(
        url,
        format!("{}/device", fake.url().trim_end_matches("/mcp"))
    );
    let asked = fake.device_asked();
    assert_eq!(asked["client_id"], PUBLIC_ID);
    assert_eq!(asked["scope"], "read write");
    assert_eq!(asked["resource"], fake.url());
    let waiting = spade.connectors.get(&id).ok_or("not listed")?;
    assert_eq!(waiting.state, "signing_in");
    let device = waiting.device.ok_or("no code shown")?;
    assert_eq!(
        (device.code.as_str(), device.state),
        ("WDJB-MJHT", "waiting")
    );

    wait_for(|| {
        spade
            .connectors
            .get(&id)
            .is_some_and(|v| v.state == "connected" && v.tools == 3 && v.device.is_none())
    })
    .await?;
    let polls = fake.device_polls();
    assert_eq!(polls.len(), 3);
    // Two seconds between polls, then seven after `slow_down`.
    assert!(polls[1] - polls[0] >= TICK * 2, "{:?}", polls[1] - polls[0]);
    assert!(polls[2] - polls[1] >= TICK * 7, "{:?}", polls[2] - polls[1]);
    assert_eq!(fake.secrets_sent(), 0);
    no_client_secret(&spade.keys, &id)?;
    let call = spade
        .connectors
        .call(&id, "echo", serde_json::json!({ "say": "hi" }))
        .await?;
    assert!(!call.is_error);
    Ok(())
}

#[tokio::test]
async fn a_device_code_that_expires_or_is_declined_says_so_and_connects_nothing() -> Result {
    for (answer, state) in [("expired_token", "expired"), ("access_denied", "denied")] {
        let fake = FakeConnector::start(app_tools()).await;
        fake.offer_device_flow(PUBLIC_ID, 1, 900);
        fake.answer_device_polls(&["authorization_pending", answer]);
        let spade = spade_shipping(&fake.url(), vec![app_for(&fake, Grant::Device)])?;
        let (id, _, _) = device_sign_in(&spade).await?;
        let view = ended(&spade, &id).await?;
        assert_eq!(view.device.map(|d| d.state), Some(state), "{answer}");
        assert_eq!(view.state, "needs_reconnect", "{answer}");
        assert_eq!(spade.keys.connector_secret(&id, "access")?, None);
        // No more polls once it ended.
        tokio::time::sleep(TICK * 4).await;
        assert_eq!(fake.device_polls().len(), 2, "{answer}");

        // Tried again from its row, by its id.
        fake.answer_device_polls(&["approve"]);
        let again = ConnectRequest {
            id: Some(id.clone()),
            ..ConnectRequest::default()
        };
        assert!(matches!(
            spade.connectors.connect(again).await?,
            Started::Device { .. }
        ));
        wait_for(|| {
            spade
                .connectors
                .get(&id)
                .is_some_and(|v| v.state == "connected")
        })
        .await?;
    }
    Ok(())
}

#[tokio::test]
async fn a_device_code_past_its_lifetime_stops_polling_even_if_the_server_never_says() -> Result {
    let fake = FakeConnector::start(app_tools()).await;
    // Lasts one second; polled every second, which is TICK here, against the real clock.
    fake.offer_device_flow(PUBLIC_ID, 1, 1);
    let spade = spade_shipping(&fake.url(), vec![app_for(&fake, Grant::Device)])?;
    let (id, _, _) = device_sign_in(&spade).await?;
    // Spade's clock is the machine's: one real second.
    tokio::time::timeout(Duration::from_secs(4), async {
        loop {
            if spade
                .connectors
                .get(&id)
                .and_then(|v| v.device)
                .is_some_and(|d| d.state == "expired")
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await?;
    let polls = fake.device_polls().len();
    tokio::time::sleep(TICK * 4).await;
    assert_eq!(fake.device_polls().len(), polls);
    Ok(())
}

#[tokio::test]
async fn a_device_signed_in_connector_is_only_for_the_bots_allowed_it() -> Result {
    let fake = FakeConnector::start(app_tools()).await;
    fake.offer_device_flow(PUBLIC_ID, 1, 900);
    fake.answer_device_polls(&["approve"]);
    let spade = spade_shipping(&fake.url(), vec![app_for(&fake, Grant::Device)])?;
    let (id, _, _) = device_sign_in(&spade).await?;
    wait_for(|| spade.connectors.get(&id).is_some_and(|v| v.tools == 3)).await?;
    assert_eq!(spade.connectors.tools_for("main", true).len(), 3);
    assert!(spade.connectors.tools_for("garden", false).is_empty());
    spade
        .connectors
        .set_access("garden", Access::Only(BTreeSet::from([id.clone()])))?;
    assert_eq!(spade.connectors.tools_for("garden", false).len(), 3);
    spade
        .connectors
        .set_access("main", Access::Only(BTreeSet::new()))?;
    assert!(spade.connectors.tools_for("main", true).is_empty());
    Ok(())
}

#[tokio::test]
async fn disconnecting_during_a_device_sign_in_stops_it_and_keeps_nothing() -> Result {
    let fake = FakeConnector::start(app_tools()).await;
    fake.offer_device_flow(PUBLIC_ID, 5, 900);
    let spade = spade_shipping(&fake.url(), vec![app_for(&fake, Grant::Device)])?;
    let (id, _, _) = device_sign_in(&spade).await?;
    assert!(spade.connectors.disconnect(&id).await?);
    fake.answer_device_polls(&["approve"]);
    tokio::time::sleep(TICK * 12).await;
    assert!(spade.connectors.get(&id).is_none());
    assert_eq!(fake.token_requests(), 0, "polled after the disconnect");
    Ok(())
}

#[tokio::test]
async fn a_server_added_by_url_naming_the_shipped_issuer_never_signs_in_as_spade() -> Result {
    // Spade's app is for the catalogue entry at the maker's address. Another server, added by
    // its own address, names the app's issuer as its authorization server, hoping the person
    // signs in as Spade and the token is then sent to it.
    let maker = FakeConnector::start(app_tools()).await;
    let impostor = FakeConnector::start(app_tools()).await;
    impostor.without_registration();
    impostor.offer_device_flow(PUBLIC_ID, 1, 900);
    let app = App {
        issuer: impostor.issuer(),
        ..app_for(&maker, Grant::Device)
    };
    let spade = spade_shipping(&maker.url(), vec![app])?;
    assert_eq!(
        spade
            .connectors
            .connect(by_url(&impostor.url()))
            .await
            .err(),
        Some(ConnectError::NeedsClient)
    );
    assert!(
        impostor.device_asked().is_empty(),
        "a device code was asked for"
    );
    assert_eq!(impostor.token_requests() + impostor.secrets_sent(), 0);
    Ok(())
}

//! Signing in as Spade's client ID metadata document (ADR 0136): against a fake app whose
//! authorization server fetches and checks the document from a local stand-in for acehq.dev,
//! serving the hosted file itself with only its `client_id` moved to the stand-in's address.

use serde_json::Value;
use spade_connect::{CALLBACK_PATH, CLIENT_METADATA_URL, Callback, ConnectRequest, FinishError};
use spade_testkit::client_document::{DOCUMENT_PATH, redirect_matches};
use spade_testkit::{ClientDocument, FakeConnector};

mod support;
use support::*;

/// The callback a document sign-in comes back to, from Spade listening on 127.0.0.1:4555.
const SHARED_CALLBACK: &str = "http://127.0.0.1:4555/v1/connectors/callback";

/// `apps/marketing/public/oauth/spade.json`, which Cloudflare Pages serves at acehq.dev.
fn hosted() -> Result<Value> {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../apps/marketing/public")
        .join(DOCUMENT_PATH.trim_start_matches('/'));
    Ok(serde_json::from_str(&std::fs::read_to_string(path)?)?)
}

/// The hosted document, served from 127.0.0.1 under that address.
async fn local_document() -> Result<ClientDocument> {
    let host = ClientDocument::start().await;
    let mut document = hosted()?;
    document["client_id"] = Value::String(host.url());
    host.serve(&document);
    Ok(host)
}

fn query(url: &str) -> Result<std::collections::HashMap<String, String>> {
    Ok(url::Url::parse(url)?.query_pairs().into_owned().collect())
}

#[tokio::test]
async fn a_server_that_fetches_client_documents_signs_spade_in_without_registering() -> Result {
    let document = local_document().await?;
    let app = FakeConnector::start(app_tools()).await;
    app.fetch_client_documents();
    let spade = spade_with_document(&document.url())?;
    let url = sign_in_url(&spade, by_url(&app.url())).await?;
    let asked = query(&url)?;
    assert_eq!(asked["client_id"], document.url());
    assert_eq!(asked["redirect_uri"], SHARED_CALLBACK);
    assert_eq!(asked["code_challenge_method"], "S256");
    assert_eq!(asked["resource"], app.url());

    let back = app.approve(&url).await;
    assert_eq!(app.documents_fetched(), 1, "{back}");
    assert_eq!(app.registrations(), 0);
    let returned = callback(&back)?;
    assert_eq!(returned.connector, None, "came back to the shared address");
    let view = spade.connectors.finish(returned).await?;
    // The exchange carried the same client ID, redirect and verifier, or the fake refused it.
    wait_for(|| {
        spade
            .connectors
            .get(&view.id)
            .is_some_and(|v| v.state == "connected" && v.tools == 3)
    })
    .await?;
    let call = spade
        .connectors
        .call(&view.id, "echo", serde_json::json!({ "say": "hi" }))
        .await?;
    assert!(!call.is_error);
    Ok(())
}

#[tokio::test]
async fn a_document_sign_in_answer_without_iss_is_refused_before_any_token_request() -> Result {
    let document = local_document().await?;
    let app = FakeConnector::start(app_tools()).await;
    app.fetch_client_documents();
    app.without_registration();
    app.without_iss();
    let spade = spade_with_document(&document.url())?;
    let url = sign_in_url(&spade, by_url(&app.url())).await?;
    assert_eq!(query(&url)?["client_id"], document.url());
    let back = app.approve(&url).await;
    assert_eq!(
        spade.connectors.finish(callback(&back)?).await.err(),
        Some(FinishError::WrongIssuer)
    );
    assert_eq!(app.token_requests(), 0);
    Ok(())
}

#[tokio::test]
async fn servers_that_do_not_fetch_documents_or_name_themselves_get_a_registered_client() -> Result
{
    let document = local_document().await?;
    let spade = spade_with_document(&document.url())?;
    let plain = FakeConnector::start(app_tools()).await;
    let quiet = FakeConnector::start(app_tools()).await;
    // Fetches documents but leaves `iss` out: registration's own address keeps answers apart.
    quiet.fetch_client_documents();
    quiet.without_iss();
    for (name, app) in [("Plain", &plain), ("Quiet", &quiet)] {
        let request = ConnectRequest {
            name: Some(name.into()),
            ..by_url(&app.url())
        };
        let url = sign_in_url(&spade, request).await?;
        let asked = query(&url)?;
        assert!(asked["client_id"].starts_with("client-"), "{name}: {url}");
        assert!(
            asked["redirect_uri"].starts_with(&format!("{SHARED_CALLBACK}/")),
            "{name}: {url}"
        );
        assert_eq!(app.registrations(), 1, "{name}");
        let back = app.approve(&url).await;
        spade.connectors.finish(callback(&back)?).await?;
    }
    assert_eq!(quiet.documents_fetched(), 0);
    Ok(())
}

#[tokio::test]
async fn an_answer_is_refused_at_a_callback_address_its_sign_in_did_not_use() -> Result {
    let document = local_document().await?;
    let spade = spade_with_document(&document.url())?;
    let shared = FakeConnector::start(app_tools()).await;
    shared.fetch_client_documents();
    let own = FakeConnector::start(app_tools()).await;
    let shared_url = sign_in_url(
        &spade,
        ConnectRequest {
            name: Some("Shared".into()),
            ..by_url(&shared.url())
        },
    )
    .await?;
    let own_url = sign_in_url(
        &spade,
        ConnectRequest {
            name: Some("Own".into()),
            ..by_url(&own.url())
        },
    )
    .await?;
    let own_id = callback(&query(&own_url)?["redirect_uri"])?
        .connector
        .unwrap_or_default();
    assert!(!own_id.is_empty());

    // The document sign-in's answer, arriving at a connector's own address.
    let moved = Callback {
        connector: Some(own_id),
        ..callback(&shared.approve(&shared_url).await)?
    };
    assert_eq!(
        spade.connectors.finish(moved).await.err(),
        Some(FinishError::WrongIssuer)
    );
    // A registered client's answer, arriving at the shared address.
    let moved = Callback {
        connector: None,
        ..callback(&own.approve(&own_url).await)?
    };
    assert_eq!(
        spade.connectors.finish(moved).await.err(),
        Some(FinishError::WrongIssuer)
    );
    assert_eq!(shared.token_requests() + own.token_requests(), 0);
    Ok(())
}

#[test]
fn the_hosted_document_names_itself_and_allows_only_spades_loopback_callback() -> Result {
    let document = hosted()?;
    assert_eq!(document["client_id"], CLIENT_METADATA_URL);
    let address = url::Url::parse(CLIENT_METADATA_URL)?;
    assert_eq!(address.scheme(), "https");
    assert_eq!(
        address.path(),
        DOCUMENT_PATH,
        "the file's place under public/"
    );
    assert!(address.query().is_none() && address.fragment().is_none());
    assert_eq!(document["client_name"], "Spade");
    assert_eq!(document["client_uri"], "https://acehq.dev");
    assert!(
        document["logo_uri"]
            .as_str()
            .is_some_and(|l| l.starts_with("https://acehq.dev/") && l.ends_with(".png"))
    );
    assert_eq!(
        document["grant_types"],
        serde_json::json!(["authorization_code", "refresh_token"])
    );
    assert_eq!(document["response_types"], serde_json::json!(["code"]));
    // Public: the document is readable by anyone, so it holds nothing secret.
    assert_eq!(document["token_endpoint_auth_method"], "none");
    for secret in ["client_secret", "client_secret_expires_at", "jwks"] {
        assert!(document.get(secret).is_none(), "{secret}");
    }
    let redirects: Vec<&str> = document["redirect_uris"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect();
    assert_eq!(
        redirects,
        [format!("http://127.0.0.1{CALLBACK_PATH}")],
        "loopback IP, no port, Spade's shared callback"
    );
    assert!(redirect_matches(redirects[0], SHARED_CALLBACK));
    assert!(redirect_matches(
        redirects[0],
        "http://127.0.0.1:61234/v1/connectors/callback"
    ));
    assert!(!redirect_matches(
        redirects[0],
        "http://127.0.0.1:4555/v1/connectors/callback/linear"
    ));
    assert!(!redirect_matches(
        redirects[0],
        "http://localhost:4555/v1/connectors/callback"
    ));
    Ok(())
}

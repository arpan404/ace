//! Connectors against a fake app (MCP server plus OAuth server) on 127.0.0.1, with keys in
//! `keyring-core`'s in-memory store. No real server, keychain or model.

use std::collections::BTreeSet;
use std::sync::Arc;
use std::time::Duration;

use keyring_core::{CredentialStore, mock};
use spade_connect::{
    Access, CallError, Callback, ConnectError, ConnectRequest, Connectors, FinishError, OsRandom,
    Setup, Started, View,
};
use spade_keys::{KeyStore, SERVICE};
use spade_mcp::{Part, Risk};
use spade_store::Store;
use spade_testkit::FakeConnector;
use spade_testkit::connector::tool;

type Result<T = ()> = std::result::Result<T, Box<dyn std::error::Error>>;

struct Spade {
    connectors: Arc<Connectors>,
    keys: KeyStore,
    database: std::path::PathBuf,
    _dir: tempfile::TempDir,
}

fn spade() -> Result<Spade> {
    spade_relisting(Duration::from_secs(600))
}

/// Spade reading each server's tool list again every `relist`.
fn spade_relisting(relist: Duration) -> Result<Spade> {
    let dir = tempfile::tempdir()?;
    let database = dir.path().join("spade.sqlite");
    let store: Arc<CredentialStore> = mock::Store::new()?;
    let keys = KeyStore::with_store(store, SERVICE);
    let connectors = Connectors::open(Setup {
        store: Store::open(&database)?,
        keys: Some(keys.clone()),
        clock: spade_connect::system_clock(),
        random: Arc::new(OsRandom),
        catalogue: spade_connect::catalogue::shipped(),
        timeout: Duration::from_secs(5),
        relist,
        addresses: spade_connect::Addresses::system(),
    })?;
    connectors.set_listening("127.0.0.1:4555".parse()?);
    Ok(Spade {
        connectors,
        keys,
        database,
        _dir: dir,
    })
}

fn app_tools() -> Vec<rmcp::model::Tool> {
    vec![
        tool("echo", Some(true), None),
        tool("create_issue", None, None),
        tool("delete_project", None, Some(true)),
    ]
}

fn by_url(url: &str) -> ConnectRequest {
    ConnectRequest {
        url: Some(url.to_owned()),
        name: Some("Fake".into()),
        ..ConnectRequest::default()
    }
}

/// Reads the redirect the browser would follow into the callback's query.
fn callback(location: &str) -> Result<Callback> {
    let url = url::Url::parse(location)?;
    let mut callback = Callback {
        // As Spade's route does: the connector is the path's last part.
        connector: url
            .path_segments()
            .and_then(|mut s| s.next_back())
            .map(str::to_owned),
        ..Callback::default()
    };
    for (key, value) in url.query_pairs() {
        match key.as_ref() {
            "code" => callback.code = Some(value.into_owned()),
            "state" => callback.state = Some(value.into_owned()),
            "iss" => callback.iss = Some(value.into_owned()),
            "error" => callback.error = Some(value.into_owned()),
            _ => {}
        }
    }
    Ok(callback)
}

async fn sign_in_url(spade: &Spade, request: ConnectRequest) -> Result<String> {
    match spade.connectors.connect(request).await? {
        Started::SignIn { url, .. } => Ok(url),
        other => Err(format!("expected a sign-in, got {other:?}").into()),
    }
}

/// Connects through the whole sign-in and waits for the tools to be listed.
async fn signed_in(spade: &Spade, app: &FakeConnector) -> Result<View> {
    let url = sign_in_url(spade, by_url(&app.url())).await?;
    let back = app.approve(&url).await;
    let view = spade.connectors.finish(callback(&back)?).await?;
    wait_for(|| spade.connectors.get(&view.id).is_some_and(|v| v.tools > 0)).await?;
    Ok(view)
}

async fn wait_for(check: impl Fn() -> bool) -> Result {
    for _ in 0..250 {
        if check() {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    Err("timed out waiting".into())
}

fn text(result: &spade_mcp::McpToolResult) -> String {
    result
        .parts
        .iter()
        .map(|p| match p {
            Part::Text { text, .. } => text.clone(),
            _ => String::new(),
        })
        .collect()
}

#[tokio::test]
async fn signing_in_discovers_the_server_registers_spade_and_uses_pkce_and_the_resource() -> Result
{
    let app = FakeConnector::start(app_tools()).await;
    let spade = spade()?;
    let url = sign_in_url(&spade, by_url(&app.url())).await?;
    assert!(url.starts_with(&format!("{}/authorize", app.issuer())));
    let back = app.approve(&url).await;
    let asked = app.last_authorize();
    assert_eq!(asked["code_challenge_method"], "S256");
    assert_eq!(
        asked["redirect_uri"],
        "http://127.0.0.1:4555/v1/connectors/callback/127-0-0-1"
    );
    assert_eq!(asked["resource"], app.url());
    // The challenge's scopes, plus offline_access because the server offers it.
    assert_eq!(asked["scope"], "read write offline_access");
    assert_eq!(app.registrations(), 1);
    assert_eq!(
        spade.connectors.get("127-0-0-1").map(|v| v.state),
        Some("signing_in")
    );

    let view = spade.connectors.finish(callback(&back)?).await?;
    assert_eq!(view.account.as_deref(), Some("person@example.com"));
    assert_eq!(view.sign_in, "oauth");
    wait_for(|| {
        spade
            .connectors
            .get(&view.id)
            .is_some_and(|v| v.state == "connected" && v.tools == 3)
    })
    .await?;
    assert!(
        app.resources().iter().all(|r| r == &app.url()),
        "{:?}",
        app.resources()
    );
    Ok(())
}

#[tokio::test]
async fn tokens_are_only_in_the_keychain_never_in_the_database_or_a_view() -> Result {
    let app = FakeConnector::start(app_tools()).await;
    let spade = spade()?;
    let view = signed_in(&spade, &app).await?;
    let call = spade
        .connectors
        .call(&view.id, "echo", serde_json::json!({ "say": "hi" }))
        .await?;
    assert_eq!(text(&call), "hi");

    let database = std::fs::read(&spade.database)?;
    let wal = std::fs::read(spade.database.with_extension("sqlite-wal")).unwrap_or_default();
    let views = format!("{:?}", spade.connectors.list());
    for token in app.issued_tokens() {
        let bytes = token.as_bytes();
        assert!(
            !database.windows(bytes.len()).any(|w| w == bytes),
            "{token} in the database"
        );
        assert!(
            !wal.windows(bytes.len()).any(|w| w == bytes),
            "{token} in the database log"
        );
        assert!(!views.contains(&token), "{token} in a view");
    }
    assert_eq!(
        spade.keys.connector_secret(&view.id, "access")?.as_deref(),
        Some("at-secret-1")
    );
    assert_eq!(
        spade.keys.connector_secret(&view.id, "refresh")?.as_deref(),
        Some("rt-secret-1")
    );
    Ok(())
}

#[tokio::test]
async fn a_callback_with_an_unknown_state_or_the_wrong_issuer_is_refused_without_a_token_request()
-> Result {
    let app = FakeConnector::start(app_tools()).await;
    let spade = spade()?;
    let url = sign_in_url(&spade, by_url(&app.url())).await?;
    let back = callback(&app.approve(&url).await)?;

    let mut forged = back.clone();
    forged.state = Some("not-the-state".into());
    assert_eq!(
        spade.connectors.finish(forged).await.err(),
        Some(FinishError::UnknownState)
    );
    let mut missing = back.clone();
    missing.state = None;
    assert_eq!(
        spade.connectors.finish(missing).await.err(),
        Some(FinishError::UnknownState)
    );

    let mut mixed_up = back.clone();
    mixed_up.iss = Some("http://127.0.0.1:1/other".into());
    assert_eq!(
        spade.connectors.finish(mixed_up).await.err(),
        Some(FinishError::WrongIssuer)
    );
    // The state was spent by that answer, so the real one can't be replayed after it either.
    assert_eq!(
        spade.connectors.finish(back).await.err(),
        Some(FinishError::UnknownState)
    );
    assert_eq!(app.token_requests(), 0);
    assert!(spade.connectors.list().is_empty());
    Ok(())
}

#[tokio::test]
async fn a_code_from_a_server_that_does_not_name_itself_only_finishes_its_own_sign_in() -> Result {
    let (first, second) = (
        FakeConnector::start(app_tools()).await,
        FakeConnector::start(app_tools()).await,
    );
    first.without_iss();
    second.without_iss();
    let spade = spade()?;
    let first_url = sign_in_url(
        &spade,
        ConnectRequest {
            name: Some("First".into()),
            ..by_url(&first.url())
        },
    )
    .await?;
    sign_in_url(
        &spade,
        ConnectRequest {
            name: Some("Second".into()),
            ..by_url(&second.url())
        },
    )
    .await?;
    let ids: Vec<String> = spade.connectors.list().into_iter().map(|v| v.id).collect();
    assert_eq!(ids.len(), 2, "{ids:?}");
    let back = first.approve(&first_url).await;
    let mine = callback(&back)?.connector.unwrap_or_default();
    assert!(ids.contains(&mine), "{back} came back to {mine}");
    let other = ids
        .iter()
        .find(|id| **id != mine)
        .cloned()
        .unwrap_or_default();
    // The first server's code, arriving at the second connector's address.
    let mixed = Callback {
        connector: Some(other),
        ..callback(&back)?
    };
    assert_eq!(
        spade.connectors.finish(mixed).await.err(),
        Some(FinishError::WrongIssuer)
    );
    assert_eq!(first.token_requests() + second.token_requests(), 0);
    Ok(())
}

#[tokio::test]
async fn an_access_token_about_to_expire_is_refreshed_before_it_is_used() -> Result {
    let app = FakeConnector::start(app_tools()).await;
    app.tokens_last(30);
    let spade = spade()?;
    let view = signed_in(&spade, &app).await?;
    let call = spade
        .connectors
        .call(&view.id, "echo", serde_json::json!({ "say": "fresh" }))
        .await?;
    assert_eq!(text(&call), "fresh");
    // The code exchange, then at least one refresh (the session keeper may renew first).
    assert!(app.token_requests() >= 2, "no refresh happened");
    assert!(
        app.bearers().iter().any(|b| b != "at-secret-1"),
        "the new token was not used"
    );
    // The refresh token rotated, and the new one is what is kept.
    let kept = spade.keys.connector_secret(&view.id, "refresh")?;
    assert_ne!(kept.as_deref(), Some("rt-secret-1"));
    Ok(())
}

#[tokio::test]
async fn a_refused_call_is_not_resent_and_the_sign_in_is_renewed_for_the_next_try() -> Result {
    let app = FakeConnector::start(app_tools()).await;
    let spade = spade()?;
    let view = signed_in(&spade, &app).await?;
    app.expire_access_tokens();
    let runs = app.tool_runs();
    let refused = spade
        .connectors
        .call(&view.id, "create_issue", serde_json::json!({}))
        .await;
    match refused {
        Err(CallError::NotRun(why)) => assert!(why.contains("renewed"), "{why}"),
        other => panic!("expected not run, got {other:?}"),
    }
    assert_eq!(app.tool_runs(), runs, "the refused call ran");
    let again = spade
        .connectors
        .call(&view.id, "create_issue", serde_json::json!({}))
        .await?;
    assert_eq!(text(&again), "ran create_issue");
    assert_eq!(app.tool_runs(), runs + 1);
    Ok(())
}

#[tokio::test]
async fn a_sign_in_that_cannot_be_renewed_asks_to_reconnect_and_reconnecting_works() -> Result {
    let app = FakeConnector::start(app_tools()).await;
    let spade = spade()?;
    let view = signed_in(&spade, &app).await?;
    app.expire_access_tokens();
    app.revoke_refresh_tokens();
    let call = spade
        .connectors
        .call(&view.id, "echo", serde_json::json!({}))
        .await;
    assert!(
        matches!(call, Err(CallError::NeedsReconnect(ref name)) if name == "Fake"),
        "{call:?}"
    );
    assert_eq!(
        spade.connectors.get(&view.id).map(|v| v.state),
        Some("needs_reconnect")
    );
    // Its tools stay findable, so a bot learns why they don't run.
    assert_eq!(spade.connectors.tools_for("main", true).len(), 3);

    let url = sign_in_url(
        &spade,
        ConnectRequest {
            id: Some(view.id.clone()),
            ..ConnectRequest::default()
        },
    )
    .await?;
    let back = app.approve(&url).await;
    spade.connectors.finish(callback(&back)?).await?;
    wait_for(|| {
        spade
            .connectors
            .get(&view.id)
            .is_some_and(|v| v.state == "connected")
    })
    .await?;
    assert_eq!(
        app.registrations(),
        1,
        "the registered client was used again"
    );
    let call = spade
        .connectors
        .call(&view.id, "echo", serde_json::json!({ "say": "back" }))
        .await?;
    assert_eq!(text(&call), "back");
    Ok(())
}

#[tokio::test]
async fn a_renewal_in_flight_when_the_app_is_disconnected_never_brings_it_back() -> Result {
    let app = FakeConnector::start(app_tools()).await;
    let spade = spade()?;
    let view = signed_in(&spade, &app).await?;
    app.expire_access_tokens();
    app.slow_tokens(Duration::from_millis(400));
    let connectors = spade.connectors.clone();
    let id = view.id.clone();
    let call =
        tokio::spawn(async move { connectors.call(&id, "echo", serde_json::json!({})).await });
    // The call was refused and its renewal is waiting on the token endpoint.
    wait_for(|| app.token_requests() == 2).await?;
    assert!(spade.connectors.disconnect(&view.id).await?);
    let _ = call.await?;
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(
        spade.connectors.list().is_empty(),
        "{:?}",
        spade.connectors.list()
    );
    assert!(spade.connectors.tools_for("main", true).is_empty());
    assert_eq!(spade.keys.connector_secret(&view.id, "access")?, None);
    assert_eq!(spade.keys.connector_secret(&view.id, "refresh")?, None);
    Ok(())
}

#[tokio::test]
async fn a_server_without_pkce_is_refused_and_one_without_registration_needs_a_client_id() -> Result
{
    let spade = spade()?;
    let no_pkce = FakeConnector::start(app_tools()).await;
    no_pkce.without_pkce();
    let refused = spade.connectors.connect(by_url(&no_pkce.url())).await;
    assert!(
        matches!(refused, Err(ConnectError::Unsupported(ref why)) if why.contains("PKCE")),
        "{refused:?}"
    );

    let closed = FakeConnector::start(app_tools()).await;
    closed.without_registration();
    let needs = spade.connectors.connect(by_url(&closed.url())).await;
    assert_eq!(needs.err(), Some(ConnectError::NeedsClient));
    let given = spade
        .connectors
        .connect(ConnectRequest {
            client_id: Some("registered-by-hand".into()),
            ..by_url(&closed.url())
        })
        .await?;
    let Started::SignIn { url, .. } = given else {
        return Err("expected a sign-in".into());
    };
    assert!(url.contains("client_id=registered-by-hand"), "{url}");
    Ok(())
}

#[tokio::test]
async fn sign_in_metadata_that_never_ends_is_cut_off_at_the_limit() -> Result {
    let app = FakeConnector::start(app_tools()).await;
    app.endless_metadata();
    let spade = spade()?;
    let started = tokio::time::Instant::now();
    let refused = spade.connectors.connect(by_url(&app.url())).await;
    assert!(
        matches!(refused, Err(ConnectError::Unreachable(ref why)) if why.contains("too large")),
        "{refused:?}"
    );
    assert!(
        started.elapsed() < Duration::from_secs(3),
        "it read until the deadline"
    );
    Ok(())
}

#[tokio::test]
async fn a_server_echoing_credentials_never_gets_them_into_a_result() -> Result {
    let app = FakeConnector::start(vec![tool("whoami", Some(true), None)]).await;
    let spade = spade()?;
    let view = signed_in(&spade, &app).await?;
    let result = spade
        .connectors
        .call(&view.id, "whoami", serde_json::json!({}))
        .await?;
    let shown = format!("{} {:?}", text(&result), result.structured);
    assert!(shown.contains("[redacted]"), "{shown}");
    for token in app.issued_tokens() {
        assert!(
            !shown.contains(&token),
            "{token} reached the result: {shown}"
        );
    }
    Ok(())
}

#[tokio::test]
async fn a_refused_code_exchange_says_so_in_spades_words_not_the_servers() -> Result {
    let app = FakeConnector::start(app_tools()).await;
    app.refuse_code_exchange("<script>steal()</script> call +1 555 0100");
    let spade = spade()?;
    let url = sign_in_url(&spade, by_url(&app.url())).await?;
    let back = app.approve(&url).await;
    let refused = spade.connectors.finish(callback(&back)?).await;
    let said = refused.err().map(|e| e.to_string()).unwrap_or_default();
    assert_eq!(said, "the app refused the sign-in");
    Ok(())
}

#[tokio::test]
async fn a_token_connects_at_once_and_a_wrong_one_is_refused() -> Result {
    let app = FakeConnector::start(app_tools()).await;
    app.accept_token("api-key-123");
    let spade = spade()?;
    let wrong = spade
        .connectors
        .connect(ConnectRequest {
            token: Some("wrong".into()),
            ..by_url(&app.url())
        })
        .await;
    assert_eq!(wrong.err(), Some(ConnectError::Refused));
    assert!(spade.connectors.list().is_empty());

    let started = spade
        .connectors
        .connect(ConnectRequest {
            token: Some("api-key-123".into()),
            ..by_url(&app.url())
        })
        .await?;
    let Started::Connected(view) = started else {
        return Err("expected connected".into());
    };
    assert_eq!(
        (view.sign_in, view.state, view.tools),
        ("token", "connected", 3)
    );
    assert!(!format!("{view:?}").contains("api-key-123"));
    let call = spade
        .connectors
        .call(&view.id, "echo", serde_json::json!({ "say": "t" }))
        .await?;
    assert_eq!(text(&call), "t");
    Ok(())
}

#[tokio::test]
async fn tools_keep_their_risk_and_each_bot_sees_only_connectors_it_may_use() -> Result {
    let app = FakeConnector::start(app_tools()).await;
    let spade = spade()?;
    let view = signed_in(&spade, &app).await?;
    let main = spade.connectors.tools_for("main", true);
    let risks: Vec<(String, Risk)> = main.iter().map(|t| (t.name.clone(), t.tool.risk)).collect();
    assert_eq!(
        risks,
        vec![
            (format!("{}__create_issue", view.id), Risk::Write),
            (format!("{}__delete_project", view.id), Risk::Destructive),
            (format!("{}__echo", view.id), Risk::Read),
        ]
    );
    assert!(
        spade.connectors.tools_for("bot-1", false).is_empty(),
        "a new bot gets none"
    );
    spade
        .connectors
        .set_access("bot-1", Access::Only(BTreeSet::from([view.id.clone()])))?;
    assert_eq!(spade.connectors.tools_for("bot-1", false).len(), 3);
    spade
        .connectors
        .set_access("main", Access::Only(BTreeSet::new()))?;
    assert!(
        spade.connectors.tools_for("main", true).is_empty(),
        "the person narrowed Spade"
    );
    assert!(matches!(
        spade
            .connectors
            .set_access("bot-1", Access::Only(BTreeSet::from(["nope".to_owned()]))),
        Err(ConnectError::Invalid(_))
    ));

    assert!(spade.connectors.disconnect(&view.id).await?);
    assert_eq!(
        spade.connectors.access("bot-1", false),
        Access::Only(BTreeSet::new())
    );
    assert!(spade.connectors.tools_for("bot-1", false).is_empty());
    assert_eq!(spade.keys.connector_secret(&view.id, "access")?, None);
    assert_eq!(spade.keys.connector_secret(&view.id, "refresh")?, None);
    Ok(())
}

#[tokio::test]
async fn a_tool_the_server_adds_while_connected_is_offered() -> Result {
    let app = FakeConnector::start(app_tools()).await;
    let spade = spade()?;
    let view = signed_in(&spade, &app).await?;
    app.add_tool_and_notify(tool("search_docs", Some(true), None))
        .await;
    let wanted = format!("{}__search_docs", view.id);
    wait_for(|| {
        spade
            .connectors
            .tools_for("main", true)
            .iter()
            .any(|t| t.name == wanted)
    })
    .await?;
    Ok(())
}

#[tokio::test]
async fn a_server_that_never_announces_changes_still_has_its_new_tools_read_on_the_timer() -> Result
{
    let app = FakeConnector::start(app_tools()).await;
    let spade = spade_relisting(Duration::from_millis(150))?;
    let view = signed_in(&spade, &app).await?;
    app.add_tool_quietly(tool("archive", None, None));
    let wanted = format!("{}__archive", view.id);
    wait_for(|| {
        spade
            .connectors
            .tools_for("main", true)
            .iter()
            .any(|t| t.name == wanted)
    })
    .await?;
    Ok(())
}

#[tokio::test]
async fn connectors_survive_a_restart_and_reopen_from_the_keychain() -> Result {
    let app = FakeConnector::start(app_tools()).await;
    let spade = spade()?;
    let view = signed_in(&spade, &app).await?;
    let again = Connectors::open(Setup {
        store: Store::open(&spade.database)?,
        keys: Some(spade.keys.clone()),
        clock: spade_connect::system_clock(),
        random: Arc::new(OsRandom),
        catalogue: Vec::new(),
        timeout: Duration::from_secs(5),
        relist: Duration::from_secs(600),
        addresses: spade_connect::Addresses::system(),
    })?;
    again.start();
    wait_for(|| {
        again
            .get(&view.id)
            .is_some_and(|v| v.state == "connected" && v.tools == 3)
    })
    .await?;
    let call = again
        .call(&view.id, "echo", serde_json::json!({ "say": "again" }))
        .await?;
    assert_eq!(text(&call), "again");
    Ok(())
}

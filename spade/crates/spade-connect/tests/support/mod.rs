//! What the connector tests share: Spade with an in-memory keychain and a temp database,
//! listening (for callbacks) on 127.0.0.1:4555, and the steps of a sign-in.

#![allow(dead_code)]

use std::sync::Arc;
use std::time::Duration;

use keyring_core::{CredentialStore, mock};
use spade_connect::{Callback, ConnectRequest, Connectors, OsRandom, Setup, Started, View};
use spade_keys::{KeyStore, SERVICE};
use spade_store::Store;
use spade_testkit::FakeConnector;
use spade_testkit::connector::tool;

pub type Result<T = ()> = std::result::Result<T, Box<dyn std::error::Error>>;

pub struct Spade {
    pub connectors: Arc<Connectors>,
    pub keys: KeyStore,
    pub database: std::path::PathBuf,
    _dir: tempfile::TempDir,
}

pub fn spade() -> Result<Spade> {
    spade_relisting(Duration::from_secs(600))
}

/// Spade reading each server's tool list again every `relist`.
pub fn spade_relisting(relist: Duration) -> Result<Spade> {
    spade_with(relist, None)
}

/// Spade signing in as the client ID metadata document at `document` where servers fetch them.
pub fn spade_with_document(document: &str) -> Result<Spade> {
    spade_with(Duration::from_secs(600), Some(document.to_owned()))
}

fn spade_with(relist: Duration, client_metadata: Option<String>) -> Result<Spade> {
    spade_with_apps(
        relist,
        client_metadata,
        Vec::new(),
        spade_connect::catalogue::shipped(),
    )
}

/// How long a second of a device sign-in's polling interval lasts in these tests.
pub const TICK: Duration = Duration::from_millis(20);

/// The catalogue entry the shipped-app tests connect through: the fake app at `url`.
pub const FAKE_ENTRY: &str = "fake";

/// Spade shipping `apps` as its own registered apps (ADR 0137), with a catalogue entry
/// [`FAKE_ENTRY`] for the fake app at `url` (marked local, as only a test can).
pub fn spade_shipping(url: &str, apps: Vec<spade_connect::App>) -> Result<Spade> {
    let mut catalogue = spade_connect::catalogue::shipped();
    catalogue.push(spade_connect::Entry {
        id: FAKE_ENTRY.into(),
        name: "Fake".into(),
        url: url.to_owned(),
        sign_in: vec![spade_connect::SignIn::OauthClient],
        notes: String::new(),
        source: "https://example.com/docs".into(),
        local: true,
    });
    spade_with_apps(Duration::from_secs(600), None, apps, catalogue)
}

/// Connecting the fake app through its catalogue entry.
pub fn from_catalogue() -> ConnectRequest {
    ConnectRequest {
        catalogue: Some(FAKE_ENTRY.into()),
        ..ConnectRequest::default()
    }
}

fn spade_with_apps(
    relist: Duration,
    client_metadata: Option<String>,
    apps: Vec<spade_connect::App>,
    catalogue: Vec<spade_connect::Entry>,
) -> Result<Spade> {
    let dir = tempfile::tempdir()?;
    let database = dir.path().join("spade.sqlite");
    let store: Arc<CredentialStore> = mock::Store::new()?;
    let keys = KeyStore::with_store(store, SERVICE);
    let connectors = Connectors::open(Setup {
        store: Store::open(&database)?,
        keys: Some(keys.clone()),
        clock: spade_connect::system_clock(),
        random: Arc::new(OsRandom),
        catalogue,
        timeout: Duration::from_secs(5),
        relist,
        addresses: spade_connect::Addresses::system(),
        client_metadata,
        apps,
        tick: TICK,
    })?;
    connectors.set_listening("127.0.0.1:4555".parse()?);
    Ok(Spade {
        connectors,
        keys,
        database,
        _dir: dir,
    })
}

pub fn app_tools() -> Vec<rmcp::model::Tool> {
    vec![
        tool("echo", Some(true), None),
        tool("create_issue", None, None),
        tool("delete_project", None, Some(true)),
    ]
}

/// The fake app by its address, marked as a server on the person's own machine, which it is.
pub fn by_url(url: &str) -> ConnectRequest {
    ConnectRequest {
        url: Some(url.to_owned()),
        name: Some("Fake".into()),
        local: true,
        ..ConnectRequest::default()
    }
}

/// Reads the redirect the browser would follow into the callback's query.
pub fn callback(location: &str) -> Result<Callback> {
    let url = url::Url::parse(location)?;
    let mut callback = Callback {
        // As Spade's routes do: the connector is what follows the callback path, if anything.
        connector: url
            .path()
            .strip_prefix(&format!("{}/", spade_connect::CALLBACK_PATH))
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

pub async fn sign_in_url(spade: &Spade, request: ConnectRequest) -> Result<String> {
    match spade.connectors.connect(request).await? {
        Started::SignIn { url, .. } => Ok(url),
        other => Err(format!("expected a sign-in, got {other:?}").into()),
    }
}

/// Connects through the whole sign-in and waits for the tools to be listed.
pub async fn signed_in(spade: &Spade, app: &FakeConnector) -> Result<View> {
    let url = sign_in_url(spade, by_url(&app.url())).await?;
    let back = app.approve(&url).await;
    let view = spade.connectors.finish(callback(&back)?).await?;
    wait_for(|| spade.connectors.get(&view.id).is_some_and(|v| v.tools > 0)).await?;
    Ok(view)
}

pub async fn wait_for(check: impl Fn() -> bool) -> Result {
    for _ in 0..250 {
        if check() {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    Err("timed out waiting".into())
}

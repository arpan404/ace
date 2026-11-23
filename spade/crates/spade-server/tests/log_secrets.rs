//! A failed call's response body never reaches Spade's log, even with `RUST_LOG=trace`: the model
//! SDK logs it, and an endpoint may fill it with the token it was sent (ADR 0214). Spade's log is
//! captured here through the same filter `main` installs.

use std::io::Write;
use std::sync::{Arc, Mutex};

use spade_models::{
    Bearers, Catalog, Credential, DispatchGuard, Endpoint, Format, Keys, Model, Models, Prompt,
    SignIn,
};
use tracing_subscriber::EnvFilter;
use tracing_subscriber::filter::filter_fn;
use tracing_subscriber::layer::SubscriberExt;

type Result<T = ()> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;

const TOKEN: &str = "secret-access-token-4417";

#[derive(Clone, Default)]
struct Captured(Arc<Mutex<Vec<u8>>>);

impl Write for Captured {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// Refuses every call, and streams, with a body that repeats the request's own token.
async fn echoing() -> Result<String> {
    use axum::http::{HeaderMap, StatusCode};
    let app = axum::Router::new().route(
        "/{*path}",
        axum::routing::post(|headers: HeaderMap| async move {
            let sent = headers
                .get("authorization")
                .and_then(|v| v.to_str().ok())
                .unwrap_or_default()
                .to_owned();
            (
                StatusCode::BAD_REQUEST,
                format!(r#"{{"error":{{"message":"bad token {sent}"}}}}"#),
            )
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let root = format!("http://{}/", listener.local_addr()?);
    tokio::spawn(async move { axum::serve(listener, app).await });
    Ok(root)
}

fn models(root: &str) -> Result<Models> {
    let models = Models::new(
        Catalog::from_json(r#"{"endpoints":[]}"#)?,
        Keys::new(|_| None),
        "1.2.3",
    )?;
    models.set_endpoints(vec![Endpoint {
        id: "chatgpt-a1".to_owned(),
        name: "ChatGPT".to_owned(),
        format: Format::OpenAiResponses,
        base_url: root.to_owned(),
        needs_key: false,
        key_env: None,
        headers: Vec::new(),
        session_header: None,
        sign_in: Some(SignIn::ChatGpt {
            account_id: "acct-1".to_owned(),
        }),
        models: vec![Model::unknown("gpt-5.5")],
    }]);
    let credential = || Credential {
        token: TOKEN.to_owned(),
        generation: 1,
    };
    models.set_bearers(Bearers::new(
        root,
        move |_| Box::pin(async move { Ok(credential()) }),
        move |_, old: Credential| Box::pin(async move { Ok(old) }),
        |_, _| Box::pin(async { Ok(Box::new(()) as DispatchGuard) }),
    ));
    Ok(models)
}

#[tokio::test(flavor = "current_thread")]
async fn a_failed_calls_body_echoing_the_token_never_reaches_the_log() -> Result {
    let root = echoing().await?;
    let models = models(&root)?;
    let captured = Captured::default();
    let writer = captured.clone();
    let subscriber = tracing_subscriber::registry()
        .with(
            tracing_subscriber::fmt::layer()
                .with_ansi(false)
                .with_writer(move || writer.clone()),
        )
        // As wide open as RUST_LOG can make it.
        .with(EnvFilter::new("trace"))
        .with(filter_fn(|meta| spade_server::logging::kept(meta.target())));
    let _logging = tracing::subscriber::set_default(subscriber);
    tracing::error!(target: "spade_server::engine", "marker before the call");
    let failed = models.chat("chatgpt-a1/gpt-5.5", &Prompt::ask("hi")).await;
    assert!(failed.is_err());
    if let Ok(stream) = models
        .stream("chatgpt-a1/gpt-5.5", &Prompt::ask("hi"))
        .await
    {
        use futures_util::StreamExt;
        let mut stream = Box::pin(stream);
        while stream.next().await.is_some() {}
    }
    let log =
        String::from_utf8_lossy(&captured.0.lock().unwrap_or_else(|p| p.into_inner())).into_owned();
    assert!(
        log.contains("marker before the call"),
        "the log is captured: {log}"
    );
    assert!(!log.contains(TOKEN), "the token reached the log:\n{log}");
    Ok(())
}

//! Page content never reaches the logs, at any verbosity, once a subscriber applies
//! [`spade_fetch::LOG_FILTER`]. The subscriber here is set up the way spade-server sets up its
//! own (tracing's fmt subscriber with an env filter, which also takes `log` records), letting
//! everything through at trace level and then applying the filter.

mod common;

use std::io::Write;
use std::sync::{Arc, Mutex};

use axum::Router;
use axum::http::header;
use axum::routing::get;
use common::{Result, local};
use reqwest::Url;
use spade_fetch::{LOG_FILTER, Page, extract};
use tokio::net::TcpListener;
use tracing_subscriber::EnvFilter;

const MARKER: &str = "zq7-unique-page-marker-41x";

#[derive(Clone, Default)]
struct Captured(Arc<Mutex<Vec<u8>>>);

impl Captured {
    fn text(&self) -> String {
        self.0
            .lock()
            .map(|b| String::from_utf8_lossy(&b).into_owned())
            .unwrap_or_default()
    }
}

impl Write for Captured {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        if let Ok(mut b) = self.0.lock() {
            b.extend_from_slice(buf);
        }
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// The characters logged one per line (`got character z`), joined back together.
fn spelled_out(logs: &str) -> String {
    logs.lines()
        .filter_map(|line| line.split("got character ").nth(1)?.chars().next())
        .collect()
}

fn page() -> &'static str {
    Box::leak(
        format!(
            "<html><head><title>{MARKER} title</title></head><body><main>\
             <h1 class=\"{MARKER}\">{MARKER}</h1><p data-x=\"{MARKER}\">{MARKER} &amp; text</p>\
             <!-- {MARKER} --><a href=\"/{MARKER}\">{MARKER}</a>\
             <script>var s = '{MARKER}';</script></main></body></html>"
        )
        .into_boxed_str(),
    )
}

#[tokio::test]
async fn fetched_page_content_never_reaches_the_logs_at_trace_level() -> Result {
    let captured = Captured::default();
    let writer = captured.clone();
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_new(format!("trace,{LOG_FILTER}"))?)
        .with_ansi(false)
        .with_writer(move || writer.clone())
        .try_init()?;
    log::trace!("log-probe");
    tracing::trace!("tracing-probe");

    // Without the filter the tokenizer logs page text (one character per line in attribute
    // values and comments), so the checks below mean something.
    let unfiltered = Captured::default();
    let unfiltered_writer = unfiltered.clone();
    let plain = tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_new("trace")?)
        .with_ansi(false)
        .with_writer(move || unfiltered_writer.clone())
        .finish();
    let base = Url::parse("https://example.com/")?;
    let source = page();
    tracing::subscriber::with_default(plain, || {
        let _ = extract::html(source, &base);
    });
    assert!(
        spelled_out(&unfiltered.text()).contains(MARKER),
        "the tokenizer logs page text when unfiltered"
    );

    let app = Router::new().route(
        "/page",
        get(move || async move { ([(header::CONTENT_TYPE, "text/html")], source) }),
    );
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let addr = listener.local_addr()?;
    tokio::spawn(async move { axum::serve(listener, app).await });
    let got = local()
        .fetch(&format!("http://{addr}/page"), Page::default())
        .await?;
    assert!(got.text.contains(MARKER), "the page was read");

    let logs = captured.text();
    assert!(logs.contains("log-probe"), "log records are captured");
    assert!(
        logs.contains("tracing-probe"),
        "tracing events are captured"
    );
    assert!(!logs.contains(MARKER), "page content was logged:\n{logs}");
    assert!(
        !spelled_out(&logs).contains(MARKER),
        "page content was logged:\n{logs}"
    );
    assert!(
        !logs.contains("html5ever") && !logs.contains("markup5ever"),
        "the tokenizer logged:\n{logs}"
    );
    Ok(())
}

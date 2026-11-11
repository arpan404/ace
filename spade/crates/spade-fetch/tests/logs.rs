//! Page content never reaches the logs, at any verbosity. The subscriber here is set up the way
//! spade-server sets up its own (tracing's fmt subscriber, which also takes `log` records),
//! with everything let through at trace level.

mod common;

use std::io::Write;
use std::sync::{Arc, Mutex};

use axum::Router;
use axum::http::header;
use axum::routing::get;
use common::{Result, local};
use spade_fetch::Page;
use tokio::net::TcpListener;

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

#[tokio::test]
async fn fetched_page_content_never_reaches_the_logs_at_trace_level() -> Result {
    let captured = Captured::default();
    let writer = captured.clone();
    tracing_subscriber::fmt()
        .with_max_level(tracing::Level::TRACE)
        .with_writer(move || writer.clone())
        .try_init()?;
    log::trace!("log-probe");
    tracing::trace!("tracing-probe");

    let page: &'static str = Box::leak(
        format!(
            "<html><head><title>{MARKER} title</title></head><body><main>\
             <h1 class=\"{MARKER}\">{MARKER}</h1><p data-x=\"{MARKER}\">{MARKER} &amp; text</p>\
             <a href=\"/{MARKER}\">{MARKER}</a><script>var s = '{MARKER}';</script>\
             </main></body></html>"
        )
        .into_boxed_str(),
    );
    let app = Router::new().route(
        "/page",
        get(move || async move { ([(header::CONTENT_TYPE, "text/html")], page) }),
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
    Ok(())
}

//! A signed-in account's stream under its waits (ADR 0214): leave to send goes at the backend's
//! first frame; a model reasoning quietly behind heartbeats is never cut off; a stall, before or
//! after the first frame, ends as possibly billed and is never sent again.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::body::{Body, Bytes};
use spade_models::{
    Bearers, Catalog, Credential, DispatchGuard, Endpoint, Format, Keys, Model, Models, Prompt,
    SignIn, StreamWaits,
};

type Result<T = ()> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;

const CREATED: &str = "event: response.created\ndata: {\"type\":\"response.created\",\"response\":{\"id\":\"r\",\"status\":\"in_progress\",\"model\":\"m\",\"output\":[]}}\n\n";
const DELTA: &str = "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"output_index\":0,\"content_index\":0,\"delta\":\"ok\"}\n\n";
const DONE: &str = "event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"r\",\"status\":\"completed\",\"model\":\"m\",\"output\":[{\"type\":\"message\",\"id\":\"m1\",\"role\":\"assistant\",\"status\":\"completed\",\"content\":[{\"type\":\"output_text\",\"text\":\"ok\",\"annotations\":[]}]}],\"usage\":{\"input_tokens\":1,\"output_tokens\":1,\"total_tokens\":2}}}\n\n";

/// A Responses backend that answers each request with `frames` (each after its pause), and
/// notes when the first frame after the heartbeats went out. Counts requests.
async fn backend(
    frames: Vec<(Duration, &'static str)>,
) -> Result<(String, Arc<AtomicUsize>, Arc<Mutex<Option<Instant>>>)> {
    let asked = Arc::new(AtomicUsize::new(0));
    let answered = Arc::new(Mutex::new(None));
    let (count, noted) = (asked.clone(), answered.clone());
    let app = axum::Router::new().route(
        "/{*path}",
        axum::routing::post(move || {
            count.fetch_add(1, Ordering::SeqCst);
            let (frames, noted) = (frames.clone(), noted.clone());
            async move {
                let body = futures_util::stream::unfold(frames.into_iter(), move |mut rest| {
                    let noted = noted.clone();
                    async move {
                        let (pause, text) = rest.next()?;
                        tokio::time::sleep(pause).await;
                        if text == DELTA {
                            noted
                                .lock()
                                .unwrap_or_else(|p| p.into_inner())
                                .get_or_insert_with(Instant::now);
                        }
                        Some((Ok::<_, std::io::Error>(Bytes::from(text)), rest))
                    }
                });
                axum::response::Response::builder()
                    .header("content-type", "text/event-stream")
                    .body(Body::from_stream(body))
                    .unwrap_or_default()
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let root = format!("http://{}/", listener.local_addr()?);
    tokio::spawn(async move { axum::serve(listener, app).await });
    Ok((root, asked, answered))
}

/// Leave to send that notes when it was let go.
struct Leave(Arc<Mutex<Option<Instant>>>);

impl Drop for Leave {
    fn drop(&mut self) {
        *self.0.lock().unwrap_or_else(|p| p.into_inner()) = Some(Instant::now());
    }
}

fn models(root: &str, waits: StreamWaits) -> Result<(Models, Arc<Mutex<Option<Instant>>>)> {
    let models = Models::new(
        Catalog::from_json(r#"{"endpoints":[]}"#)?,
        Keys::new(|_| None),
        "1.2.3",
    )?;
    models.set_endpoints(vec![Endpoint {
        id: "chatgpt-a".to_owned(),
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
        models: vec![Model::unknown("m")],
    }]);
    let released = Arc::new(Mutex::new(None));
    let noted = released.clone();
    models.set_bearers(Bearers::new(
        root,
        |_| {
            Box::pin(async {
                Ok(Credential {
                    token: "access-1".to_owned(),
                    generation: 1,
                })
            })
        },
        |_, old: Credential| Box::pin(async move { Ok(old) }),
        move |_, _| {
            let noted = noted.clone();
            Box::pin(async move { Ok(Box::new(Leave(noted)) as DispatchGuard) })
        },
    ));
    models.set_stream_waits(waits);
    Ok((models, released))
}

const QUICK: StreamWaits = StreamWaits {
    headers: Duration::from_millis(300),
    idle: Duration::from_millis(600),
    total: Duration::from_secs(30),
};

#[tokio::test]
async fn a_model_reasoning_quietly_behind_heartbeats_is_not_cut_off_at_the_header_wait() -> Result {
    // Headers and the first event at once, then nothing but comments for well past the
    // header wait, then the answer.
    let mut frames = vec![(Duration::ZERO, CREATED)];
    frames.extend((0..15).map(|_| (Duration::from_millis(100), ": keep-alive\n\n")));
    frames.extend([(Duration::ZERO, DELTA), (Duration::ZERO, DONE)]);
    let (root, asked, answered) = backend(frames).await?;
    let (models, released) = models(&root, QUICK)?;
    let reply = models.chat("chatgpt-a/m", &Prompt::ask("hi")).await?;
    assert_eq!(reply.text, "ok");
    assert_eq!(asked.load(Ordering::SeqCst), 1);
    // Leave to send went at the first frame, long before the answer's text.
    let released = released
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .ok_or("leave to send was never let go")?;
    let answered = answered
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .ok_or("the answer never came")?;
    assert!(
        released + Duration::from_millis(1000) < answered,
        "held past the first frame"
    );
    Ok(())
}

#[tokio::test]
async fn an_answer_that_goes_quiet_after_its_first_frame_ends_as_possibly_billed_once() -> Result {
    let frames = vec![(Duration::ZERO, CREATED), (Duration::from_secs(30), DONE)];
    let (root, asked, _) = backend(frames).await?;
    let (models, _) = models(&root, QUICK)?;
    let error = models
        .chat("chatgpt-a/m", &Prompt::ask("hi"))
        .await
        .err()
        .ok_or("the call should end")?;
    assert!(error.may_have_billed(), "{error:?}");
    assert!(!error.transient(), "{error:?}");
    assert_eq!(asked.load(Ordering::SeqCst), 1, "never sent again");
    Ok(())
}

#[tokio::test]
async fn a_backend_that_never_starts_answering_ends_as_possibly_billed_once() -> Result {
    // Takes the request and sends nothing at all, not even headers.
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let root = format!("http://{}/", listener.local_addr()?);
    let asked = Arc::new(AtomicUsize::new(0));
    let count = asked.clone();
    tokio::spawn(async move {
        let mut held = Vec::new();
        while let Ok((socket, _)) = listener.accept().await {
            count.fetch_add(1, Ordering::SeqCst);
            held.push(socket);
        }
    });
    let (models, released) = models(&root, QUICK)?;
    let started = Instant::now();
    let error = models
        .chat("chatgpt-a/m", &Prompt::ask("hi"))
        .await
        .err()
        .ok_or("the call should end")?;
    assert!(started.elapsed() < Duration::from_secs(5));
    assert!(error.may_have_billed(), "{error:?}");
    assert!(!error.transient(), "{error:?}");
    assert_eq!(asked.load(Ordering::SeqCst), 1, "never sent again");
    assert!(
        released.lock().unwrap_or_else(|p| p.into_inner()).is_some(),
        "leave to send is let go when the wait ends"
    );
    Ok(())
}

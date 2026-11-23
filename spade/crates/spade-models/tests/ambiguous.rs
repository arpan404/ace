//! A call whose connection is lost after the request went out may have run and been billed: it is
//! never taken as unsent, never sent again, and never hidden behind an earlier refusal.

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use spade_models::{Catalog, Effort, Keys, Models, Prompt};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

type Result<T = ()> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;

/// Answers the first `refusals` requests `400`, then reads each request whole and closes the
/// connection without a word. Counts requests.
async fn hang_up_after(refusals: usize) -> Result<(String, Arc<AtomicUsize>)> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let root = format!("http://{}/v1/", listener.local_addr()?);
    let count = Arc::new(AtomicUsize::new(0));
    let seen = count.clone();
    tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            let n = seen.fetch_add(1, Ordering::SeqCst);
            tokio::spawn(async move {
                let mut buffer = vec![0u8; 64 * 1024];
                let _ = socket.read(&mut buffer).await;
                if n < refusals {
                    let body = r#"{"error":{"message":"reasoning effort not supported"}}"#;
                    let reply = format!(
                        "HTTP/1.1 400 Bad Request\r\ncontent-type: application/json\r\n\
                         content-length: {}\r\nconnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = socket.write_all(reply.as_bytes()).await;
                }
                // Otherwise: the request is read, and the connection goes.
            });
        }
    });
    Ok((root, count))
}

fn models(root: &str) -> Result<Models> {
    let json = serde_json::json!({
        "endpoints": [ { "id": "far", "name": "Far", "format": "openai-chat", "base_url": root,
                         "key": { "env": "KEY" }, "models": [ { "id": "m", "name": "M",
                         "capabilities": ["tools", "reasoning"] } ] } ]
    });
    Ok(Models::new(
        Catalog::from_json(&json.to_string())?,
        Keys::new(|_| Some("key".to_owned())),
        "1.2.3",
    )?)
}

#[tokio::test]
async fn a_connection_lost_after_the_request_went_out_is_never_taken_as_unsent() -> Result {
    let (root, count) = hang_up_after(0).await?;
    let error = models(&root)?
        .chat("far/m", &Prompt::ask("hi"))
        .await
        .err()
        .ok_or("the call should fail")?;
    assert!(!error.transient(), "{error:?}");
    assert!(error.may_have_billed(), "{error:?}");
    assert_eq!(count.load(Ordering::SeqCst), 1);
    Ok(())
}

#[tokio::test]
async fn a_possibly_billed_failure_after_a_refused_effort_is_the_answer() -> Result {
    let (root, count) = hang_up_after(1).await?;
    let error = models(&root)?
        .chat("far/m", &Prompt::ask("hi").effort(Effort::High))
        .await
        .err()
        .ok_or("the call should fail")?;
    assert_eq!(count.load(Ordering::SeqCst), 2);
    assert_ne!(
        error.status(),
        Some(400),
        "the refusal hid what came after: {error:?}"
    );
    assert!(error.may_have_billed(), "{error:?}");
    Ok(())
}

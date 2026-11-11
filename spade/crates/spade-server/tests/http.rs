//! Runs the real server on a loopback port and talks to it over HTTP.

use std::net::SocketAddr;

use tokio::net::TcpListener;
use tokio::sync::oneshot;

struct Running {
    address: SocketAddr,
    stop: Option<oneshot::Sender<()>>,
    task: tokio::task::JoinHandle<std::io::Result<()>>,
}

async fn start() -> Result<Running, Box<dyn std::error::Error>> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let address = listener.local_addr()?;
    let (stop, stopped) = oneshot::channel::<()>();
    let task = tokio::spawn(spade_server::serve(listener, async {
        let _ = stopped.await;
    }));
    Ok(Running {
        address,
        stop: Some(stop),
        task,
    })
}

impl Running {
    fn url(&self, path: &str) -> String {
        format!("http://{}{path}", self.address)
    }

    async fn stop(mut self) -> Result<(), Box<dyn std::error::Error>> {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        self.task.await??;
        Ok(())
    }
}

#[tokio::test]
async fn health_reports_ok() -> Result<(), Box<dyn std::error::Error>> {
    let server = start().await?;
    let response = reqwest::get(server.url("/health")).await?;
    assert_eq!(response.status(), 200);
    assert_eq!(response.text().await?, r#"{"ok":true}"#);
    server.stop().await
}

#[tokio::test]
async fn unknown_paths_return_a_json_404() -> Result<(), Box<dyn std::error::Error>> {
    let server = start().await?;
    let response = reqwest::get(server.url("/nope")).await?;
    assert_eq!(response.status(), 404);
    assert_eq!(response.text().await?, r#"{"error":"not found"}"#);
    server.stop().await
}

#[tokio::test]
async fn stops_cleanly_when_asked() -> Result<(), Box<dyn std::error::Error>> {
    let server = start().await?;
    let address = server.address;
    server.stop().await?;
    assert!(
        reqwest::get(format!("http://{address}/health"))
            .await
            .is_err()
    );
    Ok(())
}
